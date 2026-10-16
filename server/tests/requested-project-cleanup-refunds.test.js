"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const mongoose = require("mongoose"), ejs = require("ejs");
const vm = require("node:vm"), { createRequire } = require("node:module");
const { TARGETS, assertTargets, archiveRequestedTestProjects } = require("../scripts/archive-requested-test-projects");
const { paymentAmounts, summarizePaymentLedger, netPaymentsThrough, refundDate } = require("../utils/enterpriseRevenue");
const period = { startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T23:59:59Z") };
const settled = { status: "verified", amount: 1000, refundAmount: 600, verifiedAt: new Date("2026-10-02T00:00:00Z"), method: "gcash" };
for (const refundStatus of ["pending", "processing", "partial", "none"]) {
  test(`${refundStatus} refund requests do not subtract cash or create a refund event`, () => {
    const payment = { ...settled, refundStatus, refundedAt: new Date("2026-10-03T00:00:00Z") };
    assert.deepEqual(paymentAmounts(payment), { gross: 1000, refunded: 0, net: 1000 });
    assert.equal(summarizePaymentLedger([payment], period).refunds, 0);
    assert.equal(netPaymentsThrough([payment], period.endDate), 1000); assert.equal(refundDate(payment), null);
  });
}
test("a requested amount without a completion marker or settlement evidence is not a refund", () => {
  assert.equal(paymentAmounts(settled).refunded, 0); assert.equal(refundDate(settled), null);
});
test("completed and legacy settled refunds keep their actual event date", () => {
  for (const completion of [{ refundStatus: "completed" }, { status: "refunded" }, { refundedAt: new Date("2026-10-03T00:00:00Z") }]) {
    assert.equal(summarizePaymentLedger([{ ...settled, ...completion }], period).refunds, 600);
  }
  const historical = { ...settled, verifiedAt: new Date("2026-09-02T00:00:00Z"), refundStatus: "completed", refundedAt: new Date("2026-10-03T00:00:00Z") };
  const ledger = summarizePaymentLedger([historical], period);
  assert.equal(ledger.grossCollections, 0); assert.equal(ledger.refunds, 600); assert.equal(ledger.netCollections, -600);
});
test("explicit test-data exclusions preserve raw payments without entering financial totals", () => {
  const payment = { ...settled, refundStatus: "completed", testDataExcludedAt: new Date() };
  assert.deepEqual(paymentAmounts(payment), { gross: 0, refunded: 0, net: 0 });
  assert.equal(summarizePaymentLedger([payment], period).netCollections, 0);
  assert.equal(payment.amount, 1000); assert.equal(payment.refundAmount, 600);
});

const clone = value => mongoose.mongo.BSON.EJSON.parse(mongoose.mongo.BSON.EJSON.stringify(value));
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(part => matches(row, part));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date) && !value._bsontype) {
      if (value.$in) return value.$in.some(item => String(item) === String(actual));
      if (value.$nin) return !value.$nin.some(item => String(item) === String(actual));
      if ("$gte" in value) return Number(actual) >= Number(value.$gte);
      if ("$ne" in value) return actual !== value.$ne;
    }
    return value == null ? actual == null : String(actual) === String(value);
  });
}
function fixture({ insufficientStock = false, changeBeforeTransaction = false } = {}) {
  let records = {
    projects: TARGETS.map((target, i) => ({ _id: new mongoose.Types.ObjectId(target.id), customer: { name: target.customer }, totalUnits: target.units, completedUnits: 0, status: i ? "cancelled" : "in_progress", bookingId: "booking-" + i })),
    bookingservices: [0,1].map(i => ({ _id: "booking-" + i, status: i ? "cancelled" : "in-progress", services: [{ status: "pending" }] })),
    workorders: [{ _id: "work-0", projectId: TARGETS[0].id, status: "in_progress", completedUnitCount: 0 }],
    dailyassignments: [{ _id: "day-0", projectId: TARGETS[0].id, status: "in_progress", completedUnits: 0 }],
    assignments: [{ _id: "assignment-0", bookingId: "booking-0", status: "in_progress", notes: [] }],
    payments: [{ _id: "payment-0", bookingId: "booking-0", ...settled, refundStatus: "pending" }, { _id: "unrelated-payment", bookingId: "real-booking", status: "verified", amount: 500 }],
    expenses: [{ _id: "expense-0", projectId: TARGETS[0].id, amount: 80, status: "approved" }],
    projectmaterials: [{ _id: "material-0", projectId: TARGETS[0].id, status: "reserved", pickedUp: false, quantity: 3, source: "inventory", sourceId: new mongoose.Types.ObjectId("670000000000000000000003") },
      { _id: "picked-material", projectId: TARGETS[0].id, status: "reserved", pickedUp: true, quantity: 1, source: "inventory", sourceId: new mongoose.Types.ObjectId("670000000000000000000003") }],
    tools: [{ _id: new mongoose.Types.ObjectId("670000000000000000000003"), quantity: 100, reservedQuantity: insufficientStock ? 1 : 10 }],
    equipmentassignments: [{ _id: "shared-kit", projectId: TARGETS[0].id, dailyKitId: "shared", status: "reserved" }, { _id: "issued", projectId: TARGETS[0].id, status: "checked_out", checkedOutAt: new Date() }, { _id: "uncollected", projectId: TARGETS[0].id, status: "reserved" }],
    activitylogs: [],
  };
  let writes = 0;
  function mutate(name, filter, update, single) {
    let count = 0;
    for (const row of records[name] || []) {
      if (!matches(row, filter)) continue;
      Object.assign(row, clone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] += value;
      for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(clone(value));
      count++; writes++; if (single) break;
    }
    return { matchedCount: count, modifiedCount: count };
  }
  const db = { collection(name) { return {
    find(filter) { return { sort() { return this; }, maxTimeMS() { return this; }, toArray: async () => clone((records[name] || []).filter(row => matches(row, filter))) }; },
    countDocuments: async filter => (records[name] || []).filter(row => matches(row, filter)).length,
    updateOne: async (filter, update) => mutate(name, filter, update, true),
    updateMany: async (filter, update) => mutate(name, filter, update, false),
    insertMany: async rows => { (records[name] ||= []).push(...clone(rows)); writes += rows.length; },
  }; } };
  const client = { startSession() { return { endSession: async () => {}, async withTransaction(work) {
    if (changeBeforeTransaction) records.payments[0].amount++;
    const before = clone(records);
    try { await work(); } catch (error) { records = before; throw error; }
  } }; } };
  return { db, client, records: () => records, writes: () => writes };
}
const backupDirectory = () => fs.mkdtempSync(path.resolve(__dirname, "../../temp/requested-test-cleanup-test-"));
test("cleanup is limited to the two owner-selected IDs and rejects identity or progress changes", () => {
  const data = fixture().records().projects;
  assert.doesNotThrow(() => assertTargets(data));
  assert.throws(() => assertTargets(data.slice(0,1)), /Both/);
  for (const changed of [{ totalUnits: 8 }, { customer: { name: "Different person" } }, { completedUnits: 1 }, { sourceOrderId: "purchase" }]) {
    assert.throws(() => assertTargets([{ ...data[0], ...changed }, data[1]]));
  }
});
test("dry-run inventories related records without writes or fake refunds", async () => {
  const f = fixture(), result = await archiveRequestedTestProjects(f);
  assert.equal(result.mode, "dry-run"); assert.equal(result.linkedBookings, 2); assert.equal(result.paymentsRetained, 1);
  assert.equal(result.completedRefundsExcludedFromReports, 0); assert.equal(result.requestedRefundsNotCompleted, 600);
  assert.equal(result.physicalStockChanges, 0); assert.equal(f.writes(), 0);
});
test("cleanup backs up originals, cancels schedules, preserves custody and financial amounts, and excludes only test rows", async () => {
  const f = fixture(), before = clone(f.records());
  const result = await archiveRequestedTestProjects({ ...f, apply: true, backupDirectory: backupDirectory() });
  assert.equal(result.mode, "archived");
  const backup = mongoose.mongo.BSON.EJSON.parse(fs.readFileSync(result.backup, "utf8"));
  assert.equal(backup.payments[0].amount, 1000); assert.equal(backup.payments[0].testDataExcludedAt, undefined);
  const after = f.records();
  assert.ok(after.projects.every(row => row.archivedAt && row.status === "cancelled"));
  assert.ok(after.bookingservices.every(row => row.status === "cancelled"));
  assert.equal(after.dailyassignments[0].status, "skipped"); assert.equal(after.workorders[0].status, "cancelled");
  assert.equal(after.payments[0].amount, before.payments[0].amount); assert.equal(after.payments[0].refundAmount, before.payments[0].refundAmount);
  assert.equal(after.payments[0].status, before.payments[0].status); assert.equal(after.payments[0].refundStatus, "pending");
  assert.ok(after.payments[0].testDataExcludedAt); assert.ok(after.expenses[0].testDataExcludedAt);
  assert.deepEqual(after.payments[1], before.payments[1]); assert.equal(after.tools[0].quantity, 100); assert.equal(after.tools[0].reservedQuantity, 7);
  assert.deepEqual(after.equipmentassignments.slice(0,2), before.equipmentassignments.slice(0,2));
  assert.equal(after.equipmentassignments[2].status, "released"); assert.equal(after.projectmaterials[1].pickedUp, true);
  assert.equal(after.activitylogs.length, 2);
  const repeated = await archiveRequestedTestProjects({ ...f, apply: true, backupDirectory: backupDirectory() });
  assert.equal(repeated.mode, "already-archived"); assert.equal(after.tools[0].reservedQuantity, 7);
});
test("insufficient stock reservation counters abort and roll back the complete cleanup", async () => {
  const f = fixture({ insufficientStock: true }), before = clone(f.records());
  await assert.rejects(archiveRequestedTestProjects({ ...f, apply: true, backupDirectory: backupDirectory() }), /reservation counter/);
  assert.deepEqual(f.records(), before);
});
test("changes after backup stop cleanup before its first database write", async () => {
  const f = fixture({ changeBeforeTransaction: true });
  await assert.rejects(archiveRequestedTestProjects({ ...f, apply: true, backupDirectory: backupDirectory() }), /changed after the backup/);
  assert.equal(f.writes(), 0); assert.equal(f.records().projects[0].archivedAt, undefined);
});
test("financial records shared with another project or purchase stop cleanup before any write", async () => {
  for (const field of ["projectId", "orderId"]) {
    const f = fixture(); f.records().payments[0][field] = "another-job";
    await assert.rejects(archiveRequestedTestProjects({ ...f, apply: true, backupDirectory: backupDirectory() }), /shared|another project/);
    assert.equal(f.writes(), 0);
  }
});
test("the reporting exclusion survives real Mongoose query casting without exposing a writable schema field", () => {
  for (const name of ["Payment", "BookingService", "Expense"]) {
    const Model = require("../models/" + name), query = Model.find({ testDataExcludedAt: null });
    query.cast(Model); assert.deepEqual(query.getFilter(), { testDataExcludedAt: null });
    assert.equal(Model.schema.path("testDataExcludedAt"), undefined);
  }
});
test("revenue page SSR and its dynamic renderer show unavailable margins instead of zero profit", () => {
  const filename = path.resolve(__dirname, "../views/pages/admin/Reports/RevenueReports.ejs");
  const source = fs.readFileSync(filename, "utf8");
  const html = ejs.render(source, { analytics: { recognizedRevenue: -896007, refunds: 925227, operatingProfit: -902386, operatingProfitMargin: null } }, { filename });
  assert.match(html, /Margin unavailable/); assert.doesNotMatch(html, /0\.0% profit/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]); scripts.forEach(script => new Function(script));
  assert.match(source, /\$\{profitBadge\(A\)\}/); assert.match(source, /minus refunds sent/);
});

