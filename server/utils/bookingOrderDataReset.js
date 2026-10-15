"use strict";

const path = require("node:path");
const recovery = require("./resetRecoveryBackup");
const { serialize, deserialize, digest, snapshotDigest, writeResetBackup } = recovery;
const { COUNT, BATCH, demoId, catalogPrice, buildCompletedDemoSeed } = require("./completedBookingDemoSeed");

const RESET_KEY = "booking-order-reset-20261015-v1";
// Exact records from the live read-only preview. On October 15, 2026 the
// owner explicitly confirmed that these were test entries and nothing was
// physically taken. This acknowledges simulated links; it never fabricates
// a return, credits stock, or bypasses other issued-equipment checks.
const TEST_CUSTODY_ACKNOWLEDGEMENT = Object.freeze({
  projectmaterials: Object.freeze(["6a984f53e9580116f93d3d00", "6a984f53e9580116f93d3d01"]),
  dailykits: Object.freeze(["6aa7ad8317db5ded206482e4", "6ab09a1d95e7ac96d8fe92ce", "6ab60ef8a4ff927d7bf2ebb1"]),
  reason: "Owner confirmed these exact previewed records are test entries only; nothing was physically taken.",
  stockQuantityChanges: 0,
});
// These collections belong exclusively to the service/order workflows. Clearing
// their orphan rows is intentional, including payments whose booking is missing.
const WORK_COLLECTIONS = Object.freeze([
  "bookingservices", "orders", "projects", "workorders", "dailyassignments", "assignments",
  "projectmaterials", "projectissues", "projectresourcepurchases", "projectworksubmissions",
  "servicereports", "servicetoolusages", "partsrequests", "stockreservations",
  "dailykits", "equipmentassignments", "kitreturns", "payments", "warrantyclaims",
  "customerassets", "maintenanceschedules", "unitassistancerequests", "relocationrequests",
]);
const PARTIAL_COLLECTIONS = Object.freeze(["expenses", "productreturns", "productrefunds", "productreturnmovements", "ratings", "notifications", "emailoutboxes"]);
const SEED_COLLECTIONS = Object.freeze(["users", "technicians", "bookingservices", "assignments", "payments", "servicereports"]);
const id = value => String(value || "");
const ids = rows => rows.map(row => row._id);
const present = field => ({ [field]: { $exists: true, $ne: null } });

async function snapshotResetData(db, session, { decryptEmail } = {}) {
  const read = async (name, filter = {}) => {
    const rows = await db.collection(name).find(filter, { session }).sort({ _id: 1 }).limit(50001).maxTimeMS(15000).toArray();
    if (rows.length > 50000) throw Error(`The ${name} collection exceeds this reset tool's limit. Use a planned database migration instead.`);
    return rows;
  };
  const remove = {};
  // MongoDB transactions do not support parallel operations on one session.
  for (const name of WORK_COLLECTIONS) remove[name] = await read(name);
  remove.expenses = await read("expenses", { $or: ["bookingId", "orderId", "projectId", "workOrderId"].map(present) });
  remove.productreturns = await read("productreturns", { $or: [{ sourceType: "order" }, present("bookingId"), present("workOrderId")] });
  remove.productrefunds = await read("productrefunds", { $or: [
    { sourceType: "order" }, { returnId: { $in: ids(remove.productreturns) } }, { originalPaymentId: { $in: ids(remove.payments) } },
  ] });
  remove.productreturnmovements = await read("productreturnmovements", { $or: [{ sourceType: "order" }, { returnId: { $in: ids(remove.productreturns) } }] });
  remove.ratings = await read("ratings", { targetType: { $in: ["booking", "order"] } });
  const allIds = Object.values(remove).flatMap(rows => ids(rows));
  const references = [...remove.bookingservices.map(row => row.bookingReference), ...remove.orders.map(row => row.orderReference)]
    .filter(value => typeof value === "string" && value.length >= 6);
  const needles = [...allIds.map(id).filter(value => value.length >= 12), ...references];
  const mentionsWork = value => needles.some(needle => value.includes(needle));
  const workType = /^(?:assignment|booking|order|project|daily_kit|daily_acceptance|kit_return|equipment_return|maintenance|unit_assistance|relocation|warranty|payment|refund|service)_/;
  const workModels = ["BookingService", "Order", "Project", "WorkOrder", "Assignment", "DailyAssignment", "DailyKit", "EquipmentAssignment", "KitReturn", "WarrantyClaim", "CustomerAsset", "MaintenanceSchedule", "UnitAssistanceRequest", "RelocationRequest", "ServiceReport", "PartsRequest", "Payment", "ProductReturn", "ProductRefund"];
  remove.notifications = (await read("notifications")).filter(row => workType.test(row.type || "") || workModels.includes(row.referenceModel)
    || allIds.some(value => id(value) === id(row.referenceId)) || mentionsWork(row.link || ""));
  const emailBlockers = [];
  remove.emailoutboxes = [];
  for (const row of await read("emailoutboxes", { status: { $in: ["pending", "processing"] } })) {
    const source = String(row.source || "application");
    if (/^(?:login_otp|registration_otp|password_reset|security)/.test(source)) continue;
    let related = /^(?:booking_|order_|project_|walk_in_(?:service_confirmation|order_confirmation))/.test(source);
    if (!related) {
      try { related = mentionsWork(JSON.stringify(await decryptEmail(row))); }
      catch { emailBlockers.push({ code: "queued_email_cannot_be_checked", id: id(row._id) }); continue; }
    }
    if (!related) continue;
    if (row.status === "processing") emailBlockers.push({ code: "transaction_email_is_processing", id: id(row._id) });
    else remove.emailoutboxes.push(row);
  }
  const tools = await read("tools");
  const technicians = await read("technicians");
  const services = await read("coreservices", { active: { $ne: false }, archivedAt: null });
  const settings = await read("sitesettings", { key: "systemConfiguration" });
  const demoUsers = await read("users", { _id: { $in: [0, 1, 2].map(index => demoId(`customer-${index}`)) } });
  return { remove, tools, technicians, services, settings, demoUsers, emailBlockers };
}

