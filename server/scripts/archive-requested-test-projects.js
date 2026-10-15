"use strict";

// Explicit owner-selected IDs only. Default mode is read-only.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { completedRefund, paymentAmounts } = require("../utils/enterpriseRevenue");
const TARGETS = Object.freeze([
  { id: "6acd3b47678aa45bd94a7354", customer: "Abby Oseo", units: 7 },
  { id: "6accb39899a4f85a0ecba22e", customer: "Joshua Javier", units: 40 },
]);
const REASON = "System owner identified these two repair projects as test data on October 15, 2026.";
const normalize = value => String(value || "").replace(/\s/g, "").toLowerCase();
const ids = rows => rows.map(row => row._id);
const serialize = value => mongoose.mongo.BSON.EJSON.stringify(value, null, 2, { relaxed: false });
const digest = value => crypto.createHash("sha256").update(serialize(value)).digest("hex");

function assertTargets(projects) {
  if (projects.length !== TARGETS.length) throw Error("Both requested project IDs must exist. No changes made.");
  for (const target of TARGETS) {
    const row = projects.find(project => String(project._id) === target.id);
    if (!row || normalize(row.customer?.name) !== normalize(target.customer) || Number(row.totalUnits) !== target.units) {
      throw Error(`Project ${target.id} does not match the supplied customer and unit count. No changes made.`);
    }
    if (row.sourceOrderId) throw Error("A selected project is linked to a product purchase. Stop for separate purchase review.");
    if (Number(row.completedUnits || 0) > 0 || row.status === "completed") throw Error("Recorded completed work requires a separate review. No changes made.");
  }
}

async function snapshot(db, session) {
  const read = (name, filter) => db.collection(name).find(filter, { session }).sort({ _id: 1 }).maxTimeMS(15000).toArray();
  const projectIds = TARGETS.map(row => new mongoose.Types.ObjectId(row.id));
  const projects = await read("projects", { _id: { $in: projectIds } });
  assertTargets(projects);
  const bookingIds = projects.map(row => row.bookingId).filter(Boolean);
  if (bookingIds.length && await db.collection("projects").countDocuments({ _id: { $nin: projectIds }, bookingId: { $in: bookingIds } }, { session, maxTimeMS: 15000 })) {
    throw Error("A booking is shared with another project. No changes made.");
  }
  const linked = { $or: [{ projectId: { $in: projectIds } }, { bookingId: { $in: bookingIds } }] };
  const result = { projects };
  for (const [key, collection, filter] of [
    ["bookings", "bookingservices", { _id: { $in: bookingIds } }],
    ["workOrders", "workorders", { projectId: { $in: projectIds } }],
    ["dailyAssignments", "dailyassignments", { projectId: { $in: projectIds } }],
    ["assignments", "assignments", linked], ["materials", "projectmaterials", { projectId: { $in: projectIds } }],
    ["equipment", "equipmentassignments", linked], ["payments", "payments", linked], ["expenses", "expenses", linked],
  ]) result[key] = await read(collection, filter);
  if (result.workOrders.some(row => Number(row.completedUnitCount || 0) > 0 || row.status === "completed")
      || result.dailyAssignments.some(row => Number(row.completedUnits || 0) > 0)) throw Error("A selected project has recorded completed units. No changes made.");
  if (result.payments.some(row => row.orderId)) throw Error("A payment is shared with a product purchase. No changes made.");
  const targets = new Set(projectIds.map(String));
  if ([...result.payments, ...result.expenses, ...result.assignments].some(row => row.projectId && !targets.has(String(row.projectId)))) {
    throw Error("A linked record also references another project. No changes made.");
  }
  const tools = result.materials.filter(row => row.source === "inventory" && row.sourceId).map(row => {
    if (!mongoose.isValidObjectId(row.sourceId)) throw Error("A material has an invalid stock reference. No changes made.");
    return new mongoose.Types.ObjectId(String(row.sourceId));
  });
  result.tools = tools.length ? await read("tools", { _id: { $in: tools } }) : [];
  return result;
}

function plan(data) {
  return {
    mode: "dry-run", projects: data.projects.map(row => ({ id: String(row._id), customer: row.customer?.name, units: row.totalUnits, status: row.status, alreadyArchived: Boolean(row.archivedAt) })),
    linkedBookings: data.bookings.length, workOrders: data.workOrders.length, dailyAssignments: data.dailyAssignments.length,
    paymentsRetained: data.payments.length, paymentAmountsRetained: data.payments.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    completedRefundsExcludedFromReports: data.payments.reduce((sum, row) => sum + paymentAmounts(row).refunded, 0),
    requestedRefundsNotCompleted: data.payments.filter(row => Number(row.refundAmount) > 0 && !completedRefund(row)).reduce((sum, row) => sum + Number(row.refundAmount), 0),
    expensesRetained: data.expenses.length,
    uncollectedReservations: data.materials.filter(row => row.status === "reserved" && !row.pickedUp).length,
    custodyRecordsRetained: data.equipment.filter(row => row.dailyKitId || row.checkedOutAt || row.status !== "reserved").length,
    physicalStockChanges: 0,
  };
}

function writeBackup(data, directory = path.resolve(__dirname, "../../temp")) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `requested-test-projects-before-archive-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.ejson`);
  const value = serialize(data), descriptor = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (fs.readFileSync(filename, "utf8") !== value) throw Error("The recovery backup could not be verified. No changes made.");
  return filename;
}

