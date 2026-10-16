'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const mongoose = require('mongoose');
const engine = require('../utils/enterpriseSchedulingEngine');
const SiteSetting = require('../models/SiteSetting');
const source = fs.readFileSync(path.join(__dirname, '../routes/bookingRoutesNew.js'), 'utf8');
const query = value => ({ select() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

function fixture(t, { duration = 180, inspection = 90, threshold = 8, sufficient = true, catalogOverride } = {}) {
  // Run the real submission handler with memory-only models and persistence.
  // The real scheduling classifier reads a mocked setting, never a database.
  engine.invalidateProjectThresholdCache();
  t.mock.method(SiteSetting, 'findOne', () => query({ value: threshold }));
  const customerId = new mongoose.Types.ObjectId();
  const calls = { capacity: [], windows: [], writes: [], projects: [], payments: [] };
  class Booking {
    constructor(data) { Object.assign(this, data); this._id = new mongoose.Types.ObjectId(); }
    static findOne() { return query(null); }
    async save() { return this; }
  }
  class Payment { constructor(data) { Object.assign(this, data); } }
  let submit;
  const router = { use() {}, get() {}, patch() {}, delete() {}, post(route, ...handlers) { if (route === '/create-new') submit = handlers.at(-1); } };
  const pure = name => require('../utils/' + name);
  const mocks = {
    express: { Router: () => router }, mongoose: { ...mongoose, isValidObjectId: () => true }, crypto: require('node:crypto'),
    '../models/BookingService': Booking, '../models/Payment': Payment,
    '../models/User': { findById: async () => ({ _id: customerId, firstName: 'Test', lastName: 'Customer', email: 'customer@example.invalid' }) },
    '../models/Project': { findOne: async () => null, create: async data => { calls.projects.push(data); return data; } },
    '../models/BookingStatus': require('../models/BookingStatus'),
    '../models/CoreService': { find: () => query(catalogOverride || [{ _id: 'core-id', name: 'Aircon Installation', active: true, basePrice: 1000, durationMinutes: duration }]) },
    '../models/RepairService': {}, '../models/UnitAssistanceRequest': {}, '../models/RelocationRequest': {}, '../models/CustomerAsset': {}, '../models/MaintenanceSchedule': {},
    '../middleware/authenticate': { authenticate() {}, requireRole: () => () => {} },
    '../middleware/bookingSubmissionUpload': () => {},
    '../utils/boundedRateLimit': { rateLimit: () => () => {} },
    '../utils/bookingPolicy': { getBufferMinutes: async () => 15, getInspectionDurationMinutes: async () => inspection,
      assertCompanyCapacity: async (...args) => { calls.capacity.push(args); } },
    '../utils/enterpriseSchedulingEngine': { ...engine,
      getProjectWindowAvailability: async input => { calls.windows.push(input); return { sufficient, totals: { totalAvailableHours: 80, workableDays: 5 } }; },
      reserveProjectCapacity: async () => {} },
    '../utils/mailer': {}, '../utils/notify': { createNotification: async () => {} },
    '../utils/relocationBookingPolicy': pure('relocationBookingPolicy'),
    '../utils/coreServicePricing': pure('coreServicePricing'), '../utils/bookingServiceItems': pure('bookingServiceItems'),
    '../utils/bookingUnitLimit': pure('bookingUnitLimit'), '../utils/projectServiceChange': {}, '../utils/audit': {},
    '../utils/projectPaymentReview': pure('projectPaymentReview'),
    '../utils/repairIdentificationPolicy': pure('repairIdentificationPolicy'),
    '../utils/paymentPolicy': { normalizePaymentChannel: value => value, MANUAL_PAYMENT_CHANNELS: ['bank'],
      getPaymentMethods: async () => ({ bank: { available: true } }), getDownpaymentPercentage: async () => 10,
      calculatePaymentBreakdown: total => ({ downpaymentPercentage: 10, downpaymentAmount: total / 10, balanceAmount: total * 0.9 }), paymentRecordMethod: () => 'bank' },
    '../utils/operationLock': { bookingCapacityLockKey: value => value, withOperationLock: async (_key, fn) => fn() },
    '../utils/rateLimitIdentity': {}, '../utils/maintenanceLifecycle': {},
    '../utils/uploadSecurity': { hasValidImageDataUrl: () => true },
    '../utils/paymentProofStorage': { discardTemporaryPaymentProof: async () => {} },
    '../utils/repairInspectionPricing': { resolveRepairInspectionFees: async services => services.map(item => item.type === 'repair' ? { fee: 500 } : null) },
    '../utils/mongoWriteSupport': { isUnsupportedMongoWriteFeature: () => false },
    '../utils/bookingSubmissionWrite': { persistBookingSubmission: async ({ booking, payment }) => { calls.writes.push(booking); calls.payments.push(payment); return booking; } },
    '../utils/loyaltyRewards': { rewardFor: async () => null, assertQuote() {}, round: value => value },
    '../public/js/appliance-services': require('../public/js/appliance-services'),
    '../public/js/nueva-ecija-coverage': require('../public/js/nueva-ecija-coverage'),
    '../utils/repairModelPolicy': pure('repairModelPolicy'), '../utils/repairUnitWorkflow': pure('repairUnitWorkflow'),
    '../utils/repairUnitLegacyGuard': () => {},
    '../models/Technician': {},
    '../models/Tool': {},
  };
  vm.runInNewContext(source.slice(0, source.indexOf('const multer =')), {
    require(name) { assert.ok(name in mocks, 'Unexpected dependency: ' + name); return mocks[name]; },
    console: { log() {}, warn() {}, error() {} }, process: { env: { NODE_ENV: 'test' } },
    module: { exports: {} }, Buffer,
  });
  async function call(overrides = {}) {
    let code = 200, body;
    const req = { user: { _id: customerId }, body: {
      services: [{ serviceId: 'core-id', type: 'core', model: 'TEST-123', quantity: 3, unitPrice: 1000, duration: 1 }],
      bookingDate: '2035-01-02', projectScheduling: { preferredStartDate: '2035-01-02', preferredCompletionDeadline: '2035-01-06', estimatedTotalHours: 1 },
      quantity: 1, location: { address: 'Test site', lat: 15.4863, lng: 120.9671 }, paymentMethod: 'cod', paymentChannel: 'bank', paymentReference: 'TEST-REFERENCE', proofImageBase64: 'mock-proof', ...overrides,
    }, app: { get: () => null } };
    await submit(req, { status(value) { code = value; return this; }, json(value) { body = value; } });
    return { code, body, calls };
  }
  return { call, calls };
}

test('compressor HP booking uses appliance-specific prices and time, ignoring client estimates', async t => {
  const catalog = [{ _id: 'core-id', name: 'Recharging', active: true, isAirconService: true,
    applianceProfiles: [{ kind: 'freezer', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: 0.125, price: 650, durationMinutes: 45 }] }] }];
  const f = fixture(t, { catalogOverride: catalog });
  const service = { serviceId: 'core-id', type: 'core', applianceKind: 'freezer', applianceGroupId: 'freezer_test_group', brand: 'Midea', model: 'TEST-123', hp: 0.125, quantity: 2, unitPrice: 1, duration: 1 };
  const changedPrice = await f.call({ services: [service], startTime: '08:00', projectScheduling: undefined });
  assert.equal(changedPrice.code, 409); assert.equal(f.calls.writes.length, 0);
  service.unitPrice = 650;
  const result = await f.call({ services: [service], startTime: '08:00', projectScheduling: undefined });
  assert.equal(result.code, 201, result.body?.error);
  const saved = result.calls.writes[0].services[0];
  assert.equal(saved.hp, 0.125); assert.equal(saved.unitPrice, 650); assert.equal(saved.duration, 45);
  assert.equal(saved.totalPrice, 1300); assert.equal(saved.applianceType, 'freezer'); assert.equal(saved.isAirconService, false);
  const bad = await f.call({ services: [{ ...service, hp: 2 }], startTime: '08:00' });
  assert.equal(bad.code, 400); assert.equal(f.calls.writes.length, 1);
});

