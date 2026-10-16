"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mongoose = require("mongoose");
const cleanup = require("../utils/scheduledTransactionCleanup");
const recovery = require("../utils/resetRecoveryBackup");
const { parseArguments } = require("../scripts/clear-scheduled-bookings-orders");
const config = cleanup.configuration("2026-10-15", "2026-10-20");
const now = new Date("2026-10-17T03:00:00Z");
const oid = () => new mongoose.Types.ObjectId();
const clone = value => mongoose.mongo.BSON.EJSON.parse(recovery.serialize(value), { relaxed: true });

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = field.split(".").reduce((value, key) => value?.[key], row);
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$in") return value.some(item => String(item) === String(actual));
        throw Error("Unsupported fixture operator " + operator);
      });
    }
    return String(actual) === String(expected);
  });
}

function fixture() {
  const state = Object.fromEntries(Object.keys(cleanup.registry()).map(name => [name, []]));
  const booking = { _id: oid(), bookingDate: new Date("2026-10-14T16:00:00Z"), bookingReference: "BOOKING-FIXTURE-15", status: "completed", createdAt: new Date("2026-09-01") };
  const outside = { _id: oid(), bookingDate: new Date("2026-10-20T16:00:00Z"), bookingReference: "BOOKING-FIXTURE-21", status: "confirmed", createdAt: now };
  const order = { _id: oid(), fulfillmentType: "delivery_installation", delivery: { preferredDate: new Date("2026-10-20T15:59:59.999Z") }, orderReference: "ORDER-FIXTURE-20", status: "completed" };
  const mirror = { _id: oid(), sourceOrderId: order._id, bookingDate: new Date("2026-10-22"), bookingReference: "INSTALLATION-FIXTURE", status: "completed" };
  order.bookingId = mirror._id;
  const otherOrder = { _id: oid(), fulfillmentType: "delivery_installation", delivery: { preferredDate: new Date("2026-10-14T15:59:59.999Z") }, status: "paid" };
  const assignment = { _id: oid(), bookingId: booking._id, status: "completed" };
  const payment = { _id: oid(), bookingId: booking._id, amount: 3000, status: "paid", privateEvidence: "PRIVATE-PAYMENT-EVIDENCE" };
  Object.assign(state, {
    bookingservices: [booking, outside, mirror], orders: [order, otherOrder], assignments: [assignment],
    payments: [payment, { _id: oid(), orderId: order._id, amount: 25000, status: "paid" }, { _id: oid(), bookingId: outside._id, amount: 50, status: "pending" }],
    servicereports: [{ _id: oid(), bookingId: booking._id, assignmentId: assignment._id }],
    dailykits: [{ _id: oid(), bookingIds: [booking._id], assignmentIds: [assignment._id], items: [] }],
    customerassets: [{ _id: oid(), originType: "booking", originId: booking._id, serviceHistory: [{ bookingId: booking._id }] }],
    ratings: [{ _id: oid(), targetType: "booking", targetId: booking._id, score: 5 }],
    notifications: [
      { _id: oid(), referenceModel: "BookingService", referenceId: booking._id, type: "booking_completed" },
      { _id: oid(), link: "/admin/appointments/" + order._id, type: "order_completed" },
      { _id: oid(), referenceModel: "BookingService", referenceId: outside._id, type: "booking_confirmed" },
      { _id: oid(), referenceModel: "User", referenceId: booking._id, type: "account_alert" },
    ],
    emailoutboxes: [
      { _id: oid(), source: "booking_confirmation", status: "pending", text: booking.bookingReference },
      { _id: oid(), source: "booking_confirmation", status: "pending", text: outside.bookingReference },
      { _id: oid(), source: "login_otp", status: "pending", text: "PRIVATE-OTP" },
    ],
    expenses: [{ _id: oid(), bookingId: booking._id, amount: 100 }, { _id: oid(), amount: 200 }],
    users: [{ _id: oid(), email: "preserved@example.test" }], technicians: [{ _id: oid(), active: true }],
    tools: [{ _id: oid(), quantity: 100, reservedQuantity: 5, checkedOutQuantity: 2 }], inventories: [{ _id: oid(), quantity: 10 }],
    payrolls: [{ _id: oid(), status: "paid", grossPay: 900 }], walkinsales: [{ _id: oid(), totalAmount: 1100 }],
    stockadjustments: [{ _id: oid(), referenceBookingId: booking._id, quantityChange: -1 }],
    sitesettings: [{ _id: oid(), key: "systemConfiguration", value: { maintenance: { enabled: true }, other: "unchanged" } }],
    activitylogs: [{ _id: oid(), action: "PREVIOUS_AUDIT" }],
  });
  let writes = 0, transactions = 0, failedCollection, replicaSet = true;
  const db = {
    databaseName: "isolated-scheduled-cleanup-fixture",
    admin: () => ({ command: async () => replicaSet ? { setName: "fixture" } : {} }),
    collection(name) {
      const rows = () => state[name] || [];
      const write = () => { writes++; if (failedCollection === name) throw Error("Simulated storage failure"); };
      return {
        find(filter = {}) { let maximum = Infinity; return { sort() { return this; }, limit(value) { maximum = value; return this; }, maxTimeMS() { return this; },
          toArray: async () => clone(rows().filter(row => matches(row, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, maximum)) }; },
        findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
        deleteMany: async filter => { write(); const deletedCount = rows().filter(row => matches(row, filter)).length;
          state[name] = rows().filter(row => !matches(row, filter)); return { deletedCount }; },
        deleteOne: async filter => { write(); const index = rows().findIndex(row => matches(row, filter)); if (index >= 0) state[name].splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 }; },
        insertOne: async row => { write(); state[name] = [...rows(), { _id: oid(), ...clone(row) }]; },
        insertMany: async docs => { write(); state[name] = [...rows(), ...clone(docs)]; },
        updateOne: async (filter, update) => {
          write(); const row = rows().find(row => matches(row, filter));
          if (row) for (const [field, value] of Object.entries(update.$set)) {
            const parts = field.split("."), key = parts.pop();
            parts.reduce((target, part) => target[part], row)[key] = clone(value);
          }
          return { matchedCount: row ? 1 : 0 };
        },
      };
    },
  };
  const client = { startSession: () => ({
    async withTransaction(callback, options) {
      assert.equal(options.readConcern.level, "snapshot"); assert.equal(options.writeConcern.w, "majority");
      transactions++; const before = clone(state);
      try { await callback(); } catch (error) {
        Object.keys(state).forEach(key => delete state[key]); Object.assign(state, before); throw error;
      }
    }, async endSession() {},
  }) };
  const decryptEmail = async row => { if (row.unreadable) throw Error("Encrypted payload unavailable"); return { text: row.text }; };
  return { db, client, state, booking, outside, order, mirror, otherOrder, config, decryptEmail, now,
    get writes() { return writes; }, get transactions() { return transactions; }, failOn(name) { failedCollection = name; }, standalone() { replicaSet = false; } };
}

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "racs-scheduled-cleanup-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("racs-scheduled-cleanup-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const prepare = (t, f) => cleanup.prepare({ ...f, backupDirectory: directory(t) });
const apply = (f, backup, extra = {}) => cleanup.apply({ ...f, backupFile: backup.backup, ...extra });

