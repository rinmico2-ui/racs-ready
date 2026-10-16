'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../public/js/appliance-services');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8').replace(/\r\n/g, '\n');
const calendar = read('enterprise-calendar.js');
const services = read('services-multi.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = data => ({ ok: true, json: async () => data });
const policy = { inspectionDurationMinutes: 90, largeProjectThresholdHours: 8 };

function fixture(override) {
  const state = { selectedServices: [{ id: 'row', serviceId: 'cleaning', type: 'core', duration: 60, quantity: 10 }] };
  const calls = { saves: 0, copies: [], renders: [], fetches: [] };
  const classes = new Set();
  const preferencesHost = { innerHTML: '<button>Old project preferences</button>', querySelector: () => null,
    classList: { add: value => classes.add(value), contains: value => classes.has(value) } };
  const window = { BookingState: state, ApplianceServices: A, __bookingPolicy: policy,
    saveBookingProgress() { calls.saves++; } };
  const context = { window, BookingState: state, URLSearchParams, console, setTimeout,
    document: { getElementById: id => id === 'projectPrefs' ? preferencesHost : null },
    syncScheduleNextAction() {}, syncServiceScheduleCopy(mode) { calls.copies.push(mode); },
    scheduleBookingProgressSave() { calls.saves++; },
    fetch: async (url, options) => {
      calls.fetches.push({ url, options });
      const overridden = override?.(url, options);
      if (overridden) return overridden;
      if (url.includes('booking-policy')) return response(policy);
      if (url.includes('holidays')) return response({ holidays: [], nonWorkingDays: [] });
      if (url.includes('/api/schedule/projects')) return response({ projects: [] });
      if (url.includes('window-availability')) return response({ days: [], totalActiveTechnicians: 2, dailyHours: 8, sufficient: true });
      if (url.includes('time-slots')) return response({ timeSlots: [{ startTime: '08:00', available: true }] });
      return response({ availableDates: [{ date: '2035-01-02', availableSlots: 4 }] });
    },
  };
  window.testRender = mode => calls.renders.push(mode);
  // Run the real request and selection lifecycle, replacing only DOM drawing.
  const exposed = calendar.replace('  return {\n    init,', `
  const draw = render;
  render = () => window.testRender(_mode);
  injectStyles = () => {};
  return {
    validateProjectRange,
    draw,
    snapshot: () => ({ mode: _mode, schedule: _scheduleData, preferences: _projectPreferences }),
    init,`);
  vm.createContext(context);
  vm.runInContext(exposed, context);
  vm.runInContext('const LARGE_SCALE_MIN_UNITS = 8;\n' + services.slice(services.indexOf('function selectedUnitTotal()'), services.indexOf('function remainingBookingUnits()')), context);
  return { api: window.EnterpriseCalendar, context, state, window, calls, preferencesHost };
}
async function initialize(f, mode = 'project') {
  return f.api.init({ mode, serviceId: f.state.selectedServices[0].serviceId,
    duration: 60, quantity: f.state.selectedServices[0].quantity,
    totalEstimatedMinutes: f.state.selectedServices[0].quantity * 60,
    showStartDatePrompt: false });
}
function reconcile(f) { f.context.reconcileBookingScheduleAfterServiceChange(); }
async function selectProject(f) {
  await initialize(f); reconcile(f);
  await f.api.applySuggestedRange('2035-01-02', '2035-01-06');
}

test('project to standard clears all dates, aliases, verdict and calendar preferences immediately', async () => {
  const f = fixture(); await selectProject(f);
  f.state.scheduleDate = f.state.selectedDate;
  f.state.selectedTime = f.state.scheduleTime = 'Old arrival';
  f.api.snapshot().preferences.preferredWorkingHours = 'afternoon';
  f.state.selectedServices[0].quantity = 1; reconcile(f);
  assert.equal(f.api.getMode(), 'appointment');
  for (const key of ['selectedDate', 'scheduleDate', 'selectedTimeSlot', 'selectedTime', 'scheduleTime', 'projectScheduling']) assert.equal(f.state[key], null, key);
  assert.equal(f.state.isProject, false);
  assert.equal(f.api.getSelectedDate(), null);
  assert.equal(f.api.getSelectedEndDate(), null);
  assert.equal(f.api.getWindowVerdict(), null);
  assert.equal(f.api.snapshot().preferences.preferredWorkingHours, 'morning');
  assert.equal(f.preferencesHost.innerHTML, '');
  assert.equal(f.preferencesHost.classList.contains('d-none'), true);
  await initialize(f, 'appointment');
  assert.equal(f.api.getMode(), 'appointment'); assert.equal(f.api.getSelectedDate(), null);
});

test('late project validation cannot restore a cleared range after changing to a standard booking', async () => {
  const pending = deferred(); let validationStarted = false;
  const f = fixture((url, options) => {
    if (url.includes('window-availability') && JSON.parse(options.body).requiredHours) { validationStarted = true; return pending.promise; }
  });
  await initialize(f); reconcile(f);
  const old = f.api.applySuggestedRange('2035-01-02', '2035-01-06');
  assert.equal(validationStarted, true);
  f.state.selectedServices[0].quantity = 1; reconcile(f);
  const saves = f.calls.saves;
  pending.resolve(response({ sufficient: true, window: { startDate: '2035-01-02', endDate: '2035-01-06' } }));
  await old;
  assert.equal(f.api.getMode(), 'appointment');
  assert.equal(f.state.projectScheduling, null); assert.equal(f.state.selectedDate, null);
  assert.equal(f.api.getWindowVerdict(), null); assert.equal(f.calls.saves, saves);
});

test('late project calendar initialization cannot overwrite the current appointment availability', async () => {
  const pending = deferred(), started = deferred(); let count = 0;
  const f = fixture(url => {
    if (url.includes('available-dates') && ++count === 1) { started.resolve(); return pending.promise; }
  });
  reconcile(f); const old = initialize(f); await started.promise;
  f.state.selectedServices[0].quantity = 1; reconcile(f);
  await initialize(f, 'appointment');
  const renders = f.calls.renders.length;
  pending.resolve(response({ blocked: true, message: 'Old project workload' })); await old;
  assert.equal(f.api.getMode(), 'appointment');
  assert.equal(f.api.snapshot().schedule.blocked, undefined);
  assert.equal(f.api.snapshot().schedule.availableDates[0].availableSlots, 4);
  assert.equal(f.calls.renders.length, renders);
});

test('standard to project clears a chosen time and requires a fresh range', async () => {
  const f = fixture(); f.state.selectedServices[0].quantity = 1;
  f.state.selectedDate = f.state.scheduleDate = new Date('2035-01-02T00:00:00');
  f.state.selectedTimeSlot = { startTime: '08:00', label: '8:00 AM' };
  f.state.selectedTime = f.state.scheduleTime = '8:00 AM';
  await initialize(f, 'appointment'); reconcile(f);
  assert.ok(f.api.getSelectedSlot());
  f.state.selectedServices[0].quantity = 10; reconcile(f);
  assert.equal(f.api.isProjectMode(), true);
  assert.equal(f.api.getSelectedSlot(), null); assert.equal(f.state.scheduleTime, null);
  await initialize(f);
  assert.equal(f.api.getSelectedDate(), null); assert.equal(f.api.getSelectedEndDate(), null);
});

test('a changed project workload also invalidates its previous capacity verdict', async () => {
  const f = fixture(); await selectProject(f);
  assert.equal(f.api.getWindowVerdict().sufficient, true);
  f.state.selectedServices[0].quantity = 12; reconcile(f);
  assert.equal(f.api.isProjectMode(), true);
  assert.equal(f.api.getWindowVerdict(), null); assert.equal(f.api.getSelectedEndDate(), null);
});

test('unchanged services preserve the saved range when the calendar is revisited', async () => {
  const f = fixture(); await selectProject(f);
  const saved = f.state.projectScheduling, saves = f.calls.saves;
  reconcile(f); await initialize(f);
  assert.equal(f.state.projectScheduling, saved);
  assert.equal(f.api.formatDateKey(f.api.getSelectedDate()), '2035-01-02');
  assert.equal(f.api.formatDateKey(f.api.getSelectedEndDate()), '2035-01-06');
  assert.equal(f.calls.saves, saves);
});

test('missing policy cannot let obsolete project flags override a standard workload', async () => {
  const f = fixture(); await selectProject(f);
  delete f.window.__bookingPolicy;
  f.state.selectedServices[0].quantity = 1;
  assert.equal(f.context.bookingRequiresProjectSchedule(), false);
  reconcile(f); assert.equal(f.api.getMode(), 'appointment'); assert.equal(f.state.projectScheduling, null);
});

test('replacing a service under the same row ID updates the service used for availability', async () => {
  const f = fixture(); await selectProject(f);
  f.state.selectedServices[0].serviceId = 'installation'; reconcile(f);
  assert.equal(f.state.selectedServiceId, 'installation'); assert.equal(f.state.selectedDate, null);
});

test('switching to a relocation quote removes all project selections and uses preferred dates', async () => {
  const f = fixture(); await selectProject(f);
  f.state.selectedServices[0].relocation = { scope: 'custom_quote' }; reconcile(f);
  assert.equal(f.api.getMode(), 'preferred'); assert.equal(f.state.projectScheduling, null);
  assert.equal(f.api.getSelectedDate(), null);
});

test('late appointment verification cannot approve the old time after a workload change', async () => {
  const pending = deferred(); let delay = false;
  const f = fixture(url => url.includes('time-slots') && delay ? pending.promise : null);
  f.state.selectedServices[0].quantity = 1;
  f.state.selectedDate = new Date('2035-01-02T00:00:00');
  f.state.selectedTimeSlot = { startTime: '08:00' };
  await initialize(f, 'appointment'); reconcile(f);
  delay = true; const verification = f.api.validateSelectedSlot();
  f.state.selectedServices[0].quantity = 10; reconcile(f);
  pending.resolve(response({ timeSlots: [{ startTime: '08:00', available: true }] }));
  assert.equal(await verification, false);
  assert.equal(f.api.getSelectedSlot(), null); assert.equal(f.api.getMode(), 'project');
});

test('standard calendar rendering hides and clears project controls outside the calendar grid', async () => {
  const f = fixture(); f.state.selectedServices[0].quantity = 1;
  await initialize(f, 'appointment');
  f.api.draw();
  assert.equal(f.preferencesHost.innerHTML, '');
  assert.equal(f.preferencesHost.classList.contains('d-none'), true);
});
