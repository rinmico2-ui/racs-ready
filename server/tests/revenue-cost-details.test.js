"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { buildRevenueCostDetails, revenueAnalyticsForRole, MAX_ROWS_PER_CATEGORY } = require("../utils/revenueCostDetails");
const date = new Date("2026-10-14T04:00:00Z");
const sum = rows => rows.reduce((total, row) => total + row.amount, 0);

function fixture() {
  return {
    serviceRows: [{ bookingId: "booking", reference: "RACS-1", completedAt: date, serviceName: "Cleaning", partsCost: 100, consumablesCost: 20, laborCost: 30, localPurchaseCost: 50,
      repairParts: [{ name: "Capacitor", quantity: 2, cost: 100 }], consumables: [{ name: "Tape", quantity: 1, cost: 20 }], localPurchases: [{ partName: "Valve", source: "Supplier", actualPurchaseCost: 50 }] }],
    orders: [{ _id: "order", bookingId: "installation", orderReference: "ORD-1", status: "completed", completedAt: date, items: [{ brand: "Fixture", modelLine: "Split", quantity: 2, costPrice: 600 }] }],
    orderConsumableUsages: [{ orderId: "order", itemType: "consumable", itemName: "Drain tube", quantityUsed: 2, unitPrice: 99, toolCost: 10 }],
    linkedServiceRows: [{ bookingId: "installation", serviceName: "Installation", partsCost: 4, consumablesCost: 5, laborCost: 6, localPurchaseCost: 7 }],
    posSales: [{ _id: "counter", invoiceNumber: "WIS-1", status: "completed", completedAt: date, totalCost: 80, items: [{ itemName: "Filter", quantity: 2, costPrice: 35 }] }],
    projectMaterials: [{ _id: "material", projectId: "project", itemName: "Insulation", type: "consumable", quantity: 3, unitPrice: 12, totalPrice: 36 }],
    projectBookings: new Map([["project", { bookingReference: "RACS-PROJECT", status: "completed", completedAt: date }]]),
    operatingExpenses: [{ _id: "expense", type: "fuel", description: "Fuel for the installation visit", status: "approved", expenseDate: date, amount: 200 }, { _id: "pending", status: "pending", amount: 999 }],
    payrollRows: [{ _id: "payroll", status: "approved", grossPay: 500, basicPay: 400, overtimePay: 50, allowances: [{ name: "Travel", amount: 50 }], employee: { firstName: "Private", lastName: "Employee" }, payslipNumber: "PRIVATE-PAYSLIP", payDate: date, periodStart: date, periodEnd: date,
      paymentReference: "NEVER-EXPOSE-PAYMENT", paymentProof: "NEVER-EXPOSE-PROOF" }, { _id: "paid", status: "paid", grossPay: 300, basicPay: 300, payDate: date }, { _id: "draft", status: "draft", grossPay: 900 }],
    totals: { service: 200, orders: 1232, pos: 80, project_materials: 36, expenses: 200, payroll: 800 },
  };
}

test("itemized entries reconcile all six cost categories without duplicating linked installation costs", () => {
  const data = buildRevenueCostDetails(fixture());
  assert.equal(data.total, 2548); assert.equal(data.reconciled, true);
  for (const category of data.categories) assert.equal(sum(category.records), category.total, category.key);
  assert.equal(data.categories.find(group => group.key === "service").recordCount, 4);
  const orderRows = data.categories.find(group => group.key === "orders").records;
  assert.equal(orderRows.find(row => row.title === "Drain tube").amount, 10);
  assert.equal(orderRows.find(row => row.title === "Fixture Split").unitCost, 600);
  assert.equal(orderRows.filter(row => row.kind === "order").length, 6);
  const expenseRows = data.categories.find(group => group.key === "expenses").records;
  assert.equal(expenseRows.length, 1); assert.equal(expenseRows[0].description, "Fuel for the installation visit");
  const payrollRows = data.categories.find(group => group.key === "payroll").records;
  assert.equal(payrollRows.length, 2); assert.equal(payrollRows[0].title, "Private Employee");
  assert.equal(sum(payrollRows[0].components), 500);
  assert.doesNotMatch(JSON.stringify(data), /NEVER-EXPOSE/);
});

test("POS uses the recorded sale cost and flags differing item costs without inventing an adjustment", () => {
  const group = buildRevenueCostDetails(fixture()).categories.find(group => group.key === "pos");
  assert.equal(group.total, 80); assert.equal(group.records[0].amount, 80);
  assert.equal(sum(group.records[0].components), 70);
  assert.match(group.records[0].warning, /differs/);
  assert.equal(group.records.length, 1);
});

