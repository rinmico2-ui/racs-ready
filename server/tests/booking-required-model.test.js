'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { validateRepairModel } = require('../utils/repairModelPolicy');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('dedicated repair checkout rejects blank and structured model values in single and multi-appliance requests', async () => {
  const source = read('routes/bookingRoutesNew.js'), start = source.indexOf("router.post('/create-repair'"), next = source.indexOf('\nrouter.', start + 1);
  let handler;
  vm.runInNewContext(source.slice(start, next < 0 ? source.indexOf('\nmodule.exports', start) : next), {
    router: { post(_path, ...handlers) { handler = handlers.at(-1); } },
    schedulingEngine: { MAX_BOOKING_UNITS: 40, LARGE_SCALE_MIN_UNITS: 8 }, validateRepairModel,
    getGcashRecipientNumber: async () => 'configured', console: { log() {}, error() {} },
  });
  for (const model of [undefined, '', '   ', null, {}, ['MODEL-123']]) for (const multi of [false, true]) {
    const item = { unitType: 'Split Aircon', brand: 'Carrier', quantity: 1, model, problemDescription: 'Aircon does not cool properly.' };
    const body = { ...item, address: 'Synthetic test site', lat: '15', lng: '121', paymentMethod: 'cod', ...(multi ? { serviceItems: JSON.stringify([{ ...item, model: 'VALID-123' }, item]) } : {}) };
    let status = 200, result;
    await handler({ body }, { status(value) { status = value; return this; }, json(value) { result = value; } });
    assert.equal(status, 400); assert.equal(result.success, false);
    assert.ok(result.errors.some(error => /model/i.test(error)));
  }
});

test('repair steps cannot advance with a blank, whitespace-only or invalid model', () => {
  const source = read('public/js/services-multi.js'), nodes = { unitType: { value: 'Split Aircon' }, unitModel: { value: '' }, repairUnitQuantity: { value: '1' }, repairProblemDescription: { value: 'Aircon does not cool properly.' } };
  const modelFunction = source.slice(source.indexOf('function repairModelValidationMessage('), source.indexOf('function isLargeScaleSelection('));
  const guideFunction = source.slice(source.indexOf('function getRepairGuideStep('), source.indexOf('function refreshRepairGuide('));
  const context = { document: { getElementById: id => nodes[id] }, REPAIR_MODEL_MAX_LENGTH: 50, SAFE_REPAIR_MODEL_PATTERN: /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/,
    selectedRepairUnitCategory: () => 'aircon', getSelectedRepairBrand: () => 'Carrier', remainingBookingUnits: () => 40 };
  vm.createContext(context); vm.runInContext(modelFunction + guideFunction, context);
  for (const model of ['', '  ', '<script>', 'A'.repeat(51)]) { nodes.unitModel.value = model; assert.equal(context.getRepairGuideStep(), 3); }
  nodes.unitModel.value = 'MODEL-123'; assert.equal(context.getRepairGuideStep(), 5);
});

test('the verified model is carried from an accepted identification request into regular checkout', async () => {
  const source = read('public/js/services-multi.js'), start = source.indexOf('async function openAcceptedUnitAssistance('), end = source.indexOf('async function openAcceptedRelocation(', start);
  const catalog = { _id: 'clean', name: 'Cleaning', isAirconService: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }] };
  const request = { _id: 'synthetic-request', status: 'accepted', applianceKind: 'aircon', serviceId: 'clean', model: 'IDENTIFIED-123', quantity: 1,
    quote: { brand: 'Carrier', airconType: 'split', hp: 1, unitPrice: 500, expiresAt: new Date(Date.now() + 3600000) } };
  let saved;
  const context = { window: { location: { search: '?assistanceId=synthetic-request' }, ApplianceServices: require('../public/js/appliance-services') }, URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({ request }) }), BookingState: { catalog: { coreServices: [catalog] }, selectedServices: [] },
    selectedUnitTotal: () => 0, MAX_BOOKING_UNITS: 40, commitCoreAppliance: rows => { saved = rows; }, history: { replaceState() {} },
    showBookingToast() {}, showError(error) { throw Error(error); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context); await context.openAcceptedUnitAssistance();
  assert.equal(saved[0].model, 'IDENTIFIED-123'); assert.equal(saved[0].assistanceRequestId, 'synthetic-request');
  assert.equal(saved[0].unitPrice, 500); assert.equal(validateRepairModel(saved[0].model, { required: true }).valid, true);
});
