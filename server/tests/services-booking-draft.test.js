"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
  assert.match(servicesScript, /const BOOKING_STORAGE_VERSION = 3/);
  assert.match(servicesScript, /calidro_booking_progress_v3_\$\{BOOKING_CUSTOMER_ID\}/);
  assert.match(servicesView, /data-customer-id=/);
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
  assert.match(servicesScript, /system explicitly so saved drafts are actually restored after a reload\.\s*initMultiServiceBooking\(\);/);
  assert.match(servicesScript, /const renderedAsLoggedIn = document\.getElementById\('entStepper'\)\?\.dataset\.authenticated === 'true'/);
  assert.match(servicesScript, /normalizeBookingStep\(data\?\.currentStep, 1\) > 1/);
  assert.match(servicesScript, /if \(BookingState\.draftRestored\)/);
  assert.match(servicesScript, /const stepToRestore = Math\.min\(getRestorableBookingStep\(\), 5\)/);
  assert.match(servicesScript, /restoreBookingProgressUI\(\)/);
  assert.doesNotMatch(
    servicesScript,
    /const stepToRestore = Math\.min\(BookingState\.maxReachedStep \|\| 1, 6\)/,
  );
});

test("booking drafts require the server-rendered customer identity and a live session", () => {
  assert.match(servicesScript, /async function hasActiveBookingCustomerSession/);
  assert.match(servicesScript, /result\?\.user\?\.role === 'customer'/);
  assert.match(servicesScript, /if \(!renderedAsLoggedIn \|\| activeSession === false\)/);
  assert.match(servicesScript, /if \(!response\.ok\) return null/);
  assert.match(servicesScript, /if \(active === false\) lockBookingAfterLogout\(\)/);
  assert.match(servicesScript, /window\.addEventListener\('racs:logout', lockBookingAfterLogout\)/);
  assert.doesNotMatch(servicesScript, /const userElements = document\.querySelectorAll/);
});

test("drafts save during mobile page lifecycle and critical booking mutations", () => {
  assert.match(servicesScript, /window\.addEventListener\('pagehide', saveBookingProgress\)/);
  assert.match(servicesScript, /document\.visibilityState === 'hidden'/);
  assert.match(servicesScript, /BookingState\.selectedServices\.push\(serviceItem\);[\s\S]*?saveBookingProgress\(\)/);
  assert.match(servicesScript, /BookingState\.customerLocation = \{ address: manualAddress \|\| coordinateLabel,[\s\S]*?scheduleBookingProgressSave\(\)/);
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

test("changing project workload clears the old range and requires a new appointment time", () => {
  const start = servicesScript.indexOf("function selectedUnitTotal() {");
  const end = servicesScript.indexOf("function remainingBookingUnits()", start);
  assert.ok(start > 0 && end > start);
  const bookingState = {
    selectedServices: [{ id: "cleaning", quantity: 8, duration: 60 }],
    selectedDate: new Date("2027-01-10T00:00:00"),
    selectedTimeSlot: null,
    isProject: true,
    projectScheduling: { endDate: "2027-01-12" },
  };
  let saves = 0;
  const context = {
    BookingState: bookingState,
    window: { __bookingPolicy: { largeProjectThresholdHours: 8 } },
    document: { getElementById: () => null },
    syncScheduleNextAction: () => {},
    scheduleBookingProgressSave: () => { saves += 1; },
  };
  vm.runInNewContext(`const LARGE_SCALE_MIN_UNITS = 8;\n${servicesScript.slice(start, end)}\nthis.bookingSchedule = { reconcileBookingScheduleAfterServiceChange, bookingRequiresProjectSchedule };`, context);
  context.bookingSchedule.reconcileBookingScheduleAfterServiceChange();
  bookingState.selectedServices[0].quantity = 1;
  context.bookingSchedule.reconcileBookingScheduleAfterServiceChange();
  assert.equal(context.bookingSchedule.bookingRequiresProjectSchedule(), false);
  assert.equal(bookingState.selectedDate, null);
  assert.equal(bookingState.projectScheduling, null);
  assert.equal(bookingState.isProject, false);
  assert.equal(saves, 1);

  bookingState.selectedDate = new Date("2027-01-10T00:00:00");
  bookingState.selectedTimeSlot = { startTime: "09:00" };
  context.bookingSchedule.reconcileBookingScheduleAfterServiceChange();
  assert.ok(bookingState.selectedTimeSlot);
  bookingState.selectedServices[0].quantity = 8;
  context.bookingSchedule.reconcileBookingScheduleAfterServiceChange();
  assert.equal(context.bookingSchedule.bookingRequiresProjectSchedule(), true);
  assert.equal(bookingState.selectedDate, null);
  assert.equal(bookingState.selectedTimeSlot, null);
  assert.equal(saves, 2);
});

test("large uploads and payment evidence are not written to localStorage", () => {
  assert.match(servicesScript, /const \{ photos, proof, paymentProof, \.\.\.safeService \} = service/);
  assert.match(servicesScript, /\.map\(createPersistedServiceSnapshot\)/);
  assert.doesNotMatch(servicesScript, /paymentProof:\s*BookingState/);
});

test("successful submission disables re-saving and refreshed assets bypass stale browser caches", () => {
  assert.match(servicesScript, /if \(BookingState\.draftPersistenceDisabled \|\| !BOOKING_CUSTOMER_ID\) return false/);
  assert.match(servicesScript, /BookingState\.draftPersistenceDisabled = true;\s*localStorage\.removeItem/);
  assert.match(servicesView, /enterprise-calendar\.js\?v=[^'"\s]+/);
  assert.match(servicesView, /services-multi\.js\?v=[^'"\s]+/);
  assert.match(servicesView, /if\(typeof window\.saveBookingProgress==='function'\) window\.saveBookingProgress\(\)/);
  assert.doesNotMatch(servicesScript, /event\.returnValue\s*=\s*''/);
});

test("booking validation points to the exact missing field after the popup", () => {
  assert.match(servicesScript, /focusTarget\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
  assert.match(servicesScript, /focusTarget\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(servicesScript, /\}\)\.then\(\(\) => focusBookingRequirement\(issue\)\)/);
});