test('service booking rejects an outside-province pin before saving or checking capacity', async t => {
  const f = fixture(t);
  const result = await f.call({location:{address:'Outside service area',lat:15.25,lng:120.65}});
  assert.equal(result.code,400); assert.equal(result.body.code,'OUTSIDE_SERVICE_AREA');
  assert.equal(f.calls.writes.length,0); assert.equal(f.calls.windows.length,0);
});

test('nearby relocation saves the real property pin for both positions and rejects extra units', async t => {
  const catalog = [{ _id: 'core-id', slug: 'aircon-relocation', name: 'Aircon Relocation', active: true, isAirconService: true,
    airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1600, durationMinutes: 120 }] }] }];
  const f = fixture(t, { catalogOverride: catalog });
  const service = { serviceId: 'core-id', type: 'core', applianceKind: 'aircon', applianceGroupId: 'nearby_move_group', brand: 'Carrier', model: 'Nexus', hp: 1, airconType: 'split', quantity: 1, unitPrice: 1600,
    relocation: { scope: 'same_property', from: { details: 'Living room', lat: 20, lng: 120 }, to: { details: 'Bedroom', lat: 20, lng: 120 } } };
  const result = await f.call({ services: [service], startTime: '08:00', projectScheduling: undefined });
  assert.equal(result.code, 201, result.body?.error);
  const move = result.calls.writes[0].services[0].relocation;
  assert.equal(move.from.lat, 15.4863); assert.equal(move.from.lng, 120.9671); assert.equal(move.to.lat, 15.4863); assert.equal(move.to.lng, 120.9671);
  assert.equal(move.from.details, 'Living room'); assert.equal(move.to.details, 'Bedroom'); assert.equal(move.to.address, 'Test site');
  const bad = await f.call({ services: [{ ...service, quantity: 2 }], startTime: '08:00' });
  assert.equal(bad.code, 400); assert.equal(f.calls.writes.length, 1);
});

