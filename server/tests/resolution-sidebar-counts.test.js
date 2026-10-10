"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { summarizeResolutionCases } = require("../utils/resolutionCenter");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

test("Resolution Center summary counts booking and order cases exactly once", () => {
  const summary = summarizeResolutionCases([
    { sourceType: "booking", issueType: "no_show" },
    { sourceType: "booking", issueType: "past_date" },
    { sourceType: "order", issueType: "dispatch_overdue" },
  ]);
  assert.equal(summary.bySource.booking, 2);
  assert.equal(summary.bySource.order, 1);
  assert.equal(summary.total, summary.bySource.booking + summary.bySource.order);
});

test("admin and secretary sidebar badges use the unified queue totals", () => {
  const admin = read("../views/partials/admin-sidebar.ejs");
  const secretary = read("../views/partials/secretary-sidebar.ejs");
  ejs.compile(admin);
  ejs.compile(secretary);
  assert.match(admin, /sidebarJson\('\/api\/admin\/resolution-center\?page=1&perPage=1'/);
  assert.match(admin, /scheduleExtendedBadges\(onResolutionCenter\)/);
  assert.match(secretary, /fetch\('\/api\/secretary\/operations\/resolution-center\?page=1&perPage=1'/);
  for (const source of [admin, secretary]) {
    assert.match(source, /const total = bookingCases \+ orderCases|setSecretaryBadge\('attentionBadge', bookingCases \+ orderCases\)/);
    assert.match(source, /addEventListener\('resolution:counts'/);
    assert.doesNotMatch(source, /attentionBadge['"],?\s*(data\.attentionRequired|data\.noShowReviewBookings)/);
  }
});

test("booking, order, and Resolution Center pages publish fresh queue counts", () => {
  const booking = read("../views/pages/admin/Appointments/AppointmentsUnified.ejs");
  const orders = read("../public/js/admin-aircon-orders.js");
  const center = read("../views/pages/admin/Appointments/AttentionQueue.ejs");
  for (const source of [booking, orders, center]) {
    assert.match(source, /dispatchEvent\(new CustomEvent\('resolution:counts'/);
  }
});

test("Resolution Center page reuses its queue summary instead of requesting the sidebar count again", () => {
  const admin = read("../views/partials/admin-sidebar.ejs");
  const secretary = read("../views/partials/secretary-sidebar.ejs");
  assert.match(admin, /onResolutionCenter \? Promise\.resolve\(null\) : sidebarJson\('\/api\/admin\/resolution-center/);
  assert.match(secretary, /onResolutionCenter \? Promise\.resolve\(null\) : fetch\('\/api\/secretary\/operations\/resolution-center/);
});

test("Resolution Center queries only due orders and projected case fields", () => {
  const route = read("../routes/adminApi.js");
  const routeStart = route.indexOf('router.get("/resolution-center"');
  const routeEnd = route.indexOf('router.post("/resolution-center/:id/close"', routeStart);
  const queueRoute = route.slice(routeStart, routeEnd);
  assert.match(queueRoute, /pickupDate: \{ \$lt: orderScheduleUpperBound \}/);
  assert.match(queueRoute, /"delivery\.preferredDate": \{ \$lt: orderScheduleUpperBound \}/);
  assert.match(queueRoute, /const orderFields = "bookingId orderReference status fulfillmentType/);
  assert.match(queueRoute, /\.select\(orderFields\)/);
  assert.match(queueRoute, /const bookingFields = "status paymentStatus paymentMethod bookingDate preferredDate startTime/);
  assert.match(queueRoute, /\.select\(bookingFields\)/);
});
