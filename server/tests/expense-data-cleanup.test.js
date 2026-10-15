"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mongoose = require("mongoose"), recovery = require("../utils/resetRecoveryBackup");
const cleanup = require("../utils/expenseDataCleanup"), { parseArguments } = require("../scripts/clear-expenses");
const now = new Date("2026-10-15T02:00:00Z"), oid = () => new mongoose.Types.ObjectId();
const clone = value => mongoose.mongo.BSON.EJSON.parse(recovery.serialize(value), { relaxed: true });

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") return expected.some(value => matches(row, value));
    if (field === "$and") return expected.every(value => matches(row, value));
    const actual = field.split(".").reduce((value, key) => value?.[key], row);
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) return Object.entries(expected).every(([op, value]) => {
      if (op === "$in") return value.some(item => String(actual) === String(item));
      if (op === "$ne") return value === null ? actual != null : String(actual) !== String(value);
      if (op === "$exists") return (actual !== undefined) === value;
      if (op === "$gte") return actual != null && actual >= value;
      if (op === "$lte") return actual != null && actual <= value;
      throw Error("Unsupported fixture operator: " + op);
    });
    return expected === null ? actual == null : String(actual) === String(expected);
  });
}

function fixture() {
  const expenses = ["approved", "approved", "pending", "rejected"].map((status, index) => ({
    _id: oid(), source: index ? "technician" : "admin", technicianId: oid(), type: "other", status,
    amount: [600, 1066, 250, 100][index], description: "PRIVATE-EXPENSE-DESCRIPTION", expenseDate: now,
    receiptImage: "/api/receipts/" + oid(), submissionFingerprint: "PRIVATE-FINGERPRINT", createdAt: now,
  }));
  const state = { expenses, notifications: [
    { _id: oid(), referenceModel: "Expense", referenceId: expenses[0]._id, type: "expense_approved" },
    { _id: oid(), referenceModel: "Expense", referenceId: expenses[2]._id, type: "expense_submitted" },
    { _id: oid(), referenceModel: "Payroll", referenceId: expenses[0]._id, type: "payroll_paid" },
    { _id: oid(), referenceModel: "Expense", referenceId: oid(), type: "expense_approved" },
  ], payrolls: [{ _id: oid(), status: "approved", grossPay: 100, payDate: now }],
  payments: [{ _id: oid(), amount: 900 }], users: [{ _id: oid(), active: true }], technicians: [{ _id: oid(), name: "Existing staff" }],
  tools: [{ _id: oid(), quantity: 10, checkedOutQuantity: 1 }], inventories: [{ _id: oid(), quantity: 20 }],
  employeecompensations: [{ _id: oid(), baseRate: 500 }], technicianattendances: [{ _id: oid(), status: "Present" }],
  bookingservices: [{ _id: oid(), localPurchase: [{ actualPurchaseCost: 350, adminVerificationStatus: "approved" }] }], orders: [{ _id: oid(), total: 1000 }],
  "financialreceipts.files": [{ _id: oid(), filename: "existing-receipt.jpg" }], "financialreceipts.chunks": [{ _id: oid(), data: "PRIVATE-RECEIPT-CONTENT" }],
  activitylogs: [{ _id: oid(), action: "EXISTING_AUDIT" }], sitesettings: [{ _id: oid(), key: "systemConfiguration", value: { maintenance: { enabled: false } } }],
  walkinsales: [{ _id: oid(), invoiceNumber: "POS-FIXTURE", status: "completed", totalAmount: 1100, totalCost: 100, createdAt: now, completedAt: now, paymentMethod: "cash", items: [] }],
  };
  let writes = 0, transactions = 0, failure, replica = true;
  const db = { databaseName: "isolated-expense-cleanup-fixture", admin: () => ({ command: async () => replica ? { setName: "fixture" } : {} }),
    collection(name) {
      const rows = () => state[name] || [], write = () => { writes++; if (name === failure) throw Error("Simulated write failure"); };
      return {
        find(filter) { let maximum = Infinity; return { sort() { return this; }, limit(value) { maximum = value; return this; }, maxTimeMS() { return this; },
          toArray: async () => clone(rows().filter(row => matches(row, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, maximum)) }; },
        findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
        deleteMany: async filter => { write(); const deletedCount = rows().filter(row => matches(row, filter)).length; state[name] = rows().filter(row => !matches(row, filter)); return { deletedCount }; },
        insertOne: async row => { write(); state[name] = [...rows(), { _id: oid(), ...clone(row) }]; },
        insertMany: async documents => { write(); state[name] = [...rows(), ...clone(documents)]; },
        updateOne: async (filter, update) => { write(); const row = rows().find(row => matches(row, filter)); if (row) Object.assign(row, clone(update.$set)); return { matchedCount: row ? 1 : 0 }; },
      };
    },
  };
  const client = { startSession: () => ({ async withTransaction(callback, options) {
    transactions++; assert.equal(options.writeConcern.w, "majority"); const original = clone(state);
    try { await callback(); } catch (error) { Object.keys(state).forEach(key => delete state[key]); Object.assign(state, original); throw error; }
  }, async endSession() {} }) };
  return { db, client, state, get writes() { return writes; }, get transactions() { return transactions; }, failOn(name) { failure = name; }, standalone() { replica = false; } };
}

function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "racs-expense-cleanup-test-"));
  t.after(() => {
    assert.equal(path.dirname(result), path.resolve(os.tmpdir()));
    assert.ok(path.basename(result).startsWith("racs-expense-cleanup-test-"));
    fs.rmSync(result, { recursive: true, force: true });
  });
  return result;
}

