"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mongoose = require("mongoose");
const recovery = require("../utils/resetRecoveryBackup");
const cleanup = require("../utils/paidPayrollCleanup");
const { parseArguments } = require("../scripts/clear-paid-payroll");
const now = new Date("2026-10-15T02:00:00Z");
const oid = () => new mongoose.Types.ObjectId();
const clone = value => mongoose.mongo.BSON.EJSON.parse(recovery.serialize(value), { relaxed: true });

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") return expected.some(value => matches(row, value));
    if (field === "$and") return expected.every(value => matches(row, value));
    const actual = field.split(".").reduce((value, key) => value?.[key], row);
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$in") return value.some(item => String(actual) === String(item));
        if (op === "$ne") return value === null ? actual != null : String(actual) !== String(value);
        if (op === "$exists") return (actual !== undefined) === value;
        if (op === "$gte") return actual != null && actual >= value;
        if (op === "$lte") return actual != null && actual <= value;
        throw Error("Unsupported fixture operator: " + op);
      });
    }
    return expected === null ? actual == null : String(actual) === String(expected);
  });
}

function fixture() {
  const employee = oid();
  const payrolls = ["paid", "paid", "approved", "draft", "voided"].map((status, index) => ({
    _id: oid(), employee, status, periodStart: new Date(`2026-0${index + 5}-01T00:00:00Z`), periodEnd: new Date(`2026-0${index + 5}-28T00:00:00Z`),
    payDate: now, grossPay: index === 0 ? 3000 : index === 1 ? 3200 : 500, netPay: index === 0 ? 2800 : index === 1 ? 3000 : 450,
    allowances: [{ name: "Transport", amount: 200 }], paymentReference: status === "paid" ? "PRIVATE-REFERENCE" : "",
  }));
  const state = { payrolls, notifications: [
    { _id: oid(), referenceModel: "Payroll", referenceId: payrolls[0]._id, type: "payroll_approved" },
    { _id: oid(), referenceModel: "Payroll", referenceId: payrolls[0]._id, type: "payroll_paid" },
    { _id: oid(), referenceModel: "Payroll", referenceId: payrolls[2]._id, type: "payroll_approved" },
    { _id: oid(), referenceModel: "BookingService", referenceId: payrolls[0]._id, type: "booking_created" },
  ], payments: [], activitylogs: [{ _id: oid(), action: "PREVIOUS_AUDIT" }],
  sitesettings: [{ _id: oid(), key: "systemConfiguration", value: { maintenance: { enabled: false } } }],
  users: [{ _id: employee, active: true }], technicians: [{ _id: oid(), user: employee }],
  employeecompensations: [{ _id: oid(), employee, baseRate: 500 }], technicianattendances: [{ _id: oid(), status: "Present" }],
  secretaryattendances: [{ _id: oid(), status: "Present" }], payrolltemplates: [{ _id: oid(), name: "Transport" }],
  expenses: [{ _id: oid(), amount: 250 }], walkinsales: [{ _id: oid(), status: "completed", totalAmount: 1100, totalCost: 100, createdAt: now, completedAt: now, paymentMethod: "cash", items: [] }],
  };
  let writes = 0, transactions = 0, failCollection, replicaSet = true;
  const db = { databaseName: "isolated-paid-payroll-fixture", admin: () => ({ command: async () => replicaSet ? { setName: "fixture" } : {} }),
    collection(name) {
      const rows = () => state[name] || [];
      const write = () => { writes++; if (name === failCollection) throw Error("Simulated write failure"); };
      return {
        find(filter) { let maximum = Infinity; return { sort() { return this; }, limit(value) { maximum = value; return this; }, maxTimeMS() { return this; },
          toArray: async () => clone(rows().filter(row => matches(row, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, maximum)) }; },
        findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
        insertOne: async row => { write(); state[name] = [...rows(), { _id: oid(), ...clone(row) }]; },
        insertMany: async documents => { write(); state[name] = [...rows(), ...clone(documents)]; },
        deleteMany: async filter => { write(); const deletedCount = rows().filter(row => matches(row, filter)).length; state[name] = rows().filter(row => !matches(row, filter)); return { deletedCount }; },
        updateOne: async (filter, update) => { write(); const row = rows().find(row => matches(row, filter)); if (row) Object.assign(row, clone(update.$set)); return { matchedCount: row ? 1 : 0 }; },
      };
    },
  };
  const client = { startSession: () => ({ async withTransaction(callback, options) {
    assert.equal(options.writeConcern.w, "majority"); transactions++; const before = clone(state);
    try { await callback(); } catch (error) { Object.keys(state).forEach(key => delete state[key]); Object.assign(state, before); throw error; }
  }, async endSession() {} }) };
  return { db, client, state, get writes() { return writes; }, get transactions() { return transactions; },
    failOn(name) { failCollection = name; }, standalone() { replicaSet = false; } };
}

function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "racs-paid-payroll-test-"));
  t.after(() => {
    assert.equal(path.dirname(result), path.resolve(os.tmpdir()));
    assert.ok(path.basename(result).startsWith("racs-paid-payroll-test-"));
    fs.rmSync(result, { recursive: true, force: true });
  });
  return result;
}

