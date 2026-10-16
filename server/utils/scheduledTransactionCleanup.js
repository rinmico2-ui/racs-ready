"use strict";

const path = require("node:path");
const recovery = require("./resetRecoveryBackup");
const dates = require("./reportingDates");
const { strictManilaDateKey } = require("./bookingDateTime");

const OPERATION = "scheduled-booking-order-cleanup-v1";
const MODEL_NAMES = Object.freeze([
  "BookingService", "Order", "Project", "WorkOrder", "DailyAssignment", "Assignment",
  "ProjectMaterial", "ProjectIssue", "ProjectResourcePurchase", "ProjectWorkSubmission",
  "ServiceReport", "ServiceToolUsage", "PartsRequest", "StockReservation", "DailyKit",
  "EquipmentAssignment", "KitReturn", "Payment", "WarrantyClaim", "CustomerAsset",
  "MaintenanceSchedule", "UnitAssistanceRequest", "RelocationRequest", "Expense",
  "ProductReturn", "ProductRefund", "ProductReturnMovement", "Rating", "Notification", "EmailOutbox",
]);
const ROOTS = new Set(["bookingservices", "orders"]);
const id = value => String(value || "");
const ids = rows => rows.map(row => row._id);

function configuration(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")
    || strictManilaDateKey(from) !== from || strictManilaDateKey(to) !== to || from > to
    || dates.parseDate(to) - dates.parseDate(from) > 30 * dates.DAY) {
    throw Error("Use valid inclusive --from and --to dates in YYYY-MM-DD format, spanning at most 31 days.");
  }
  return { from, to, basis: "scheduled", timeZone: "Asia/Manila" };
}
const operationKey = config => `${OPERATION}:${config.from}:${config.to}`;
const dateKey = value => value == null ? "" : dates.dateKey(value);
const inRange = (value, config) => { const key = dateKey(value); return Boolean(key && key >= config.from && key <= config.to); };
const orderDate = row => row.fulfillmentType === "customer_pickup" ? row.pickupDate : row.delivery?.preferredDate;

function valuesAt(value, parts) {
  if (Array.isArray(value)) return value.flatMap(item => valuesAt(item, parts));
  if (!parts.length) return value == null ? [] : [value];
  return value == null ? [] : valuesAt(value[parts[0]], parts.slice(1));
}

function registry() {
  const models = MODEL_NAMES.map(name => require(`../models/${name}`));
  const names = Object.fromEntries(models.map(Model => [Model.modelName, Model.collection.name]));
  const result = {};
  function walk(schema, prefix = "") {
    const refs = [];
    schema.eachPath((name, type) => {
      const field = prefix + name;
      const target = names[type.options.ref || type.getEmbeddedSchemaType?.()?.options.ref];
      if (target) refs.push({ field, target });
      if (type.schema) refs.push(...walk(type.schema, field + "."));
    });
    return refs;
  }
  for (const Model of models) result[Model.collection.name] = walk(Model.schema);
  return result;
}

function links(row, refs) {
  const result = refs.flatMap(({ field, target }) => valuesAt(row, field.split(".")).map(value => ({ field, target, id: id(value) })));
  // Older expense and workflow documents can retain links no longer declared
  // in the current schema. Read raw stored references rather than dropping them.
  for (const [field, target] of Object.entries({
    bookingId: "bookingservices", bookingIds: "bookingservices", sourceOrderId: "orders", existingBookingId: "bookingservices",
    orderId: "orders", orderIds: "orders", projectId: "projects", projectIds: "projects",
    workOrderId: "workorders", workOrderIds: "workorders", assignmentId: "assignments", assignmentIds: "assignments",
    dailyAssignmentId: "dailyassignments", dailyAssignmentIds: "dailyassignments", dailyKitId: "dailykits",
  })) {
    if (refs.some(reference => reference.field === field)) continue;
    for (const value of valuesAt(row, [field])) result.push({ field, target, id: id(value) });
  }
  const typed = (field, type, mapping) => {
    if (row[field] && mapping[row[type]]) result.push({ field, target: mapping[row[type]], id: id(row[field]) });
  };
  typed("sourceId", "sourceType", { booking: "bookingservices", order: "orders" });
  typed("originId", "originType", { booking: "bookingservices", order: "orders" });
  typed("targetId", "targetType", { booking: "bookingservices", order: "orders" });
  typed("sourceCompletionId", "sourceCompletionType", { booking: "bookingservices", order: "orders" });
  for (const group of ["items", "returnedItems", "deltaItems"]) for (const item of row[group] || []) {
    const target = { booking: "bookingservices", order: "orders", project: "projects" }[item.manualJobType];
    if (target && item.manualJobId) result.push({ field: `${group}.manualJobId`, target, id: id(item.manualJobId) });
  }
  return result;
}

