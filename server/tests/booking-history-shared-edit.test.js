'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A = require('../public/js/appliance-services');
const source = fs.readFileSync(path.join(__dirname, '../routes/bookingRoutesNew.js'), 'utf8');
const start = source.indexOf('async function validatedServiceItems('), end = source.indexOf('\n/**', start);
function fixture(coreCatalog) {
  let lookups = 0;
  const context = { ...require('../utils/relocationBookingPolicy'), require, validateBookingUnitLimit: A.unitCount, bookingServices: booking => booking.services,
    validateRepairModel: require('../utils/repairModelPolicy').validateRepairModel,
    CoreService: { findOne: () => ({ lean: async () => coreCatalog }) }, resolveCoreServicePricing: require('../utils/coreServicePricing').resolveCoreServicePricing,
    schedulingEngine: { MAX_BOOKING_UNITS: 40 }, getInspectionDurationMinutes: async () => 90,
    resolveRepairInspectionFees: async items => { lookups++; return items.map(item => {
      if (!['Washer', 'Dryer'].includes(item.unitType)) throw Error('Unsupported appliance');
      return { unitType: item.unitType, unitLabel: item.unitType, categorySlug: 'appliance', fee: item.unitType === 'Dryer' ? 750 : 500 };
    }); }, RepairService: { findOne() { throw Error('Category repairs have no RepairService catalog ID'); } } };
  vm.runInNewContext(source.slice(start, end), context);
  return { normalize: context.validatedServiceItems, lookups: () => lookups };
}
const row = () => ({ _id: 'fixture-row', type: 'repair', serviceId: null, unitType: 'Washer', unitCategory: 'appliance', applianceType: 'Washer',
  brand: 'Carrier', model: 'MODEL-123', problemDescription: 'The appliance does not spin or drain.', quantity: 1, unitPrice: 600, totalPrice: 600,
  status: 'inspection_pending', phase: 'repair_phase_1', photos: ['saved.jpg'], units: [{ unitNumber: 1, status: 'pending' }] });

test('booking edit preserves saved inspection prices, evidence and unit workflow when changing a model', async () => {
  const f = fixture(), previous = row(), booking = { services: [previous] };
  const [result] = await f.normalize([{ ...previous, model: 'MODEL-456' }], booking);
  assert.equal(result.model, 'MODEL-456'); assert.equal(result.unitPrice, 600); assert.equal(result.totalPrice, 600);
  assert.equal(result._id, previous._id); assert.equal(result.photos[0], 'saved.jpg'); assert.equal(result.units[0].unitNumber, 1);
  assert.equal(f.lookups(), 0); assert.equal(previous.model, 'MODEL-123');
});

test('the service change endpoint refuses duplicate saved identities before catalog lookup or persistence', async () => {
  const f = fixture(), previous = row();
  await assert.rejects(f.normalize([previous, { ...previous, brand: 'Midea' }], { services: [previous] }), error => error.status === 400 && /only one appliance/.test(error.message));
  assert.equal(f.lookups(), 0);
});

test('individually edited core units keep distinct saved identities and use server catalog prices', async () => {
  const catalog = { _id: 'cleaning', name: 'Cleaning', active: true, isAirconService: true,
    airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }, { hp: 2, price: 850, durationMinutes: 90 }] }] };
  const previous = { _id: 'saved-core', serviceId: 'cleaning', type: 'core', applianceKind: 'aircon', applianceGroupId: 'appliance_original',
    brand: 'Carrier', airconType: 'split', hp: 1, quantity: 2, unitPrice: 500, totalPrice: 1000, status: 'pending', photos: ['saved.jpg'] };
  const selection = [previous];
  require('../public/js/booking-editor-services').replaceCore(selection, [
    { ...previous, _id: undefined, quantity: 1, applianceGroupId: 'appliance_batch_first', unitPrice: 1 },
    { ...previous, _id: undefined, quantity: 1, applianceGroupId: 'appliance_batch_second', brand: 'Daikin', model: 'SECOND-123', hp: 2, unitPrice: 1 },
  ], 'appliance_original');
  const normalized = await fixture(catalog).normalize(selection, { services: [previous] });
  assert.equal(normalized[0]._id, 'saved-core'); assert.equal(normalized[1]._id, undefined);
  assert.equal(normalized[0].unitPrice, 500); assert.equal(normalized[1].unitPrice, 850);
  assert.equal(normalized[0].photos[0], 'saved.jpg'); assert.equal(normalized[1].model, 'SECOND-123');
  assert.equal(A.unitCount(normalized), 2);
});