test("date cleanup CLI requires explicit valid dates and a backup for destructive modes", () => {
  const args = ["--from", config.from, "--to", config.to];
  assert.deepEqual(parseArguments(args), { mode: "preview", config, backupFile: undefined });
  assert.equal(parseArguments([...args, "--apply", "--backup", "private.ejson.gz"]).mode, "apply");
  for (const tail of [["--apply"], ["--restore"], ["--apply", "--prepare"], ["--backup", "x"], ["--from", config.from], ["--all"]]) assert.throws(() => parseArguments([...args, ...tail]));
  for (const [from, to] of [["2026-02-30", config.to], [config.to, config.from], ["2026-09-01", config.to], ["2026-10-15T00:00:00Z", config.to]]) assert.throws(() => cleanup.configuration(from, to));
  assert.throws(() => parseArguments([]));
});

test("read-only preview uses Philippine schedule dates, includes linked installation, and emits no evidence", async () => {
  const f = fixture();
  const result = await cleanup.preview(f);
  assert.equal(result.scheduledBookings, 1);
  assert.equal(result.linkedInstallationBookings, 1);
  assert.equal(result.deletionCounts.bookingservices, 2);
  assert.equal(result.deletionCounts.orders, 1);
  assert.equal(result.deletionCounts.payments, 2);
  assert.equal(result.deletionCounts.notifications, 2);
  assert.equal(result.deletionCounts.emailoutboxes, 1);
  assert.equal(result.deletionCounts.expenses, 1);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.paymentsByStatus, { paid: { count: 2, amount: 28000 } });
  assert.equal(f.writes, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|fixture@example|privateEvidence/);
});

