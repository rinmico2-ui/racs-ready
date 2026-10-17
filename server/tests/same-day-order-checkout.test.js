'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../public/js/order-schedule-policy');
const { validateCheckoutSelection, validatePickupDate, DEFAULT_STORE_HOURS } = require('../utils/orderCheckoutPolicy');
const { validateInstallationWindow } = require('../utils/orderInstallationProject');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const morning = new Date('2026-10-17T02:00:00Z'); // 10 AM Philippine time
const deliveryInput = () => ({
  fulfillmentType: 'delivery_installation', paymentMethod: 'cod', timeSlot: '12:30 PM',
  delivery: { address: '123 Main Street, Nueva Ecija', contactNumber: '09171234567',
    preferredDate: '2026-10-17', coordinates: { lat: 15.2, lng: 120.9 } },
});

for (const timeZone of ['UTC', 'Asia/Manila', 'America/Los_Angeles']) {
  test(`${timeZone}: delivery and pickup permit the current Philippine date and reject yesterday`, t => {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const now = new Date('2026-10-16T17:00:00Z'); // Oct 17, 1 AM; Oct 16 in UTC/US
    assert.equal(policy.todayKey(now), '2026-10-17');
    const result = validateCheckoutSelection(deliveryInput(), { now });
    assert.equal(result.delivery.preferredDate.toISOString().slice(0, 10), '2026-10-17');
    assert.equal(validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, now).toISOString().slice(0, 10), '2026-10-17');
    const yesterday = deliveryInput(); yesterday.delivery.preferredDate = '2026-10-16';
    assert.throws(() => validateCheckoutSelection(yesterday, { now }), { code: 'ORDER_DELIVERY_DATE_INVALID' });
    assert.throws(() => validatePickupDate('2026-10-16', DEFAULT_STORE_HOURS, now), { code: 'ORDER_PICKUP_DATE_INVALID' });
  });
}

test('same-day starts honor exact advance notice, seconds, configured zero and Philippine midnight', () => {
  assert.equal(policy.isSlotBookable('2026-10-17', 719, 120, morning), false);
  assert.equal(policy.isSlotBookable('2026-10-17', 720, 120, morning), true);
  assert.equal(policy.isSlotBookable('2026-10-17', 720, 120, new Date(+morning + 1000)), false);
  assert.equal(policy.isSlotBookable('2026-10-17', 630, 0, morning), true);
  assert.equal(policy.isSlotBookable('2026-10-17', 629, 0, morning), false);
  assert.equal(policy.isSlotBookable('2026-10-18', 60, 120, new Date('2026-10-17T15:30:00Z')), false);
  assert.equal(policy.isSlotBookable('2026-10-18', 90, 120, new Date('2026-10-17T15:30:00Z')), true);
  assert.equal(policy.isSlotBookable('2026-02-30', 720, 120, morning), false);
  assert.equal(policy.isSlotBookable('2026-10-17', NaN, 120, morning), false);
});

test('same-day pickup honors opening days, closing cutoff and the configured notice', () => {
  assert.doesNotThrow(() => validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, morning));
  const cutoff = new Date('2026-10-17T08:00:00Z'); // 4 PM, closes 6 PM
  assert.throws(() => validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, cutoff), { code: 'ORDER_PICKUP_STORE_CLOSED' });
  assert.doesNotThrow(() => validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, new Date(+cutoff - 1000)));
  assert.doesNotThrow(() => validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, cutoff, 60));
  assert.throws(() => validatePickupDate('2026-10-18', DEFAULT_STORE_HOURS, morning), { code: 'ORDER_PICKUP_STORE_CLOSED' });
  assert.throws(() => validatePickupDate('2026-10-17', DEFAULT_STORE_HOURS, new Date('2026-10-17T12:00:00Z')), { code: 'ORDER_PICKUP_STORE_CLOSED' });
  assert.equal(policy.isPickupAvailable('2026-10-17', null, 120, morning), false);
  const pickup = { fulfillmentType: 'customer_pickup', paymentMethod: 'cash_onsite', pickupDate: '2026-10-17' };
  assert.doesNotThrow(() => validateCheckoutSelection(pickup, { storeHours: DEFAULT_STORE_HOURS, now: cutoff, minAdvanceNoticeMinutes: 60 }));
});

test('large installations still require a future planning window', () => {
  assert.throws(() => validateInstallationWindow({ preferredStartDate: '2026-10-17', preferredCompletionDeadline: '2026-10-20' }, null, morning), { code: 'ORDER_PROJECT_WINDOW_INVALID' });
});

