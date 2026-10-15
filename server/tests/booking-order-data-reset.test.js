"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mongoose = require("mongoose");
const reset = require("../utils/bookingOrderDataReset");
const { COUNT, buildCompletedDemoSeed } = require("../utils/completedBookingDemoSeed");
const { parseArguments } = require("../scripts/reset-booking-order-data");
const { summarizePaymentLedger } = require("../utils/enterpriseRevenue");
const { bookingReportValue } = require("../utils/bookingReportValue");
const now = new Date("2026-10-15T02:00:00Z");
const oid = () => new mongoose.Types.ObjectId();
const clone = value => mongoose.mongo.BSON.EJSON.parse(reset.serialize(value), { relaxed: true });

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") return expected.some(value => matches(row, value));
    if (field === "$and") return expected.every(value => matches(row, value));
    const actual = field.split(".").reduce((value, key) => value?.[key], row);
    const same = (a, b) => String(a) === String(b);
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$exists") return (actual !== undefined) === value;
        if (op === "$ne") return value === null ? actual != null : !same(actual, value);
        if (op === "$in") return value.some(item => same(actual, item));
        if (op === "$nin") return value.every(item => !same(actual, item));
        if (op === "$gte") return actual != null && actual >= value;
        if (op === "$lte") return actual != null && actual <= value;
        if (op === "$gt") return actual != null && actual > value;
        if (op === "$elemMatch") return Array.isArray(actual) && actual.some(item => matches(item, value));
        throw Error(`Unsupported fixture operator: ${op}`);
      });
    }
    return expected === null ? actual == null : same(actual, expected);
  });
}