test('two core services on four appliances keep four physical units and use combined catalog work time', async t => {
  const catalog = ['core-id', 'second-id'].map((_id, index) => ({ _id, name: index ? 'Freon Recharging' : 'Aircon Cleaning', active: true, isAirconService: true,
    airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1000, durationMinutes: 60 }] }] }));
  const rows = require('../public/js/appliance-services').serviceLines(catalog, { applianceKind: 'aircon', brand: 'Carrier', model: 'Nexus', airconType: 'split', hp: 1, quantity: 4 }, catalog.map(row => row._id), 'appliance_shared_test');
  const { code, body, calls } = await fixture(t, { catalogOverride: catalog }).call({ services: rows, startTime: '08:00' });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, false); assert.equal(calls.projects.length, 0);
  assert.equal(calls.writes[0].quantity, 4); assert.equal(calls.writes[0].serviceDurationMinutes, 480);
  assert.equal(calls.writes[0].services[0].applianceGroupId, 'appliance_shared_test'); assert.equal(calls.writes[0].services[1].model, 'Nexus');
  assert.equal(calls.writes[0].totalPrice, 8000);
});
test('shared appliances with longer combined work still use the multi-day project flow', async t => {
  const catalog = ['core-id', 'second-id'].map(_id => ({ _id, name: 'Core service', active: true, isAirconService: true,
    airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1000, durationMinutes: 90 }] }] }));
  const rows = require('../public/js/appliance-services').serviceLines(catalog, { applianceKind: 'aircon', brand: 'Carrier', model: 'TEST-123', airconType: 'split', hp: 1, quantity: 4 }, catalog.map(row => row._id), 'appliance_shared_test');
  const { code, body, calls } = await fixture(t, { catalogOverride: catalog }).call({ services: rows });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, true);
  assert.equal(calls.projects[0].totalUnits, 4); assert.equal(calls.windows[0].requiredHours, 12);
  assert.equal(calls.projects[0].unitGroups[1].applianceGroupId, rows[0].applianceGroupId);
});
test('refrigerator booking is validated against staff prices and saves its own appliance details', async t => {
  const catalog = [{ _id: 'core-id', name: 'Leak Testing', active: true, isAirconService: true, applianceProfiles: [{ kind: 'refrigerator', enabled: true, unitPrice: 1000, durationMinutes: 75 }] }];
  const rows = require('../public/js/appliance-services').serviceLines(catalog, { applianceKind: 'refrigerator', brand: 'Midea', model: 'REF-123', quantity: 1 }, ['core-id'], 'appliance_fridge_test');
  const { code, body, calls } = await fixture(t, { catalogOverride: catalog }).call({ services: rows, startTime: '08:00' });
  assert.equal(code, 201, body?.error); assert.equal(calls.writes[0].services[0].hp, null);
  assert.equal(calls.writes[0].services[0].applianceTypeName, 'Refrigerator'); assert.equal(calls.writes[0].services[0].isAirconService, false);
  rows[0].unitPrice = 1;
  const changed = await fixture(t, { catalogOverride: catalog }).call({ services: rows, startTime: '08:00' });
  assert.equal(changed.code, 409); assert.equal(changed.calls.writes.length, 0);
});
test('a long job below eight units submits as a project without a start time', async t => {
  const { code, body, calls } = await fixture(t).call();
  assert.equal(code, 201, body?.error);
  assert.equal(body.isProject, true);
  assert.equal(body.booking.status, 'pending_project_scheduling');
  assert.equal(body.booking.startTime, undefined);
  assert.equal(calls.capacity.length, 0);
  assert.equal(calls.windows.length, 2);
  for (const window of calls.windows) { assert.equal(window.requiredHours, 9); assert.equal(window.totalUnits, 3); }
  assert.equal(calls.writes[0].projectScheduling.estimatedTotalHours, 9);
  assert.equal(calls.projects[0].totalUnits, 3);
});