function calendarFixture(instant = morning, availableSlots = 2) {
  let current = +instant;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  let payload = { minAdvanceNoticeMinutes: 120, timeSlots: [
    { startTime: '11:30 AM', available: true },
    { startTime: '12:30 PM', available: true },
    { startTime: '01:00 PM', available: false },
  ] };
  const element = () => ({ innerHTML: '', textContent: '', style: {}, hidden: true,
    querySelectorAll: () => [], setAttribute() {} });
  const window = { __bookingPolicy: { minAdvanceNoticeMinutes: 120 } };
  const sandbox = { window, Date: ClockDate, console: { warn() {} }, URLSearchParams,
    document: { getElementById: () => null },
    fetch: async () => ({ ok: true, json: async () => payload }) };
  vm.runInNewContext(source('public/js/order-schedule-policy.js'), sandbox);
  vm.runInNewContext(source('public/js/checkout-calendar.js') + '\nwindow.Calendar = CheckoutCalendar;', sandbox);
  const calendar = Object.create(window.Calendar.prototype);
  calendar.state = { activeMonth: new Date('2026-10-01T00:00:00'), selectedDate: null, selectedTimeSlot: null, duration: 60, quantity: 1, travelTime: 30 };
  const events = [];
  calendar.options = { onDateSelect: value => events.push(['date', value]), onTimeSelect: value => events.push(['time', value]) };
  calendar.scheduleData = { availableDates: [{ date: '2026-10-17', availableSlots }] };
  calendar.holidaysData = { holidays: [], nonWorkingDays: [] };
  calendar.dom = Object.fromEntries(['grid', 'label', 'prevBtn', 'nextBtn', 'timeSection', 'timeGrid', 'timeDateLabel', 'nextAction', 'nextTitle'].map(key => [key, element()]));
  return { calendar, events, setPayload(value) { payload = value; }, setTime(value) { current = +value; } };
}

for (const timeZone of ['UTC', 'Asia/Manila', 'America/Los_Angeles']) {
  test(`${timeZone}: the checkout calendar selects today using Philippine time and live slots`, async t => {
    const previous = process.env.TZ; process.env.TZ = timeZone;
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const { calendar, events } = calendarFixture();
    calendar.render();
    const cell = calendar.dom.grid.innerHTML.match(/<div class="[^"]*" data-date="2026-10-17"[^>]*>/)[0];
    assert.match(cell, / limited/); assert.match(cell, /role="button"/);
    await calendar.selectDate('2026-10-17');
    assert.ok(events.some(([type, value]) => type === 'date' && value === '2026-10-17'));
    assert.match(calendar.dom.timeGrid.innerHTML, /12:30 PM/);
    assert.doesNotMatch(calendar.dom.timeGrid.innerHTML, /11:30 AM|01:00 PM/);
    assert.equal(await calendar.validateSelectedSlot('2026-10-17', '12:30 PM'), true);
  });
}

test('a saved same-day time is cleared when it expires or capacity is lost', async () => {
  const { calendar, events, setPayload, setTime } = calendarFixture();
  assert.equal(await calendar.validateSelectedSlot('2026-10-17', '12:30 PM'), true);
  setTime(new Date('2026-10-17T02:31:00Z'));
  assert.equal(await calendar.validateSelectedSlot('2026-10-17', '12:30 PM'), false);
  assert.equal(calendar.state.selectedTimeSlot, null);
  assert.ok(events.some(([type, value]) => type === 'time' && value === ''));
  setTime(morning);
  setPayload({ timeSlots: [] });
  assert.equal(await calendar.validateSelectedSlot('2026-10-17', '12:30 PM'), false);
});

test('today is disabled when full, a holiday, or missing from live availability', () => {
  for (const reason of ['full', 'holiday', 'closed']) {
    const { calendar } = calendarFixture(morning, reason === 'full' ? 0 : 2);
    if (reason === 'holiday') calendar.holidaysData.holidays = [{ date: '2026-10-17T00:00:00Z', name: 'Holiday' }];
    if (reason === 'closed') calendar.scheduleData.availableDates = [];
    calendar.render();
    const cell = calendar.dom.grid.innerHTML.match(/<div class="[^"]*" data-date="2026-10-17"[^>]*>/)[0];
    assert.doesNotMatch(cell, /role="button"/);
  }
});