test("paid payroll CLI defaults to preview and rejects ambiguous or incomplete mutation flags", () => {
  assert.deepEqual(parseArguments([]), { mode: "preview" });
  assert.deepEqual(parseArguments(["--apply"]), { mode: "apply" });
  assert.deepEqual(parseArguments(["--restore", "--backup", "private.ejson.gz"]), { mode: "restore", backupFile: "private.ejson.gz" });
  for (const args of [["--apply", "--restore"], ["--all"], ["--backup", "private.ejson.gz"], ["--restore"], ["--restore", "--backup", "--apply"]]) assert.throws(() => parseArguments(args));
});

test("preview only reads paid payroll and prints aggregate totals without payroll identity or proof details", async () => {
  const f = fixture(), result = await cleanup.cleanupPaidPayroll({ ...f, now });
  assert.equal(result.mode, "dry-run"); assert.equal(f.writes, 0);
  assert.equal(result.paidPayrollRecords, 2); assert.equal(result.linkedNotifications, 2);
  assert.equal(result.grossPayrollRemovedFromReports, 6200); assert.equal(result.netPaidPayroll, 5800);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-REFERENCE|paymentReference|paymentProof|"(?:employee|payslipNumber)":/);
});

test("paid-only cleanup saves original documents, deletes linked notifications and preserves all other payroll and staff data", async t => {
  const f = fixture(), original = clone(f.state);
  const result = await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) });
  assert.equal(result.mode, "deleted"); assert.equal(result.atomic, true); assert.equal(result.recoveryVerified, true); assert.equal(f.transactions, 1);
  assert.equal(f.state.payrolls.length, 3); assert.ok(f.state.payrolls.every(row => row.status !== "paid"));
  assert.deepEqual(f.state.payrolls, original.payrolls.filter(row => row.status !== "paid"));
  assert.deepEqual(f.state.notifications, original.notifications.slice(2));
  for (const name of ["users", "technicians", "employeecompensations", "technicianattendances", "secretaryattendances", "payrolltemplates", "expenses", "walkinsales", "payments"]) assert.deepEqual(f.state[name], original[name], name);
  assert.deepEqual(f.state.sitesettings.find(row => row.key === "systemConfiguration"), original.sitesettings[0]);
  assert.match(path.basename(result.backup), /^paid-payroll-reset-\d{13}-[a-f0-9]{8}\.ejson\.gz$/);
  const { artifact, backupSha256 } = await recovery.readResetBackup(result.backup);
  assert.equal(backupSha256, result.backupSha256);
  assert.equal(artifact.original.remove.payrolls.length, 2); assert.equal(artifact.original.remove.payrolls[0].status, "paid");
  assert.ok(artifact.original.remove.payrolls[0].periodStart instanceof Date);
  assert.equal(artifact.original.remove.payrolls[0].paymentReference, "PRIVATE-REFERENCE");
  assert.equal(f.state.activitylogs.length, 2); assert.equal(f.state.activitylogs[0].action, "PREVIOUS_AUDIT");
  assert.equal(f.state.activitylogs[1].details.grossPayroll, 6200);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-REFERENCE|paymentReference/);
});

