"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const viewsRoot = path.join(__dirname, "../views/pages/admin/Appointments");
const calendar = fs.readFileSync(path.join(viewsRoot, "Calendar.ejs"), "utf8");
const workspace = fs.readFileSync(path.join(viewsRoot, "AppointmentsUnified.ejs"), "utf8");
const orderScript = fs.readFileSync(path.join(__dirname, "../public/js/admin-aircon-orders.js"), "utf8");

test("calendar full-record actions carry the selected work identifier", () => {
  assert.match(calendar, /calendarBookingsPath \+ "\?sel=" \+ encodeURIComponent\(id\)/);
  assert.match(calendar, /calendarOrdersPath \+ "\?order=" \+ encodeURIComponent\(id\)/);
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
