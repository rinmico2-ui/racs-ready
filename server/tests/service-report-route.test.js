"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ejs = require("ejs");

const pagesPath = path.join(__dirname, "../routes/pages.js");
const pageRequire = createRequire(pagesPath);
const pages = fs.readFileSync(pagesPath, "utf8");
const routeStart = pages.lastIndexOf("router.get(", pages.indexOf('"/admin/reports/service/data"'));
const routeSource = pages.slice(routeStart, pages.indexOf("\nrouter.post(", routeStart));
const templatePath = path.join(__dirname, "../views/pages/admin/Reports/ServiceReport.ejs");

function booking(id, amount) {
  return {
    _id: id, bookingReference: `BOOK-${id}`, status: "completed", serviceType: "core",
    servicePrice: amount, totalPrice: amount, quantity: 1, paymentMethod: "cash",
    createdAt: new Date("2026-10-10T01:00:00Z"), completedAt: new Date("2026-10-10T04:00:00Z"),
    bookingDate: new Date("2026-10-10T01:00:00Z"), customer: { name: "Sample customer" },
    service: { name: "Cleaning" },
  };
}

async function runReport({ role = "admin", format, rows = [booking("service", 1000), booking("installation", 5000)], failOrders = false } = {}) {
  let handler, rendered, sent, status = 200;
  const errors = [], lookups = [], headers = {};
  const query = data => ({ select() { return this; }, sort() { return this; }, lean: async () => data });
  const models = {
    BookingService: { find: () => query(rows) },
    Technician: { find: () => query([]) },
    Order: { find(filter) {
      lookups.push(filter);
      if (failOrders) throw new Error("Database temporarily unavailable");
      return query([{ bookingId: "installation" }]);
    } },
    Rating: { find: () => query([]) },
    Assignment: { find: () => query([]) },
    PartsRequest: { find: () => query([]) },
  };
  const costAnalytics = {
    buildServiceCostAnalytics: async () => ({
      totals: { revenue: 0, partsCost: 0, consumablesCost: 0, laborCost: 0, localPurchaseCost: 0, grossProfit: 0 },
      services: [], equipment: [], sourceRows: { reports: [], assignments: [] },
    }),
  };
  function routeRequire(request) {
    if (request.startsWith("../models/")) {
      const model = models[request.slice("../models/".length)];
      assert.ok(model, `Unexpected model lookup: ${request}`);
      return model;
    }
    if (request === "../utils/serviceCostAnalytics") return costAnalytics;
    if (request === "../utils/revenueRecognition") return {
      buildProjectPricingMap: async () => new Map(),
      bookingApprovedValue: require("../utils/bookingReportValue").bookingReportValue,
    };
    return pageRequire(request);
  }
  vm.runInNewContext(routeSource, {
    router: { get(routes, auth, callback) {
      assert.ok(routes.includes(`/${role}/reports/service/data`));
      handler = callback;
    } },
    pageAuth: { requireRole(roles) { assert.ok(roles.includes(role)); return () => {}; } },
    require: routeRequire,
    readServiceReportFragment: () => ({ key: "test", html: null }),
    writeServiceReportFragment: () => {},
    ...require("../utils/reportRankings"),
    ...require("../utils/reportPdf"),
    console: { error: (...args) => errors.push(args) },
  }, { filename: pagesPath });
  const req = { user: { role }, query: { range: "custom", from: "2026-10-01", to: "2026-10-15", ...(format ? { format } : {}) } };
  const res = {
    set(name, value) { headers[name] = value; return this; },
    status(value) { status = value; return this; },
    json(value) { sent = value; return this; },
    send(value) { sent = value; return this; },
    render(view, data, callback) {
      rendered = data;
      assert.equal(view, "pages/admin/Reports/ServiceReport");
      if (callback) {
        try { callback(null, ejs.render(fs.readFileSync(templatePath, "utf8"), data, { filename: templatePath })); }
        catch (error) { callback(error); }
      }
      return this;
    },
  };
  await handler(req, res);
  return { rendered, sent, status, errors, lookups, headers };
}

for (const role of ["admin", "secretary"]) {
  test(`${role} service report loads populated data and excludes legacy order installations`, async () => {
    const result = await runReport({ role });
    assert.equal(result.errors.length, 0, String(result.errors[0]));
    assert.equal(result.rendered.reportError, null);
    assert.equal(result.rendered.analytics.totalBookings, 1);
    assert.equal(result.rendered.analytics.completedRevenue, 1000);
    assert.equal(result.rendered.analytics.bookingDrilldown[0].id, "service");
    assert.equal(result.lookups.length, 1);
    assert.deepEqual(Array.from(result.lookups[0].bookingId.$in), ["service", "installation"]);
    assert.match(result.sent, /Completed services/);
  });
}

test("empty service reports load without an unnecessary order query", async () => {
  const result = await runReport({ rows: [] });
  assert.equal(result.errors.length, 0);
  assert.equal(result.lookups.length, 0);
  assert.equal(result.rendered.analytics.totalBookings, 0);
});

test("service report CSV exports use the same installation exclusion", async () => {
  const result = await runReport({ format: "csv" });
  assert.equal(result.errors.length, 0);
  assert.equal(result.headers["Content-Type"], "text/csv; charset=utf-8");
  assert.match(result.sent, /BOOK-service/);
  assert.doesNotMatch(result.sent, /BOOK-installation/);
});

test("service report PDF exports execute successfully for populated data", async () => {
  const result = await runReport({ role: "secretary", format: "pdf" });
  assert.equal(result.errors.length, 0, String(result.errors[0]));
  assert.equal(result.headers["Content-Type"], "application/pdf");
  assert.equal(result.sent.subarray(0, 5).toString(), "%PDF-");
});

test("failed order lookups produce an unavailable export instead of partial service totals", async () => {
  const result = await runReport({ format: "csv", failOrders: true });
  assert.equal(result.status, 503);
  assert.match(result.sent.error, /could not be exported/);
  assert.equal(result.headers["Content-Type"], undefined);
});