test("paid payroll linked to payment deductions is blocked without deleting or backing up anything", async t => {
  const f = fixture(), backupDirectory = directory(t);
  f.state.payments.push({ _id: oid(), payrollDeductionId: f.state.payrolls[0]._id });
  const result = await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory });
  assert.equal(result.mode, "blocked"); assert.equal(result.blockers[0].code, "linked_payment_deductions_require_review");
  assert.equal(f.writes, 0); assert.deepEqual(fs.readdirSync(backupDirectory), []);
});

test("failed backup or unsupported standalone database prevents any paid payroll mutation", async t => {
  const f = fixture(), original = clone(f.state), backupDirectory = directory(t);
  f.standalone();
  await assert.rejects(cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory }), /replica set/);
  assert.equal(f.writes, 0);
  const other = fixture();
  t.mock.method(fs.promises, "rename", async () => { throw Error("Simulated backup failure"); });
  await assert.rejects(cleanup.cleanupPaidPayroll({ ...other, now, apply: true, backupDirectory }), /Simulated backup failure/);
  assert.equal(other.writes, 0); assert.deepEqual(f.state, original);
});

test("an audit write failure atomically rolls paid payroll and notifications back", async t => {
  const f = fixture(), original = clone(f.state);
  f.failOn("activitylogs");
  await assert.rejects(cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) }), /Simulated write failure.*Verified recovery backup retained/);
  assert.deepEqual(f.state, original); assert.equal(f.transactions, 1);
});

test("payroll changed after backup is not deleted and later paid records survive the one-time cleanup", async t => {
  const f = fixture(), writer = recovery.writeResetBackup;
  t.mock.method(recovery, "writeResetBackup", async (...args) => {
    const result = await writer(...args);
    f.state.payrolls[0].grossPay += 1;
    return result;
  });
  await assert.rejects(cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) }), /changed after backup/);
  assert.equal(f.writes, 0); assert.equal(f.state.payrolls.filter(row => row.status === "paid").length, 2);
  t.mock.restoreAll();
  const other = fixture(), backupDirectory = directory(t);
  await cleanup.cleanupPaidPayroll({ ...other, now, apply: true, backupDirectory });
  other.state.payrolls[0].status = "paid";
  const writes = other.writes;
  assert.equal((await cleanup.cleanupPaidPayroll({ ...other, now, apply: true, backupDirectory })).mode, "already-applied");
  assert.equal(other.writes, writes); assert.ok(other.state.payrolls.some(row => row.status === "paid"));
});

test("newly paid payroll outside the backup is not included in deletion", async t => {
  const f = fixture(), writer = recovery.writeResetBackup;
  const newlyPaidId = f.state.payrolls.find(row => row.status === "approved")._id;
  t.mock.method(recovery, "writeResetBackup", async (...args) => {
    const result = await writer(...args);
    f.state.payrolls.find(row => String(row._id) === String(newlyPaidId)).status = "paid";
    return result;
  });
  assert.equal((await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) })).mode, "deleted");
  assert.equal(f.state.payrolls.filter(row => row.status === "paid").length, 1);
  assert.equal(String(f.state.payrolls.find(row => row.status === "paid")._id), String(newlyPaidId));
});

test("paid payroll recovery restores exact documents and notifications while preserving the audit and preventing repeated cleanup", async t => {
  const f = fixture(), original = clone(f.state);
  const result = await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) });
  assert.equal((await cleanup.restorePaidPayroll({ ...f, now, backupFile: result.backup })).mode, "restored");
  const sorted = rows => rows.map(row => recovery.serialize(row)).sort();
  assert.deepEqual(sorted(f.state.payrolls), sorted(original.payrolls));
  assert.deepEqual(sorted(f.state.notifications), sorted(original.notifications));
  assert.equal(f.state.activitylogs.length, 3);
  assert.equal((await cleanup.restorePaidPayroll({ ...f, now, backupFile: result.backup })).mode, "already-restored");
  assert.equal((await cleanup.cleanupPaidPayroll({ ...f, now, apply: true })).mode, "already-applied");
});

