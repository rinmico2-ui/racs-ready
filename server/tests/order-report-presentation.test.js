"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const templatePath = path.join(__dirname, "..", "views", "pages", "admin", "Reports", "OrderReports.ejs");
const template = fs.readFileSync(templatePath, "utf8");
const focusedCss = fs.readFileSync(path.join(__dirname, "..", "public", "css", "order-report-focused.css"), "utf8");
const analytics = {
  totalOrders: 0, validOrders: 0, grossOrderValue: 0, recognizedRevenue: 0, recognizedOrders: 0,
  grossCollections: 0, refunds: 0, netCollections: 0, outstandingBalance: 0, ledgerMismatchCount: 0,
  estimatedCost: 0, estimatedGrossMargin: 0, costCoveragePercent: 100, marginReliable: true,
  orderGrowth: 0, cancelledOrders: 0, cancellationRate: 0, openOrders: 0, overdueOrders: 0,
  unassignedOrders: 0, pendingPaymentOrders: 0, actionRequiredOrders: 0, medianCycleHours: 0,
  p90CycleHours: 0, onTimeRate: 0, onTimeSampleSize: 0,
  backlogAging: { today:0, twoToThree:0, fourToSeven:0, overSeven:0 }, cancellationReasons: [],
  fulfillmentBreakdown: {}, statusBreakdown: {}, paymentBreakdown: {}, dailyTrend: [], topProducts: [], recentOrders: [],
  appliedFilters: {}, reportStart: "2026-01-01", reportEnd: "2026-01-31",
};

test("order report renders focused progressive analysis and valid browser JavaScript", () => {
  const html = ejs.render(template, {
    analytics,
    analyticsJson: JSON.stringify(analytics),
    filters: { range:"30", from:"", to:"", activeCount:0, fulfillment:"", status:"", paymentStatus:"", paymentMethod:"", technician:"", q:"", brand:"", minValue:null, maxValue:null },
    filterOptions: { technicians:[], brands:[] },
  }, { filename:templatePath });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length);
  scripts.forEach(script => assert.doesNotThrow(() => new Function(script)));
  assert.equal((template.match(/<article class="sr-kpi(?:\s|")/g) || []).length, 4);
  assert.equal((template.match(/<canvas id=/g) || []).length, 3);
});

test("order report separates executive, fulfillment, cash, product, and record decisions", () => {
  for (const label of ["Valid orders placed", "Completed order value", "Net collections", "Orders requiring attention"]) assert.match(template, new RegExp(label));
  for (const tab of ["Overview", "Fulfillment", "Cash &amp; margin", "Products", "Records"]) assert.match(template, new RegExp(">" + tab + "<"));
  for (const measure of ["Median cycle", "90th percentile", "On-time completion", "Active backlog aging", "Cancellation reasons"]) assert.match(template, new RegExp(measure));
  assert.match(template, /Financial time bases/);
  assert.doesNotMatch(template, /Executive outlook/);
  assert.doesNotMatch(template, /Brand Contribution/);
  assert.doesNotMatch(template, /Fulfillment team/);
});

test("order report motion is polished and accessibility-aware", () => {
  for (const animation of ["or-rise", "or-tab-enter", "or-grow-bar", "or-soft-pulse"]) assert.match(focusedCss, new RegExp(animation));
  assert.match(focusedCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(template, /prefers-reduced-motion:\s*reduce/);
  assert.match(template, /duration:reduceMotion\?0:420/);
});
