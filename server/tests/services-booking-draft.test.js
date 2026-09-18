"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const servicesScript = fs.readFileSync(
  path.join(__dirname, "../public/js/services-multi.js"),
  "utf8",
);
const calendarScript = fs.readFileSync(
  path.join(__dirname, "../public/js/enterprise-calendar.js"),
  "utf8",
);
const servicesView = fs.readFileSync(
  path.join(__dirname, "../views/pages/services.ejs"),
  "utf8",
);

test("unfinished bookings use a versioned, expiring local draft", () => {
  assert.match(servicesScript, /const BOOKING_STORAGE_VERSION = 2/);
  assert.match(servicesScript, /const BOOKING_STORAGE_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(servicesScript, /version: BOOKING_STORAGE_VERSION/);
  assert.match(servicesScript, /Date\.now\(\) - data\.savedAt > BOOKING_STORAGE_MAX_AGE_MS/);
  assert.match(servicesScript, /localStorage\.setItem\(BOOKING_STORAGE_KEY, JSON\.stringify\(data\)\)/);
});

test("draft persistence uses the active booking fields and actual current step", () => {
  assert.match(servicesScript, /selectedDate: serializeBookingDate\(BookingState\.selectedDate \|\| BookingState\.scheduleDate\)/);
  assert.match(servicesScript, /selectedTimeSlot: BookingState\.selectedTimeSlot \|\| null/);
  assert.match(servicesScript, /currentStep: normalizeBookingStep\(BookingState\.currentStep, 1\)/);
  assert.match(servicesScript, /BookingState\.selectedDate = parsedDate/);
  assert.match(servicesScript, /BookingState\.selectedTimeSlot = data\.selectedTimeSlot \|\| null/);
  assert.match(servicesScript, /BookingState\.paymentMethod = \['gcash', 'cod'\]\.includes\(data\.paymentMethod\)/);
  assert.match(servicesScript, /BookingState\.currentStep = normalizeBookingStep\(data\.currentStep \|\| data\.maxReachedStep, 1\)/);
});

test("a draft can restore before a service is added and resumes only at a valid step", () => {
  assert.match(servicesScript, /normalizeBookingStep\(data\?\.currentStep, 1\) > 1/);
  assert.match(servicesScript, /if \(BookingState\.draftRestored\)/);
  assert.match(servicesScript, /const stepToRestore = getRestorableBookingStep\(\)/);
  assert.match(servicesScript, /restoreBookingProgressUI\(\)/);
  assert.doesNotMatch(
    servicesScript,
    /const stepToRestore = Math\.min\(BookingState\.maxReachedStep \|\| 1, 6\)/,
  );
});

test("drafts save during mobile page lifecycle and critical booking mutations", () => {
  assert.match(servicesScript, /window\.addEventListener\('pagehide', saveBookingProgress\)/);
  assert.match(servicesScript, /document\.visibilityState === 'hidden'/);
  assert.match(servicesScript, /BookingState\.selectedServices\.push\(serviceItem\);[\s\S]*?saveBookingProgress\(\)/);
  assert.match(servicesScript, /BookingState\.customerLocation = \{ address: coordinateLabel,[\s\S]*?scheduleBookingProgressSave\(\)/);
  assert.match(servicesScript, /BookingState\.selectedDate = date;\s*saveBookingProgress\(\)/);
  assert.match(calendarScript, /BookingState\.selectedTimeSlot = _selectedSlot;[\s\S]*?window\.saveBookingProgress\(\)/);
  assert.match(calendarScript, /BookingState\.projectScheduling = selection;\s*if \(typeof window\.saveBookingProgress/);
});

test("the calendar rehydrates saved dates, time slots, and project ranges", () => {
  assert.match(calendarScript, /const restoredDate = window\.BookingState\.selectedDate \|\| window\.BookingState\.scheduleDate/);
  assert.match(calendarScript, /_selectedSlot = window\.BookingState\.selectedTimeSlot \|\| null/);
  assert.match(calendarScript, /const restoredEndDate = window\.BookingState\.projectScheduling\?\.endDate/);
  assert.match(calendarScript, /_currentMonth = _selectedDate \? new Date\(_selectedDate\) : new Date\(\)/);
  assert.match(calendarScript, /if \(_mode === 'appointment' && _selectedDate\) await loadTimeSlots\(_selectedDate\)/);
  assert.match(servicesScript, /const hasUsableDate = selectedDate[\s\S]*?selectedDate >= today/);
});

test("large uploads and payment evidence are not written to localStorage", () => {
  assert.match(servicesScript, /const \{ photos, proof, paymentProof, \.\.\.safeService \} = service/);
  assert.match(servicesScript, /\.map\(createPersistedServiceSnapshot\)/);
  assert.doesNotMatch(servicesScript, /paymentProof:\s*BookingState/);
});

test("successful submission disables re-saving and refreshed assets bypass stale browser caches", () => {
  assert.match(servicesScript, /if \(BookingState\.draftPersistenceDisabled\) return false/);
  assert.match(servicesScript, /BookingState\.draftPersistenceDisabled = true;\s*localStorage\.removeItem/);
  assert.match(servicesView, /enterprise-calendar\.js\?v=20260917-manila-slots-v1/);
  assert.match(servicesView, /services-multi\.js\?v=20260917-card-checkout-v1/);
  assert.match(servicesView, /if\(typeof window\.saveBookingProgress==='function'\) window\.saveBookingProgress\(\)/);
});
