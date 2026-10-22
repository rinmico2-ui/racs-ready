'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const RequestModel = require('../models/UnitAssistanceRequest');
const customerId = '68a000000000000000000001', requestId = '68a000000000000000000002';
let records = [], fee = 500, linkedBooking = null;
const query = value => ({ select() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const mock = (name, exports) => { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; };
mock('../middleware/authenticate', { authenticate(req, _res, next) { req.user = { _id: req.get('x-fixture-user') || customerId }; next(); }, requireRole: () => (_req, _res, next) => next() });
mock('../utils/boundedRateLimit', { rateLimit: () => (_req, _res, next) => next() });
mock('../utils/rateLimitIdentity', { authenticatedOrIpKey: () => customerId });
mock('../models/CoreService', { findOne: () => { throw Error('Repair identification must not use a Core service'); } });
mock('../models/BookingService', { findOne: filter => query(linkedBooking && String(filter._id) === linkedBooking._id && String(filter.customerId) === linkedBooking.customerId ? linkedBooking : null) });
mock('../models/SiteSetting', { findOne: () => query({ value: fee }) });
mock('../models/ServiceCategory', { find: () => query([{ name: 'Appliances', slug: 'appliance', active: true, unitTypes: [{ value: 'Washing Machine', label: 'Washing Machine' }, { value: 'Dryer', label: 'Dryer', inspectionFee: 700 }] },
  { name: 'Air Conditioning', slug: 'aircon', active: true, unitTypes: [{ value: 'Split Type Aircon', label: 'Split Type Aircon', inspectionFee: 650 }] }]) });
mock('../utils/bookingPolicy', { getInspectionDurationMinutes: async () => 90 });
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
  const actual = key.split('.').reduce((target, part) => target?.[part], row);
  if (value === null) return actual == null;
  if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(actual);
  if (value && typeof value === 'object' && '$gt' in value) return actual > value.$gt;
  return String(actual) === String(value);
});
mock('../models/UnitAssistanceRequest', {
  findOne: filter => query(records.find(row => matches(row, filter)) || null),
  create: async value => { const row = { ...value, _id: requestId, status: 'pending' }; records.push(row); return row; },
  findOneAndUpdate: async (filter, change) => {
    const row = records.find(row => matches(row, filter)); if (!row) return null;
    Object.assign(row, change.$set); if (change.$push?.events) row.events.push(change.$push.events); return row;
  },
});
mock('../utils/notify', { createNotification: async () => {} });
const policy = require('../utils/repairIdentificationPolicy');
const app = express(); app.use(express.json()); app.use('/api/unit-assistance', require('../routes/unitAssistanceRoutes'));
const payload = () => ({ requestType: 'repair', repairUnitCategory: 'appliance', repairUnitType: 'Washing Machine',
  problemDescription: 'The machine will not spin or drain.', quantity: 1, clientRequestId: 'repair-identification-test-01' });