function fixture() {
  const booking = oid(), order = oid(), payment = oid(), orderReturn = oid(), counterReturn = oid();
  const state = Object.fromEntries([...reset.WORK_COLLECTIONS, ...reset.PARTIAL_COLLECTIONS].map(name => [name, []]));
  Object.assign(state, {
    bookingservices: [{ _id: booking, bookingReference: "OLD-BOOK-0001", status: "completed" }],
    orders: [{ _id: order, orderReference: "OLD-ORDER-0001", status: "pending" }],
    payments: [{ _id: payment, bookingId: oid(), amount: 700000, status: "paid", method: "cash" }], // orphan included
    tools: [{ _id: oid(), quantity: 10, reservedQuantity: 3, checkedOutQuantity: 1 }],
    technicians: [{ _id: oid(), name: "Existing staff", availabilityStatus: "In Progress", active: true }],
    coreservices: [{ _id: oid(), name: "Cleaning", basePrice: 1000, active: true }],
    users: [{ _id: oid(), email: "existing@example.invalid", active: true }],
    sitesettings: [{ _id: oid(), key: "systemConfiguration", value: { maintenance: { enabled: true } } }],
    productreturns: [{ _id: orderReturn, sourceType: "order", sourceId: order }, { _id: counterReturn, sourceType: "walk_in", sourceId: oid() }],
    productrefunds: [{ _id: oid(), sourceType: "order", returnId: orderReturn }, { _id: oid(), sourceType: "walk_in", returnId: counterReturn }],
    productreturnmovements: [{ _id: oid(), sourceType: "order", returnId: orderReturn }, { _id: oid(), sourceType: "walk_in", returnId: counterReturn }],
    expenses: [{ _id: oid(), bookingId: oid(), amount: 100 }, { _id: oid(), source: "admin", amount: 200 }],
    ratings: [{ _id: oid(), targetType: "booking", targetId: booking }, { _id: oid(), targetType: "order", targetId: order }, { _id: oid(), targetType: "technician", score: 5 }],
    notifications: [{ _id: oid(), type: "booking_completed", referenceId: booking }, { _id: oid(), type: "leave_approved" }],
    emailoutboxes: [{ _id: oid(), source: "application", status: "pending", text: "Your appointment OLD-BOOK-0001 was booked" }, { _id: oid(), source: "login_otp", status: "pending" }],
    walkinsales: [{ _id: oid(), total: 1100 }], payrolls: [{ _id: oid(), netPay: 9000 }],
    stockadjustments: [{ _id: oid(), referenceId: booking, quantity: -2 }], activitylogs: [{ _id: oid(), action: "OLD_AUDIT" }],
    hvac_products: [{ _id: oid(), variants: [{ quantity: 20 }] }], inventories: [{ _id: oid(), quantity: 30 }],
  });
  let writes = 0, transactions = 0, failCollection, replicaSet = true;
  const db = {
    databaseName: "isolated-reset-fixture",
    admin: () => ({ command: async () => replicaSet ? { setName: "fixture" } : {} }),
    collection(name) {
      const rows = () => state[name] || [];
      const write = () => { writes++; if (name === failCollection) throw Error("Simulated write failure"); };
      return {
        find(filter) {
          let maximum = Infinity;
          return { sort() { return this; }, limit(value) { maximum = value; return this; }, maxTimeMS() { return this; },
            toArray: async () => clone(rows().filter(row => matches(row, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, maximum)) };
        },
        findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
        deleteMany: async filter => { write(); const count = rows().filter(row => matches(row, filter)).length; state[name] = rows().filter(row => !matches(row, filter)); return { deletedCount: count }; },
        deleteOne: async filter => { write(); const index = rows().findIndex(row => matches(row, filter)); if (index >= 0) state[name].splice(index, 1); return { deletedCount: index >= 0 ? 1 : 0 }; },
        insertMany: async documents => { write(); state[name] = [...rows(), ...clone(documents)]; },
        insertOne: async document => { write(); state[name] = [...rows(), { _id: oid(), ...clone(document) }]; },
        updateOne: async (filter, update) => { write(); const row = rows().find(row => matches(row, filter)); if (row) Object.assign(row, clone(update.$set)); return { matchedCount: row ? 1 : 0 }; },
        replaceOne: async (filter, replacement) => { write(); const index = rows().findIndex(row => matches(row, filter)); if (index >= 0) state[name][index] = clone(replacement); },
      };
    },
  };
  const client = { startSession: () => ({
    async withTransaction(callback, options) {
      assert.equal(options.writeConcern.w, "majority"); transactions++;
      const before = clone(state);
      try { await callback(); } catch (error) { Object.keys(state).forEach(key => delete state[key]); Object.assign(state, before); throw error; }
    }, async endSession() {},
  }) };
  const decryptEmail = row => ({ text: row.text || "Unrelated mail" });
  return { db, client, state, decryptEmail, get writes() { return writes; }, get transactions() { return transactions; },
    failOn(name) { failCollection = name; }, standalone() { replicaSet = false; } };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "racs-reset-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("racs-reset-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
async function prepare(t, f) { return reset.prepareReset({ ...f, backupDirectory: temporaryDirectory(t), now }); }

test("reset CLI is read-only by default and rejects ambiguous destructive modes", () => {
  assert.deepEqual(parseArguments([]), { mode: "preview", backupFile: undefined });
  for (const args of [["--apply"], ["--restore"], ["--prepare", "--apply"], ["--aply"], ["--backup", "a.ejson"]]) assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(["--apply", "--backup", "backup.ejson"]), { mode: "apply", backupFile: "backup.ejson" });
  assert.deepEqual(parseArguments(["--delete-only"]), { mode: "delete-only", backupFile: undefined });
  for (const args of [["--delete-only", "--apply"], ["--delete-only", "--prepare"], ["--delete-only", "--restore"], ["--delete-only", "--backup", "old.ejson.gz"]]) assert.throws(() => parseArguments(args));
});

test("deletion-only reset backs up linked data, creates no demo identities and reopens the site atomically", async t => {
  const f = fixture(), directory = temporaryDirectory(t);
  // Removing records does not require a priced service or free demo IDs.
  f.state.coreservices = [];
  f.state.users.push({ _id: require("../utils/completedBookingDemoSeed").demoId("customer-0"), email: "preserve@example.invalid", active: true });
  f.state.sitesettings[0].value.application = { allowCustomerRegistrations: false };
  f.state.sitesettings[0].value.notifications = { criticalEmailAlerts: true };
  const original = clone(f.state);
  const result = await reset.deleteOnlyReset({ ...f, backupDirectory: directory, now });
  assert.equal(result.mode, "deleted"); assert.equal(result.atomic, true); assert.equal(result.recoveryVerified, true);
  assert.equal(f.transactions, 1); assert.equal(result.maintenanceEnabled, false);
  assert.equal(result.remainingBookings, 0); assert.equal(result.remainingOrders, 0);
  for (const name of reset.WORK_COLLECTIONS) assert.equal(f.state[name].length, 0, name);
  assert.equal(Number(result.seed.completedServiceBookings), 0); assert.equal(Number(result.seed.disabledDemoCustomers), 0); assert.equal(Number(result.seed.inactiveDemoTechnicians), 0);
  assert.deepEqual(f.state.users, original.users);
  assert.equal(f.state.technicians.length, original.technicians.length);
  for (const name of ["walkinsales", "payrolls", "stockadjustments", "hvac_products", "inventories", "coreservices"]) assert.deepEqual(f.state[name], original[name], name);
  assert.equal(f.state.tools[0].quantity, original.tools[0].quantity);
  assert.equal(f.state.tools[0].checkedOutQuantity, original.tools[0].checkedOutQuantity);
  assert.equal(f.state.tools[0].reservedQuantity, 0);
  const configuration = f.state.sitesettings.find(row => row.key === "systemConfiguration").value;
  assert.equal(configuration.maintenance.enabled, false);
  assert.deepEqual(configuration.application, original.sitesettings[0].value.application);
  assert.deepEqual(configuration.notifications, original.sitesettings[0].value.notifications);
  assert.equal(f.state.emailoutboxes.length, 1); assert.equal(f.state.emailoutboxes[0].source, "login_otp");
  assert.equal(f.state.expenses.length, 1); assert.equal(f.state.productrefunds.length, 1);
  const marker = f.state.sitesettings.find(row => row.key === reset.RESET_KEY);
  assert.equal(marker.value.resetMode, "delete-only"); assert.equal(marker.value.maintenanceDisabled, true);
  assert.deepEqual(marker.value.seedUserIds, []);
  const log = f.state.activitylogs.find(row => row.action === "BOOKING_ORDER_DATA_RESET");
  assert.equal(log.details.completedDemoBookings, 0); assert.equal(log.details.maintenanceDisabled, true);
  const { artifact } = await reset.readResetBackup(result.backup);
  assert.equal(artifact.resetMode, "delete-only");
  assert.equal(artifact.original.remove.bookingservices.length, 1);
  assert.equal(artifact.original.remove.orders.length, 1);
  assert.ok(Object.values(artifact.seed).every(rows => rows.length === 0));
});

test("deletion-only failure rolls back financial deletions and maintenance reopening together", async t => {
  const f = fixture(), original = clone(f.state), directory = temporaryDirectory(t);
  // The audit write occurs after deletes and the maintenance setting update.
  f.failOn("activitylogs");
  await assert.rejects(reset.deleteOnlyReset({ ...f, backupDirectory: directory, now }), /Simulated write failure.*Verified recovery backup retained/);
  assert.deepEqual(f.state, original); assert.equal(f.transactions, 1);
  const backup = fs.readdirSync(directory).find(name => name.endsWith(".ejson.gz"));
  assert.ok(backup);
  assert.equal((await reset.readResetBackup(path.join(directory, backup))).artifact.resetMode, "delete-only");
});

test("deletion-only mode retains custody, maintenance and replica-set checks", async t => {
  const f = fixture(), directory = temporaryDirectory(t);
  f.state.sitesettings[0].value.maintenance.enabled = false;
  let result = await reset.deleteOnlyReset({ ...f, backupDirectory: directory, now });
  assert.equal(result.mode, "blocked"); assert.equal(f.writes, 0);
  f.state.sitesettings[0].value.maintenance.enabled = true;
  f.state.equipmentassignments.push({ _id: oid(), status: "checked_out" });
  result = await reset.deleteOnlyReset({ ...f, backupDirectory: directory, now });
  assert.equal(result.mode, "blocked"); assert.equal(f.writes, 0);
  assert.ok(result.blockers.some(row => row.code === "return_issued_equipment_or_consumables_first"));
  f.state.equipmentassignments = []; f.standalone();
  await assert.rejects(reset.deleteOnlyReset({ ...f, backupDirectory: directory, now }), /replica set/);
  assert.equal(f.writes, 0); assert.equal(f.state.sitesettings[0].value.maintenance.enabled, true);
});

test("backup failure prevents deletion-only changes and never reopens a partially reset site", async t => {
  const f = fixture(), original = clone(f.state);
  t.mock.method(fs.promises, "rename", async () => { throw Error("Simulated backup failure"); });
  await assert.rejects(reset.deleteOnlyReset({ ...f, backupDirectory: temporaryDirectory(t), now }), /Simulated backup failure/);
  assert.equal(f.writes, 0); assert.equal(f.transactions, 0); assert.deepEqual(f.state, original);
});

test("repeat deletion-only invocation preserves bookings created after the reset", async t => {
  const f = fixture(), directory = temporaryDirectory(t);
  await reset.deleteOnlyReset({ ...f, backupDirectory: directory, now });
  f.state.bookingservices.push({ _id: oid(), bookingReference: "REAL-NEW-BOOKING", status: "pending" });
  const writes = f.writes;
  assert.equal((await reset.deleteOnlyReset({ ...f, backupDirectory: directory, now })).mode, "already-applied");
  assert.equal(f.state.bookingservices.length, 1); assert.equal(f.writes, writes);
});

test("deletion-only recovery permits maintenance toggling but refuses changes to other settings", async t => {
  const f = fixture(), original = clone(f.state);
  const result = await reset.deleteOnlyReset({ ...f, backupDirectory: temporaryDirectory(t), now });
  const settings = f.state.sitesettings.find(row => row.key === "systemConfiguration");
  settings.value.maintenance = { enabled: true, enabledAt: new Date(now.getTime() + 60000), enabledBy: oid(), message: "Recovery" };
  settings.updatedAt = new Date(now.getTime() + 60000);
  settings.value.application = { allowCustomerRegistrations: false };
  await assert.rejects(reset.applyReset({ ...f, backupFile: result.backup, now, restore: true }), /changed after the snapshot/);
  delete f.state.sitesettings.find(row => row.key === "systemConfiguration").value.application;
  assert.equal((await reset.applyReset({ ...f, backupFile: result.backup, now, restore: true })).mode, "restored");
  for (const name of reset.WORK_COLLECTIONS) assert.deepEqual(f.state[name], original[name], name);
  assert.deepEqual(f.state.tools, original.tools); assert.deepEqual(f.state.technicians, original.technicians);
  assert.deepEqual(f.state.users, original.users);
  assert.equal(f.state.sitesettings.find(row => row.key === "systemConfiguration").value.maintenance.enabled, true);
});

test("preview includes orphan transactions and preserves independent counter sales, payroll and reviews", async () => {
  const f = fixture(), plan = reset.buildResetPlan(await reset.snapshotResetData(f.db, undefined, f));
  assert.equal(f.writes, 0);
  assert.equal(plan.deletionCounts.payments, 1);
  for (const name of ["productreturns", "productrefunds", "productreturnmovements", "expenses", "notifications", "emailoutboxes"]) assert.equal(plan.deletionCounts[name], 1, name);
  assert.equal(plan.deletionCounts.ratings, 2);
  assert.equal(plan.physicalQuantityChanges, 0);
  assert.equal(plan.blockers.length, 0);
});

test("reset refuses unresolved custody, pending returns and deducted reservations", async () => {
  const f = fixture();
  f.state.equipmentassignments.push({ _id: oid(), status: "checked_out" });
  f.state.stockreservations.push({ _id: oid(), status: "reserved", stockTreatment: "deducted" });
  f.state.kitreturns.push({ _id: oid(), status: "pending" });
  const result = await reset.prepareReset({ ...f, now });
  assert.equal(result.mode, "blocked"); assert.equal(f.writes, 0);
  assert.ok(result.blockers.some(row => row.code.includes("issued_equipment")));
  assert.ok(result.blockers.some(row => row.code.includes("deducted_reservations")));
});

test("only the five owner-confirmed simulated custody IDs are acknowledged", async () => {
  const f = fixture(), confirmed = reset.TEST_CUSTODY_ACKNOWLEDGEMENT;
  f.state.projectmaterials = confirmed.projectmaterials.map(value => ({ _id: new mongoose.Types.ObjectId(value), status: "reserved", pickedUp: true }));
  f.state.dailykits = confirmed.dailykits.map(value => ({ _id: new mongoose.Types.ObjectId(value), items: [{ quantityIssued: 1, quantityReturned: 0 }] }));
  let plan = reset.buildResetPlan(await reset.snapshotResetData(f.db, undefined, f));
  assert.equal(plan.blockers.length, 0);
  assert.deepEqual(plan.acknowledgedTestCustody.projectmaterials, [...confirmed.projectmaterials]);
  assert.deepEqual(plan.acknowledgedTestCustody.dailykits, [...confirmed.dailykits]);
  assert.equal(plan.acknowledgedTestCustody.stockQuantityChanges, 0);
  const otherMaterial = { _id: oid(), status: "reserved", pickedUp: true };
  const otherKit = { _id: oid(), items: [{ quantityIssued: 1 }] };
  f.state.projectmaterials.push(otherMaterial); f.state.dailykits.push(otherKit);
  // A genuine open custody ledger stays blocked even if a confirmed kit links it.
  f.state.equipmentassignments.push({ _id: oid(), dailyKitId: f.state.dailykits[0]._id, status: "checked_out" });
  plan = reset.buildResetPlan(await reset.snapshotResetData(f.db, undefined, f));
  assert.deepEqual(plan.blockers.find(row => row.code === "resolve_picked_up_project_materials_first").ids, [String(otherMaterial._id)]);
  assert.deepEqual(plan.blockers.find(row => row.code === "resolve_unsettled_daily_kit_items_first").ids, [String(otherKit._id)]);
  assert.equal(plan.blockers.find(row => row.code === "return_issued_equipment_or_consumables_first").count, 1);
  assert.equal(f.writes, 0);
});

test("simulated custody removal keeps stock unchanged and records the acknowledgement in backup and audit", async t => {
  const f = fixture(), confirmed = reset.TEST_CUSTODY_ACKNOWLEDGEMENT;
  f.state.projectmaterials = confirmed.projectmaterials.map(value => ({ _id: new mongoose.Types.ObjectId(value), status: "reserved", pickedUp: true }));
  f.state.dailykits = confirmed.dailykits.map(value => ({ _id: new mongoose.Types.ObjectId(value), items: [{ quantityIssued: 2, quantityReturned: 0 }] }));
  const physical = f.state.tools[0].quantity, checkedOut = f.state.tools[0].checkedOutQuantity;
  const prepared = await prepare(t, f);
  assert.equal((await reset.readResetBackup(prepared.backup)).artifact.acknowledgedTestCustody.dailykits.length, 3);
  const result = await reset.applyReset({ ...f, backupFile: prepared.backup, now });
  assert.equal(result.mode, "reset-and-seeded");
  assert.equal(f.state.tools[0].quantity, physical); assert.equal(f.state.tools[0].checkedOutQuantity, checkedOut);
  assert.equal(f.state.projectmaterials.length, 0); assert.equal(f.state.dailykits.length, 0);
  const log = f.state.activitylogs.find(row => row.action === "BOOKING_ORDER_DATA_RESET");
  assert.equal(log.details.acknowledgedTestCustody.projectmaterials.length, 2);
  assert.match(log.details.acknowledgedTestCustody.reason, /nothing was physically taken/);
});

test("preparing writes only a private checksummed recovery file", async t => {
  const f = fixture(), result = await prepare(t, f);
  assert.equal(result.mode, "prepared"); assert.equal(f.writes, 0);
  const { artifact, backupSha256 } = await reset.readResetBackup(result.backup);
  assert.equal(backupSha256, result.backupSha256);
  assert.equal(artifact.original.remove.payments.length, 1);
  assert.equal(artifact.seed.bookingservices.length, COUNT);
  assert.ok(artifact.original.tools[0]._id instanceof mongoose.Types.ObjectId);
  await assert.rejects(reset.writeResetBackup(artifact, path.resolve(__dirname, "../public/reset-backup")), /public\/upload/);
});

test("completed demo bookings have consistent paid ledgers, costs, historical dates and disabled identities", async () => {
  const seed = await buildCompletedDemoSeed({ services: [{ _id: oid(), name: "Cleaning", basePrice: 1000 }], now });
  assert.equal(seed.bookingservices.length, 24);
  assert.ok(seed.users.every(row => row.active === false && row.blocked && !row.emailVerified && row.email.endsWith("@example.invalid")));
  assert.ok(seed.technicians.every(row => row.active === false && !row.user));
  const approved = seed.bookingservices.reduce((sum, row) => sum + bookingReportValue(row), 0);
  assert.equal(approved, summarizePaymentLedger(seed.payments).grossCollections);
  assert.equal(seed.servicereports.reduce((sum, row) => sum + row.actualLaborCost, 0), approved * 0.25);
  for (const row of seed.bookingservices) {
    assert.equal(row.status, "completed"); assert.equal(row.isProject, false);
    assert.ok(row.createdAt < row.completedAt && row.completedAt < now);
    const payment = seed.payments.find(payment => String(payment.bookingId) === String(row._id));
    assert.equal(payment.amount, row.totalPrice); assert.equal(row.amountPaid, row.totalPrice); assert.equal(row.balanceAmount, 0);
    assert.ok(seed.assignments.some(assignment => String(assignment.bookingId) === String(row._id) && assignment.status === "completed"));
  }
});

test("apply atomically resets linked records, seeds only completed service work and preserves physical stock", async t => {
  const f = fixture(), original = clone(f.state), prepared = await prepare(t, f);
  const result = await reset.applyReset({ ...f, backupFile: prepared.backup, now });
  assert.equal(result.mode, "reset-and-seeded"); assert.equal(f.transactions, 1);
  assert.equal(f.state.bookingservices.length, 24); assert.equal(f.state.orders.length, 0); assert.equal(f.state.payments.length, 24);
  assert.ok(f.state.bookingservices.every(row => row.status === "completed" && row.customer.name.startsWith("Demo")));
  assert.equal(f.state.tools[0].quantity, original.tools[0].quantity);
  assert.equal(f.state.tools[0].checkedOutQuantity, original.tools[0].checkedOutQuantity);
  assert.equal(f.state.tools[0].reservedQuantity, 0);
  for (const name of ["walkinsales", "payrolls", "stockadjustments", "hvac_products", "inventories"]) assert.deepEqual(f.state[name], original[name], name);
  assert.equal(f.state.expenses.length, 1); assert.equal(f.state.productrefunds.length, 1);
  assert.equal(f.state.users[0].email, original.users[0].email);
  assert.equal(f.state.emailoutboxes.length, 1); assert.equal(f.state.emailoutboxes[0].source, "login_otp");
  assert.equal(f.state.activitylogs[0].action, "OLD_AUDIT"); assert.equal(f.state.activitylogs.length, 2);
});

test("a changed snapshot, corrupt backup or standalone server prevents any destructive write", async t => {
  const f = fixture(), prepared = await prepare(t, f);
  f.state.orders.push({ _id: oid(), status: "pending" });
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now }), /changed after the snapshot/);
  assert.equal(f.writes, 0);
  f.state.orders.pop(); f.standalone();
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now }), /replica set/);
  assert.equal(f.writes, 0);
  fs.appendFileSync(prepared.backup, " ");
  await assert.rejects(reset.readResetBackup(prepared.backup), /checksum/);
});

