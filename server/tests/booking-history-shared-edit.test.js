'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A = require('../public/js/appliance-services');
const source = fs.readFileSync(path.join(__dirname, '../routes/bookingRoutesNew.js'), 'utf8');
const start = source.indexOf('async function validatedServiceItems('), end = source.indexOf('\n/**', start);
function fixture() {
  let lookups = 0;
  const context = { require, validateBookingUnitLimit: A.unitCount, bookingServices: booking => booking.services,
    validateRepairModel: require('../utils/repairModelPolicy').validateRepairModel,
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