test("expense CLI is read-only by default and rejects ambiguous destructive arguments", () => {
  assert.deepEqual(parseArguments([]), { mode: "preview" });
  assert.deepEqual(parseArguments(["--apply"]), { mode: "apply" });
  assert.deepEqual(parseArguments(["--restore", "--backup", "private.ejson.gz"]), { mode: "restore", backupFile: "private.ejson.gz" });
  for (const args of [["--apply", "--restore"], ["--all"], ["--restore"], ["--backup", "a"], ["--restore", "--backup", "--apply"]]) assert.throws(() => parseArguments(args));
});

test("expense preview includes every approval status and only prints aggregate counts and amounts", async () => {
  const f = fixture(), result = await cleanup.cleanupExpenses({ ...f, now });
  assert.equal(f.writes, 0); assert.equal(result.mode, "dry-run"); assert.equal(result.expenseRecords, 4); assert.equal(result.linkedNotifications, 2);
  assert.equal(result.totalExpenseAmount, 2016);
  assert.deepEqual(result.byStatus, { approved: { count: 2, amount: 1666 }, pending: { count: 1, amount: 250 }, rejected: { count: 1, amount: 100 } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|technicianId|receiptImage|submissionFingerprint/);
});

test("cleanup atomically removes backed-up expenses and exact notifications while preserving payroll, sales, receipts and stock", async t => {
  const f = fixture(), original = clone(f.state), backupDirectory = directory(t);
  const receipt = path.join(backupDirectory, "existing-receipt.txt"); fs.writeFileSync(receipt, "Existing private receipt");
  const result = await cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory });
  assert.equal(result.mode, "deleted"); assert.equal(result.atomic, true); assert.equal(result.recoveryVerified, true); assert.equal(f.transactions, 1);
  assert.equal(f.state.expenses.length, 0); assert.deepEqual(f.state.notifications, original.notifications.slice(2));
  for (const [name, rows] of Object.entries(original)) if (!["expenses", "notifications", "sitesettings", "activitylogs"].includes(name)) assert.deepEqual(f.state[name], rows, name);
  assert.deepEqual(f.state.sitesettings[0], original.sitesettings[0]); assert.equal(fs.readFileSync(receipt, "utf8"), "Existing private receipt");
  assert.equal(f.state.activitylogs.length, 2); assert.equal(f.state.activitylogs[0].action, "EXISTING_AUDIT");
  assert.equal(f.state.activitylogs[1].details.byStatus.approved.amount, 1666);
  assert.match(path.basename(result.backup), /^expense-reset-\d{13}-[a-f0-9]{8}\.ejson\.gz$/);
  const { artifact } = await recovery.readResetBackup(result.backup);
  assert.equal(artifact.original.remove.expenses.length, 4);
  assert.ok(artifact.original.remove.expenses[0]._id instanceof mongoose.Types.ObjectId);
  assert.ok(artifact.original.remove.expenses[0].expenseDate instanceof Date);
  assert.equal(artifact.original.remove.expenses[0].submissionFingerprint, "PRIVATE-FINGERPRINT");
  assert.equal(artifact.original.remove.expenses[0].description, "PRIVATE-EXPENSE-DESCRIPTION");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|technicianId|receiptImage/);
});