test("selection includes both endpoints and excludes the immediately adjacent dates", async () => {
  const f = fixture();
  f.state.bookingservices.push({ _id: oid(), bookingDate: new Date("2026-10-14T15:59:59.999Z") },
    { _id: oid(), bookingDate: new Date("2026-10-20T15:59:59.999Z") });
  const result = await cleanup.preview(f);
  assert.equal(result.scheduledBookings, 2);
  assert.equal(result.deletionCounts.bookingservices, 3);
});

test("customer pickup uses pickupDate and ignores an unrelated delivery date", async () => {
  const f = fixture();
  f.state.orders.push({ _id: oid(), fulfillmentType: "customer_pickup", pickupDate: new Date("2026-10-19"), delivery: { preferredDate: new Date("2026-11-01") } },
    { _id: oid(), fulfillmentType: "customer_pickup", pickupDate: new Date("2026-11-01"), delivery: { preferredDate: new Date("2026-10-19") } });
  assert.equal((await cleanup.preview(f)).deletionCounts.orders, 2);
});

test("all completed, cancelled and unfinished transactions in range are included", async () => {
  const f = fixture();
  for (const status of ["cancelled", "pending", "in-progress"]) f.state.bookingservices.push({ _id: oid(), bookingDate: new Date("2026-10-17"), status });
  assert.equal((await cleanup.preview(f)).scheduledBookings, 4);
});

test("shared daily kits block deletion instead of selecting an outside-range booking", async t => {
  const f = fixture(); f.state.dailykits[0].bookingIds.push(f.outside._id);
  const result = await prepare(t, f);
  assert.equal(result.mode, "blocked");
  assert.ok(result.blockers.some(row => row.code === "shared_or_outside_range_transaction" && row.collection === "dailykits"));
  assert.equal(result.deletionCounts.bookingservices, 2);
  assert.equal(f.writes, 0);
});

test("outside-range booking pointing to a selected assignment is reported as a shared dependency", async () => {
  const f = fixture(); f.outside.assignmentId = f.state.assignments[0]._id;
  const result = await cleanup.preview(f);
  assert.ok(result.blockers.some(row => row.collection === "bookingservices" && row.fields.includes("assignmentId")));
});

test("order mirror pointing to an outside-range order blocks deleting that parent order", async () => {
  const f = fixture(); f.state.bookingservices.push({ _id: oid(), bookingDate: new Date("2026-10-16"), sourceOrderId: f.otherOrder._id });
  const result = await cleanup.preview(f);
  assert.ok(result.blockers.some(row => row.collection === "bookingservices" && row.fields.includes("sourceOrderId")));
  assert.equal(result.deletionCounts.orders, 1);
});

test("child records linked through projects, work orders and typed origins are collected transitively", async () => {
  const f = fixture();
  const project = { _id: oid(), bookingId: f.booking._id }, workOrder = { _id: oid(), projectId: null };
  workOrder.projectId = project._id;
  f.state.projects.push(project); f.state.workorders.push(workOrder);
  f.state.dailyassignments.push({ _id: oid(), workOrderId: workOrder._id, projectId: project._id });
  f.state.projectissues.push({ _id: oid(), projectId: project._id });
  f.state.warrantyclaims.push({ _id: oid(), sourceType: "order", sourceId: f.order._id });
  f.state.maintenanceschedules.push({ _id: oid(), assetId: f.state.customerassets[0]._id });
  const result = await cleanup.preview(f);
  for (const name of ["projects", "workorders", "dailyassignments", "projectissues", "warrantyclaims", "maintenanceschedules"]) assert.equal(result.deletionCounts[name], 1, name);
});