function buildResetPlan(data) {
  const blockers = [...data.emailBlockers];
  const acknowledgedTestCustody = Object.fromEntries(["projectmaterials", "dailykits"].map(name => [name,
    data.remove[name].filter(row => TEST_CUSTODY_ACKNOWLEDGEMENT[name].includes(id(row._id))).map(row => id(row._id)),
  ]));
  acknowledgedTestCustody.reason = TEST_CUSTODY_ACKNOWLEDGEMENT.reason;
  acknowledgedTestCustody.stockQuantityChanges = 0;
  if (!data.settings[0]?.value?.maintenance?.enabled) blockers.push({ code: "enable_maintenance_in_admin_system_settings_first" });
  if (!data.services.some(row => row.active !== false && !row.archivedAt && catalogPrice(row) > 0)) blockers.push({ code: "configure_an_active_core_service_price_first" });
  const add = (code, rows) => { if (rows.length) blockers.push({ code, count: rows.length, ids: rows.slice(0, 10).map(row => id(row._id)) }); };
  add("return_issued_equipment_or_consumables_first", data.remove.equipmentassignments.filter(row => ["checked_out", "in_use"].includes(row.status) || row.returnPending));
  add("review_pending_kit_returns_first", data.remove.kitreturns.filter(row => row.status === "pending"));
  add("resolve_checked_out_repair_parts_first", data.remove.stockreservations.filter(row => row.status === "checked_out"));
  add("cancel_unissued_deducted_reservations_in_normal_workflow_first", data.remove.stockreservations.filter(row => row.status === "reserved" && row.stockTreatment !== "soft_hold"));
  add("resolve_picked_up_project_materials_first", data.remove.projectmaterials.filter(row => row.status === "reserved" && row.pickedUp
    && !TEST_CUSTODY_ACKNOWLEDGEMENT.projectmaterials.includes(id(row._id))));
  const assignments = new Map(data.remove.equipmentassignments.map(row => [id(row._id), row]));
  add("resolve_unsettled_daily_kit_items_first", data.remove.dailykits.filter(kit => !TEST_CUSTODY_ACKNOWLEDGEMENT.dailykits.includes(id(kit._id))
    && [...(kit.items || []), ...(kit.returnedItems || []), ...(kit.deltaItems || [])].some(item => {
    if (item.returnPendingQuantity > 0) return true;
    const custody = [item.equipmentAssignmentId, ...(item.custodyAssignmentIds || [])].map(value => assignments.get(id(value))).filter(Boolean);
    if (custody.length && custody.every(row => ["returned", "released", "consumed", "damaged", "lost"].includes(row.status))) return false;
    return Number(item.quantityIssued || 0) > Number(item.quantityUsed || 0) + Number(item.quantityReturned || 0) + Number(item.quantityDamaged || 0) + Number(item.quantityMissing || 0);
  })));
  const targetReturnIds = new Set(ids(data.remove.productreturns).map(id));
  add("shared_counter_sale_refund_needs_review", data.remove.productrefunds.filter(row => row.sourceType === "walk_in" && !targetReturnIds.has(id(row.returnId))));
  add("invalid_reservation_counter_needs_review", data.tools.filter(row => !Number.isFinite(Number(row.reservedQuantity || 0)) || Number(row.reservedQuantity || 0) < 0));
  return {
    mode: "dry-run", operation: RESET_KEY, deletionCounts: Object.fromEntries(Object.entries(data.remove).map(([name, rows]) => [name, rows.length])),
    seed: { batch: BATCH, completedServiceBookings: COUNT, completedOrders: 0, disabledDemoCustomers: 3, inactiveDemoTechnicians: 2, customerNotifications: 0 },
    reservationCountersToClear: data.tools.filter(row => Number(row.reservedQuantity) > 0).length,
    physicalQuantityChanges: 0, acknowledgedTestCustody, blockers,
    preserved: ["existing accounts and staff", "catalogs", "physical stock and checkout counters", "independent counter sales and their returns", "unlinked expenses and payroll", "security/activity/stock audit history", "uploads"],
    note: "All service/order workflow records, including orphan rows, are targeted. Demo transactions are clearly labeled and included in reports; they are not actual income. Independent counter sales, payroll and expenses still affect analytics.",
  };
}