test("write failures roll the deletion and seed back together", async t => {
  const f = fixture(), prepared = await prepare(t, f), original = clone(f.state);
  f.failOn("servicereports");
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now }), /Simulated write failure/);
  assert.deepEqual(f.state, original);
});

test("repeat runs preserve new real bookings rather than wiping again", async t => {
  const f = fixture(), prepared = await prepare(t, f);
  await reset.applyReset({ ...f, backupFile: prepared.backup, now });
  const fresh = { _id: oid(), status: "pending", bookingReference: "NEW-REAL-BOOKING" };
  f.state.bookingservices.push(fresh);
  const writes = f.writes;
  assert.equal((await reset.applyReset({ ...f, backupFile: prepared.backup, now })).mode, "already-applied");
  assert.equal((await reset.prepareReset({ ...f, now })).mode, "already-applied");
  assert.equal(f.writes, writes); assert.ok(f.state.bookingservices.includes(fresh));
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now, restore: true }), /changed after the snapshot/);
});

test("unchanged reset can be restored exactly while retaining its audit trail", async t => {
  const f = fixture(), original = clone(f.state), prepared = await prepare(t, f);
  await reset.applyReset({ ...f, backupFile: prepared.backup, now });
  const result = await reset.applyReset({ ...f, backupFile: prepared.backup, now, restore: true });
  assert.equal(result.mode, "restored");
  for (const name of ["bookingservices", "orders", "payments", "tools", "technicians", "users", "expenses", "productrefunds", "emailoutboxes"]) {
    const byId = rows => [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    assert.deepEqual(byId(f.state[name]), byId(original[name]), name);
  }
  assert.equal(f.state.activitylogs.length, 3);
  assert.ok(!f.state.sitesettings.some(row => row.key === reset.RESET_KEY));
});

test("admin recovery downloads require authentication and reject traversal and other files", async t => {
  const express = require("express"), pageAuth = require("../middleware/pageAuth");
  const { createResetBackupDownload } = require("../utils/bookingOrderResetBackupDownload");
  const f = fixture(), prepared = await prepare(t, f);
  const app = express();
  app.use((req, res, next) => {
    const role = req.get("x-fixture-role");
    req.authResolved = true;
    req.user = role ? { _id: "fixture-admin", role, active: true, emailVerified: true } : null;
    next();
  });
  app.get("/admin/maintenance/data-reset-backups/:filename", pageAuth.requireRole("admin"), createResetBackupDownload({ directory: path.dirname(prepared.backup) }));
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = base + prepared.backupDownloadPath;
  for (const role of [undefined, "customer", "secretary", "technician"]) {
    const response = await fetch(resource, { headers: role ? { "x-fixture-role": role } : {}, redirect: "manual" });
    assert.equal(response.status, 302, String(role));
    assert.ok(!response.headers.get("content-disposition"));
  }
  const headers = { "x-fixture-role": "admin" };
  const response = await fetch(resource, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(require("node:crypto").createHash("sha256").update(downloaded).digest("hex"), prepared.backupSha256);
  const checksum = await fetch(base + prepared.checksumDownloadPath, { headers });
  assert.equal(checksum.status, 200); assert.equal((await checksum.text()).trim(), prepared.backupSha256);
  for (const filename of [".env", "..%2f.env", "other.ejson", "booking-order-reset-1792029253030-00000000.ejson"]) {
    const result = await fetch(`${base}/admin/maintenance/data-reset-backups/${filename}`, { headers });
    assert.equal(result.status, 404, filename);
    assert.doesNotMatch(await result.text(), /payloadCiphertext|passwordHash|MONGODB_URI/);
  }
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  assert.match(pages, /"\/admin\/maintenance\/data-reset-backups\/:filename",\s*pageAuth\.requireRole\("admin"\)/);
});

test("recovery download rejects symbolic links even for an administrator", async t => {
  const { createResetBackupDownload } = require("../utils/bookingOrderResetBackupDownload");
  t.mock.method(fs.promises, "lstat", async () => ({ isFile: () => true, isSymbolicLink: () => true }));
  let status;
  const res = { set() {}, status(value) { status = value; return this; }, json() {}, download() { assert.fail("A symlink must not be served"); } };
  await createResetBackupDownload()({ user: { role: "admin" }, params: { filename: "booking-order-reset-1792029253030-00000000.ejson" } }, res);
  assert.equal(status, 404);
});

test("demo data reconciles in the real revenue and saved service cost engines", async t => {
  const seed = await buildCompletedDemoSeed({ services: [{ _id: oid(), name: "Cleaning", basePrice: 1000 }], now });
  const names = {
    BookingService: "bookingservices", Assignment: "assignments", Payment: "payments", Technician: "technicians", ServiceReport: "servicereports",
  };
  for (const name of ["BookingService", "Order", "Payment", "ProductRefund", "Technician", "WalkInSale", "Inventory", "HVACProduct", "Tool", "Expense", "Payroll", "ProjectMaterial", "ServiceToolUsage", "Project", "WorkOrder", "DailyAssignment", "ServiceReport", "EquipmentAssignment"]) {
    t.mock.method(require("../models/" + name), "find", (filter = {}) => {
      const result = (seed[names[name]] || []).filter(row => matches(row, filter));
      return { select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => result };
    });
  }
  const cache = require("../utils/reportCache");
  cache.clear("revenue-analytics"); t.after(() => cache.clear("revenue-analytics"));
  const { analytics } = await require("../utils/revenueAnalytics").buildRevenueAnalytics({ from: "2026-08-01", to: "2026-10-15" });
  assert.equal(analytics.recognizedGrossRevenue, 48000);
  assert.equal(analytics.netCollections, 48000);
  assert.equal(analytics.outstandingValue, 0);
  assert.equal(analytics.collectionRate, 100);
  assert.equal(analytics.totalPartsCost, 12000);
  assert.equal(analytics.operatingProfit, 36000);
  assert.equal(analytics.reconciliation.unmatchedPaymentRecords, 0);
  assert.equal(analytics.activity.completed.length, 24);
});

test("maintenance, expired preparations and edited demo identities are guarded", async t => {
  const f = fixture();
  f.state.sitesettings[0].value.maintenance.enabled = false;
  assert.equal((await reset.prepareReset({ ...f, now })).mode, "blocked"); assert.equal(f.writes, 0);
  f.state.sitesettings[0].value.maintenance.enabled = true;
  const prepared = await prepare(t, f);
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now: new Date(now.getTime() + 31 * 60000) }), /expired/);
  assert.equal(f.writes, 0);
  await reset.applyReset({ ...f, backupFile: prepared.backup, now });
  f.state.users.find(row => row.email.endsWith("@example.invalid") && row.blocked).active = true;
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now, restore: true }), /changed after the snapshot/);
});