test("saved missing order costs remain zero while legacy rows identify current catalog fallback", () => {
  const data = buildRevenueCostDetails({ orders: [{ _id: "legacy", status: "completed", completedAt: date, items: [{ inventoryId: "item", quantity: 1, costPrice: 0 }, { inventoryId: "item", quantity: 1 }] }],
    orderCostCatalog: [{ _id: "item", costPrice: 400 }], totals: { orders: 400 } });
  const group = data.categories.find(group => group.key === "orders");
  assert.equal(group.records[0].amount, 0); assert.match(group.records[0].warning, /No usable bought price/);
  assert.equal(group.records[1].amount, 400); assert.match(group.records[1].basis, /Legacy/);
  assert.equal(group.reconciled, true);
});

test("large record lists retain whole-period totals and explicitly identify truncation", () => {
  const count = MAX_ROWS_PER_CATEGORY + 2;
  const data = buildRevenueCostDetails({ operatingExpenses: Array.from({ length: count }, (_, index) => ({ _id: String(index), status: "approved", amount: 1, expenseDate: date })), totals: { expenses: count } });
  const group = data.categories.find(group => group.key === "expenses");
  assert.equal(group.records.length, MAX_ROWS_PER_CATEGORY); assert.equal(group.recordCount, count);
  assert.equal(group.total, count); assert.equal(group.recordedTotal, count); assert.equal(group.reconciled, true); assert.equal(group.truncated, true);
});

test("missing details are flagged rather than forcing the cost total to match", () => {
  const data = buildRevenueCostDetails({ totals: { expenses: 100 } });
  assert.equal(data.reconciled, false); assert.equal(data.total, 100);
  const group = data.categories.find(group => group.key === "expenses");
  assert.equal(group.recordedTotal, 0); assert.equal(group.records.length, 0);
});

test("salary detail redaction preserves report totals and never modifies the shared cached report", () => {
  const original = { payrollCost: 800, costDetails: buildRevenueCostDetails(fixture()) };
  for (const role of ["secretary", "customer", undefined]) {
    const result = revenueAnalyticsForRole(original, role), group = result.costDetails.categories.find(group => group.key === "payroll");
    assert.equal(group.records.length, 0); assert.equal(group.restricted, true); assert.equal(group.total, 800);
    assert.equal(result.costDetails.total, original.costDetails.total);
    assert.doesNotMatch(JSON.stringify(result), /Private Employee|PRIVATE-PAYSLIP|"sourceId":"payroll"/);
  }
  assert.equal(revenueAnalyticsForRole(original, "admin"), original);
  assert.equal(original.costDetails.categories.find(group => group.key === "payroll").records.length, 2);
});

async function revenueRoute({ role, format, legacy = false, cached }) {
  const file = path.join(__dirname, legacy ? "../routes/secretaryApi.js" : "../routes/adminApi.js"), source = fs.readFileSync(file, "utf8"), routeRequire = createRequire(file);
  const start = source.indexOf('router.get("/reports/revenue"'), next = source.indexOf("\nrouter.", start + 1);
  const end = legacy ? (next < 0 ? source.indexOf("\nmodule.exports", start) : next) : source.indexOf("\n//", start);
  let handler, sent, exported, status = 200;
  vm.runInNewContext(source.slice(start, end), { router: { get(name, callback) { handler = callback; } }, process, console,
    require(request) {
      if (request === "../utils/revenueAnalytics") return { buildRevenueAnalytics: async () => cached };
      if (request === "../utils/reportPdf") return { sendReportPdf: async (res, kind, analytics) => { exported = analytics; } };
      return routeRequire(request);
    } }, { filename: file });
  const req = { user: { role }, query: { ...(format ? { format } : {}), role: "admin", includePayrollDetails: "true" } };
  const res = { set() { return this; }, vary() { return this; }, status(value) { status = value; return this; }, json(value) { sent = value; }, send(value) { sent = value; } };
  await handler(req, res, error => { throw error; });
  return { sent, exported, status };
}

