'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createService, quantities } = require('../utils/kitReturnService');
const { createService: createEquipmentService } = require('../utils/technicianToolsService');
const { outstanding, available } = require('../utils/kitMaterialBalance');
const T = '507f1f77bcf86cd799439011', E = '507f1f77bcf86cd799439012', A = '507f1f77bcf86cd799439013', K = '507f1f77bcf86cd799439014', B = '507f1f77bcf86cd799439015', U = '507f1f77bcf86cd799439016', I = '507f1f77bcf86cd799439017';
const clone = value => structuredClone(value);
function values(row, key) {
  let result = [row];
  for (const part of key.split('.')) result = result.flatMap(value => Array.isArray(value) ? value.map(entry => entry?.[part]) : [value?.[part]]);
  return result.flatMap(value => Array.isArray(value) ? value : [value]);
}
function match(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => match(row, item));
    if (key === '$and') return expected.every(item => match(row, item));
    if (key === '$nor') return !expected.some(item => match(row, item));
    const actual = values(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, target]) => {
      if (op === '$in') return actual.some(value => target.map(String).includes(String(value)));
      if (op === '$nin') return actual.every(value => !target.map(String).includes(String(value)));
      if (op === '$ne') return actual.every(value => value !== target);
      if (op === '$exists') return actual.some(value => value !== undefined) === target;
      throw Error('Unhandled query: ' + op);
    });
    return actual.some(value => expected == null ? value == null : String(value) === String(expected));
  });
}
function expression(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const [op, input] = Object.entries(value)[0], args = input.map(item => expression(item, row));
  if (op === '$cond') return args[0] ? args[1] : args[2];
  if (op === '$ifNull') return args[0] ?? args[1];
  if (op === '$add') return args[0] + args[1];
  if (op === '$subtract') return args[0] - args[1];
  if (op === '$max') return Math.max(...args);
  if (op === '$in') return args[1].includes(args[0]);
  if (op === '$gt') return args[0] > args[1];
  if (op === '$lte') return args[0] <= args[1];
  throw Error('Unhandled expression: ' + op);
}
function fixture() {
  let data = {
    EquipmentAssignment: [{ _id: A, technicianId: T, equipmentId: E, equipmentName: 'Pump', quantity: 2, consumable: false, status: 'checked_out', resolutionState: 'open', dailyKitId: K, bookingId: B }],
    DailyKit: [{ _id: K, technicianId: T, status: 'confirmed', items: [{ _id: E, name: 'Pump', category: 'equipment', toolId: E, equipmentAssignmentId: A, checkoutStatus: 'checked_out', issuedBookingIds: [B] }, { _id: I, name: 'Copper', category: 'consumable', toolId: I, unit: 'm', quantityIssued: 10, quantityUsed: 2, quantityReturned: 0, checkoutStatus: 'issued', issuedBookingIds: [B] }], deltaItems: [] }],
    Tool: [{ _id: E, quantity: 3, checkedOutQuantity: 2, minStockLevel: 3 }, { _id: I, quantity: 4, minStockLevel: 3 }],
    BookingService: [{ _id: B, status: 'cancelled' }], Assignment: [{ _id: U, bookingId: B, technicianId: T }],
    KitReturn: [], StockAdjustment: [], StockReservation: [], Order: [], DailyAssignment: [], WorkOrder: [], Project: [], Notification: [], ToolAssignment: [], EquipmentUsageLog: [],
  };
  let number = 40, tail = Promise.resolve(), fail = '';
  function document(name, row) {
    if (!row) return null;
    const doc = clone(row);
    Object.defineProperty(doc, 'save', { value: async () => {
      if (fail === name) throw Error(name + ' unavailable');
      const index = data[name].findIndex(item => item._id === doc._id);
      data[name][index] = clone(doc); return doc;
    } });
    return doc;
  }
  function query(run) { return { session() { return this; }, select() { return this; }, sort() { return this; }, lean() { return Promise.resolve().then(run); }, then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); } }; }
  function apply(row, update) {
    if (Array.isArray(update)) { const before = clone(row); for (const [key, value] of Object.entries(update[0].$set)) row[key] = expression(value, before); return; }
    for (const [key, value] of Object.entries(update.$set || {})) {
      const parts = key.split('.'); let parent = row; for (const part of parts.slice(0, -1)) parent = parent[part]; parent[parts.at(-1)] = value;
    }
    for (const [key, value] of Object.entries(update.$inc || {})) row[key] = Number(row[key] || 0) + value;
  }
  const models = Object.fromEntries(Object.keys(data).map(name => [name, {
    find(filter) { return query(() => data[name].filter(row => match(row, filter)).map(row => document(name, row))); },
    findById(value) { return query(() => document(name, data[name].find(row => row._id === String(value)))); },
    findOne(filter) { return query(() => document(name, data[name].find(row => match(row, filter)))); },
    exists(filter) { return query(() => data[name].some(row => match(row, filter))); },
    findOneAndUpdate(filter, update) { return query(() => { if (fail === name) throw Error(name + ' unavailable'); const row = data[name].find(row => match(row, filter)); if (!row) return null; apply(row, update); return document(name, row); }); },
    async updateOne(filter, update) { if (fail === name) throw Error(name + ' unavailable'); const row = data[name].find(row => match(row, filter)); if (!row) return { matchedCount: 0, modifiedCount: 0 }; apply(row, update); return { matchedCount: 1, modifiedCount: 1 }; },
    async updateMany(filter, update) { for (const row of data[name].filter(row => match(row, filter))) apply(row, update); },
    async create(rows) { if (fail === name) throw Error(name + ' unavailable'); return rows.map(input => { const row = { _id: (number++).toString(16).padStart(24, '0'), ...(name === 'KitReturn' ? { status: 'pending', unused: 0, used: 0, damaged: 0, missing: 0 } : {}), ...clone(input) }; data[name].push(row); return document(name, row); }); },
  }]));
  const db = { isValidObjectId: mongoose.isValidObjectId, async startSession() { return { async withTransaction(fn) {
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    const before = clone(data); try { return await fn(); } catch (error) { data = before; throw error; } finally { release(); }
  }, async endSession() {} }; } };
  const equipmentService = createEquipmentService({ ...models, mongoose: db });
  return { service: createService({ ...models, mongoose: db, equipmentService }), get data() { return data; }, set fail(value) { fail = value; } };
}
const equipmentInput = { assignmentIds: [A], technicianIds: [T], userId: U };
const materialInput = { kitId: K, itemId: I, technicianIds: [T], userId: U, unused: 8 };

