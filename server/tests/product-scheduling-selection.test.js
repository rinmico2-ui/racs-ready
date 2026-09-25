"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const calendar = read("public/js/checkout-calendar.js");
const cart = read("views/partials/cart-wizard.ejs");
const direct = read("views/partials/aircons.ejs");

test("product scheduling uses simple date and time labels in both checkouts", () => {
  assert.match(calendar, /slotsText = 'Open'/);
  assert.match(calendar, /slotsText = 'Few left'/);
  assert.match(calendar, /Choose a start time/);
  assert.match(calendar, /statusLabel = selected \? 'Selected' : 'Available'/);
  assert.doesNotMatch(calendar, /Teams Available|Past Date|\$\{availInfo\.availableSlots\} slots/);
  assert.match(cart, /future-date-v3/);
  assert.match(direct, /future-date-v3/);
});

test("choosing a product delivery time reveals an explicit next action", () => {
  assert.match(calendar, /id="coScheduleNext" role="status" aria-live="polite" hidden/);
  assert.match(calendar, /Continue to payment/);
  assert.match(calendar, /window\.wizardNext\?\.\(\)/);
  assert.match(calendar, /this\._syncNextAction\(date\)/);
  assert.match(cart, /checkoutCalendar\?\.restoreSelection\(draft\.preferredDate, draft\.timeSlot\)/);
  assert.match(direct, /checkoutCalendar\?\.restoreSelection\(draft\.preferredDate, draft\.timeSlot\)/);
});

test("calendar never invents available times when the scheduling API fails", () => {
  assert.match(calendar, /Could not check available times\. Please try again/);
  assert.match(calendar, /Could not check open dates\. Please try again/);
  assert.match(calendar, /validateSelectedSlot\(dateValue, timeValue\)/);
  assert.doesNotMatch(calendar, /using fallback|const startMin = 480|reservedCount > 0/);
});

test("product calendar never offers today when the order API requires a future date", () => {
  assert.match(calendar, /const isPast = key <= this\._formatKey\(today\)/);
  assert.match(calendar, /if \(dateObj <= today\) return/);
});
