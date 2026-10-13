'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const calendar = fs.readFileSync(path.join(__dirname, '../public/js/enterprise-calendar.js'), 'utf8').replace(/\r\n/g, '\n');
const services = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');

function fixture({ sufficient = true, reducedMotion = false, fetchOverride } = {}) {
  const calls = { focus: [], scroll: [], fetch: [], selected: [], steps: [] };
  function target(name) { return { setAttribute() {}, focus(options) { calls.focus.push({ name, options }); }, scrollIntoView(options) { calls.scroll.push({ name, options }); } }; }
  const heading = target('preferences'), validation = target('validation');
  const elements = { projectPrefs: { querySelector: () => heading }, projectRangeValidation: validation };
  const state = { selectedServices: [{ quantity: 8 }] };
  const window = { BookingState: state, matchMedia: () => ({ matches: reducedMotion }) };
  const context = { window, document: { getElementById: id => elements[id] || null },
    console: { error() {}, debug() {} }, setTimeout,
    showStep: step => calls.steps.push(step),
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body); calls.fetch.push(request);
      return fetchOverride ? fetchOverride(request) : { ok: true, json: async () => ({ sufficient, window: request, requiredHours: 12 }) };
    },
  };
  // Expose the real range handlers in a test-only VM; replace just rendering.
  const exposed = calendar.replace('  return {\n    init,', `
  function configureTest() {
    _mode = 'project'; _quantity = 8; _totalEstimatedMinutes = 720;
    _selectedDate = null; _selectedEndDate = null; _selectingEndDate = false;
    _showStartDatePrompt = false; render = () => {};
    _projectAvailability = new Map([['2035-01-03', {capacityHours: 80}]]);
    _onSelectCb = selection => window.testSelected(selection);
  }
  return { configureTest, handleProjectDateSelect, validateProjectRange,
    init,`);
  window.testSelected = selection => calls.selected.push(selection);
  vm.runInNewContext(exposed, context);
  const api = window.EnterpriseCalendar; api.configureTest();
  return { api, calls, state };
}

test('choosing the end date focuses preferences and keeps the scheduling step open', async () => {
  const { api, calls, state } = fixture();
  await api.handleProjectDateSelect('2035-01-02');
  assert.equal(calls.scroll.length, 0); assert.equal(calls.fetch.length, 0);
  await api.handleProjectDateSelect('2035-01-06');
  assert.equal(calls.scroll[0].name, 'preferences'); assert.equal(calls.scroll[0].options.block, 'start');
  assert.equal(calls.focus[0].name, 'preferences'); assert.equal(calls.focus[0].options.preventScroll, true);
  assert.equal(calls.selected.length, 1); assert.equal(calls.steps.length, 0);
  assert.equal(state.projectScheduling.preferences.completionDeadline, '2035-01-06');
  assert.equal(state.projectScheduling.windowVerdict.sufficient, true);
});

test('insufficient capacity reveals date guidance instead of preferences', async () => {
  const { api, calls } = fixture({ sufficient: false });
  await api.applySuggestedRange('2035-01-02', '2035-01-06');
  assert.equal(calls.scroll[0].name, 'validation'); assert.equal(calls.selected.length, 0);
});

test('recommended ranges also lead to preferences and respect reduced motion', async () => {
  const { api, calls } = fixture({ reducedMotion: true });
  await api.applySuggestedRange('2035-01-02', '2035-01-06');
  assert.equal(calls.scroll[0].name, 'preferences'); assert.equal(calls.scroll[0].options.behavior, 'auto');
});

test('resetting a range prevents a late capacity response from restoring it or moving focus', async () => {
  let finish;
  const { api, calls, state } = fixture({ fetchOverride: request => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ sufficient: true, window: request }) }); }) });
  const pending = api.applySuggestedRange('2035-01-02', '2035-01-06');
  api.resetRange(); finish(); await pending;
  assert.equal(api.getWindowVerdict(), null); assert.equal(state.projectScheduling, null);
  assert.equal(calls.selected.length, 0); assert.equal(calls.scroll.length, 0);
});