async function revenueFixture({ refundStatus = "pending", excluded = false } = {}) {
  const filename = require.resolve("../utils/revenueAnalytics"), realRequire = createRequire(filename);
  const booking = { _id: "booking-test", status: "completed", createdAt: new Date("2026-10-01"), completedAt: new Date("2026-10-02"), totalPrice: 29220, serviceType: "core", ...(excluded ? { testDataExcludedAt: new Date() } : {}) };
  const payment = { _id: "payment-test", bookingId: booking._id, status: "verified", amount: 1096200, refundAmount: 925227,
    verifiedAt: new Date("2026-10-02"), refundedAt: new Date("2026-10-03"), refundStatus, method: "gcash", ...(excluded ? { testDataExcludedAt: new Date() } : {}) };
  const cost = { _id: "expense-test", status: "approved", amount: 6379, type: "other", expenseDate: new Date("2026-10-02"), ...(excluded ? { testDataExcludedAt: new Date() } : {}) };
  const queried = [];
  const fakeModel = (name, rows = []) => ({ find(filter) {
    queried.push({ name, filter });
    let output = rows.filter(row => filter.testDataExcludedAt !== null || !row.testDataExcludedAt);
    return { select(fields) {
      if (name === "Payment") { const allowed = fields.split(" "); output = output.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key === "_id" || allowed.includes(key)))); }
      return this;
    }, sort() { return this; }, populate() { return this; }, lean: async () => output };
  } });
  const fake = { BookingService: fakeModel("BookingService", [booking]), Payment: fakeModel("Payment", [payment]), Expense: fakeModel("Expense", [cost]) };
  const module = { exports: {} };
  const customRequire = name => {
    if (name.startsWith("../models/")) { const key = name.split("/").at(-1); return fake[key] || fakeModel(key); }
    if (name === "./revenueRecognition") return { ...realRequire(name), buildProjectPricingMap: async () => new Map() };
    if (name === "./serviceCostAnalytics") return { buildServiceCostAnalytics: async () => ({ totals: { partsCost: 0, consumablesCost: 0, localPurchaseCost: 0, laborCost: 0 }, services: [] }) };
    if (name === "./reportCache") return { remember: (_namespace, _query, producer) => producer() };
    return realRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { require: customRequire, module, exports: module.exports, Date, console, process }, { filename });
  const result = await module.exports.buildRevenueAnalytics({ from: "2026-10-01", to: "2026-10-31" });
  return { ...result, queried };
}
test("the real revenue engine does not deduct the reported 925227 while its refund is pending", async () => {
  const { analytics } = await revenueFixture();
  assert.equal(analytics.recognizedGrossRevenue, 29220); assert.equal(analytics.refunds, 0);
  assert.equal(analytics.recognizedRevenue, 29220); assert.equal(analytics.netCollections, 1096200);
  assert.equal(analytics.operatingProfit, 22841); assert.ok(analytics.operatingProfitMargin > 0);
});
test("genuine completed refunds keep negative totals and show no fabricated zero margin", async () => {
  const { analytics } = await revenueFixture({ refundStatus: "completed" });
  assert.equal(analytics.refunds, 925227); assert.equal(analytics.recognizedRevenue, -896007);
  assert.equal(analytics.netCollections, 170973); assert.equal(analytics.operatingProfit, -902386);
  assert.equal(analytics.operatingProfitMargin, null); assert.equal(analytics.grossProfitMargin, null);
});
test("test-project payments, completed bookings, and expenses are excluded by the real report queries", async () => {
  const { analytics, queried } = await revenueFixture({ refundStatus: "completed", excluded: true });
  assert.equal(analytics.refunds, 0); assert.equal(analytics.grossCollections, 0); assert.equal(analytics.recognizedRevenue, 0); assert.equal(analytics.approvedExpenseTotal, 0);
  for (const name of ["Payment", "BookingService", "Expense"]) assert.ok(queried.filter(row => row.name === name).every(row => row.filter.testDataExcludedAt === null));
});
