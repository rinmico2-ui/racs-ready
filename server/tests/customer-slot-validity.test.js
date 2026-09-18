"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

const scheduleRoutes = read("routes/scheduleRoutes.js");
const productRoutes = read("routes/productRoutes.js");
const bookingPolicy = read("utils/bookingPolicy.js");
const checkoutCalendar = read("public/js/checkout-calendar.js");
const enterpriseCalendar = read("public/js/enterprise-calendar.js");
const cartWizard = read("views/partials/cart-wizard.ejs");
const directWizard = read("views/partials/aircons.ejs");
const serviceBooking = read("public/js/services-multi.js");

test("service and product slot generation use the Manila timing guard", () => {
  assert.match(scheduleRoutes, /manilaSlotTiming\(requestedDateKey, slotStart/);
  assert.match(scheduleRoutes, /manilaSlotTiming\(dateKey, currentStart/);
  assert.match(productRoutes, /manilaSlotTiming\(dateKey, s/);
  assert.match(bookingPolicy, /manilaSlotTiming\(bookingDate, startMin/);
});

test("both customer checkout calendars revalidate a selected slot", () => {
  assert.match(checkoutCalendar, /async validateSelectedSlot\(dateValue, timeValue\)/);
  assert.match(checkoutCalendar, /cache: 'no-store'/);
  assert.match(cartWizard, /await checkoutCalendar\.validateSelectedSlot\(/);
  assert.match(directWizard, /await checkoutCalendar\.validateSelectedSlot\(date, timeSlot\)/);
  assert.match(enterpriseCalendar, /async function validateSelectedSlot\(\)/);
  assert.match(serviceBooking, /await EnterpriseCalendar\.validateSelectedSlot\(\)/);
});

test("stale selections are cleared and customers are asked to choose again", () => {
  assert.match(checkoutCalendar, /this\.state\.selectedTimeSlot = null/);
  assert.match(enterpriseCalendar, /window\.BookingState\.selectedTimeSlot = null/);
  for (const source of [cartWizard, directWizard, serviceBooking]) {
    assert.match(source, /Time Slot No Longer Available|time slot has passed or was just reserved/i);
  }
});
