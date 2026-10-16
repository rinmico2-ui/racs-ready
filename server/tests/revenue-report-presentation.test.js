"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");
const vm = require("node:vm");

const reportsDirectory = path.join(__dirname, "..", "views", "pages", "admin", "Reports");
const revenuePath = path.join(reportsDirectory, "RevenueReports.ejs");
const revenueTemplate = fs.readFileSync(revenuePath, "utf8");
const serviceTemplate = fs.readFileSync(path.join(reportsDirectory, "ServiceReport.ejs"), "utf8");
const orderTemplate = fs.readFileSync(path.join(reportsDirectory, "OrderReports.ejs"), "utf8");
const revenueCss = fs.readFileSync(path.join(__dirname, "..", "public", "css", "revenue-report-focused.css"), "utf8");
const sharedKpiCss = fs.readFileSync(path.join(__dirname, "..", "public", "css", "report-kpis.css"), "utf8");
const revenueAnalyticsSource = fs.readFileSync(path.join(__dirname, "..", "utils", "revenueAnalytics.js"), "utf8");
const revenueAuditSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "auditRevenueAnalytics.js"), "utf8");
const walkInSaleSource = fs.readFileSync(path.join(__dirname, "..", "models", "WalkInSale.js"), "utf8");
const posRoutesSource = fs.readFileSync(path.join(__dirname, "..", "routes", "posRoutes.js"), "utf8");
const adminControllerSource = fs.readFileSync(path.join(__dirname, "..", "controllers", "adminController.js"), "utf8");
const repairPartsTemplate = fs.readFileSync(path.join(__dirname, "..", "views", "pages", "admin", "Inventory", "RepairParts.ejs"), "utf8");

test("revenue report renders with valid browser JavaScript", () => {
  [{ analytics: {} }, { analytics: null, deferredAnalytics: true }].forEach((locals) => {
    const html = ejs.render(revenueTemplate, locals, { filename: revenuePath });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length);
    scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
  });
});

