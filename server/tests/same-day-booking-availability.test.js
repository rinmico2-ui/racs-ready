"use strict";

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const mongoose = require('mongoose');
const routes = require('../routes/scheduleRoutes');
const engine = require('../utils/enterpriseSchedulingEngine');
const { manilaDateKey, parseAppointmentTime } = require('../utils/bookingDateTime');

function hostTimeZone(t, timeZone) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
}
function query(value) {
  return { select() { return this; }, lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
function fixture(t, options = {}) {
  const technicianId = new mongoose.Types.ObjectId();
  const schedule = { technicianId, workingDays: Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek, startMinutes: 480, endMinutes: 1140 })), nonWorkingWeekdays: [], restDates: [] };
  t.mock.method(require('../models/Technician'), 'find', () => query(options.closed ? [] : [{ _id: technicianId, active: true }]));
  t.mock.method(require('../models/TechnicianSchedule'), 'find', () => query([schedule]));
  for (const name of ['BookingService', 'Assignment', 'DailyAssignment', 'Order']) {
    t.mock.method(require(`../models/${name}`), 'find', () => query([]));
  }
  t.mock.method(require('../models/NonWorkingDay'), 'find', () => query(options.holidays || []));
  t.mock.method(require('../models/LeaveRequest'), 'find', () => query(options.leave
    ? [{ technicianId, startDate: new Date('2026-10-17T00:00:00Z'), endDate: new Date('2026-10-17T23:59:59Z') }] : []));
  t.mock.method(require('../models/SiteSetting'), 'findOne', () => query(null));
  t.mock.method(engine, 'getProjectReservedByDateMap', async () => new Map());
  t.mock.method(engine, 'getProjectReservationsForDate', async () => ({ reservedTechnicians: 0 }));
  // Capacity calculations log counts; fixture requests do not need production logs.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}
async function availableDates() {
  const handler = routes.stack.find(layer => layer.route?.path === '/available-dates').route.stack[0].handle;
  let payload, statusCode = 200;
  const response = { status(code) { statusCode = code; return this; }, json(body) { payload = body; } };
  await handler({ query: { duration: '60', quantity: '1', mode: 'manual' } }, response);
  assert.equal(statusCode, 200, JSON.stringify(payload));
  return payload;
}

for (const timeZone of ['UTC', 'Asia/Manila']) {
  for (const [label, instant] of [
    ['after Philippine midnight while UTC is the prior evening', '2026-10-16T18:30:00Z'],
    ['the Philippine morning', '2026-10-17T02:00:00Z'],
    ['late afternoon with valid evening work hours', '2026-10-17T07:30:00Z'],
  ]) {
    test(`${timeZone}: date and slot APIs agree during ${label}`, async t => {
      hostTimeZone(t, timeZone);
      t.mock.timers.enable({ apis: ['Date'], now: new Date(instant) });
      fixture(t);
      const date = manilaDateKey(new Date());
      const dates = await availableDates();
      const slots = await routes.getTimeSlotsForQuery({ date, duration: '60', quantity: '1' });
      assert.equal(slots.statusCode, 200);
      const available = slots.payload.timeSlots.filter(row => row.available);
      assert.ok(available.length > 0);
      const today = dates.availableDates.find(row => row.date === date);
      assert.ok(today, 'Today must remain selectable when the time-slot API has capacity');
      assert.equal(today.availableSlots, available.length);
      for (const slot of available) {
        const start = new Date(`${date}T00:00:00+08:00`).getTime() + parseAppointmentTime(slot.startTime) * 60000;
        assert.ok(start - Date.now() >= 120 * 60000, 'Two-hour advance notice must remain enforced');
      }
    });
  }
  test(`${timeZone}: no same-day slots are offered when advance notice crosses midnight`, async t => {
    hostTimeZone(t, timeZone);
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T15:00:00Z') });
    fixture(t);
    const dates = await availableDates();
    assert.equal(dates.availableDates.some(row => row.date === '2026-10-17'), false);
    const tomorrow = await routes.getTimeSlotsForQuery({ date: '2026-10-18', duration: '60' });
    assert.ok(tomorrow.payload.timeSlots.length > 0);
    assert.ok(dates.availableDates.some(row => row.date === '2026-10-18'));
  });
}

for (const [label, options] of [
  ['no working technicians', { closed: true }],
  ['approved technician leave', { leave: true }],
  ['a holiday', { holidays: [{ date: new Date('2026-10-17T00:00:00Z') }] }],
]) {
  test(`corrected same-day dates still honor ${label}`, async t => {
    hostTimeZone(t, 'UTC');
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-16T18:30:00Z') });
    fixture(t, options);
    const result = await availableDates();
    assert.equal(result.availableDates.some(row => row.date === '2026-10-17'), false);
  });
}

async function renderCalendar(t, availableSlots) {
  hostTimeZone(t, 'Asia/Manila');
  const instant = new Date('2026-10-17T07:30:00Z').getTime(); // 3:30 PM PHT
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  }
  const grid = { innerHTML: '', querySelectorAll: () => [] };
  const document = { getElementById(id) {
    if (id === 'calendarGrid') return grid;
    if (['calendar-date-colors', 'ent-calendar-styles'].includes(id)) return {};
    return null;
  } };
  const sandbox = { document, window: {}, Date: ClockDate, URLSearchParams, console,
    async fetch(url) { return { ok: true, json: async () => url.includes('booking-policy')
      ? { minAdvanceNoticeMinutes: 120 }
      : url.includes('holidays') ? { holidays: [], nonWorkingDays: [] }
      : { availableDates: [{ date: '2026-10-17', availableSlots }] } }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/enterprise-calendar.js'), 'utf8'), sandbox);
  await sandbox.window.EnterpriseCalendar.init({ duration: 60, quantity: 1, syncGlobalState: false,
    showCommercialProjects: false, autoDetectProject: false });
  return grid.innerHTML.match(/<div class="[^"]*ent-cal-cell[^"]*" data-date="2026-10-17"[^>]*>/)?.[0];
}

test('the calendar keeps today clickable when server-approved slots extend beyond the former 5 PM cutoff', async t => {
  const cell = await renderCalendar(t, 2);
  assert.match(cell, / limited/); assert.match(cell, /role="button"/);
  assert.doesNotMatch(cell, /non-working|Closed Today/);
});

test('the calendar still blocks a date with no remaining capacity', async t => {
  const cell = await renderCalendar(t, 0);
  assert.match(cell, / full/); assert.doesNotMatch(cell, /role="button"/);
});