test('repair booking edits can clear the optional model and preserve omitted saved models', async () => {
  const f = fixture(), previous = row(), booking = { services: [previous] };
  const [cleared] = await f.normalize([{ ...previous, model: '' }], booking);
  assert.equal(cleared.model, ''); assert.equal(cleared.unitPrice, previous.unitPrice);
  const input = { ...previous }; delete input.model;
  const [preserved] = await f.normalize([input], booking);
  assert.equal(preserved.model, previous.model);
  await assert.rejects(f.normalize([{ ...previous, model: '<script>' }], booking), /model number/i);
});

test('changing an unstarted repair appliance uses its catalog inspection fee instead of silently retaining the old type', async () => {
  const f = fixture(), previous = row();
  const [result] = await f.normalize([{ ...previous, unitType: 'Dryer', applianceType: 'Dryer' }], { services: [previous] });
  assert.equal(result.unitType, 'Dryer'); assert.equal(result.unitPrice, 750); assert.equal(result.totalPrice, 750); assert.equal(f.lookups(), 1);
  await assert.rejects(f.normalize([{ ...previous, unitType: 'Forged' }], { services: [previous] }), /Unsupported appliance/);
  await assert.rejects(f.normalize([{ ...previous, unitType: 'Dryer' }], { services: [{ ...previous, status: 'repair_in_progress' }] }), /entered the repair workflow/);
});

test('new repair quantities cannot be increased while historical multi-unit entries keep their accepted quantity', async () => {
  const f = fixture(), previous = row();
  await assert.rejects(f.normalize([{ ...previous, quantity: 2 }], { services: [previous] }), /each repair appliance separately/);
  const legacy = { ...previous, quantity: 2, totalPrice: 1200 };
  const [result] = await f.normalize([{ ...legacy, model: 'UPDATED-123' }], { services: [legacy] });
  assert.equal(result.quantity, 2); assert.equal(result.totalPrice, 1200);
});

test('unchanged historical repair choices remain usable while new unverified repairs are refused', async () => {
  const f = fixture(), legacy = { ...row(), unitType: 'Other', applianceType: 'Other', unitCategory: 'other', model: '', brand: "I don't know" };
  const [result] = await f.normalize([legacy], { services: [legacy] });
  assert.equal(result.unitType, 'Other'); assert.equal(result.unitPrice, 600); assert.equal(f.lookups(), 0);
  const fresh = { ...row(), _id: undefined, brand: "I don't know" };
  await assert.rejects(f.normalize([fresh], { services: [] }), /require a brand/);
});

const relocationCatalog = { _id: 'move', slug: 'aircon-relocation', name: 'Aircon Relocation', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1600, durationMinutes: 120 }] }] };
const moveRow = scope => ({ _id: 'saved-relocation', serviceId: 'move', name: 'Aircon Relocation', type: 'core', quantity: 1,
  applianceKind: 'aircon', brand: 'Carrier', hp: 1, airconType: 'split', unitPrice: 1600, duration: 120,
  relocation: { scope, from: { details: 'Room A' }, to: { details: 'Room B', address: 'Palayan, Nueva Ecija', lat: 15.54, lng: 121.08 }, completedTasks: ['removal.disconnect'] } });
for (const scope of ['same_property', 'different_address']) {
  test(`editing ${scope} relocation preserves saved pins and checklist progress`, async () => {
    const f = fixture(relocationCatalog), before = moveRow(scope);
    const booking = { customerId: 'customer', services: [before], location: { address: 'Cabanatuan, Nueva Ecija', lat: 15.4863, lng: 120.9671 } };
    const [saved] = await f.normalize([{ ...before, unitPrice: 1, relocation: { ...before.relocation, completedTasks: ['testing.all'] } }], booking);
    assert.equal(saved.unitPrice, 1600); assert.equal(saved.relocation.scope, scope);
    assert.equal(saved.relocation.from.lat, 15.4863); assert.equal(saved.relocation.to.lat, scope === 'same_property' ? 15.4863 : 15.54);
    assert.deepEqual(Array.from(saved.relocation.completedTasks), ['removal.disconnect']);
  });
  test(`editing ${scope} relocation cannot add a repair, another service or another unit`, async () => {
    const f = fixture(relocationCatalog), before = moveRow(scope), booking = { services: [before] };
    await assert.rejects(f.normalize([before, row()], booking), /on its own/);
    await assert.rejects(f.normalize([{ ...before, quantity: 2 }], booking), /one aircon/);
  });
}