test('eight short units still use project scheduling', async t => {
  const { code, body, calls } = await fixture(t, { duration: 30 }).call({ services: [{ serviceId: 'core-id', type: 'core', model: 'TEST-123', quantity: 8, unitPrice: 1000 }] });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, true);
  assert.equal(calls.windows[0].requiredHours, 4);
});

test('standard bookings require a start time even if the client claims a project', async t => {
  const { code, body, calls } = await fixture(t, { duration: 60 }).call({ isProject: true });
  assert.equal(code, 400); assert.match(body.error, /start time/); assert.equal(calls.writes.length, 0);
});

test('standard appointments retain their date, time and capacity checks', async t => {
  const { code, body, calls } = await fixture(t, { duration: 60 }).call({ startTime: '08:00', projectScheduling: undefined });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, false); assert.equal(body.booking.startTime, '08:00');
  assert.equal(calls.capacity.length, 2); assert.equal(calls.windows.length, 0);
});

test('project submission cannot skip the end date or capacity validation', async t => {
  const f = fixture(t, { sufficient: false });
  const incomplete = await f.call({ projectScheduling: { preferredStartDate: '2035-01-02' } });
  assert.equal(incomplete.code, 400); assert.match(incomplete.body.error, /end date/);
  const full = await f.call(); assert.equal(full.code, 409); assert.equal(f.calls.writes.length, 0);
});

test('a single repair uses the inspection policy and stays a standard appointment', async t => {
  const { code, body, calls } = await fixture(t, { inspection: 120, threshold: 6 }).call({
    services: [{ serviceId: 'repair-id', type: 'repair', brand: 'Carrier', model: 'TEST-123', name: 'Aircon repair', unitType: 'Split Aircon', hp: 1, quantity: 1, duration: 1, problemDescription: 'Aircon is not cooling properly' }], startTime: '08:00',
  });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, false);
  assert.equal(calls.windows.length, 0); assert.equal(calls.capacity.length, 2);
  assert.equal(calls.writes[0].serviceDurationMinutes, 120); assert.equal(calls.writes[0].services[0].hp, 1);
});

test('client duration and nested schedule cannot force project classification', async t => {
  const { code, calls } = await fixture(t, { duration: 60 }).call({
    services: [{ serviceId: 'core-id', type: 'core', model: 'TEST-123', quantity: 3, unitPrice: 1000, duration: 9999, schedule: { durationMinutes: 9999 } }],
  });
  assert.equal(code, 400); assert.equal(calls.windows.length, 0); assert.equal(calls.writes.length, 0);
});

test('a workload exactly at the hours threshold remains a standard appointment', async t => {
  const { code, body, calls } = await fixture(t, { duration: 120 }).call({
    services: [{ serviceId: 'core-id', type: 'core', model: 'TEST-123', quantity: 4, unitPrice: 1000 }], startTime: '08:00',
  });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, false);
  assert.equal(calls.capacity.length, 2);
});

test('mixed core and repair groups share one combined project workload', async t => {
  const { code, body, calls } = await fixture(t, { duration: 90 }).call({ services: [
    { serviceId: 'core-id', type: 'core', quantity: 5, unitPrice: 1000 },
    { serviceId: 'repair-id', brand: 'Carrier', model: 'TEST-123', name: 'Aircon repair', unitType: 'Split Aircon', hp: 3, type: 'repair', quantity: 1, problemDescription: 'Aircon is not cooling properly' },
  ] });
  assert.equal(code, 201, body?.error); assert.equal(body.isProject, true);
  assert.equal(calls.windows[0].requiredHours, 9); assert.equal(calls.windows[0].totalUnits, 6);
  assert.equal(calls.projects[0].unitGroups.length, 2); assert.equal(calls.projects[0].projectPhase, 'assessment');
});