async function readResetBackup(file, options) {
  const result = await recovery.readResetBackup(file, options);
  const { artifact } = result;
  if (artifact.operation !== RESET_KEY || Number(artifact.schemaVersion) !== 1) throw Error("This is not a supported booking/order reset backup.");
  return result;
}

async function prepareReset({ db, backupDirectory, now = new Date(), decryptEmail }) {
  if (await db.collection("sitesettings").findOne({ key: RESET_KEY })) return { mode: "already-applied", operation: RESET_KEY, message: "This one-time reset has already run. Later bookings will not be deleted." };
  const original = await snapshotResetData(db, undefined, { decryptEmail });
  const plan = buildResetPlan(original);
  if (plan.blockers.length) return { ...plan, mode: "blocked", databaseChanges: 0 };
  const seed = await buildCompletedDemoSeed({ services: original.services, now });
  for (const name of ["users", "technicians"]) {
    if (await db.collection(name).findOne({ _id: { $in: ids(seed[name]) } })) throw Error("A reserved demo identity already exists. No database changes made.");
  }
  const artifact = { schemaVersion: 1, operation: RESET_KEY, database: db.databaseName, preparedAt: now, original, seed,
    acknowledgedTestCustody: plan.acknowledgedTestCustody, preparedPlan: plan };
  return { ...plan, mode: "prepared", databaseChanges: 0, ...await writeResetBackup(artifact, backupDirectory), next: "Download both private backup files before applying. Do not post their contents or place them in public/uploads." };
}

