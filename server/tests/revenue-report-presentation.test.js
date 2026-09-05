"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const reportsDirectory = path.join(__dirname, "..", "views", "pages", "admin", "Reports");
const revenuePath = path.join(reportsDirectory, "RevenueReports.ejs");
const revenueTemplate = fs.readFileSync(revenuePath, "utf8");
const serviceTemplate = fs.readFileSync(path.join(reportsDirectory, "ServiceReport.ejs"), "utf8");
const orderTemplate = fs.readFileSync(path.join(reportsDirectory, "OrderReports.ejs"), "utf8");
const revenueCss = fs.readFileSync(path.join(__dirname, "..", "public", "css", "revenue-report-focused.css"), "utf8");
const sharedKpiCss = fs.readFileSync(path.join(__dirname, "..", "public", "css", "report-kpis.css"), "utf8");
const revenueAnalyticsSource = fs.readFileSync(path.join(__dirname, "..", "utils", "revenueAnalytics.js"), "utf8");
const revenueAuditSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "auditRevenueAnalytics.js"), "utf8");

test("revenue report renders with valid browser JavaScript", () => {
  const html = ejs.render(revenueTemplate, { analytics: {} }, { filename: revenuePath });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length);
  scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
});

test("revenue report starts with four decision KPIs", () => {
  for (const metric of ["Recognized Revenue", "Net Collections", "Operating Profit", "Outstanding Receivables"]) {
    assert.match(revenueTemplate, new RegExp(metric));
  }
  assert.match(revenueCss, /#kpiGrid\s*>\s*\.kpi-enterprise:nth-child\(1\)/);
  assert.match(revenueCss, /#kpiGrid\s*>\s*\.kpi-enterprise:nth-child\(5\)/);
  assert.match(revenueCss, /grid-template-columns:\s*repeat\(4/);
});

test("revenue drilldowns use progressive disclosure", () => {
  for (const tab of ["Overview", "Revenue", "Collections", "Profit &amp; cost", "Services", "Products", "Activity"]) {
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
  assert.match(revenueTemplate, /Management Overview/);
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
  for (const control of ["Scheduling intervention", "Payment exceptions", "Direct-cost confidence", "Financial close backlog"]) {
    assert.match(revenueTemplate, new RegExp(control));
  }
  for (const field of ["atRiskServiceBookings", "paymentExceptionCount", "orderCostCoverage", "completionEvidenceCoverage", "draftPayrollCount"]) {
    assert.match(revenueAnalyticsSource, new RegExp(field));
  }
  assert.match(revenueAnalyticsSource, /\{ completedAt: dateFilter \}/);
  assert.match(revenueAnalyticsSource, /changedAt: dateFilter/);
  assert.match(revenueAnalyticsSource, /Expense\.find\(\{ expenseDate: dateFilter \}\)/);
  assert.match(revenueAnalyticsSource, /Payroll\.find\(\{ status: \{ \$ne: "voided" \}/);
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
