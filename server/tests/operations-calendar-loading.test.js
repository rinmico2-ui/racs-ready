"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseOperationsCalendarRange } = require("../utils/operationsCalendarRange");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("operations calendar accepts visible ranges but rejects unbounded scans", () => {
  const range = parseOperationsCalendarRange("2026-09-01", "2026-10-12");
  assert.equal(range.startDate.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(range.endDate.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.throws(() => parseOperationsCalendarRange("2026-09-01", "2026-12-01"), /between 1 and 62 days/);
  assert.throws(() => parseOperationsCalendarRange("2026-09-31", "2026-10-01"), /valid YYYY-MM-DD/);
  assert.throws(() => parseOperationsCalendarRange("2026-10-01", "2026-09-01"), /between 1 and 62 days/);
  assert.throws(() => parseOperationsCalendarRange(undefined, undefined), /valid YYYY-MM-DD/);
});

test("admin calendar uses small, date-bounded feeds instead of list KPIs and pagination", () => {
  const pages = read("routes/pages.js");
  const appointments = read("routes/appointmentRoutes.js");
  const orders = read("routes/orderRoutes.js");
  const calendar = read("views/pages/admin/Appointments/Calendar.ejs");
  const bookingModel = read("models/BookingService.js");
  const orderModel = read("models/Order.js");

  assert.match(pages, /calendarAppointmentsListApi: "\/api\/appointments\/calendar"/);
  assert.match(pages, /calendarOrdersListApi: "\/api\/orders\/calendar"/);
  assert.match(appointments, /router\.get\("\/calendar", auth\.authenticate, auth\.requireRole\(\["admin", "secretary"\]\)/);
  assert.match(orders, /router\.get\("\/calendar", authenticate, requireRole\(\["admin", "secretary"\]\)/);
  assert.match(appointments, /BookingService\.find\(\{ bookingDate \}\)[\s\S]*?\.select\(/);
  assert.match(orders, /Order\.find\(\{ \$or: \[[\s\S]*?\.select\(/);
  assert.match(calendar, /if \(calendarRangeController\) calendarRangeController\.abort\(\)/);
  assert.match(calendar, /loadSchedulesInBackground\(\)/);
  assert.match(calendar, /Promise\.allSettled\(\[[\s\S]*?fetchAppointmentsForRange[\s\S]*?showLoadedResults\(\)[\s\S]*?fetchOrdersForRange/);
  assert.match(bookingModel, /bookingSchema\.index\(\{ bookingDate: 1, startTime: 1, _id: 1 \}\)/);
  assert.match(orderModel, /orderSchema\.index\(\{ "delivery\.preferredDate": 1 \}\)/);
  assert.match(orderModel, /orderSchema\.index\(\{ pickupDate: 1 \}\)/);
});