async function read(db, name, session, filter = {}) {
  const rows = await db.collection(name).find(filter, { session }).sort({ _id: 1 }).limit(50001).maxTimeMS(15000).toArray();
  if (rows.length > 50000) throw Error(`The ${name} collection exceeds the cleanup limit. No changes made.`);
  return rows;
}

function selectRecords(all, config, refs = registry()) {
  const selected = Object.fromEntries(Object.keys(refs).map(name => [name, new Set()]));
  const add = (name, row) => selected[name].add(id(row._id));
  for (const row of all.bookingservices) if (inRange(row.bookingDate, config)) add("bookingservices", row);
  for (const row of all.orders) if (inRange(orderDate(row), config)) add("orders", row);
  const scheduledBookings = selected.bookingservices.size;
  const mirroredIds = new Set(all.orders.filter(row => selected.orders.has(id(row._id))).map(row => id(row.bookingId)));
  for (const row of all.bookingservices) {
    if (selected.orders.has(id(row.sourceOrderId)) || mirroredIds.has(id(row._id))) add("bookingservices", row);
  }
  let changed;
  do {
    changed = false;
    // Some older records keep only the parent's pointer to the assignment,
    // payment or assistance request. Include those owned children as well.
    const owned = new Set(["assignments", "payments", "unitassistancerequests", "relocationrequests", "servicereports", "projects"]);
    for (const [name, fields] of Object.entries(refs)) for (const row of all[name]) if (selected[name].has(id(row._id))) {
      for (const link of links(row, fields)) if (owned.has(link.target) && !selected[link.target].has(link.id)) {
        const child = all[link.target].find(candidate => id(candidate._id) === link.id);
        if (child) { add(link.target, child); changed = true; }
      }
    }
    for (const [name, fields] of Object.entries(refs)) {
      if (ROOTS.has(name) || ["notifications", "emailoutboxes"].includes(name)) continue;
      for (const row of all[name]) if (!selected[name].has(id(row._id))
        && links(row, fields).some(link => selected[link.target]?.has(link.id))) {
        add(name, row); changed = true;
      }
    }
  } while (changed);

  const blockers = [];
  // A shared kit, payment, asset or project must never pull an unrelated booking
  // or order into the deletion. Keep ambiguous dependency groups blocked.
  for (const [name, fields] of Object.entries(refs)) {
    if (["notifications", "emailoutboxes"].includes(name)) continue;
    for (const row of all[name]) {
      const chosen = selected[name].has(id(row._id));
      const crosses = links(row, fields).filter(link => chosen
        ? ROOTS.has(link.target) && !selected[link.target].has(link.id)
        : selected[link.target]?.has(link.id));
      if (crosses.length) blockers.push({ code: "shared_or_outside_range_transaction", collection: name, id: id(row._id), fields: [...new Set(crosses.map(link => link.field))] });
    }
  }
  const remove = Object.fromEntries(Object.keys(refs).map(name => [name, all[name].filter(row => selected[name].has(id(row._id)))]));
  return { remove, blockers, scheduledBookings, linkedInstallationBookings: remove.bookingservices.length - scheduledBookings };
}

function mentionMatcher(remove) {
  const tokens = Object.values(remove).flatMap(rows => rows.map(row => id(row._id)));
  tokens.push(...remove.bookingservices.map(row => row.bookingReference), ...remove.orders.map(row => row.orderReference));
  const expressions = [...new Set(tokens.filter(value => typeof value === "string" && value.length >= 6))]
    .map(value => new RegExp(`(^|[^a-zA-Z0-9_-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-zA-Z0-9_-])`));
  return value => expressions.some(expression => expression.test(String(value || "")));
}

async function snapshot(db, config, session, { decryptEmail } = {}) {
  const refs = registry(), all = {};
  for (const name of Object.keys(refs)) all[name] = await read(db, name, session,
    name === "emailoutboxes" ? { status: { $in: ["pending", "processing"] } } : {});
  const selected = selectRecords(all, config, refs), { remove, blockers } = selected;
  const mentions = mentionMatcher(remove);
  const modelCollections = Object.fromEntries(MODEL_NAMES.map(name => [name, require(`../models/${name}`).collection.name]));
  const targets = new Set(Object.values(remove).flatMap(rows => rows.map(row => id(row._id))));
  remove.notifications = all.notifications.filter(row => {
    const collection = modelCollections[row.referenceModel];
    return (collection && remove[collection].some(target => id(target._id) === id(row.referenceId)))
      || (!row.referenceModel && targets.has(id(row.referenceId))) || mentions(row.link);
  });
  for (const row of all.emailoutboxes) {
    if (!["pending", "processing"].includes(row.status) || /^(?:login_otp|registration_otp|password_reset|security)/.test(row.source || "")) continue;
    let related;
    try { related = mentions(JSON.stringify(await decryptEmail(row))); }
    catch { blockers.push({ code: "queued_email_cannot_be_checked", id: id(row._id) }); continue; }
    if (!related) continue;
    if (row.status === "processing") blockers.push({ code: "transaction_email_is_processing", id: id(row._id) });
    else remove.emailoutboxes.push(row);
  }
  return {
    remove,
    checks: [{ ...config, scheduledBookings: selected.scheduledBookings, linkedInstallationBookings: selected.linkedInstallationBookings, blockers }],
  };
}

