"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const viewsRoot = path.join(__dirname, "../views/pages/admin/Appointments");
const calendar = fs.readFileSync(path.join(viewsRoot, "Calendar.ejs"), "utf8");
const workspace = fs.readFileSync(path.join(viewsRoot, "AppointmentsUnified.ejs"), "utf8");
const orderScript = fs.readFileSync(path.join(__dirname, "../public/js/admin-aircon-orders.js"), "utf8");
const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
const adminSidebar = fs.readFileSync(path.join(__dirname, "../views/partials/admin-sidebar.ejs"), "utf8");
const secretarySidebar = fs.readFileSync(path.join(__dirname, "../views/partials/secretary-sidebar.ejs"), "utf8");

test("calendar full-record actions carry the selected work identifier", () => {
  assert.match(calendar, /calendarBookingsPath \+ "\?" \+ encodeURIComponent\(calendarBookingsQueryParam\)/);
  assert.match(calendar, /calendarOrdersPath \+ "\?" \+ encodeURIComponent\(calendarOrdersQueryParam\)/);
});

test("appointments workspace opens the booking selected by the calendar", () => {
  assert.match(workspace, /linkedBookingId=params\.get\('sel'\)/);
  assert.match(workspace, /\^\[a-f\\d\]\{24\}\$/);
  assert.match(workspace, /AU\.Queue\.viewBooking\(linkedBookingId\)/);
});

test("orders workspace opens the order selected by the calendar", () => {
  assert.match(orderScript, /linkedOrderId = new URLSearchParams\(window\.location\.search\)\.get\("order"\)/);
  assert.match(orderScript, /window\._aoViewOrder\(linkedOrderId\)/);
});

test("operations calendar is a standalone shared workspace", () => {
  assert.match(pages, /"\/admin\/operations\/calendar"/);
  assert.match(pages, /"\/secretary\/operations\/calendar"/);
  assert.match(adminSidebar, /href="\/admin\/operations\/calendar"[\s\S]*?Operations Calendar/);
  assert.match(secretarySidebar, /href="\/secretary\/operations\/calendar"[\s\S]*?Operations Calendar/);
  assert.doesNotMatch(adminSidebar, /href="\/admin\/appointments\/calendar"/);
  assert.doesNotMatch(secretarySidebar, /href="\/secretary\/calendar"/);
});

test("operations calendar loads both booking and order schedules", () => {
  assert.match(calendar, /fetch\(calendarAppointmentsListApi \+ "\?" \+ params\.toString\(\)/);
  assert.match(calendar, /fetch\(calendarOrdersListApi \+ "\?" \+ params\.toString\(\)/);
  assert.match(calendar, /id="calToggleBookings"/);
  assert.match(calendar, /id="calToggleOrders"/);
  assert.match(calendar, /state\.allOrders = orders\.filter\(o => orderScheduledDate\(o\)\)/);
  assert.match(calendar, /const source = state\.showBookings \? state\.appointments : \[\]/);
  assert.match(calendar, /const orderSource = state\.showOrders \? state\.orders : \[\]/);
});