async function applyReset({ db, client, backupFile, now = new Date(), decryptEmail, restore = false }) {
  const { artifact, backupSha256 } = await readResetBackup(backupFile, { omitOriginal: !restore });
  if (artifact.database !== db.databaseName) throw Error("The recovery backup belongs to a different database.");
  const marker = await db.collection("sitesettings").findOne({ key: RESET_KEY });
  if (!restore && marker) return { mode: "already-applied", operation: RESET_KEY, message: "This one-time reset has already run. Later bookings will not be deleted." };
  if (restore && (!marker || marker.value.backupSha256 !== backupSha256)) throw Error("This backup does not match the applied reset.");
  if (!restore && (now - artifact.preparedAt < 0 || now - artifact.preparedAt > 30 * 60000)) throw Error("The prepared backup expired. Prepare a fresh snapshot before applying.");
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw Error("Atomic reset requires a MongoDB replica set or sharded cluster. No standalone fallback is allowed.");
  const session = client.startSession();
  const plan = artifact.preparedPlan || buildResetPlan(artifact.original);
  let afterHash;
  try {
    await session.withTransaction(async () => {
      const current = await snapshotResetData(db, session, { decryptEmail });
      if (!current.settings[0]?.value?.maintenance?.enabled) throw Error("Enable maintenance in Admin System Settings before changing records.");
      const hashVersion = Number(restore ? marker.value.snapshotDigestVersion : artifact.snapshotDigestVersion) || 1;
      const expectedHash = restore ? marker.value.afterHash : artifact.originalSnapshotHash || snapshotDigest(artifact.original, hashVersion);
      if (snapshotDigest(current, hashVersion) !== expectedHash) throw Error("Records changed after the snapshot. No changes made. Prepare again; do not overwrite newer work.");
      if (!restore && buildResetPlan(current).blockers.length) throw Error("Unresolved custody or reservation checks block the reset. No changes made.");
      const options = { session };
      if (restore) {
        for (const name of SEED_COLLECTIONS) {
          const removed = await db.collection(name).deleteMany({ _id: { $in: ids(artifact.seed[name]) } }, options);
          if (removed.deletedCount !== artifact.seed[name].length) throw Error("Seed records changed; restore was rolled back.");
        }
        for (const [name, rows] of Object.entries(artifact.original.remove)) if (rows.length) await db.collection(name).insertMany(rows, options);
        for (const tool of artifact.original.tools) await db.collection("tools").replaceOne({ _id: tool._id }, tool, options);
        for (const technician of artifact.original.technicians) await db.collection("technicians").replaceOne({ _id: technician._id }, technician, options);
        await db.collection("sitesettings").deleteOne({ key: RESET_KEY }, options);
      } else {
        for (const [name, rows] of Object.entries(current.remove)) if (rows.length) {
          const removed = await db.collection(name).deleteMany({ _id: { $in: ids(rows) } }, options);
          if (removed.deletedCount !== rows.length) throw Error(`The ${name} records changed; reset was rolled back.`);
        }
        // All three reservation ledgers are removed: project materials,
        // EquipmentAssignments and StockReservations. Physical and checked-out
        // quantities are deliberately unchanged; unresolved issuance blocks above.
        for (const tool of current.tools.filter(row => Number(row.reservedQuantity) > 0)) {
          const updated = await db.collection("tools").updateOne({ _id: tool._id, reservedQuantity: tool.reservedQuantity }, { $set: { reservedQuantity: 0 } }, options);
          if (updated.matchedCount !== 1) throw Error("An inventory reservation changed; reset was rolled back.");
        }
        for (const technician of current.technicians.filter(row => ["Assigned", "On The Way", "In Progress"].includes(row.availabilityStatus))) {
          await db.collection("technicians").updateOne({ _id: technician._id }, { $set: { availabilityStatus: "Offline" } }, options);
        }
        for (const name of SEED_COLLECTIONS) await db.collection(name).insertMany(artifact.seed[name], options);
        const after = await snapshotResetData(db, session, { decryptEmail });
        const remaining = Object.entries(after.remove).filter(([name, rows]) => rows.length !== (artifact.seed[name]?.length || 0));
        if (remaining.length || after.remove.bookingservices.some(row => row.status !== "completed") || after.remove.orders.length) throw Error("Reset verification failed; all changes were rolled back.");
        afterHash = digest(after);
        await db.collection("sitesettings").insertOne({ key: RESET_KEY, value: { appliedAt: now, backupSha256, afterHash, snapshotDigestVersion: 2, seedUserIds: ids(artifact.seed.users) }, createdAt: now, updatedAt: now }, options);
      }
      await db.collection("activitylogs").insertOne({
        action: restore ? "BOOKING_ORDER_DATA_RESET_RESTORED" : "BOOKING_ORDER_DATA_RESET", actionType: "system",
        actorName: "Owner-authorized database maintenance", source: "system", outcome: "success", createdAt: now,
        details: { operation: RESET_KEY, backup: path.basename(backupFile), backupSha256, counts: plan.deletionCounts,
          acknowledgedTestCustody: plan.acknowledgedTestCustody, completedDemoBookings: restore ? 0 : COUNT },
      }, options);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } finally { await session.endSession(); }
  return { ...plan, mode: restore ? "restored" : "reset-and-seeded", backup: backupFile, backupSha256, atomic: true,
    message: restore ? "The original records were restored; the audit trail was retained." : "24 completed demo service bookings were created. Orders are empty. No email, OTP, gateway charge or physical stock movement was generated. Keep the backup outside the container.",
  };
}

module.exports = { RESET_KEY, TEST_CUSTODY_ACKNOWLEDGEMENT, WORK_COLLECTIONS, PARTIAL_COLLECTIONS, SEED_COLLECTIONS, serialize, deserialize, digest,
  snapshotResetData, buildResetPlan, writeResetBackup, readResetBackup, prepareReset, applyReset };
