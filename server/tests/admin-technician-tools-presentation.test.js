"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

const pages = read("../routes/pages.js");
const appointmentsApi = read("../routes/appointmentManagement.js");
const sidebar = read("../views/partials/admin-sidebar.ejs");
const view = read("../views/pages/admin/Inventory/TechnicianTools.ejs");
const client = read("../public/js/technician-tools-admin.js");

test("admin Technician Tools workspace is routed and discoverable", () => {
  assert.match(pages, /\/admin\/inventory\/technician-tools/);
  assert.match(pages, /pages\/admin\/Inventory\/TechnicianTools/);
  assert.match(sidebar, /href="\/admin\/inventory\/technician-tools"/);
  assert.match(view, /id="ttaDate"/);
  assert.match(view, /id="ttaTechnician"/);
  assert.match(view, /id="ttaDetailModal"/);
});

test("Daily Kit audit API is registered before the dynamic appointment route", () => {
  const dailyKitRoute = appointmentsApi.indexOf("router.get('/daily-kits'");
  const appointmentDetailRoute = appointmentsApi.indexOf("router.get('/:id'");
  assert.ok(dailyKitRoute >= 0, "daily-kit audit route should exist");
  assert.ok(appointmentDetailRoute >= 0, "appointment detail route should exist");
  assert.ok(dailyKitRoute < appointmentDetailRoute, "static daily-kit route must not be swallowed by /:id");
});

test("admin audit response joins bookings, orders, custody, and active technicians", () => {
  assert.match(appointmentsApi, /BookingService\.find\(\{ _id: \{ \$in: bookingIds \} \}\)/);
  assert.match(appointmentsApi, /Order\.find\(\{ _id: \{ \$in: orderIds \} \}\)/);
  assert.match(appointmentsApi, /EquipmentAssignment\.find\(\{ dailyKitId: \{ \$in: kitIds \} \}\)/);
  assert.match(appointmentsApi, /Technician\.find\(\{ active: \{ \$ne: false \}, archivedAt: null \}\)/);
  assert.match(appointmentsApi, /summary,/);
});

test("client supports operational filters and a non-mutating Daily Kit drill-down", () => {
  assert.match(client, /\/api\/admin\/appointments\/daily-kits\?date=/);
  assert.match(client, /function matchesFilters/);
  assert.match(client, /function openDetail/);
  assert.doesNotMatch(client, /method:\s*['"](?:POST|PATCH|PUT|DELETE)/);
});