test("compressed recovery round-trips more than 64 MiB of original evidence without omitting BSON types", async t => {
  const evidence = "x".repeat(8 * 1024 * 1024);
  const original = { remove: { bookingservices: Array.from({ length: 9 }, (_, index) => ({ _id: oid(), createdAt: now, quantity: index + 1, proofPhoto: evidence })) }, tools: [], technicians: [], services: [], settings: [], demoUsers: [], emailBlockers: [] };
  const artifact = { schemaVersion: 1, operation: reset.RESET_KEY, database: "isolated-reset-fixture", preparedAt: now, original, seed: { users: [] } };
  const prepared = await reset.writeResetBackup(artifact, temporaryDirectory(t));
  assert.ok(prepared.expandedBytes > 64 * 1024 * 1024);
  assert.ok(prepared.compressedBytes < 1024 * 1024);
  assert.equal(prepared.recoveryVerified, true);
  assert.match(prepared.backup, /\.ejson\.gz$/);
  const thin = (await reset.readResetBackup(prepared.backup, { omitOriginal: true })).artifact;
  assert.equal(thin.original, undefined);
  assert.equal(thin.originalSnapshotHash, reset.digest(original));
  const recovered = (await reset.readResetBackup(prepared.backup)).artifact.original;
  assert.equal(recovered.remove.bookingservices.length, 9);
  assert.equal(recovered.remove.bookingservices[8].proofPhoto, evidence);
  assert.ok(recovered.remove.bookingservices[0]._id instanceof mongoose.Types.ObjectId);
  assert.equal(recovered.remove.bookingservices[0].createdAt.toISOString(), now.toISOString());
  assert.equal(Number(recovered.remove.bookingservices[8].quantity), 9);
});

