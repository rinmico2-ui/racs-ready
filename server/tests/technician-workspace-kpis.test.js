"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = relativePath => fs.readFileSync(path.join(__dirname, relativePath), "utf8");
const technicianApi = read("../routes/technicianApi.js");
const orderRoutes = read("../routes/orderRoutes.js");
const assignmentsView = read("../views/pages/technician/assignments.ejs");
const ordersView = read("../views/pages/technician/technicianorders.ejs");

test("booking KPIs use the same standard-assignment scope as the All tab", () => {
  const kpis = technicianApi.slice(
    technicianApi.indexOf('router.get("/kpis"'),
    technicianApi.indexOf('router.get("/calendar"'),
  );
  const assignments = technicianApi.slice(
    technicianApi.indexOf('router.get("/assignments"'),
    technicianApi.indexOf('router.get("/assignments/:id"'),
  );

  assert.match(kpis, /status: \{ \$nin: TECHNICIAN_HIDDEN_ASSIGNMENT_STATUSES \}/);
  assert.match(assignments, /filter\.status = \{ \$nin: TECHNICIAN_HIDDEN_ASSIGNMENT_STATUSES \}/);
  assert.match(kpis, /TECHNICIAN_ACTIVE_ASSIGNMENT_STATUSES\.reduce/);
  assert.match(assignments, /filter\.status = \{ \$in: TECHNICIAN_ACTIVE_ASSIGNMENT_STATUSES \}/);
  assert.match(assignments, /manilaDateTime\(new Date\(\), 0\)/);
});

test("booking financial KPIs count each completed standard booking once", () => {
  const kpis = technicianApi.slice(
    technicianApi.indexOf('router.get("/kpis"'),
    technicianApi.indexOf('router.get("/calendar"'),
  );

  assert.match(kpis, /\{ \$group: \{ _id: "\$bookingId" \} \}/);
  assert.match(kpis, /bookingId: \{ \$in: completedStandardBookingIds \}/);
  assert.match(kpis, /status: "approved"/);
  assert.doesNotMatch(assignmentsView, />Net Profit</);
  assert.doesNotMatch(assignmentsView, />Earnings</);
  assert.match(assignmentsView, />Service Value</);
  assert.match(assignmentsView, />Service Margin</);
});

test("order rows and KPIs share the delivery-and-installation ownership scope", () => {
  const technicianOrders = orderRoutes.slice(
    orderRoutes.indexOf('router.get("/technician/all"'),
    orderRoutes.indexOf('router.get("/assignment-plan"'),
  );

  assert.match(technicianOrders, /const filter = \{ \.\.\.technicianOrderScope \}/);
  assert.match(technicianOrders, /\{ \$match: technicianOrderScope \}/);
  assert.match(orderRoutes, /const TECHNICIAN_ORDER_FULFILLMENT_TYPES = \["delivery_only", "delivery_installation"\]/);
  assert.match(orderRoutes, /"arrived"/);
  assert.match(technicianOrders, /TECHNICIAN_ACTIVE_ORDER_STATUSES\.reduce/);
  assert.match(ordersView, /setT\('heroActive',\s+s\.active != null/);
});