test("empty expenses and unsupported standalone MongoDB do not change records", async t => {
  const empty = fixture(); empty.state.expenses = [];
  assert.equal((await cleanup.cleanupExpenses({ ...empty, now, apply: true })).mode, "nothing-to-delete"); assert.equal(empty.writes, 0);
  const f = fixture(); f.standalone();
  await assert.rejects(cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), /replica set/);
  assert.equal(f.writes, 0);
});

test("a failed recovery backup prevents every expense deletion", async t => {
  const f = fixture(), original = clone(f.state);
  t.mock.method(fs.promises, "rename", async () => { throw Error("Simulated backup failure"); });
  await assert.rejects(cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), /Simulated backup failure/);
  assert.equal(f.writes, 0); assert.deepEqual(f.state, original);
});

test("a late audit failure rolls expense deletion and its completion marker back together", async t => {
  const f = fixture(), original = clone(f.state); f.failOn("activitylogs");
  await assert.rejects(cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), /Simulated write failure.*Verified recovery backup retained/);
  assert.deepEqual(f.state, original); assert.equal(f.transactions, 1);
});

test("changed approval data aborts cleanup, while new expenses outside the backup survive deletion and reruns", async t => {
  const f = fixture(), writer = recovery.writeResetBackup;
  t.mock.method(recovery, "writeResetBackup", async (...args) => { const result = await writer(...args); f.state.expenses[2].status = "approved"; return result; });
  await assert.rejects(cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), /changed after backup/);
  assert.equal(f.writes, 0); assert.equal(f.state.expenses.length, 4); t.mock.restoreAll();
  const other = fixture(), newer = { _id: oid(), status: "approved", amount: 999, description: "New real expense", expenseDate: now };
  t.mock.method(recovery, "writeResetBackup", async (...args) => { const result = await writer(...args); other.state.expenses.push(clone(newer)); return result; });
  await cleanup.cleanupExpenses({ ...other, now, apply: true, backupDirectory: directory(t) });
  assert.deepEqual(other.state.expenses, [newer]); const writes = other.writes;
  assert.equal((await cleanup.cleanupExpenses({ ...other, now, apply: true })).mode, "already-applied"); assert.equal(other.writes, writes);
});

test("expense recovery restores exact original records and notifications without replacing newer expense IDs", async t => {
  const f = fixture(), original = clone(f.state), result = await cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) });
  f.state.expenses.push({ ...original.expenses[0], amount: 9999 }); const preserved = clone(f.state);
  await assert.rejects(cleanup.restoreExpenses({ ...f, now, backupFile: result.backup }), /already exists/); assert.deepEqual(f.state, preserved);
  f.state.expenses = [];
  assert.equal((await cleanup.restoreExpenses({ ...f, now, backupFile: result.backup })).mode, "restored");
  const sorted = rows => rows.map(row => recovery.serialize(row)).sort();
  assert.deepEqual(sorted(f.state.expenses), sorted(original.expenses)); assert.deepEqual(sorted(f.state.notifications), sorted(original.notifications));
  assert.equal(f.state.activitylogs.length, 3);
  assert.equal((await cleanup.restoreExpenses({ ...f, now, backupFile: result.backup })).mode, "already-restored");
  assert.equal((await cleanup.cleanupExpenses({ ...f, now, apply: true })).mode, "already-applied");
});