test("new reset application reads verified metadata without retaining another full source snapshot", async t => {
  const f = fixture(), prepared = await prepare(t, f);
  const recovery = require("../utils/resetRecoveryBackup"), read = recovery.readResetBackup;
  let originalOmitted = false;
  t.mock.method(recovery, "readResetBackup", async (file, options) => {
    const result = await read(file, options);
    originalOmitted = options.omitOriginal === true && result.artifact.original === undefined;
    return result;
  });
  assert.equal((await reset.applyReset({ ...f, backupFile: prepared.backup, now })).mode, "reset-and-seeded");
  assert.equal(originalOmitted, true);
});

test("corrupt or truncated compressed recovery is refused before database mutation", async t => {
  const f = fixture(), prepared = await prepare(t, f), zlib = require("node:zlib"), crypto = require("node:crypto");
  const originalBytes = fs.readFileSync(prepared.backup);
  function replace(bytes) {
    fs.writeFileSync(prepared.backup, bytes);
    fs.writeFileSync(prepared.backup + ".sha256", crypto.createHash("sha256").update(bytes).digest("hex") + "\n");
  }
  replace(originalBytes.subarray(0, originalBytes.length - 8));
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now }));
  assert.equal(f.writes, 0);
  const lines = zlib.gunzipSync(originalBytes).toString("utf8").trimEnd().split("\n");
  const index = lines.findIndex(line => line.includes("OLD-BOOK-0001"));
  lines[index] = lines[index].replace("OLD-BOOK-0001", "ALTERED-000001");
  replace(zlib.gzipSync(lines.join("\n") + "\n"));
  await assert.rejects(reset.applyReset({ ...f, backupFile: prepared.backup, now }), /snapshot verification/);
  assert.equal(f.writes, 0);
});