function batchFixture() {
  const f = fixture();
  f.data.DailyKit[0].items.push({ _id: U, name: 'Tape', category: 'repair_part', toolId: U, unit: 'rolls', quantityIssued: 3, quantityUsed: 0, issuedBookingIds: [B] });
  f.data.Tool.push({ _id: U, quantity: 6 });
  return f;
}
const batchInput = { technicianIds: [T], userId: U, items: [{ kitId: K, itemId: I, unused: 8 }, { kitId: K, itemId: U, unused: 3 }] };

test('batch material returns reserve all selected items without crediting stock before receipt', async () => {
  const f = batchFixture(), reports = await f.service.reportMaterialsBatch(batchInput);
  assert.equal(reports.length, 2);
  assert.equal(f.data.Tool[1].quantity, 4); assert.equal(f.data.Tool[2].quantity, 6);
  assert.equal(available(f.data.DailyKit[0].items[1]), 0); assert.equal(available(f.data.DailyKit[0].items[2]), 0);
  for (const report of reports) await f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' });
  assert.equal(f.data.Tool[1].quantity, 12); assert.equal(f.data.Tool[2].quantity, 9);
  assert.equal(f.data.StockAdjustment.length, 2);
});

test('a stale quantity, pending report, or foreign kit rolls back every material in the batch', async () => {
  for (const second of [{ kitId: K, itemId: U, unused: 4 }, { kitId: B, itemId: U, unused: 3 }]) {
    const f = batchFixture();
    await assert.rejects(f.service.reportMaterialsBatch({ ...batchInput, items: [batchInput.items[0], second] }));
    assert.equal(f.data.KitReturn.length, 0); assert.equal(available(f.data.DailyKit[0].items[1]), 8);
    assert.equal(f.data.Tool[1].quantity, 4);
  }
  const f = batchFixture();
  await f.service.reportMaterials({ ...materialInput, itemId: U, unused: 1 });
  await assert.rejects(f.service.reportMaterialsBatch(batchInput), { status: 409 });
  assert.equal(f.data.KitReturn.length, 1); assert.equal(available(f.data.DailyKit[0].items[1]), 8);
});