test("corrupt backups and another database cannot be used to recover expense records", async t => {
  const f = fixture(), result = await cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), before = clone(f.state);
  f.db.databaseName = "different-database";
  await assert.rejects(cleanup.restoreExpenses({ ...f, now, backupFile: result.backup }), /not a supported expense/);
  fs.appendFileSync(result.backup, "corrupt");
  await assert.rejects(cleanup.restoreExpenses({ ...f, now, backupFile: result.backup }), /checksum/); assert.deepEqual(f.state, before);
});

test("expense recovery downloads require admin and retain their exact verified checksum", async t => {
  const express = require("express"), pageAuth = require("../middleware/pageAuth"), { BACKUP_NAME, createResetBackupDownload } = require("../utils/bookingOrderResetBackupDownload");
  const f = fixture(), result = await cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }), app = express();
  app.use((req, res, next) => { const role = req.get("x-fixture-role"); req.authResolved = true; req.user = role ? { _id: "fixture-admin", role, active: true, emailVerified: true } : null; next(); });
  app.get("/admin/maintenance/data-reset-backups/:filename", pageAuth.requireRole("admin"), createResetBackupDownload({ directory: path.dirname(result.backup) }));
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}`;
  for (const role of [undefined, "customer", "secretary", "technician"]) assert.equal((await fetch(base + result.backupDownloadPath, { redirect: "manual", headers: role ? { "x-fixture-role": role } : {} })).status, 302);
  const response = await fetch(base + result.backupDownloadPath, { headers: { "x-fixture-role": "admin" } });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(require("node:crypto").createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), result.backupSha256);
  for (const name of [".env", "../expense-reset-1792029253030-00000000.ejson.gz", "other-1792029253030-00000000.ejson.gz"]) assert.equal(BACKUP_NAME.test(name), false);
});

test("the real revenue engine stops counting deleted approved expenses and preserves POS costs and payroll", async t => {
  const f = fixture();
  for (const name of ["BookingService", "Order", "Payment", "ProductRefund", "Technician", "WalkInSale", "Inventory", "HVACProduct", "Tool", "Expense", "Payroll", "ProjectMaterial", "ServiceToolUsage", "Project", "WorkOrder", "DailyAssignment", "ServiceReport", "EquipmentAssignment"]) {
    t.mock.method(require("../models/" + name), "find", (filter = {}) => {
      const rows = name === "Expense" ? f.state.expenses : name === "WalkInSale" ? f.state.walkinsales : name === "Payroll" ? f.state.payrolls : [];
      const result = rows.filter(row => matches(row, filter));
      return { select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => result };
    });
  }
  const cache = require("../utils/reportCache"), { buildRevenueAnalytics } = require("../utils/revenueAnalytics");
  cache.clear("revenue-analytics"); t.after(() => cache.clear("revenue-analytics"));
  const before = (await buildRevenueAnalytics({ from: "2026-10-01", to: "2026-10-15" })).analytics;
  assert.equal(before.approvedExpenseTotal, 1666); assert.equal(before.operatingProfit, -766);
  await cleanup.cleanupExpenses({ ...f, now, apply: true, backupDirectory: directory(t) }); cache.clear("revenue-analytics");
  const after = (await buildRevenueAnalytics({ from: "2026-10-01", to: "2026-10-15" })).analytics;
  assert.equal(after.approvedExpenseTotal, 0); assert.equal(after.operatingProfit, 900);
  assert.equal(after.posCost, before.posCost); assert.equal(after.payrollCost, before.payrollCost);
  assert.equal(after.operatingProfit - before.operatingProfit, 1666);
});