test("legacy uncompressed recovery files can still apply and restore", async t => {
  const f = fixture(), prepared = await prepare(t, f), crypto = require("node:crypto");
  const { artifact } = await reset.readResetBackup(prepared.backup);
  delete artifact.snapshotDigestVersion; delete artifact.originalSnapshotHash;
  const file = prepared.backup.replace(/\.gz$/, ""), bytes = reset.serialize(artifact);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(file + ".sha256", crypto.createHash("sha256").update(bytes).digest("hex") + "\n");
  assert.equal((await reset.applyReset({ ...f, backupFile: file, now })).mode, "reset-and-seeded");
  assert.equal((await reset.applyReset({ ...f, backupFile: file, now, restore: true })).mode, "restored");
  assert.equal(f.state.bookingservices.length, 1);
  assert.equal(f.state.orders.length, 1);
});

test("failed recovery publication removes only files created by that attempt", async t => {
  const f = fixture(), directory = temporaryDirectory(t);
  const artifact = { schemaVersion: 1, operation: reset.RESET_KEY, database: f.db.databaseName, preparedAt: now,
    original: await reset.snapshotResetData(f.db, undefined, f), seed: { users: [] } };
  fs.writeFileSync(path.join(directory, "keep-private-backup.txt"), "Existing recovery material");
  t.mock.method(fs.promises, "rename", async () => { throw Object.assign(Error("Simulated disk failure"), { code: "EIO" }); });
  await assert.rejects(reset.writeResetBackup(artifact, directory), /Simulated disk failure/);
  assert.deepEqual(fs.readdirSync(directory), ["keep-private-backup.txt"]);
  assert.equal(f.writes, 0);
});