test('concurrent duplicate batches save once and never double reserve or credit stock', async () => {
  const f = batchFixture();
  const results = await Promise.allSettled([1, 2].map(() => f.service.reportMaterialsBatch(batchInput)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.data.KitReturn.length, 2);
  assert.equal(f.data.DailyKit[0].items[1].returnPendingQuantity, 8);
  assert.equal(f.data.DailyKit[0].items[2].returnPendingQuantity, 3);
  assert.equal(f.data.StockAdjustment.length, 0);
});

test('batch input cannot spoof ownership and rejects duplicates, empty, oversized, or invalid quantities', async () => {
  const f = batchFixture();
  for (const items of [[], Array(101).fill(batchInput.items[0]), [batchInput.items[0], batchInput.items[0]], [{ ...batchInput.items[0], unused: -1 }], [null]]) {
    await assert.rejects(f.service.reportMaterialsBatch({ ...batchInput, items }), { status: 400 });
  }
  await assert.rejects(f.service.reportMaterialsBatch({ ...batchInput, technicianIds: [B], items: [{ ...batchInput.items[0], technicianIds: [T], userId: T, session: {} }] }), { status: 404 });
  assert.equal(f.data.KitReturn.length, 0);
  const [report] = await f.service.reportMaterialsBatch({ ...batchInput, items: [{ ...batchInput.items[0], technicianIds: [B], userId: B, status: 'received', session: {} }] });
  assert.equal(report.reportedBy, U); assert.equal(report.technicianId, T); assert.equal(report.status, 'pending');
});

test('bulk mixed quantities preserve explanations and active work protections', async () => {
  const f = batchFixture(), items = [batchInput.items[0], { kitId: K, itemId: U, unused: 1, used: 1, damaged: 1 }];
  await assert.rejects(f.service.reportMaterialsBatch({ ...batchInput, items }), { status: 400 });
  assert.equal(f.data.KitReturn.length, 0);
  f.data.BookingService[0].status = 'in_progress';
  await assert.rejects(f.service.reportMaterialsBatch({ ...batchInput, items, notes: 'One used and one damaged.' }), { status: 409 });
  assert.equal(f.data.KitReturn.length, 0); assert.equal(available(f.data.DailyKit[0].items[1]), 8);
  f.data.BookingService[0].status = 'cancelled';
  const reports = await f.service.reportMaterialsBatch({ ...batchInput, items, notes: 'One used and one damaged.' });
  assert.equal(reports[1].used, 1); assert.equal(reports[1].damaged, 1); assert.equal(reports[1].notes, 'One used and one damaged.');
});

async function reviewFixture() {
  const f = fixture(), [equipment] = await f.service.reportEquipment(equipmentInput), material = await f.service.reportMaterials(materialInput);
  return { f, input: { items: [{ reportId: equipment._id }, { reportId: material._id }], userId: U, decision: 'receive', confirmedReceived: true } };
}

test('returning an extra repair part closes its checked-out reservation and restores stock once', async () => {
  const f = fixture(), item = f.data.DailyKit[0].items[1];
  item.category = 'repair_part'; item.quantityIssued = 2; item.quantityUsed = 1;
  f.data.StockReservation.push({ _id: A, bookingId: B, toolId: I, quantity: 2, quantityFulfilled: 1, status: 'checked_out' });
  const report = await f.service.reportMaterials({ kitId: K, itemId: I, unused: 1, technicianIds: [T], userId: U });
  await f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' });
  assert.equal(f.data.Tool[1].quantity, 5); assert.equal(f.data.DailyKit[0].items[1].quantityReturned, 1);
  assert.equal(f.data.StockReservation[0].quantityReturned, 1); assert.equal(f.data.StockReservation[0].quantityFulfilled, 1);
  assert.equal(f.data.StockReservation[0].status, 'fulfilled');
  await assert.rejects(f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' }), { status: 409 });
  assert.equal(f.data.Tool[1].quantity, 5); assert.equal(f.data.StockAdjustment.length, 1);
});

test('admin batch receipt handles equipment and corrected materials together and retains original claims', async () => {
  const { f, input } = await reviewFixture();
  input.items[0].userId = B; input.items[0].session = {}; // cannot replace the actor or transaction
  input.items[1].quantities = { unused: 4, used: 1, damaged: 2, missing: 1 };
  input.items[1].notes = 'Four metres received, one used, two damaged, one missing.';
  const reports = await f.service.reconcileBatch(input);
  assert.equal(reports.length, 2); assert.ok(reports.every(row => row.status === 'received' && row.receivedBy === U));
  assert.equal(f.data.Tool[0].quantity, 5); assert.equal(f.data.Tool[1].quantity, 8);
  assert.equal(f.data.KitReturn[1].reportedQuantities.unused, 8);
  assert.equal(f.data.DailyKit[0].items[1].quantityDamaged, 2);
});

test('an invalid later review rolls back earlier equipment receipt, stock, kit, and report status', async () => {
  const { f, input } = await reviewFixture();
  input.items[1].quantities = { unused: 7 };
  await assert.rejects(f.service.reconcileBatch(input), { status: 409 });
  assert.equal(f.data.Tool[0].quantity, 3); assert.equal(f.data.Tool[1].quantity, 4);
  assert.equal(f.data.EquipmentAssignment[0].status, 'checked_out');
  assert.equal(f.data.EquipmentAssignment[0].returnPending, true);
  assert.ok(f.data.KitReturn.every(row => row.status === 'pending'));
  assert.equal(f.data.DailyKit[0].items[0].returnPendingQuantity, 2);
  assert.equal(f.data.StockAdjustment.length, 0);
});

test('already reviewed reports and concurrent batch retries cannot restore stock twice', async () => {
  const { f, input } = await reviewFixture();
  const results = await Promise.allSettled([1, 2].map(() => f.service.reconcileBatch(input)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.data.Tool[0].quantity, 5); assert.equal(f.data.Tool[1].quantity, 12);
  assert.equal(f.data.StockAdjustment.length, 1);
  const second = await reviewFixture();
  await second.f.service.reconcile({ reportId: second.input.items[1].reportId, decision: 'receive', userId: U });
  await assert.rejects(second.f.service.reconcileBatch(second.input), { status: 409 });
  assert.equal(second.f.data.KitReturn[0].status, 'pending');
  assert.equal(second.f.data.Tool[0].quantity, 3);
});

test('batch rejection releases pending quantities, retains custody and adds no stock', async () => {
  const { f, input } = await reviewFixture();
  await assert.rejects(f.service.reconcileBatch({ ...input, decision: 'reject' }), { status: 400 });
  assert.ok(f.data.KitReturn.every(row => row.status === 'pending'));
  await f.service.reconcileBatch({ ...input, decision: 'reject', notes: 'Items have not been handed over yet.' });
  assert.ok(f.data.KitReturn.every(row => row.status === 'rejected' && row.receiptNotes === 'Items have not been handed over yet.'));
  assert.equal(f.data.EquipmentAssignment[0].status, 'checked_out'); assert.equal(f.data.EquipmentAssignment[0].returnPending, false);
  assert.equal(available(f.data.DailyKit[0].items[1]), 8);
  assert.equal(f.data.Tool[0].quantity, 3); assert.equal(f.data.Tool[1].quantity, 4);
});

test('bulk receipt requires explicit confirmation and valid distinct report IDs within the batch limit', async () => {
  const { f, input } = await reviewFixture();
  for (const confirmedReceived of [false, undefined, 'true']) await assert.rejects(f.service.reconcileBatch({ ...input, confirmedReceived }), { status: 400 });
  for (const items of [[], Array(101).fill(input.items[0]), [input.items[0], input.items[0]], [null], [{ reportId: 'bad' }]]) await assert.rejects(f.service.reconcileBatch({ ...input, items }), { status: 400 });
  assert.equal(f.data.Tool[0].quantity, 3); assert.ok(f.data.KitReturn.every(row => row.status === 'pending'));
});

test('cancelled job equipment stays checked out until admin physically receives it', async () => {
  const f = fixture(), [report] = await f.service.reportEquipment(equipmentInput);
  assert.equal(f.data.Tool[0].quantity, 3);
  assert.equal(f.data.EquipmentAssignment[0].status, 'checked_out');
  assert.equal(f.data.EquipmentAssignment[0].returnPending, true);
  assert.equal(f.data.DailyKit[0].items[0].returnPendingQuantity, 2);
  assert.deepEqual(report.bookingIds, [B]);
  await assert.rejects(f.service.reportEquipment(equipmentInput), { status: 409 });
  await f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' });
  assert.equal(f.data.Tool[0].quantity, 5);
  assert.equal(f.data.EquipmentAssignment[0].status, 'returned');
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, 'returned');
  assert.equal(f.data.KitReturn[0].status, 'received');
  assert.equal(f.data.KitReturn[0].receivedBy, U);
});

test('shared tools remain required by another unfinished booking, even after live kit links are cleared', async () => {
  const f = fixture(); f.data.DailyKit[0].items[0].issuedBookingIds.push(U); f.data.BookingService.push({ _id: U, status: 'in_progress' });
  await assert.rejects(f.service.reportEquipment(equipmentInput), { status: 409 });
  assert.equal(f.data.KitReturn.length, 0);
  assert.equal(f.data.Tool[0].quantity, 3);
});

test('another technician cannot report equipment or materials they do not own', async () => {
  const f = fixture();
  await assert.rejects(f.service.reportEquipment({ ...equipmentInput, technicianIds: [U] }), { status: 403 });
  await assert.rejects(f.service.reportMaterials({ ...materialInput, technicianIds: [U] }), { status: 404 });
  assert.equal(f.data.KitReturn.length, 0);
});

test('unused materials are reserved against usage while pending, and received once with a stock history record', async () => {
  const f = fixture(), report = await f.service.reportMaterials(materialInput);
  assert.equal(f.data.Tool[1].quantity, 4);
  assert.equal(outstanding(f.data.DailyKit[0].items[1]), 8);
  assert.equal(available(f.data.DailyKit[0].items[1]), 0);
  await assert.rejects(f.service.reportMaterials(materialInput), { status: 409 });
  const results = await Promise.allSettled([1, 2].map(() => f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.data.Tool[1].quantity, 12);
  assert.equal(f.data.DailyKit[0].items[1].quantityReturned, 8);
  assert.equal(f.data.DailyKit[0].items[1].quantityUsed, 2);
  assert.equal(available(f.data.DailyKit[0].items[1]), 0);
  assert.equal(f.data.StockAdjustment.length, 1);
  assert.equal(f.data.StockAdjustment[0].delta, 8);
});

test('partial return leaves the remaining issued quantities usable for other jobs', async () => {
  const f = fixture(); await f.service.reportMaterials({ ...materialInput, unused: 3 });
  assert.equal(available(f.data.DailyKit[0].items[1]), 5);
});

test('admin can correct quantities without losing the technician report; only usable returned units are credited', async () => {
  const f = fixture(), report = await f.service.reportMaterials(materialInput);
  await f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive', quantities: { unused: 4, used: 1, damaged: 2, missing: 1 }, notes: 'Four metres received. One used on the cancelled attempt. Two damaged; one missing.' });
  const item = f.data.DailyKit[0].items[1];
  assert.equal(f.data.Tool[1].quantity, 8);
  assert.equal(item.quantityUsed, 3); assert.equal(item.quantityDamaged, 2); assert.equal(item.quantityMissing, 1);
  assert.equal(outstanding(item), 0);
  assert.equal(f.data.KitReturn[0].reportedQuantities.unused, 8);
  assert.equal(f.data.KitReturn[0].unused, 4);
});

test('damage or loss equipment report waits for admin and never credits available stock', async () => {
  for (const condition of ['damaged', 'lost']) {
    const f = fixture(), [report] = await f.service.reportEquipment({ ...equipmentInput, condition, damageDescription: 'Pump damaged in transit.' });
    assert.equal(f.data.Tool[0].quantity, 3);
    await f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' });
    assert.equal(f.data.Tool[0].quantity, 3);
    assert.equal(f.data.EquipmentAssignment[0].status, condition);
    assert.equal(f.data.Tool[0].assignable, false);
  }
});

test('rejected reports release the pending quantity without increasing stock and permit correction', async () => {
  const f = fixture(), report = await f.service.reportMaterials(materialInput);
  await assert.rejects(f.service.reconcile({ reportId: report._id, userId: U, decision: 'reject' }), { status: 400 });
  await f.service.reconcile({ reportId: report._id, userId: U, decision: 'reject', notes: 'Please bring the items back first.' });
  assert.equal(f.data.Tool[1].quantity, 4);
  assert.equal(available(f.data.DailyKit[0].items[1]), 8);
  await f.service.reportMaterials(materialInput);
  assert.equal(f.data.KitReturn.length, 2);
});

test('rejecting equipment retains custody and permits another report', async () => {
  const f = fixture(), [report] = await f.service.reportEquipment(equipmentInput);
  await f.service.reconcile({ reportId: report._id, userId: U, decision: 'reject', notes: 'Equipment not handed over yet.' });
  assert.equal(f.data.EquipmentAssignment[0].returnPending, false);
  assert.equal(f.data.DailyKit[0].items[0].returnPendingQuantity, 0);
  assert.equal(f.data.Tool[0].quantity, 3);
  await f.service.reportEquipment(equipmentInput);
});

test('material receipt failures roll back stock, counters, audit history, and report status together', async () => {
  for (const fail of ['Tool', 'StockAdjustment', 'DailyKit', 'KitReturn']) {
    const f = fixture(), report = await f.service.reportMaterials(materialInput); f.fail = fail;
    await assert.rejects(f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive' }), /unavailable/);
    assert.equal(f.data.Tool[1].quantity, 4);
    assert.equal(f.data.KitReturn[0].status, 'pending');
    assert.equal(f.data.DailyKit[0].items[1].returnPendingQuantity, 8);
    assert.equal(f.data.StockAdjustment.length, 0);
  }
});

test('admin manual equipment receipt closes a pending technician report atomically', async () => {
  const f = fixture(); await f.service.reportEquipment(equipmentInput);
  await f.service.receiveEquipmentRecord({ assignmentId: A, userId: U, condition: 'good', notes: 'Received at the office.' });
  assert.equal(f.data.KitReturn[0].status, 'received');
  assert.equal(f.data.Tool[0].quantity, 5);
  await assert.rejects(f.service.receiveEquipmentRecord({ assignmentId: A, userId: U, condition: 'good' }), { status: 409 });
});

test('over-reporting, bad quantities, and a different received total leave stock unchanged', async () => {
  for (const value of [-1, Infinity, NaN]) assert.throws(() => quantities({ unused: value }), { status: 400 });
  const f = fixture();
  await assert.rejects(f.service.reportMaterials({ ...materialInput, unused: 9 }), { status: 409 });
  const report = await f.service.reportMaterials(materialInput);
  await assert.rejects(f.service.reconcile({ reportId: report._id, userId: U, decision: 'receive', quantities: { unused: 5 } }), { status: 409 });
  assert.equal(f.data.Tool[1].quantity, 4);
});