test('deferred report retains product charts and uses the server CSV action after filters load',()=>{
  const html=ejs.render(revenueTemplate,{analytics:null,deferredAnalytics:true},{filename:revenuePath});
  for(const id of ['brandRevenue','fulfillmentMix','onlineProductSummary','revenueActivityView','revenueActivityTotal'])assert.ok(html.includes('id="'+id+'"'),id+' must exist before analytics arrives');
  assert.match(html,/id="exportRevenue"[^>]*data-report-csv="revenue"/);
  assert.doesNotMatch(html,/sales-and-payments\.csv|new Blob\(\[rows\.map/);
  assert.match(html,/\/js\/revenue-reconciliation\.js\?v=/);
});

test("revenue report starts with four decision KPIs", () => {
  for (const metric of ["Completed sales", "Money received", "Profit after expenses", "Unpaid balance"]) {
    assert.match(revenueTemplate, new RegExp(metric));
  }
  assert.match(revenueCss, /#kpiGrid\s*>\s*\.kpi-enterprise:nth-child\(1\)/);
  assert.match(revenueCss, /#kpiGrid\s*>\s*\.kpi-enterprise:nth-child\(5\)/);
  assert.match(revenueCss, /grid-template-columns:\s*repeat\(4/);
});

test("revenue drilldowns use progressive disclosure", () => {
  for (const tab of ["Overview", "Sales", "Collections", "Profit &amp; cost", "Services", "Products", "Activity"]) {
    assert.match(revenueTemplate, new RegExp(">" + tab + "<"));
  }
  assert.match(revenueTemplate, /requested : 'section-executive', false/);
  assert.match(revenueTemplate, /node\.hidden = id !== target/);
  assert.match(revenueTemplate, /window\.dispatchEvent\(new Event\('resize'\)\)/);
  assert.match(revenueTemplate, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
  for (const activity of ["Service bookings", "Online orders", "POS sales", "Completed activity"]) {
    assert.match(revenueTemplate, new RegExp(activity));
  }
  assert.match(revenueTemplate, /revenueActivitySnapshot/);
  assert.match(revenueTemplate, /Business summary/);
  assert.match(revenueTemplate, /const topInsights=/);
  assert.match(revenueTemplate, /danger:0,warning:1,info:2,success:3/);
  assert.equal((revenueTemplate.match(/id="section-[^"]+" class="rr-section"/g) || []).length, 7);
  assert.match(revenueTemplate, /class="rr-subsection"/);
  assert.match(revenueTemplate, /onlineOrderProductUnits/);
  assert.match(revenueTemplate, /onlineOrderProductRevenue/);
  assert.match(revenueAnalyticsSource, /onlineOrderProductUnits/);
  assert.match(revenueAnalyticsSource, /onlineOrderProductRevenue/);
  assert.match(revenueAnalyticsSource, /totalProductUnits = allProducts\.reduce/);
});

test("revenue report provides service portfolio decisions and a disclosed forecast", () => {
  for (const label of [
    "Highest known profit",
    "Lowest recorded profit",
    "Service profit estimates and next steps",
    "30-Day Sales Outlook",
    "Expected range",
  ]) assert.match(revenueTemplate, new RegExp(label));
  assert.match(revenueTemplate, /id="serviceProfitRanking"/);
  assert.match(revenueTemplate, /id="revenueForecast"/);
  assert.match(revenueTemplate, /serviceLineDrilldownModal/);
  assert.match(revenueTemplate, /How shared costs are split:/);
  assert.match(revenueTemplate, /Missing costs can change the result/);
  assert.match(revenueTemplate, /planning estimate/);
});

test("horizontal service profit tooltips show the plotted peso amount rather than the category index", () => {
  const configurations = new Map();
  class Chart {
    static defaults = { font: {} };
    constructor(canvas, config) { configurations.set(canvas.id, config); }
  }
  const context = { Chart, charts: {}, chartConfigs: {}, destroyCharts() {},
    document: { querySelectorAll: () => [], getElementById: id => ({ id }) },
    window: { RACSRevenueReconciliation: { salesView: value => value, serviceCost: () => 0 } },
    peso: value => '₱' + Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  const start = revenueTemplate.indexOf('  function updateCharts(A) {');
  const end = revenueTemplate.indexOf('  function renderSparklines(A)', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(revenueTemplate.slice(start, end), context);
  const rows = Array.from({ length: 13 }, (_, index) => ({ serviceName: 'Service ' + index, grossProfit: 12345.67 - index * 100 }));
  context.updateCharts({ serviceProfitability: { rows } });
  const chart = configurations.get('serviceProfitRanking'), dataset = chart.data.datasets[0];
  assert.equal(chart.options.indexAxis, 'y');
  assert.equal(chart.data.labels[7], 'Service 0');
  assert.equal(dataset.data[7], 12345.67);
  const label = chart.options.plugins.tooltip.callbacks.label;
  assert.equal(label({ dataset, parsed: { x: dataset.data[7], y: 7 } }), 'Profit before expenses: ₱12,345.67');
  assert.equal(label({ dataset, parsed: { x: 0, y: 7 } }), 'Profit before expenses: ₱0.00');
  assert.equal(label({ dataset, parsed: { x: -247.35, y: 7 } }), 'Profit before expenses: ₱-247.35');
});

test("POS analytics includes sellable inventory categories and excludes company equipment", () => {
  for (const label of ["Repair Parts", "Job supplies", "Aircon Products", "Top walk-in products by category"]) {
    assert.match(revenueTemplate, new RegExp(label));
  }
  assert.match(revenueTemplate, /data-pos-category="repair_parts"/);
  assert.match(revenueTemplate, /data-pos-category="consumables"/);
  assert.match(revenueTemplate, /data-pos-category="aircon_products"/);
  assert.match(revenueTemplate, /Company equipment is not included/);
  assert.match(revenueTemplate, /renderPosCategorySection/);
  assert.match(revenueAnalyticsSource, /recognizedWalkInOrders/);
  assert.match(revenueAnalyticsSource, /counterSaleBusinessCategory/);
  assert.match(revenueAnalyticsSource, /inventoryClass === "operational_asset"/);
  assert.match(revenueAnalyticsSource, /posCategoryBreakdown/);
  assert.match(revenueAnalyticsSource, /posCategoryProducts/);
  assert.match(walkInSaleSource, /inventoryClass/);
  assert.match(posRoutesSource, /Tool\.effectiveInventoryClass\(tool\)/);
  assert.match(posRoutesSource, /type:\s*\{ \$nin: \["equipment", "tool"\] \}/);
  assert.match(adminControllerSource, /\["equipment", "tool"\]\.includes\(normalizedType\)/);
  assert.match(repairPartsTemplate, /merchandiseOption\.disabled = equipmentType/);
  assert.match(revenueCss, /\.rr-pos-category-grid/);
});

test("revenue, service, and order reports share one KPI system", () => {
  for (const template of [revenueTemplate, serviceTemplate, orderTemplate]) {
    assert.match(template, /\/css\/report-kpis\.css/);
  }
  assert.match(serviceTemplate, /class="report-kpi-grid"/);
  assert.match(orderTemplate, /class="report-kpi-grid"/);
  assert.match(sharedKpiCss, /report-kpi-enter/);
  assert.match(sharedKpiCss, /prefers-reduced-motion:\s*reduce/);
});

test("revenue overview exposes decision controls derived from the full ledger", () => {
  for (const control of ["Schedule needs a change", "Payments to check", "Saved cost details", "Costs waiting for approval"]) {
    assert.match(revenueTemplate, new RegExp(control));
  }
  for (const field of ["atRiskServiceBookings", "paymentExceptionCount", "orderCostCoverage", "completionEvidenceCoverage", "draftPayrollCount"]) {
    assert.match(revenueAnalyticsSource, new RegExp(field));
  }
  assert.match(revenueAnalyticsSource, /\{ completedAt: dateFilter \}/);
  assert.match(revenueAnalyticsSource, /changedAt: dateFilter/);
  assert.match(revenueAnalyticsSource, /Expense\.find\(\{ expenseDate: dateFilter, testDataExcludedAt: null \}\)/);
  assert.match(revenueAnalyticsSource, /Payroll\.find\(\{ status: \{ \$ne: "voided" \}/);
  assert.match(revenueAnalyticsSource, /buildServiceProfitability/);
  assert.match(revenueAnalyticsSource, /buildRevenueForecast/);
});

test("database revenue audit is aggregate-only and does not mutate records", () => {
  assert.match(revenueAuditSource, /collectionsReviewed: 12/);
  assert.match(revenueAuditSource, /costCoverage/);
  assert.match(revenueAuditSource, /linkedCoveragePercent/);
  assert.match(revenueAuditSource, /reportEngine/);
  assert.match(revenueAuditSource, /buildRevenueAnalytics\(\)/);
  assert.match(revenueAuditSource, /autoIndex", false/);
  assert.doesNotMatch(revenueAuditSource, /\.(?:insert|update|delete|remove|bulkWrite|save|create)\s*\(/);
});
