"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const template = fs.readFileSync(
  path.join(__dirname, "..", "views", "pages", "admin", "Reports", "ServiceReport.ejs"),
  "utf8",
);
const pageRoutes = fs.readFileSync(
  path.join(__dirname, "..", "routes", "pages.js"),
  "utf8",
);
const serviceRoute = pageRoutes.slice(
  pageRoutes.indexOf('"/admin/reports/service"'),
  pageRoutes.indexOf('"/admin/reports/inventory"'),
);

test("service report renders with an empty analytics result and valid browser JavaScript", () => {
  const html = ejs.render(template, { analytics: null, reportError: null });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test("service report presents a focused four-KPI executive summary", () => {
  assert.equal((template.match(/<article class="sr-kpi(?:\s|\")/g) || []).length, 4);
  for (const label of [
    "Completed services",
    "Completion rate",
    "Completed-service value",
    "Service contribution",
  ]) {
    assert.match(template, new RegExp(label));
  }
  assert.match(template, /Provisional/);
  assert.doesNotMatch(template, /Enterprise Service Controls/);
});

test("service report uses progressive disclosure instead of an analytics wall", () => {
  assert.equal((template.match(/<canvas id=/g) || []).length, 3);
  for (const tab of ["Overview", "Performance", "Cost &amp; contribution", "Quality", "Records"]) {
    assert.match(template, new RegExp(">" + tab + "<"));
  }
  assert.match(template, /<details class="sr-more-filters"/);
  assert.match(template, /Needs attention/);
  assert.match(template, /Top services/);
});

test("service report keeps booked and completed value definitions distinct", () => {
  assert.match(template, /this is not completed revenue/);
  assert.match(template, /Value from services whose lifecycle is recognized as completed/);
  assert.match(template, /Service contribution/);
  assert.match(template, /Missing records can overstate contribution/);
  assert.match(template, /\^\[=\+\\-@\\t\\r\]/);
});

test("advanced service filters are visible, retained, and applied server-side", () => {
  const filters = [
    "status",
    "service",
    "technician",
    "assignment",
    "priority",
    "appliance",
    "brand",
    "area",
    "scale",
    "payment",
    "valueBand",
    "sla",
    "warranty",
    "search",
  ];
  for (const filter of filters) {
    assert.match(template, new RegExp(`name="${filter}"`), `${filter} must be available in the filter drawer`);
    assert.match(pageRoutes, new RegExp(`req\\.query\\.${filter}`), `${filter} must be accepted by the report route`);
    assert.match(pageRoutes, new RegExp(`filterContext\\.${filter}`), `${filter} must affect the report cohort`);
  }
  assert.match(template, /activeAdvancedFilters/);
  assert.match(template, /<details class="sr-more-filters" open>/);
  assert.match(template, /14 available/);
  for (const group of ["Workflow", "Service &amp; location", "Commercial"]) {
    assert.match(template, new RegExp(group));
  }
  assert.match(serviceRoute, /bookings = bookings\.filter/);
});

test("filtered reports avoid obsolete and duplicate database reads", () => {
  assert.match(serviceRoute, /const \[bookingRows, technicians\] = await Promise\.all/);
  assert.match(serviceRoute, /includeSourceRows: true/);
  assert.match(serviceRoute, /serviceCostAnalytics\.sourceRows\?\.reports/);
  assert.doesNotMatch(serviceRoute, /require\("\.\.\/models\/Order"\)/);
  assert.doesNotMatch(serviceRoute, /require\("\.\.\/models\/TechnicianAttendance"\)/);
  assert.doesNotMatch(serviceRoute, /BookingService\.aggregate/);
  assert.match(template, /Updating…/);
  assert.match(template, /aria-busy/);
});
