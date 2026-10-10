"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const {
  buildReportCenterInsights,
  countPipeline,
} = require("../utils/reportCenter");

const serverRoot = path.join(__dirname, "..");

test("report center classifies active and terminal work without double counting rows", () => {
  const summary = countPipeline([
    { _id: "pending", count: 4 },
    { _id: "completed", count: 6 },
    { _id: "cancelled", count: 2 },
  ], new Set(["completed", "cancelled"]));

  assert.deepEqual(summary, {
    total: 12,
    active: 4,
    terminal: 8,
    byStatus: { pending: 4, completed: 6, cancelled: 2 },
  });
});

test("report center insights prioritize financial and stock issues to check", () => {
  const insights = buildReportCenterInsights({
    financial: {
      operatingProfit: -2500,
      monthlyRevenue: 10000,
      pendingPayments: 5000,
      costDataCoverage: 60,
    },
    operations: { activeBookings: 2, activeOrders: 3 },
    inventory: { alerts: 5, outOfStock: 2, lowStock: 3 },
  });

  assert.equal(insights.length, 4);
  assert.equal(insights[0].tone, "danger");
  assert.match(insights[0].title, /Saved costs are higher than completed sales/);
  assert.ok(insights.some(insight => /Stock/.test(insight.title)));
  insights.forEach(insight => assert.match(insight.href, /^\/admin\//));
});

test("report center ranks payment issues to check ahead of informational workload", () => {
  const insights = buildReportCenterInsights({
    financial: {
      operatingProfit: 1000,
      monthlyRevenue: 5000,
      pendingPayments: 0,
      costDataCoverage: 100,
      paymentActionCount: 2,
      paymentExceptionCount: 1,
    },
    operations: { activeBookings: 4, activeOrders: 3 },
    inventory: { alerts: 0, outOfStock: 0, lowStock: 0 },
  });

  assert.equal(insights[0].tone, "danger");
  assert.match(insights[0].title, /Payments need checking/);
  assert.equal(insights.at(-1).tone, "success");
});

test("admin report center is wired as a lightweight protected shell", async () => {
  const pages = fs.readFileSync(path.join(serverRoot, "routes/pages.js"), "utf8");
  const api = fs.readFileSync(path.join(serverRoot, "routes/adminApi.js"), "utf8");
  const sidebar = fs.readFileSync(path.join(serverRoot, "views/partials/admin-sidebar.ejs"), "utf8");
  const client = fs.readFileSync(path.join(serverRoot, "public/js/admin-report-center.js"), "utf8");
  const html = await ejs.renderFile(path.join(serverRoot, "views/pages/admin/Reports/ReportCenter.ejs"), {});

  assert.match(pages, /\["\/admin\/reports", "\/secretary\/reports"\][\s\S]*pageAuth\.requireRole\(\["admin", "secretary"\]\)[\s\S]*ReportCenter/);
  assert.match(api, /router\.get\("\/reports\/overview"/);
  assert.match(sidebar, /href="\/admin\/reports"[^>]*>[\s\S]*Report Center/);
  assert.match(client, /fetch\("\/api\/" \+ reportRole \+ "\/reports\/overview"/);
  assert.match(html, /id="reportCenterTitle">Report Center/);
  assert.match(html, /Sales and Payments/);
  assert.match(html, /Service Reports/);
  assert.match(html, /Order Reports/);
  assert.match(html, /Stock Reports/);
  assert.match(html, /id="financialPositionTitle">Sales and payments/);
  assert.match(html, /id="operationalExposureTitle">Unfinished work and alerts/);
  assert.match(html, /Profit after saved costs/);
  assert.doesNotMatch(html, />Profit after expenses</i);
  assert.match(html, /People &amp; customer experience/);
  assert.match(html, /Where the numbers come from/);
  assert.match(html, /Missing costs can make this estimate too high/);
  assert.match(html, /role="tablist" aria-label="Report Center views"/);
  assert.match(html, /id="rcPanelDecisions"[^>]*hidden/);
  assert.match(html, /Suggested Actions/);
  const decisionsHtml = await ejs.renderFile(path.join(serverRoot, "views/pages/admin/Reports/ReportCenter.ejs"), { initialReportTab: "decisions" });
  assert.match(decisionsHtml, /id="rcPanelOverview"[^>]*hidden/);
  assert.match(decisionsHtml, /id="rcTabDecisions"[^>]*aria-selected="true"/);
  assert.match(pages, /reports\/decisions'[\s\S]*res\.redirect\(302, `\/\$\{req\.user\.role\}\/reports\?/);
});