test("a parent's payment pointer includes an orphan payment without selecting unrelated orphan rows", async () => {
  const f = fixture(), payment = { _id: oid(), amount: 250, status: "pending" };
  f.order.paymentId = payment._id;
  f.state.payments.push(payment, { _id: oid(), amount: 999, status: "paid" });
  assert.equal((await cleanup.preview(f)).deletionCounts.payments, 3);
});

test("legacy expense order references are included even without a current schema declaration", async () => {
  const f = fixture();
  f.state.expenses.push({ _id: oid(), orderId: f.order._id, amount: 150 });
  assert.equal((await cleanup.preview(f)).deletionCounts.expenses, 2);
});

test("active stock reservations and issued equipment block preparing and never change stock", async t => {
  for (const [name, input, code] of [
    ["equipmentassignments", { bookingId: null, status: "checked_out" }, "settle_or_release_equipment_first"],
    ["stockreservations", { bookingId: null, status: "reserved", stockTreatment: "soft_hold" }, "settle_or_release_stock_reservations_first"],
    ["kitreturns", { bookingIds: [], status: "pending" }, "review_pending_kit_returns_first"],
  ]) {
    const f = fixture(), row = { ...input, _id: oid(), bookingId: f.booking._id };
    if (name === "kitreturns") row.bookingIds = [f.booking._id];
    f.state[name].push(row); const stock = clone(f.state.tools);
    const result = await prepare(t, f);
    assert.equal(result.mode, "blocked"); assert.ok(result.blockers.some(blocker => blocker.code === code));
    assert.equal(f.writes, 0); assert.deepEqual(f.state.tools, stock);
  }
});

test("unsettled daily-kit quantity and orphan issued checkout block cleanup", async t => {
  for (const item of [{ quantityIssued: 2, quantityUsed: 1 }, { checkoutStatus: "checked_out", quantityIssued: 0 }]) {
    const f = fixture(); f.state.dailykits[0].items = [item];
    assert.ok((await prepare(t, f)).blockers.some(row => row.code === "resolve_unsettled_daily_kit_items_first"));
  }
});

test("linked queued messages are deleted but authentication and unrelated messages are preserved", async () => {
  const f = fixture(); f.state.emailoutboxes.push({ _id: oid(), source: "application", status: "pending", text: "prefix" + f.booking.bookingReference + "suffix" });
  assert.equal((await cleanup.preview(f)).deletionCounts.emailoutboxes, 1);
  f.state.emailoutboxes[0].status = "processing";
  assert.ok((await cleanup.preview(f)).blockers.some(row => row.code === "transaction_email_is_processing"));
  f.state.emailoutboxes[0].unreadable = true;
  assert.ok((await cleanup.preview(f)).blockers.some(row => row.code === "queued_email_cannot_be_checked"));
});

test("maintenance is required for preparing while preview works with the site open", async t => {
  const f = fixture(); f.state.sitesettings[0].value.maintenance.enabled = false;
  assert.equal((await cleanup.preview(f)).mode, "dry-run");
  await assert.rejects(prepare(t, f), /Enable Maintenance/); assert.equal(f.writes, 0);
});

test("prepared recovery verifies BSON dates and private evidence before any database write", async t => {
  const f = fixture(), result = await prepare(t, f);
  assert.equal(result.mode, "prepared"); assert.equal(result.recoveryVerified, true); assert.equal(f.writes, 0);
  const { artifact } = await recovery.readResetBackup(result.backup);
  assert.ok(artifact.original.remove.bookingservices[0]._id instanceof mongoose.Types.ObjectId);
  assert.ok(artifact.original.remove.bookingservices[0].bookingDate instanceof Date);
  assert.ok(artifact.original.remove.payments.some(row => row.privateEvidence === "PRIVATE-PAYMENT-EVIDENCE"));
});

test("apply deletes only prepared transactions and related records, retaining stock, staff, outside work and independent finances", async t => {
  const f = fixture(), before = clone(f.state), backup = await prepare(t, f);
  const result = await apply(f, backup);
  assert.equal(result.mode, "deleted"); assert.equal(result.atomic, true); assert.equal(f.transactions, 1);
  assert.deepEqual(f.state.bookingservices, [before.bookingservices[1]]);
  assert.deepEqual(f.state.orders, [before.orders[1]]);
  assert.deepEqual(f.state.payments, [before.payments[2]]);
  assert.deepEqual(f.state.notifications, before.notifications.slice(2));
  assert.deepEqual(f.state.emailoutboxes, before.emailoutboxes.slice(1));
  assert.deepEqual(f.state.expenses, [before.expenses[1]]);
  for (const name of ["users", "technicians", "tools", "inventories", "walkinsales", "payrolls", "stockadjustments"]) assert.deepEqual(f.state[name], before[name], name);
  assert.deepEqual(f.state.sitesettings[0], before.sitesettings[0]);
  assert.equal(f.state.activitylogs[1].action, "SCHEDULED_TRANSACTIONS_REMOVED");
});