async function applySnapshot(db, data, session, { at, backup }) {
  const metadata = { testDataExcludedAt: at, testDataExclusionReason: REASON };
  const options = { session };
  const update = (collection, rows, change) => rows.length ? db.collection(collection).updateMany({ _id: { $in: ids(rows) } }, change, options) : Promise.resolve();
  await update("projects", data.projects, { $set: { ...metadata, status: "cancelled", archivedAt: at, archiveReason: REASON, updatedAt: at, reservedTechnicians: 0, dailyRequiredTechnicians: 0 } });
  for (const booking of data.bookings) {
    await db.collection("bookingservices").updateOne({ _id: booking._id }, {
      $set: { ...metadata, status: "cancelled", cancellationReason: REASON, cancelledAt: at, updatedAt: at, autoReschedulePending: false,
        services: (booking.services || []).map(row => ({ ...row, status: "cancelled" })) },
      $push: { statusHistory: { fromStatus: booking.status, toStatus: "cancelled", changedByModel: "System", changedByName: "System owner requested test cleanup", changedAt: at, reason: REASON } },
    }, options);
  }
  await update("workorders", data.workOrders, { $set: { status: "cancelled", cancellationReason: REASON, cancelledAt: at, updatedAt: at } });
  await update("dailyassignments", data.dailyAssignments, { $set: { status: "skipped", notes: REASON, updatedAt: at } });
  await update("assignments", data.assignments, { $set: { status: "cancelled", cancelledAt: at }, $push: { notes: { text: REASON, byName: "System owner requested test cleanup", createdAt: at } } });
  // Financial amounts/statuses remain intact and recoverable; only these test
  // transactions are excluded from Sales and Payments. No refunds are issued.
  await update("payments", data.payments, { $set: metadata });
  await update("expenses", data.expenses, { $set: metadata });
  const releases = new Map();
  for (const material of data.materials.filter(row => row.status === "reserved" && !row.pickedUp)) {
    await db.collection("projectmaterials").updateOne({ _id: material._id, status: "reserved", pickedUp: { $ne: true } }, { $set: { status: "cancelled", cancellationReason: REASON, cancelledAt: at } }, options);
    if (material.source === "inventory" && material.sourceId) {
      const quantity = Number(material.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw Error("Invalid material reservation quantity. Transaction aborted.");
      const key = String(material.sourceId); releases.set(key, (releases.get(key) || 0) + quantity);
    }
  }
  for (const [key, quantity] of releases) {
    const result = await db.collection("tools").updateOne({ _id: new mongoose.Types.ObjectId(key), reservedQuantity: { $gte: quantity } }, { $inc: { reservedQuantity: -quantity } }, options);
    if (result.matchedCount !== 1) throw Error("A reservation counter changed or is insufficient. Transaction aborted; other kits were not adjusted.");
  }
  const targets = new Set(ids(data.projects).map(String));
  for (const row of data.equipment.filter(row => row.status === "reserved" && !row.dailyKitId && !row.checkedOutAt && targets.has(String(row.projectId)))) {
    await db.collection("equipmentassignments").updateOne({ _id: row._id, status: "reserved" }, { $set: { status: "released", releasedAt: at, releaseReason: REASON, resolutionState: "resolved" } }, options);
  }
  await db.collection("activitylogs").insertMany(data.projects.map(row => ({ actor: null, actorName: "System owner requested test cleanup", action: "project.test_data_archived", module: "projects", category: "project", entityType: "Project", entityId: row._id,
    actionType: "cancelled", source: "system", outcome: "success", createdAt: at, updatedAt: at, details: { reason: REASON, previousStatus: row.status, backup: path.basename(backup) } })), options);
}

async function archiveRequestedTestProjects({ db, client, apply = false, backupDirectory }) {
  const initial = await snapshot(db);
  const summary = plan(initial);
  if (!apply) return summary;
  if (initial.projects.every(row => row.archivedAt && row.testDataExcludedAt) && initial.payments.every(row => row.testDataExcludedAt)
      && initial.expenses.every(row => row.testDataExcludedAt)) return { ...summary, mode: "already-archived" };
  const backup = writeBackup(initial, backupDirectory), signature = digest(initial);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await snapshot(db, session);
      if (digest(current) !== signature) throw Error("Related records changed after the backup. No changes made; rerun the dry-run.");
      await applySnapshot(db, current, session, { at: new Date(), backup });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
  const after = await snapshot(db);
  if (after.projects.some(row => !row.archivedAt || row.status !== "cancelled") || after.payments.some(row => !row.testDataExcludedAt)) throw Error("Cleanup verification failed. Inspect the recovery backup before retrying.");
  return { ...summary, mode: "archived", backup, backupSha256: signature, reportingExclusion: "Only explicitly linked test payments and expenses; financial amounts and statuses retained.", custody: "Issued/shared kit records remain. Technicians must return issued equipment through the existing returns workflow." };
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
  (async () => {
    const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");
    if (!process.env.MONGODB_URI) throw Error("Database configuration is missing.");
    const connection = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
    await mongoose.connect(disableRetryableWritesForDirectConnection(connection.uri), { serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await archiveRequestedTestProjects({ db: mongoose.connection.db, client: mongoose.connection.getClient(), apply: process.argv.includes("--apply") }), null, 2));
  })().catch(error => { console.error(JSON.stringify({ error: error.name, code: error.code || null,
    message: /^(Mongo|Mongoose)/.test(error.name) ? "Database connection unavailable or transaction failed. Run inside the application container; do not reopen a public MongoDB port." : error.message })); process.exitCode = 1;
  }).finally(() => mongoose.disconnect());
}

module.exports = { TARGETS, assertTargets, snapshot, plan, writeBackup, applySnapshot, archiveRequestedTestProjects };
