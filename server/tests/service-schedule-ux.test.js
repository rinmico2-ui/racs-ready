"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const calendar = read("public/js/enterprise-calendar.js");
const styles = read("public/css/enterprise-calendar.css");
const view = read("views/pages/services.ejs");
const scheduleRoute = read("routes/scheduleRoutes.js");

test("date and time availability are labeled according to their API meanings", () => {
  assert.match(scheduleRoute, /Count distinct time windows[\s\S]*?availableSlots: dayTotalAvailable/);
  assert.match(scheduleRoute, /const availableCount = countFreeTechs\(slotStart, slotEnd\)/);
  assert.match(calendar, /tooltipText = `\$\{count\} start time\$\{count !== 1 \? 's' : ''\} available/);
  assert.match(calendar, /statusLabel = isSelected \? 'Selected' : 'Available'/);
  assert.doesNotMatch(calendar, /Availability ng buong service team|1 team na lang|Lumipas na/);
});

test("appointment time choices do not expose technician counts", () => {
  const times = calendar.slice(calendar.indexOf("function renderTimeSlotsUI"), calendar.indexOf("PROJECT MODE"));
  assert.doesNotMatch(times, /technician|slot\.availableCount/);
  assert.match(times, /statusLabel = isSelected \? 'Selected' : 'Available'/);
  assert.match(times, /statusLabel = 'Fully booked'/);
  assert.match(view, /enterprise-calendar\.js\?v=20260925-schedule-next-v6/);
});

test("calendar cells show only the day number; counts appear after choosing a date", () => {
  const appointment = calendar.slice(calendar.indexOf("function renderAppointmentMode()"), calendar.indexOf("async function handleDateSelect"));
  assert.match(appointment, /Tap a green or orange date to see its available times/);
  assert.match(appointment, /<span class="ent-cal-date">\$\{day\}<\/span>/);
  assert.doesNotMatch(appointment, /<span class="ent-cal-slots">|slotsText =/);
  assert.match(calendar, /const availableTimes = slots\.filter/);
  assert.match(calendar, /class="ent-time-count"/);
  assert.match(view, /enterprise-calendar\.css\?v=20260925-date-only-v4/);
});

test("the schedule guides users from date to time with accessible choices", () => {
  assert.match(view, /Pick a date, then choose a start time/);
  assert.match(calendar, /Now pick a start time/);
  assert.match(calendar, /aria-pressed=/);
  assert.match(calendar, /el\.addEventListener\('keydown'/);
  assert.match(styles, /\.ent-time-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(156px, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 575px\)[\s\S]*?\.ent-time-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("empty or failed schedule responses never create unverified booking times", () => {
  assert.match(calendar, /if \(apiResult && Array\.isArray\(apiResult\.slots\)\) \{\s*renderTimeSlotsUI\(grid, apiResult\.slots\)/);
  assert.match(calendar, /We could not check available times/);
  assert.match(calendar, /ent-time-retry/);
  assert.doesNotMatch(calendar, /Fallback: generate client-side dynamic slots/);
});

test("changing the date clears the previous time before a new one is chosen", () => {
  assert.match(calendar, /async function handleDateSelect[\s\S]*?BookingState\.selectedTimeSlot = null;[\s\S]*?BookingState\.scheduleTime = null;/);
  assert.match(calendar, /window\.BookingState\.selectedTime = _selectedSlot\.label;[\s\S]*?window\.BookingState\.scheduleTime = _selectedSlot\.label;/);
});
