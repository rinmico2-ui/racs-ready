'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createService, approvedParts } = require('../utils/repairCompletionInventory');
const DailyKit = require('../models/DailyKit'), Tool = require('../models/Tool'), Usage = require('../models/ServiceToolUsage');
const { recordBookingConsumableUsage } = require('../utils/dailyKitService');
const id = n => n.toString(16).padStart(24, '0');
const B = id(1), A = id(2), T = id(3), P = id(4), C = id(5), E = id(6), session = {};
const query = value => ({ session() { return this; }, select() { return this; }, lean() { return this; },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function fixture(options = {}) {
  const usage = [], writes = [];
  const part = { name: 'Run capacitor', quantity: 1, cost: 400, toolId: P };
  const booking = { _id: B, bookingDate: new Date('2026-10-22T00:00:00+08:00'), quotation: { parts: [part] }, ...options.booking };
  const kit = options.noKit ? null : { items: [
    { _id: id(10), name: 'Run capacitor', toolId: P, category: 'repair_part', bookingIds: [B], quantityIssued: options.issued || 1, quantityUsed: 0, checkoutStatus: 'issued' },
    { _id: id(11), name: 'Tape', toolId: C, category: 'consumable', bookingIds: [B], quantityIssued: 1, quantityUsed: 0, checkoutStatus: 'issued' },
    { _id: id(12), name: 'Multimeter', toolId: E, category: 'equipment', bookingIds: [B], checkoutStatus: 'checked_out' },
    { _id: id(13), name: 'Other job cleaner', toolId: C, category: 'consumable', bookingIds: [id(99)], quantityIssued: 10, checkoutStatus: 'issued' },
  ], async save(opts) { assert.equal(opts.session, session); writes.push('kit'); } };
  const stock = { _id: P, type: 'part', quantity: 7, costPrice: 100, ...options.tool };
  const reservation = { _id: id(20), toolId: P, quantity: options.issued || 1, status: options.reservationStatus || 'checked_out', stockTreatment: 'deducted', quantityFulfilled: 0,
    async save(opts) { assert.equal(opts.session, session); writes.push('reservation'); } };
  const api = createService({ DailyKit: { findOne(filter) { assert.equal(filter.technicianId, T); return query(kit); } },
    Tool: { find: () => query([stock]) }, StockReservation: { find: () => query(options.noReservations ? [] : [reservation]) },
    ServiceToolUsage: { async insertMany(rows, opts) { assert.equal(opts.session, session); usage.push(...rows); } } });
  const input = { booking, assignment: { _id: A, bookingDate: booking.bookingDate }, technicianId: T, userId: T, session };
  return { api, input, kit, stock, reservation, usage, writes };
}

test('completion gets parts from approved and completed appliance quotes, excluding declined quotes', () => {
  const booking = { repairUnitTracking: true, services: [{ type: 'repair', units: [
    { unitIndex: 1, repairReview: { state: 'completed' }, quotation: { parts: [{ name: 'Capacitor', toolId: P, quantity: 1 }] } },
    { unitIndex: 2, repairReview: { state: 'approved' }, quotation: { parts: [{ name: 'Capacitor', toolId: P, quantity: 2 }] } },
    { unitIndex: 3, repairReview: { state: 'declined' }, quotation: { parts: [{ name: 'Compressor', quantity: 1 }] } },
  ] }] };
  const parts = approvedParts(booking); assert.equal(parts.length, 1); assert.equal(parts[0].quantity, 3);
});

test('summary separates replacement parts, scoped consumables and reusable equipment without writes', async () => {
  const f = fixture(), plan = await f.api.plan(f.input);
  assert.equal(plan.parts[0].name, 'Run capacitor'); assert.equal(plan.parts[0].missing, 0);
  assert.deepEqual(plan.consumables, [{ itemName: 'Tape', unit: 'pcs', available: 1 }]);
  assert.equal(plan.equipmentCount, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.usage, []);
});

test('issued parts are attributed once, their checked-out reservation is fulfilled and warehouse quantity is unchanged', async () => {
  const f = fixture(), parts = await f.api.record(f.input);
  assert.deepEqual(parts, [{ name: 'Run capacitor', quantity: 1, unit: 'pcs' }]);
  assert.equal(f.kit.items[0].quantityUsed, 1); assert.equal(f.kit.items[1].quantityUsed, 0);
  assert.equal(f.kit.items[2].checkoutStatus, 'checked_out'); assert.equal(f.stock.quantity, 7);
  assert.equal(f.reservation.status, 'fulfilled'); assert.equal(f.reservation.quantityFulfilled, 1);
  assert.equal(f.usage.length, 1); assert.equal(f.usage[0].itemType, 'part'); assert.equal(f.usage[0].quantityUsed, 1);
  assert.equal(f.usage[0].unitPrice, 100); assert.equal(f.usage[0].deductedFromInventory, true);
});

test('extra issued parts stay available for return instead of being automatically consumed', async () => {
  const f = fixture({ issued: 2 }); await f.api.record(f.input);
  assert.equal(f.kit.items[0].quantityUsed, 1); assert.equal(f.reservation.quantityFulfilled, 1);
  assert.equal(f.reservation.status, 'checked_out'); assert.equal(f.stock.quantity, 7);
});

test('legacy deducted reservations are fulfilled without decrementing stock again', async () => {
  const f = fixture({ noKit: true, reservationStatus: 'reserved' }); await f.api.record(f.input);
  assert.equal(f.reservation.status, 'fulfilled'); assert.equal(f.stock.quantity, 7); assert.equal(f.usage.length, 1);
});

test('a nearby purchased part is recorded without decrementing warehouse stock or charging its expense twice', async () => {
  const f = fixture({ noKit: true, noReservations: true, booking: { quotation: { parts: [{ name: 'Supplier capacitor', quantity: 1 }] },
    localPurchase: [{ quotationKey: 'name:supplier capacitor', quantity: 1, purchaseByType: 'customer', purchaseStatus: 'verified' }] } });
  await f.api.record(f.input); assert.equal(f.usage.length, 1); assert.equal(f.usage[0].deductedFromInventory, false);
  assert.equal(f.usage[0].unitPrice, 0); assert.equal(f.usage[0].toolItemId, undefined); assert.equal(f.stock.quantity, 7);
});

test('missing parts and equipment disguised as quoted parts block completion without any stock usage', async () => {
  for (const options of [{ noKit: true, noReservations: true }, { tool: { type: 'equipment', inventoryClass: 'operational_asset' } }]) {
    const f = fixture(options); await assert.rejects(f.api.record(f.input), { status: 409 });
    assert.equal(f.usage.length, 0); assert.deepEqual(f.writes, []); assert.equal(f.stock.quantity, 7);
  }
});

test('a labor-only repair has no part consumption or automatic equipment return', async () => {
  const f = fixture({ booking: { quotation: { parts: [] } } });
  assert.deepEqual(await f.api.record(f.input), []); assert.equal(f.usage.length, 0); assert.deepEqual(f.writes, []);
  assert.equal(f.kit.items[2].checkoutStatus, 'checked_out');
});

test('issued consumables accept zero or fractional actual usage without touching warehouse stock', async t => {
  const kit = { items: [{ name: 'Tape', toolId: C, category: 'consumable', bookingIds: [B], quantityIssued: 1, quantityUsed: 0 }], async save() {} }, usages = [];
  t.mock.method(DailyKit, 'findOne', () => query(kit));
  t.mock.method(Tool, 'findById', () => query({ costPrice: 10 }));
  t.mock.method(Usage, 'find', filter => { assert.equal(filter.itemType, 'consumable'); return query([]); });
  t.mock.method(Usage, 'insertMany', async rows => { usages.push(...rows); });
  const input = { technicianId: T, userId: T, assignmentId: A, bookingId: B, date: '2026-10-22', session };
  await recordBookingConsumableUsage({ ...input, usages: [{ itemName: 'Tape', quantityUsed: 0 }] });
  assert.equal(kit.items[0].quantityUsed, 0); assert.equal(usages.length, 0);
  await recordBookingConsumableUsage({ ...input, usages: [{ itemName: 'Tape', quantityUsed: .25 }] });
  assert.equal(kit.items[0].quantityUsed, .25); assert.equal(usages[0].quantityUsed, .25);
  await assert.rejects(recordBookingConsumableUsage({ ...input, usages: [{ itemName: 'Tape', quantityUsed: 1 }] }), { status: 409 });
  await assert.rejects(recordBookingConsumableUsage({ ...input, usages: [] }), { status: 400 });
  await assert.rejects(recordBookingConsumableUsage({ ...input, usages: [{ itemName: 'Unissued cleaner', quantityUsed: 1 }, { itemName: 'Tape', quantityUsed: 0 }] }), { status: 403 });
});

test('a mixed booking records Repair and later final Core usage independently and retries each only once', async t => {
  const kit = { items: [{ name: 'Tape', toolId: C, category: 'consumable', bookingIds: [B], quantityIssued: 2, quantityUsed: 0 }], async save() {} }, usages = [];
  t.mock.method(DailyKit, 'findOne', () => query(kit));
  t.mock.method(Tool, 'findById', () => query({ costPrice: 10 }));
  t.mock.method(Usage, 'find', filter => query(usages.filter(row => row.itemType === 'consumable'
    && (filter.completionStage === 'repair' ? row.completionStage === 'repair' : row.completionStage !== 'repair'))));
  t.mock.method(Usage, 'insertMany', async rows => { usages.push(...rows); });
  const input = { technicianId: T, userId: T, assignmentId: A, bookingId: B, date: '2026-10-22', session };
  const repair = { ...input, completionStage: 'repair', usages: [{ itemName: 'Tape', quantityUsed: .5 }] };
  const final = { ...input, usages: [{ itemName: 'Tape', quantityUsed: .25 }] };
  await recordBookingConsumableUsage(repair); await recordBookingConsumableUsage(final);
  assert.equal(kit.items[0].quantityUsed, .75); assert.equal(usages.length, 2);
  assert.equal(usages[0].completionStage, 'repair'); assert.equal(usages[1].completionStage, 'final');
  assert.equal((await recordBookingConsumableUsage(repair)).alreadyRecorded, true);
  assert.equal((await recordBookingConsumableUsage(final)).alreadyRecorded, true);
  assert.equal(kit.items[0].quantityUsed, .75); assert.equal(usages.length, 2);
  await assert.rejects(recordBookingConsumableUsage({ ...final, usages: [{ itemName: 'Tape', quantityUsed: .5 }] }), { status: 409 });
});