test("recovery refuses overlapping replacement payroll and corrupt backups without overwriting records", async t => {
  const f = fixture(), original = clone(f.state);
  const result = await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) });
  f.state.payrolls.push({ ...original.payrolls[0], _id: oid(), status: "draft" });
  const preserved = clone(f.state);
  await assert.rejects(cleanup.restorePaidPayroll({ ...f, now, backupFile: result.backup }), /overlaps/);
  assert.deepEqual(f.state, preserved);
  fs.appendFileSync(result.backup, "altered");
  await assert.rejects(cleanup.restorePaidPayroll({ ...f, now, backupFile: result.backup }), /checksum/);
  assert.deepEqual(f.state, preserved);
});

test("private recovery downloads support payroll backups and still enforce administrator access", async t => {
  const express = require("express"), pageAuth = require("../middleware/pageAuth");
  const { BACKUP_NAME, createResetBackupDownload } = require("../utils/bookingOrderResetBackupDownload");
  const f = fixture(), result = await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) });
  const app = express();
  app.use((req, res, next) => { const role = req.get("x-fixture-role"); req.authResolved = true; req.user = role ? { _id: "fixture-admin", role, active: true, emailVerified: true } : null; next(); });
  app.get("/admin/maintenance/data-reset-backups/:filename", pageAuth.requireRole("admin"), createResetBackupDownload({ directory: path.dirname(result.backup) }));
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const role of [undefined, "customer", "secretary", "technician"]) assert.equal((await fetch(base + result.backupDownloadPath, { redirect: "manual", headers: role ? { "x-fixture-role": role } : {} })).status, 302);
  const response = await fetch(base + result.backupDownloadPath, { headers: { "x-fixture-role": "admin" } });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(require("node:crypto").createHash("sha256").update(bytes).digest("hex"), result.backupSha256);
  for (const name of [".env", "../paid-payroll-reset-1792029253030-00000000.ejson.gz", "arbitrary-1792029253030-00000000.ejson.gz"]) assert.equal(BACKUP_NAME.test(name), false);
  await assert.rejects(recovery.writeResetBackup({}, directory(t), { namePrefix: "../outside" }), /Unsupported/);
});

test("real revenue engine removes deleted paid payroll cost while retaining approved-but-unpaid payroll", async t => {
  const f = fixture();
  for (const name of ["BookingService", "Order", "Payment", "ProductRefund", "Technician", "WalkInSale", "Inventory", "HVACProduct", "Tool", "Expense", "Payroll", "ProjectMaterial", "ServiceToolUsage", "Project", "WorkOrder", "DailyAssignment", "ServiceReport", "EquipmentAssignment"]) {
    t.mock.method(require("../models/" + name), "find", (filter = {}) => {
      const rows = name === "Payroll" ? f.state.payrolls : name === "WalkInSale" ? f.state.walkinsales : [];
      const result = rows.filter(row => matches(row, filter));
      return { select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => result };
    });
  }
  const cache = require("../utils/reportCache"), { buildRevenueAnalytics } = require("../utils/revenueAnalytics");
  cache.clear("revenue-analytics"); t.after(() => cache.clear("revenue-analytics"));
  const before = (await buildRevenueAnalytics({ from: "2026-10-01", to: "2026-10-15" })).analytics;
  assert.equal(before.payrollCost, 6700); assert.equal(before.operatingProfit, -5700);
  await cleanup.cleanupPaidPayroll({ ...f, now, apply: true, backupDirectory: directory(t) });
  cache.clear("revenue-analytics");
  const after = (await buildRevenueAnalytics({ from: "2026-10-01", to: "2026-10-15" })).analytics;
  assert.equal(after.payrollCost, 500); assert.equal(after.operatingProfit, 500);
  assert.equal(after.posRevenue, before.posRevenue); assert.equal(after.posCost, before.posCost);
  assert.equal(after.operatingProfit - before.operatingProfit, 6200);
});