test("a repeated range cleanup preserves new transactions created after the first deletion", async t => {
  const f = fixture(), backup = await prepare(t, f);
  await apply(f, backup);
  f.state.bookingservices.push({ _id: oid(), bookingDate: new Date("2026-10-18") });
  const before = clone(f.state), writes = f.writes;
  assert.equal((await cleanup.preview(f)).mode, "already-applied");
  assert.equal((await prepare(t, f)).mode, "already-applied");
  await assert.rejects(apply(f, backup), /already ran/);
  assert.equal(f.writes, writes); assert.deepEqual(f.state, before);
});

test("changed selected records, new selected transactions and new linked payments invalidate preparation", async t => {
  for (const change of [f => { f.booking.status = "cancelled"; }, f => { f.state.bookingservices.push({ _id: oid(), bookingDate: new Date("2026-10-17") }); },
    f => { f.state.payments.push({ _id: oid(), bookingId: f.booking._id, amount: 75 }); }]) {
    const f = fixture(), backup = await prepare(t, f); change(f); const before = clone(f.state);
    await assert.rejects(apply(f, backup), /changed after preparation/);
    assert.deepEqual(f.state, before); assert.equal(f.writes, 0);
  }
});

test("unrelated outside-range updates do not invalidate or expand the prepared deletion", async t => {
  const f = fixture(), backup = await prepare(t, f);
  f.outside.status = "cancelled";
  await apply(f, backup);
  assert.equal(f.state.bookingservices[0].status, "cancelled");
});

test("late audit failure rolls back transaction removal and the marker together", async t => {
  const f = fixture(), backup = await prepare(t, f), before = clone(f.state); f.failOn("activitylogs");
  await assert.rejects(apply(f, backup), /Simulated storage failure/);
  assert.deepEqual(f.state, before);
});

test("expired preparations, mismatched dates, another database, and standalone MongoDB cannot delete data", async t => {
  const f = fixture(), backup = await prepare(t, f), before = clone(f.state);
  await assert.rejects(apply(f, backup, { now: new Date(now.getTime() + 31 * 60000) }), /expired/);
  await assert.rejects(apply(f, backup, { config: cleanup.configuration("2026-10-16", "2026-10-20") }), /matching scheduled/);
  f.db.databaseName = "another-db";
  await assert.rejects(apply(f, backup), /matching scheduled/);
  f.db.databaseName = "isolated-scheduled-cleanup-fixture"; f.standalone();
  await assert.rejects(apply(f, backup), /replica set/);
  assert.deepEqual(f.state, before); assert.equal(f.writes, 0);
});

test("recovery restores exact backed-up records without overwriting surviving work or stock", async t => {
  const f = fixture(), before = clone(f.state), backup = await prepare(t, f);
  await apply(f, backup);
  const result = await apply(f, backup, { restore: true });
  assert.equal(result.mode, "restored"); assert.equal(f.state.activitylogs.length, 3);
  const ordered = rows => rows.map(row => recovery.serialize(row)).sort();
  for (const [name, rows] of Object.entries(before)) if (!["sitesettings", "activitylogs"].includes(name)) assert.deepEqual(ordered(f.state[name]), ordered(rows), name);
});

test("recovery refuses existing IDs and corrupt files instead of overwriting data", async t => {
  const f = fixture(), backup = await prepare(t, f);
  await apply(f, backup); f.state.bookingservices.push(clone(f.booking));
  const before = clone(f.state);
  await assert.rejects(apply(f, backup, { restore: true }), /already exists/);
  fs.appendFileSync(backup.backup, "corrupt");
  await assert.rejects(apply(f, backup, { restore: true }), /checksum/);
  assert.deepEqual(f.state, before);
});
