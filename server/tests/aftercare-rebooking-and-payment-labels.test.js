"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { manilaDateKey, firstMaintenanceSlot } = require("../utils/maintenanceBooking");
const BookingService = require("../models/BookingService");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("aftercare creates a repeat booking for on-site collection without a deposit", () => {
  const aftercare = read("public/js/maintenance-customer.js");
  const routes = read("routes/maintenanceRoutes.js");
  assert.match(aftercare, /if \(bookButton\) return bookMaintenance\(bookButton\)/);
  assert.match(aftercare, /\/api\/maintenance\/schedules\/\$\{encodeURIComponent\(button\.dataset\.scheduleId\)\}\/book/);
  assert.match(routes, /router\.post\("\/schedules\/:id\/book", auth\.requireRole\("customer"\)/);
  assert.match(routes, /await linkScheduleToBooking\(/);
  assert.match(routes, /paymentStatus: "pending"/);
  assert.match(routes, /paymentOnSite: true/);
  assert.match(routes, /downpaymentAmount: 0/);
  assert.match(routes, /status: "awaiting_assignment"/);
  assert.match(routes, /paymentChannel: "other"/);
  assert.match(routes, /amountPaid: 0/);
  assert.match(routes, /await authoritativeDeliveryQuote\(/);
  assert.match(routes, /return res\.json\(\{ booking: existing, alreadyBooked: true \}\)/);
});

test("technician sees the full on-site amount and can use normal collection", () => {
  const api = read("routes/technicianApi.js");
  const view = read("views/pages/technician/assignments.ejs");
  assert.match(api, /item\.paymentOnSite = bk\.maintenance\?\.paymentOnSite === true/);
  assert.match(api, /assignment\.paymentOnSite = bk\.maintenance\?\.paymentOnSite === true/);
  assert.match(view, /paymentOnSite \? 'PAY ON SITE'/);
  assert.match(view, /paymentOnSite \? 'Collect on site' : 'Balance due'/);
  assert.match(api, /router\.post\("\/assignments\/:id\/collect-payment"/);
});

test("only maintenance marked pay-on-site can skip the COD downpayment", async () => {
  const base = { bookingDate: new Date("2026-12-24T00:00:00Z"), paymentMethod: "cod", downpaymentAmount: 0 };
  await new BookingService({ ...base, maintenance: { isMaintenance: true, paymentOnSite: true } }).validate();
  await assert.rejects(
    new BookingService({ ...base, maintenance: { isMaintenance: true } }).validate(),
    /Downpayment amount is required/,
  );
});

test("next maintenance time uses Manila date and the first truly available slot", async () => {
  assert.equal(manilaDateKey(new Date("2026-09-25T17:00:00Z")), "2026-09-26");
  const queries = [];
  const selected = await firstMaintenanceSlot("2026-09-26", 120, 45, async (query) => {
    queries.push(query);
    return { statusCode: 200, payload: { timeSlots: query.date === "2026-09-27"
      ? [{ startTime: "08:00", available: false }, { startTime: "08:30", available: true }]
      : [] } };
  });
  assert.deepEqual(selected, { date: "2026-09-27", startTime: "08:30" });
  assert.deepEqual(queries.map((query) => query.date), ["2026-09-26", "2026-09-27"]);
  assert.equal(queries[0].travelTime, "45");
  assert.equal(await firstMaintenanceSlot("2026-09-26", 120, 45,
    async () => ({ statusCode: 200, payload: { timeSlots: [] } }), 2), null);
});

test("technician payment snapshot does not call a full GCash payment a down payment", () => {
  const view = read("views/pages/technician/assignments.ejs");
  assert.match(view, /toLowerCase\(\) === 'gcash' \? 'Full payment' : 'Down payment'/);
});