test('a newer range wins even when the previous response finishes last', async () => {
  const finishes = [];
  const { api, calls } = fixture({ fetchOverride: request => new Promise(resolve => { finishes.push(() => resolve({ ok: true, json: async () => ({ sufficient: true, window: request }) })); }) });
  const old = api.applySuggestedRange('2035-01-02', '2035-01-06');
  const current = api.applySuggestedRange('2035-01-03', '2035-01-08');
  finishes[1](); await current; finishes[0](); await old;
  assert.equal(api.getWindowVerdict().window.endDate, '2035-01-08');
  assert.equal(calls.selected.length, 1); assert.equal(calls.scroll.length, 1);
});

test('background validation leaves the customer at the preference they are editing', async () => {
  const { api, calls } = fixture();
  await api.applySuggestedRange('2035-01-02', '2035-01-06');
  calls.scroll.length = 0; calls.focus.length = 0;
  await api.validateProjectRange();
  assert.equal(calls.scroll.length, 0); assert.equal(calls.focus.length, 0);
});

test('failed availability requests never advance to preferences', async () => {
  const { api, calls } = fixture({ fetchOverride: async () => ({ ok: false }) });
  await api.applySuggestedRange('2035-01-02', '2035-01-06');
  assert.equal(api.getWindowVerdict(), null); assert.equal(calls.selected.length, 0); assert.equal(calls.scroll.length, 0);
});

test('customer project detection uses the repair inspection policy and duration boundary', () => {
  const code = services.slice(services.indexOf('function selectedUnitTotal()'), services.indexOf('let bookingScheduleServiceSignature'));
  const context = { BookingState: { selectedServices: [{ type: 'repair', quantity: 4, duration: 1 }] },
    window: { ApplianceServices: require('../public/js/appliance-services'), __bookingPolicy: { inspectionDurationMinutes: 120, largeProjectThresholdHours: 6 } }, LARGE_SCALE_MIN_UNITS: 8 };
  vm.runInNewContext(code, context);
  assert.equal(context.selectedServiceMinutes(), 480); assert.equal(context.bookingRequiresProjectSchedule(), true);
  context.window.__bookingPolicy.largeProjectThresholdHours = 8;
  assert.equal(context.bookingRequiresProjectSchedule(), false);
  context.BookingState.selectedServices[0].quantity = 8;
  assert.equal(context.bookingRequiresProjectSchedule(), true);
});

test('the real submission payload retains the chosen range, policy workload and each repair problem', async () => {
  const scope = services.slice(services.indexOf('function selectedUnitTotal()'), services.indexOf('let bookingScheduleServiceSignature'));
  const prepare = services.slice(services.indexOf('async function prepareBookingData()'), services.indexOf('function showBookingSuccessModal(result)'));
  const units = [{ label: 'Bedroom', problemDescription: 'Not cooling in the bedroom' }, { label: 'Office', problemDescription: 'Water leaking in the office' }];
  const state = { selectedServices: [{ serviceId: 'repair-id', type: 'repair', quantity: 2, duration: 1, units }],
    selectedDate: '2035-01-02', customerLocation: { address: 'Test site', lat: 15, lng: 121 },
    projectScheduling: { preferredStartDate: '2035-01-02', endDate: '2035-01-06', preferences: { workingDays: ['monday'], preferredWorkingHours: 'afternoon' } },
  };
  const context = { BookingState: state, LARGE_SCALE_MIN_UNITS: 8, URLSearchParams,
    window: { ApplianceServices: require('../public/js/appliance-services'), __bookingPolicy: { inspectionDurationMinutes: 300, largeProjectThresholdHours: 8 }, location: { search: '' } },
    document: { getElementById: () => null }, isRepairBookingService: service => service.type === 'repair',
    currentBookingReward: () => null, bookingTravelFare: () => 0,
    formatDateKey: date => date.toISOString().slice(0, 10),
  };
  vm.runInNewContext(scope + '\n' + prepare, context);
  const payload = JSON.parse(JSON.stringify(await context.prepareBookingData()));
  assert.equal(payload.isProject, true); assert.equal(payload.startTime, undefined);
  assert.equal(payload.projectScheduling.preferredStartDate, '2035-01-02');
  assert.equal(payload.projectScheduling.preferredCompletionDeadline, '2035-01-06');
  assert.equal(payload.projectScheduling.preferredWorkingHours.start, 'afternoon');
  assert.equal(payload.projectScheduling.estimatedTotalHours, 10);
  assert.deepEqual(payload.services[0].units, units);
});