test("JSON, CSV and PDF route projections enforce salary permissions despite spoofed query options and shared cache", async () => {
  const cached = { filters: {}, technicians: [], analytics: { costDetails: buildRevenueCostDetails(fixture()), monthlyRevenue: {}, dailyRevenue: [] } };
  for (const format of [undefined, "csv", "pdf"]) {
    const admin = await revenueRoute({ role: "admin", format, cached });
    assert.match(typeof admin.sent === "string" ? admin.sent : JSON.stringify(admin.exported || admin.sent), /Private Employee|PRIVATE-PAYSLIP/);
    const secretary = await revenueRoute({ role: "secretary", format, cached });
    assert.equal(secretary.status, 200);
    assert.doesNotMatch(typeof secretary.sent === "string" ? secretary.sent : JSON.stringify(secretary.exported || secretary.sent), /Private Employee|PRIVATE-PAYSLIP/);
  }
  const legacy = await revenueRoute({ role: "secretary", legacy: true, cached });
  assert.doesNotMatch(JSON.stringify(legacy.sent), /Private Employee|PRIVATE-PAYSLIP/);
  assert.equal(cached.analytics.costDetails.categories.find(group => group.key === "payroll").records.length, 2);
});

function browserView() {
  const ids = ["revenueCostRecordList", "revenueCostCategory", "revenueCostRecordTotal", "revenueCostRecordCount", "revenueCostRecordWarning", "revenueCostRecordPage", "revenueCostPrevious", "revenueCostNext"];
  const nodes = Object.fromEntries(ids.map(id => [id, { innerHTML: "", textContent: "", value: id === "revenueCostCategory" ? "all" : "", hidden: false }])), events = {};
  const context = { Intl, window: {}, document: { getElementById: id => nodes[id] || null, addEventListener(name, callback) { events[name] = callback; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/revenue-reconciliation.js"), "utf8"), context);
  return { nodes, render: context.window.RACSRevenueReconciliation.render,
    choose(key) { nodes.revenueCostCategory.value = key; events.change({ target: { id: "revenueCostCategory" } }); },
    next() { events.click({ target: { closest: selector => selector === "#revenueCostNext" } }); } };
}

test("cost list shows descriptions, references, item quantities and recorded differences safely", () => {
  const data = fixture(); data.operatingExpenses[0].description = '<img src=x onerror="alert(1)">';
  const view = browserView(); view.render({ costDetails: buildRevenueCostDetails(data) });
  assert.match(view.nodes.revenueCostRecordList.innerHTML, /WIS-1|ORD-1/);
  assert.match(view.nodes.revenueCostRecordList.innerHTML, /Saved items/);
  assert.match(view.nodes.revenueCostRecordList.innerHTML, /differs/);
  assert.match(view.nodes.revenueCostRecordList.innerHTML, /&lt;img/);
  assert.doesNotMatch(view.nodes.revenueCostRecordList.innerHTML, /<img|<script/);
  view.choose("expenses"); assert.match(view.nodes.revenueCostRecordTotal.textContent, /200\.00/);
  assert.doesNotMatch(view.nodes.revenueCostRecordList.innerHTML, /WIS-1|PRIVATE-PAYSLIP/);
});

test("cost list pagination and refreshed or removed expenses use current record totals", () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({ _id: String(index), status: "approved", type: "other", amount: 1, description: "Expense " + index, expenseDate: date }));
  const view = browserView(); view.render({ costDetails: buildRevenueCostDetails({ operatingExpenses: rows, totals: { expenses: 26 } }) });
  assert.equal((view.nodes.revenueCostRecordList.innerHTML.match(/<article/g) || []).length, 25);
  assert.match(view.nodes.revenueCostRecordTotal.textContent, /26\.00/);
  view.next(); assert.equal((view.nodes.revenueCostRecordList.innerHTML.match(/<article/g) || []).length, 1);
  view.render({ costDetails: buildRevenueCostDetails() });
  assert.match(view.nodes.revenueCostRecordList.innerHTML, /No cost entries/);
  assert.match(view.nodes.revenueCostRecordTotal.textContent, /0\.00/);
  assert.equal(view.nodes.revenueCostNext.disabled, true);
});

test("restricted or truncated cost lists state why all records are not displayed", () => {
  const data = { costDetails: buildRevenueCostDetails(fixture()) }, view = browserView();
  view.render(revenueAnalyticsForRole(data, "secretary")); view.choose("payroll");
  assert.match(view.nodes.revenueCostRecordWarning.textContent, /Only administrators/);
  assert.match(view.nodes.revenueCostRecordTotal.textContent, /800\.00/);
  assert.doesNotMatch(view.nodes.revenueCostRecordList.innerHTML, /Private Employee|PRIVATE-PAYSLIP/);
  const details = buildRevenueCostDetails({ totals: { expenses: 20 } }); details.categories.find(group => group.key === "expenses").truncated = true;
  view.render({ costDetails: details }); view.choose("expenses");
  assert.match(view.nodes.revenueCostRecordWarning.textContent, /smaller date range/);
  assert.match(view.nodes.revenueCostRecordWarning.textContent, /do not match/);
});