test('core and repair bookings accept optional models while both reject malformed supplied values', async t => {
  const f = fixture(t);
  for (const type of ['core', 'repair']) for (const model of [undefined, '', '   ', null, {}, ['TEST-123'], '<script>']) {
    if (model == null || typeof model === 'string' && !model.trim()) continue;
    const { code, body, calls } = await f.call({ services: [{ serviceId: 'core-id', type, quantity: 1, model }] });
    assert.equal(code, 400); assert.match(body.error, /model/i);
    assert.equal(calls.writes.length, 0); assert.equal(calls.capacity.length, 0); assert.equal(calls.windows.length, 0);
  }
  for (const model of [undefined, '', '   ', null]) {
    const result = await fixture(t, { duration: 60 }).call({ services: [{ serviceId: 'core-id', type: 'core', quantity: 1, unitPrice: 1000, model }], startTime: '08:00' });
    assert.equal(result.code, 201, result.body?.error); assert.equal(result.calls.writes[0].services[0].model, null);
    const repair = await fixture(t).call({ services: [{ serviceId: 'repair-id', type: 'repair', brand: 'Carrier', model, name: 'Aircon repair', unitType: 'Split Aircon', hp: 1, quantity: 1, problemDescription: 'Aircon is not cooling properly' }], startTime: '08:00' });
    assert.equal(repair.code, 201, repair.body?.error); assert.equal(repair.calls.writes[0].services[0].model, null);
  }
});

const relocationCatalog = [{ _id: 'core-id', slug: 'aircon-relocation', name: 'Aircon Relocation', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1600, durationMinutes: 120 }] }] }];
const relocationItem = scope => ({ serviceId: 'core-id', type: 'core', applianceKind: 'aircon', brand: 'Carrier', hp: 1,
  airconType: 'split', quantity: 1, unitPrice: 1600, totalPrice: 1, duration: 1,
  relocation: { scope, from: { details: 'Living room', lat: 1, lng: 1 }, to: { details: 'Bedroom', address: 'Palayan, Nueva Ecija', lat: 15.54, lng: 121.08 } } });
for (const scope of ['same_property', 'different_address']) {
  test(`${scope} relocation creates a normal appointment and payment at the catalog price`, async t => {
    const f = fixture(t, { catalogOverride: relocationCatalog });
    const result = await f.call({ services: [relocationItem(scope)], startTime: '08:00', projectScheduling: undefined });
    assert.equal(result.code, 201, result.body?.error);
    const booking = f.calls.writes[0], row = booking.services[0];
    assert.equal(row.unitPrice, 1600); assert.equal(row.totalPrice, 1600); assert.equal(row.duration, 120);
    assert.equal(row.relocation.scope, scope); assert.equal(row.relocation.from.lat, 15.4863);
    assert.equal(row.relocation.to.lat, scope === 'same_property' ? 15.4863 : 15.54);
    assert.equal(f.calls.payments.length, 1); assert.ok(f.calls.payments[0]);
    assert.equal(row.relocation.requestId, undefined); assert.equal(f.calls.projects.length, 0); assert.ok(f.calls.capacity.length >= 1);
  });
  test(`${scope} relocation rejects another service even if relocation metadata and name are omitted`, async t => {
    const f = fixture(t, { catalogOverride: relocationCatalog });
    const first = relocationItem(scope); delete first.relocation; first.name = 'Not relocation';
    const result = await f.call({ services: [first, { ...first }], startTime: '08:00' });
    assert.equal(result.code, 400); assert.match(result.body.error, /on its own/); assert.equal(f.calls.writes.length, 0);
  });
  test(`${scope} relocation rejects stale or manipulated prices and never saves a quote`, async t => {
    const f = fixture(t, { catalogOverride: relocationCatalog });
    const result = await f.call({ services: [{ ...relocationItem(scope), unitPrice: 0 }], startTime: '08:00' });
    assert.equal(result.code, 409); assert.equal(f.calls.writes.length, 0);
  });
}
test('another-address relocation rejects absent pins, identical pins, outside-coverage pins and legacy quote requests', async t => {
  const f = fixture(t, { catalogOverride: relocationCatalog });
  for (const change of [{ scope: 'custom_quote' }, { requestId: '507f1f77bcf86cd799439011' }, { to: {} },
    { to: { address: 'Unpinned destination', lat: null, lng: null } },
    { to: { address: 'Same property address', lat: 15.4863, lng: 120.9671 } },
    { to: { address: 'Outside Nueva Ecija', lat: 14.6, lng: 121 } }]) {
    const item = relocationItem('different_address'); Object.assign(item.relocation, change);
    const result = await f.call({ services: [item], startTime: '08:00' });
    assert.equal(result.code, 400, JSON.stringify(change)); assert.equal(f.calls.writes.length, 0);
  }
});
test('relocation needs a real appointment start time before payment is stored', async t => {
  const f = fixture(t, { catalogOverride: relocationCatalog });
  const result = await f.call({ services: [relocationItem('different_address')], projectScheduling: undefined });
  assert.equal(result.code, 400); assert.equal(f.calls.writes.length, 0);
});
