'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
const functions = source.slice(source.indexOf('async function openAcceptedUnitAssistance('), source.indexOf('function injectTransitionStyles('));
const id = '68a000000000000000000001';
function fixture({ repair = false, status = 'accepted', expires = Date.now() + 3600000, existingBookingId = null, blocked = false } = {}) {
  const catalog = { _id: 'clean', name: 'Cleaning', isAirconService: true, active: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }] };
  const request = { _id: id, status, requestType: repair ? 'repair' : 'core', existingBookingId, applianceKind: 'aircon', serviceId: 'clean', model: '', quantity: 1,
    repair: { problemDescription: 'Aircon is not cooling.' }, quote: { brand: 'Carrier', airconType: 'split', hp: 1, unitPrice: 500, durationMinutes: 60, unitType: 'Split Type Repair', unitCategory: 'aircon', expiresAt: new Date(expires) } };
  const state = { selectedServices: [], applianceDraft: { assistanceReceipt: { id: repair ? 'another-request' : id } }, repairDraft: { assistanceReceipt: { id: repair ? id : 'another-request' } } };
  const calls = { steps: [], errors: [], redirects: [], resets: [], fetches: [], saves: 0 };
  const context = { window: { location: { search: '?assistanceId=' + id, assign: target => calls.redirects.push(target) }, ApplianceServices: require('../public/js/appliance-services'),
    CoreApplianceBooking: { reset: () => calls.resets.push('core') }, RepairApplianceBooking: { reset: () => calls.resets.push('repair') } },
    URLSearchParams, BookingState: Object.assign(state, { catalog: { coreServices: [catalog] } }), MAX_BOOKING_UNITS: 40,
    fetch: async (url, options) => { calls.fetches.push({ url, options }); return { ok: true, json: async () => ({ request }) }; },
    selectedUnitTotal: () => state.selectedServices.length,
    commitCoreAppliance: rows => { state.selectedServices.push(...rows); }, repairUnitPricing: () => ({ inspectionFee: 500 }),
    updateSelectedServicesDisplay() {}, updatePricingDisplay() {}, updateContinueButtonState() {}, saveBookingProgress: () => { calls.saves++; },
    history: { replaceState() {} }, validateStep: () => !blocked, showStep: step => calls.steps.push(step), showBookingToast() {}, showError: message => calls.errors.push(message),
  };
  vm.runInNewContext(functions, context);
  return { state, request, calls, run: () => context.openAcceptedUnitAssistance() };
}
for (const repair of [false, true]) test(`accepted ${repair ? 'repair' : 'core'} quote opens the address step and clears only its matching receipt`, async () => {
  const f = fixture({ repair }); await f.run(); await f.run();
  assert.equal(f.state.selectedServices.length, 1);
  assert.equal(f.state.selectedServices[0].assistanceRequestId, id);
  assert.equal(f.state.selectedServices[0].unitPrice, 500);
  assert.deepEqual(f.calls.steps, [3, 3]);
  assert.deepEqual(f.calls.resets, [repair ? 'repair' : 'core']);
  assert.equal(f.state[repair ? 'repairDraft' : 'applianceDraft'], null);
  assert.equal(f.state[repair ? 'applianceDraft' : 'repairDraft'].assistanceReceipt.id, 'another-request');
  assert.ok(f.calls.fetches.every(call => call.options.cache === 'no-store'));
  assert.deepEqual(f.calls.errors, []);
});
test('a quoted price needs customer acceptance and an existing-booking change stays with staff', async () => {
  for (const options of [{ status: 'quoted' }, { existingBookingId: 'existing' }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.state.selectedServices.length, 0);
    assert.deepEqual(f.calls.steps, []);
    assert.deepEqual(f.calls.redirects, ['/unit-assistance?requestId=' + id]);
  }
});
test('pending, declined and expired quotes do not unlock a new booking', async () => {
  for (const options of [{ status: 'pending' }, { status: 'declined' }, { expires: Date.now() - 1 }, { expires: NaN }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.state.selectedServices.length, 0);
    assert.deepEqual(f.calls.steps, []);
    assert.match(f.calls.errors[0], /no longer available/i);
  }
});
test('a changed catalog price and an unfinished unrelated appliance cannot skip booking validation', async () => {
  const changed = fixture(); changed.request.quote.unitPrice = 1; await changed.run();
  assert.equal(changed.state.selectedServices.length, 0); assert.deepEqual(changed.calls.steps, []);
  assert.match(changed.calls.errors[0], /price changed/i);
  const blocked = fixture({ blocked: true }); await blocked.run();
  assert.equal(blocked.state.selectedServices.length, 1); assert.deepEqual(blocked.calls.steps, []);
});

test('quote refresh recovers without sockets on polling, focus and reconnect, and stops cleanly', async () => {
  const { bindWorkflowRefresh } = require('../public/js/customer-workflow-refresh');
  const events = {}, timers = new Map(); let sequence = 0, interval, poll, loads = 0;
  const doc = { hidden: false, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  const win = { console, setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval(fn, delay) { poll = fn; interval = delay; return 1; }, clearInterval() {},
    addEventListener: (name, fn) => { events[name] = fn; }, removeEventListener: name => { delete events[name]; } };
  const binding = bindWorkflowRefresh({ window: win, document: doc, refresh: async () => { loads++; }, pollIntervalMs: 15000 });
  assert.equal(interval, 15000);
  poll(); events.focus(); events.online(); events['notification:new']();
  assert.equal(timers.size, 1);
  const [id, run] = timers.entries().next().value; timers.delete(id); await run();
  assert.equal(loads, 1);
  doc.hidden = true; poll(); assert.equal(timers.size, 0);
  binding.stop(); assert.equal(events.focus, undefined); assert.equal(events.online, undefined);
  poll(); assert.equal(timers.size, 0);
});
