const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const vm = require("node:vm");
const { isSecretaryReportRequest } = require("../utils/secretaryReportAccess");

const reports = path.join(__dirname, "../views/pages/admin/Reports");
const ratings = path.join(__dirname, "../views/pages/admin/Ratings");

test("all shared analytics templates compile", () => {
  for (const name of ["ReportCenter", "RevenueReports", "ServiceReport", "OrderReports", "InventoryReports"]) {
    const file = path.join(reports, `${name}.ejs`);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(file, "utf8"), { filename: file }));
  }
  for (const name of ["service", "aircons", "technicians", "analytics"]) {
    const file = path.join(ratings, `${name}.ejs`);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(file, "utf8"), { filename: file }));
  }
});

test("secretary Report Center links to its own full report library", async () => {
  const html = await ejs.renderFile(path.join(reports, "ReportCenter.ejs"), { user: { role: "secretary" } });
  for (const route of ["revenue", "service", "orders", "inventory"]) {
    assert.match(html, new RegExp(`href="/secretary/reports/${route}"`));
  }
  assert.match(html, /href="\/secretary\/ratings\/service"/);
  assert.match(html, /href="\/secretary\/ratings\/technicians"/);
  assert.match(html, /href="\/secretary\/pointofsale"/);
  assert.doesNotMatch(html, /href="\/admin\//);
  assert.doesNotMatch(html, /href="\/secretary\/(refunds|audit-trail)"/);
});

test("secretary report shells use secretary data and filter routes", async () => {
  const user = { role: "secretary" };
  const service = await ejs.renderFile(path.join(reports, "ServiceReport.ejs"), {
    user, analytics: null, deferredAnalytics: true, reportError: null,
  });
  assert.match(service, /action="\/secretary\/reports\/service"/);
  assert.match(service, /\/secretary\/reports\/service\/data/);
  assert.doesNotMatch(service, /href="\/admin\//);

  const orderShell = await ejs.renderFile(path.join(reports, "DeferredOrderReport.ejs"), { user });
  assert.match(orderShell, /data-report-role="secretary"/);

  const revenue = await ejs.renderFile(path.join(reports, "RevenueReports.ejs"), {
    user, analytics: null, deferredAnalytics: true,
  });
  assert.match(revenue, /\/api\/secretary\/reports\/revenue/);
  assert.match(revenue, /href="\/secretary\/pointofsale"/);
  assert.doesNotMatch(revenue, /href="\/admin\//);

  const inventory = await ejs.renderFile(path.join(reports, "InventoryReports.ejs"), {
    user, analytics: null,
  });
  assert.match(inventory, /action="\/secretary\/reports\/inventory"/);
  assert.doesNotMatch(inventory, /href="\/admin\//);

  const orders = await ejs.renderFile(path.join(reports, "OrderReports.ejs"), {
    user, analytics: {}, analyticsJson: "{}", filters: {}, filterOptions: {}, orderPhotoEvidence: [], reportError: null,
  });
  assert.match(orders, /action="\/secretary\/reports\/orders"/);
  assert.match(orders, /href="\/secretary\/inventory\/ordered-products"/);
  assert.match(orders, /\/api\/secretary\/reports\/orders\/drilldown/);
  assert.doesNotMatch(orders, /href="\/admin\//);

  for (const html of [service, revenue, orders]) {
    for (const script of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
      assert.doesNotThrow(() => new vm.Script(script));
    }
  }
});

test("secretary rating pages use the same views with read-only data endpoints", async () => {
  for (const name of ["service", "aircons", "technicians", "analytics"]) {
    const html = await ejs.renderFile(path.join(ratings, `${name}.ejs`), { user: { role: "secretary" } });
    assert.match(html, /\/api\/secretary\/ratings\//);
    assert.doesNotMatch(html, /href="\/admin\//);
    for (const script of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
      assert.doesNotThrow(() => new vm.Script(script), name);
    }
  }
  const products = await ejs.renderFile(path.join(ratings, "aircons.ejs"), { user: { role: "secretary" } });
  assert.match(products, /\.ratings-admin-only\{display:none!important\}/);
  assert.doesNotMatch(products, /<button type="button" class="btn btn-warning" onclick="flagReview\(\)"/);
});

test("secretary analytics API permits reporting reads but no moderation or admin writes", () => {
  for (const [method, route] of [
    ["GET", "/reports/overview"], ["GET", "/reports/revenue"],
    ["GET", "/reports/orders/export"], ["POST", "/reports/orders/drilldown"],
    ["POST", "/reports/service/drilldown"], ["GET", "/ratings/service"],
    ["GET", "/ratings/technicians"], ["GET", "/ratings/analytics"],
  ]) assert.equal(isSecretaryReportRequest({ method, path: route }), true, route);
  for (const [method, route] of [
    ["PATCH", "/ratings/abc/moderation"], ["POST", "/staff"],
    ["GET", "/audit"], ["POST", "/reports/revenue"],
  ]) assert.equal(isSecretaryReportRequest({ method, path: route }), false, route);
});