function plan(data, config) {
  const blockers = [...data.checks[0].blockers];
  const block = (collection, code, predicate) => {
    const rows = data.remove[collection].filter(predicate);
    if (rows.length) blockers.push({ code, collection, count: rows.length, ids: rows.slice(0, 10).map(row => id(row._id)) });
  };
  block("equipmentassignments", "settle_or_release_equipment_first", row => !["released", "returned", "consumed", "damaged", "lost"].includes(row.status) || row.returnPending);
  block("stockreservations", "settle_or_release_stock_reservations_first", row => ["reserved", "checked_out"].includes(row.status));
  block("projectmaterials", "settle_or_release_project_materials_first", row => row.status === "reserved");
  block("kitreturns", "review_pending_kit_returns_first", row => row.status === "pending");
  const custody = new Map(data.remove.equipmentassignments.map(row => [id(row._id), row]));
  block("dailykits", "resolve_unsettled_daily_kit_items_first", row => ["items", "returnedItems", "deltaItems"].some(group => (row[group] || []).some(item => {
    if (Number(item.returnPendingQuantity) > 0) return true;
    const assignments = [item.equipmentAssignmentId, ...(item.custodyAssignmentIds || [])].map(value => custody.get(id(value))).filter(Boolean);
    if (assignments.length && assignments.every(entry => ["returned", "released", "consumed", "damaged", "lost"].includes(entry.status))) return false;
    if (["checked_out", "issued", "in_custody"].includes(item.checkoutStatus) && !assignments.length) return true;
    return Number(item.quantityIssued || 0) > ["quantityUsed", "quantityReturned", "quantityDamaged", "quantityMissing"].reduce((sum, key) => sum + Number(item[key] || 0), 0);
  })));
  for (const name of ["productreturns", "productrefunds", "productreturnmovements"]) {
    block(name, "independent_counter_sale_dependency_needs_review", row => row.sourceType === "walk_in");
  }
  return {
    mode: "dry-run", operation: operationKey(config), scope: config,
    dateFields: { bookings: "bookingDate", orders: "delivery.preferredDate or pickupDate for customer_pickup" },
    scheduledBookings: data.checks[0].scheduledBookings, linkedInstallationBookings: data.checks[0].linkedInstallationBookings,
    deletionCounts: Object.fromEntries(Object.entries(data.remove).map(([name, rows]) => [name, rows.length])),
    paymentsByStatus: Object.fromEntries([...new Set(data.remove.payments.map(row => row.status || "unknown"))].sort().map(status => {
      const rows = data.remove.payments.filter(row => (row.status || "unknown") === status);
      return [status, { count: rows.length, amount: Math.round(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100 }];
    })),
    blockers, physicalStockChanges: 0, reservationCounterChanges: 0, seedRecords: 0,
    preserved: ["bookings and orders outside the selected schedule dates (shared dependencies block cleanup)", "accounts and staff", "physical inventory and reservation counters", "independent POS sales", "unrelated expenses and payroll", "audit history and uploaded files"],
  };
}

async function requireMaintenance(db, session) {
  const settings = await db.collection("sitesettings").findOne({ key: "systemConfiguration" }, { session });
  if (settings?.value?.maintenance?.enabled !== true) throw Error("Enable Maintenance Mode in Admin System Settings before preparing or applying this cleanup.");
}
async function requireTransactions(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw Error("Cleanup requires a MongoDB replica set or sharded cluster. No standalone fallback is allowed.");
}

async function preview({ db, config, decryptEmail }) {
  const marker = await db.collection("sitesettings").findOne({ key: operationKey(config) });
  if (marker && !marker.value.restoredAt) return { mode: "already-applied", operation: operationKey(config), databaseChanges: 0 };
  return { ...plan(await snapshot(db, config, undefined, { decryptEmail }), config), databaseChanges: 0 };
}

async function prepare({ db, config, decryptEmail, backupDirectory, now = new Date() }) {
  const marker = await db.collection("sitesettings").findOne({ key: operationKey(config) });
  if (marker && !marker.value.restoredAt) return { mode: "already-applied", operation: operationKey(config), databaseChanges: 0 };
  await requireMaintenance(db);
  const original = await snapshot(db, config, undefined, { decryptEmail }), summary = plan(original, config);
  if (summary.blockers.length) return { ...summary, mode: "blocked", databaseChanges: 0 };
  if (!original.remove.bookingservices.length && !original.remove.orders.length) return { ...summary, mode: "nothing-to-delete", databaseChanges: 0 };
  const prepared = await recovery.writeResetBackup({ operation: OPERATION, schemaVersion: 1, database: db.databaseName, config,
    preparedAt: now, original, seed: {} }, backupDirectory);
  return { ...summary, ...prepared, mode: "prepared", databaseChanges: 0,
    next: "Download the private backup and checksum before applying this exact prepared scope. Maintenance is unchanged." };
}

function validateBackup(artifact, db, config) {
  const allowed = Object.keys(registry());
  if (artifact.operation !== OPERATION || Number(artifact.schemaVersion) !== 1 || artifact.database !== db.databaseName
    || JSON.stringify(artifact.config) !== JSON.stringify(config) || Number(artifact.snapshotDigestVersion) !== 2
    || !Array.isArray(artifact.original?.checks) || Object.keys(artifact.original).some(key => !["remove", "checks"].includes(key))
    || Object.keys(artifact.seed || {}).length || Object.keys(artifact.original.remove || {}).sort().join() !== allowed.sort().join()) {
    throw Error("This is not a matching scheduled booking/order cleanup backup for this database and date range.");
  }
}

async function apply({ db, client, config, backupFile, decryptEmail, restore = false, now = new Date() }) {
  const { artifact, backupSha256 } = await recovery.readResetBackup(backupFile);
  validateBackup(artifact, db, config);
  if (!restore && (now - artifact.preparedAt < 0 || now - artifact.preparedAt > 30 * 60000)) throw Error("Prepared cleanup expired. Prepare a fresh backup.");
  const summary = plan(artifact.original, config);
  if (summary.blockers.length) throw Error("This backup contains unresolved dependencies or custody records. No changes made.");
  await requireMaintenance(db); await requireTransactions(db);
  const key = operationKey(config), session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await requireMaintenance(db, session);
      const marker = await db.collection("sitesettings").findOne({ key }, { session });
      if (restore) {
        if (!marker || marker.value.backupSha256 !== backupSha256 || marker.value.restoredAt) throw Error("This backup does not match an active cleanup to restore.");
        for (const [name, rows] of Object.entries(artifact.original.remove)) {
          if (rows.length && await db.collection(name).findOne({ _id: { $in: ids(rows) } }, { session })) throw Error("A recovery record already exists. No existing record was overwritten.");
        }
        for (const [name, rows] of Object.entries(artifact.original.remove)) if (rows.length) await db.collection(name).insertMany(rows, { session });
        await db.collection("sitesettings").updateOne({ key }, { $set: { "value.restoredAt": now } }, { session });
      } else {
        if (marker && !marker.value.restoredAt) throw Error("This date-range cleanup already ran. No later records will be deleted.");
        const current = await snapshot(db, config, session, { decryptEmail });
        if (recovery.digest(current) !== artifact.originalSnapshotHash) throw Error("Selected records or dependencies changed after preparation. No changes made; prepare again.");
        if (plan(current, config).blockers.length) throw Error("Unresolved dependencies or custody block this cleanup.");
        for (const [name, rows] of Object.entries(current.remove)) if (rows.length) {
          const removed = await db.collection(name).deleteMany({ _id: { $in: ids(rows) } }, { session });
          if (removed.deletedCount !== rows.length) throw Error("Cleanup record counts changed; all changes were rolled back.");
        }
        if (marker) await db.collection("sitesettings").deleteOne({ key }, { session });
        await db.collection("sitesettings").insertOne({ key, value: { appliedAt: now, backupSha256, config }, createdAt: now, updatedAt: now }, { session });
      }
      await db.collection("activitylogs").insertOne({ action: restore ? "SCHEDULED_TRANSACTIONS_RESTORED" : "SCHEDULED_TRANSACTIONS_REMOVED",
        actionType: "system", source: "system", actorName: "Owner-authorized scheduled transaction cleanup", outcome: "success", createdAt: now,
        details: { config, backup: path.basename(backupFile), backupSha256, counts: summary.deletionCounts } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } catch (error) {
    error.message += ` Verified recovery backup retained at ${backupFile}.`;
    throw error;
  } finally { await session.endSession(); }
  return { ...summary, mode: restore ? "restored" : "deleted", atomic: true, backup: backupFile, backupSha256,
    maintenanceChanged: false, message: "Only the prepared bookings/orders and their linked records were changed. No seeding or physical stock changes. Allow 30 seconds for report caches, then refresh." };
}

module.exports = { OPERATION, MODEL_NAMES, configuration, operationKey, orderDate, valuesAt, registry, links, selectRecords, snapshot, plan, preview, prepare, apply };