async function serverFixture(t) {
  records = []; fee = 500; linkedBooking = null;
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (url, body, user) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/unit-assistance${url}`, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(user ? { 'x-fixture-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: result.status, body: await result.json() };
  };
}

test('repair identification supports non-Core appliances, ignores stale hidden details, and deduplicates retries', async t => {
  const send = await serverFixture(t);
  const response = await send('/', { ...payload(), brand: 'STALE BRAND', model: 'STALE-123', hp: 3, unitPrice: 1 });
  assert.equal(response.status, 201); assert.equal(records.length, 1);
  const request = records[0];
  assert.equal(request.requestType, 'repair'); assert.equal(request.serviceId, null); assert.equal(request.applianceKind, 'other');
  assert.equal(request.brand, "I don't know"); assert.equal(request.model, ''); assert.equal(request.hp, null);
  assert.equal(request.repair.inspectionFee, 500); assert.equal(request.repair.problemDescription, payload().problemDescription);
  assert.equal((await send('/', payload())).status, 200); assert.equal(records.length, 1);
  await new RequestModel(request).validate();
});

test('repair identification rejects unsupported catalog values, invalid quantities and malformed problems before saving', async t => {
  const send = await serverFixture(t);
  for (const change of [{ repairUnitCategory: 'fake' }, { repairUnitType: 'Not in catalog' }, { quantity: 0 }, { quantity: 2 }, { quantity: 41 },
    { quantity: {} }, { problemDescription: {} }, { problemDescription: 'short' }, { requestType: 'injected' }]) {
    assert.equal((await send('/', { ...payload(), ...change })).status, 400);
  }
  assert.equal(records.length, 0);
});

test('booking-history repair assistance links only an open booking owned by the requesting customer', async t => {
  const send = await serverFixture(t), bookingId = '68a000000000000000000088';
  const body = { ...payload(), existingBookingId: bookingId };
  linkedBooking = { _id: bookingId, customerId: '68a000000000000000000099', status: 'pending', bookingReference: 'FIXTURE' };
  assert.equal((await send('/', body)).status, 409); assert.equal(records.length, 0);
  linkedBooking.customerId = customerId; linkedBooking.status = 'completed';
  assert.equal((await send('/', body)).status, 409); assert.equal(records.length, 0);
  linkedBooking.status = 'pending';
  assert.equal((await send('/', body)).status, 201);
  assert.equal(records[0].existingBookingId, bookingId); assert.equal(records[0].status, 'pending');
  assert.equal(records[0].quote, undefined); assert.equal(records[0].bookingId, undefined);
  assert.equal(linkedBooking.status, 'pending', 'requesting help does not apply a booking change');
});

test('staff repair verification requires a known brand and prices only inspection from the live catalog', async t => {
  const send = await serverFixture(t); await send('/', payload());
  const quote = { brand: 'Carrier', model: 'MODEL-123', unitType: 'Washing Machine', verificationMethod: 'model_label', unitPrice: 1 };
  for (const change of [{ brand: "I don't know" }, { model: '<script>' }, { unitType: 'Not in catalog' }, { verificationMethod: 'injected' }]) {
    assert.equal((await send(`/staff/${requestId}/quote`, { ...quote, ...change })).status, 400);
  }
  assert.equal(records[0].status, 'pending');
  fee = 650;
  const result = await send(`/staff/${requestId}/quote`, quote);
  assert.equal(result.status, 200); assert.equal(records[0].model, 'MODEL-123');
  assert.equal(records[0].quote.unitPrice, 650); assert.equal(records[0].quote.durationMinutes, 90);
  assert.equal(records[0].quote.unitType, 'Washing Machine'); assert.equal(records[0].quote.hp, null);
  assert.equal(records[0].quote.airconType, null); assert.equal(records[0].status, 'quoted');
  assert.equal((await send(`/mine/${requestId}/decision`, { decision: 'accept' }, '68a000000000000000000099')).status, 409);
  assert.equal((await send(`/mine/${requestId}/decision`, { decision: 'accept' })).status, 200);
  assert.equal(records[0].status, 'accepted');
});

test('staff can confirm a repair inspection without a model number', async t => {
  const send = await serverFixture(t); await send('/', payload());
  const result = await send(`/staff/${requestId}/quote`, { brand: 'Carrier', model: '', unitType: 'Washing Machine', verificationMethod: 'customer_contact' });
  assert.equal(result.status, 200); assert.equal(records[0].model, '');
  assert.equal(records[0].status, 'quoted');
});

test('a repair quote cannot be reused with altered appliance details, quantity, fee, owner status or expiry', () => {
  const request = { requestType: 'repair', status: 'accepted', model: 'MODEL-123', quantity: 2,
    quote: { brand: 'Carrier', unitType: 'Washing Machine', unitCategory: 'appliance', unitPrice: 500, expiresAt: new Date(Date.now() + 3600000) } };
  const item = { type: 'repair', ...request.quote, model: request.model, quantity: 2 };
  assert.equal(policy.repairQuoteMatches(request, item), true);
  for (const change of [{ brand: 'Other' }, { model: 'OTHER' }, { unitType: 'Dryer' }, { unitCategory: 'aircon' }, { quantity: 3 }, { unitPrice: 1 }]) assert.equal(policy.repairQuoteMatches(request, { ...item, ...change }), false);
  for (const change of [{ status: 'pending' }, { requestType: 'core' }, { bookingId: 'already-used' }, { existingBookingId: 'existing' }, { quote: { ...request.quote, expiresAt: new Date(0) } }]) assert.equal(policy.repairQuoteMatches({ ...request, ...change }, item), false);
});

test('staff confirms aircon repair HP before quoting and an accepted quote cannot be reused with another HP', async t => {
  const send = await serverFixture(t);
  assert.equal((await send('/', { ...payload(), repairUnitCategory: 'aircon', repairUnitType: 'Split Type Aircon' })).status, 201);
  assert.equal(records[0].applianceKind, 'aircon');
  const body = { brand: 'Carrier', model: 'MODEL-123', unitType: 'Split Type Aircon', verificationMethod: 'model_label' };
  for (const hp of [undefined, '', {}, 999]) assert.equal((await send(`/staff/${requestId}/quote`, { ...body, hp })).status, 400);
  assert.equal((await send(`/staff/${requestId}/quote`, { ...body, hp: 3 })).status, 200);
  assert.equal(records[0].quote.hp, 3); assert.equal(records[0].quote.unitPrice, 650);
  assert.equal((await send(`/mine/${requestId}/decision`, { decision: 'accept' })).status, 200);
  const request = records[0], item = { ...request.quote, quantity: 1, model: request.model };
  assert.equal(policy.repairQuoteMatches(request, item), true);
  assert.equal(policy.repairQuoteMatches(request, { ...item, hp: 1 }), false);
});

test('accepted repair identification resumes as a repair inspection with the verified model and problem', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
  const start = source.indexOf('async function openAcceptedUnitAssistance('), end = source.indexOf('function injectTransitionStyles(', start);
  const request = { _id: requestId, requestType: 'repair', status: 'accepted', model: 'MODEL-123', quantity: 2, repair: { problemDescription: payload().problemDescription },
    quote: { brand: 'Carrier', unitType: 'Washing Machine', unitCategory: 'appliance', unitPrice: 500, durationMinutes: 90, expiresAt: new Date(Date.now() + 3600000) } };
  const state = { selectedServices: [] };
  const context = { window: { location: { search: `?assistanceId=${requestId}` }, ApplianceServices: require('../public/js/appliance-services') }, URLSearchParams, BookingState: state, MAX_BOOKING_UNITS: 40,
    fetch: async () => ({ ok: true, json: async () => ({ request }) }), selectedUnitTotal: () => 0,
    repairUnitPricing: () => ({ inspectionFee: 500 }), updateSelectedServicesDisplay() {}, updatePricingDisplay() {}, updateContinueButtonState() {}, saveBookingProgress() {}, validateStep: () => true, showStep() {}, history: { replaceState() {} }, showBookingToast() {}, showError(error) { throw Error(error); } };
  vm.runInNewContext(source.slice(start, end), context); await context.openAcceptedUnitAssistance(); await context.openAcceptedUnitAssistance();
  assert.equal(state.selectedServices.length, 1); const item = state.selectedServices[0];
  assert.equal(item.type, 'repair'); assert.equal(item.model, 'MODEL-123'); assert.equal(item.assistanceRequestId, requestId);
  assert.equal(item.totalPrice, 1000); assert.equal(item.problemDescription, payload().problemDescription);
});

test('staff can render verification for a repair-only appliance without a Core service profile', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/unit-assistance-staff.js'), 'utf8');
  const start = source.indexOf('  function renderQuoteForm('), end = source.indexOf('  function renderResolution(', start);
  const nodes = [];
  const text = (tag, className, value) => {
    const node = { tag, className, textContent: value || '', value: '', children: [],
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener() {}, setCustomValidity() {} };
    nodes.push(node); return node;
  };
  const context = { text, section: () => text('section'), field: (_label, input) => input, guidance: value => text('p', '', value),
    option: (value, label) => Object.assign(text('option', '', label), { value }), canRenewAccepted: () => false,
    state: { brands: ['Carrier', 'LG'] }, append: (parent, ...children) => { parent.append(...children); return parent; },
    A: { profile() { throw Error('Repair must not use Core appliance pricing'); } }, pesos: value => `PHP ${value}` };
  vm.runInNewContext(source.slice(start, end), context);
  const result = context.renderQuoteForm({ requestType: 'repair', applianceKind: 'other', serviceId: null, status: 'pending', quantity: 2,
    repair: { unitType: 'Washing Machine', inspectionFee: 500, problemDescription: 'Machine will not drain.' } });
  assert.ok(result.children.some(node => node.tag === 'form'));
  assert.ok(nodes.some(node => node.textContent.includes('PHP 1000 total')));
  assert.ok(nodes.some(node => node.tag === 'input' && node.value === 'Washing Machine'));
});
