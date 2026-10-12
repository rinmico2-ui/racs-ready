'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mongoose = require('mongoose');
const file = path.join(__dirname, '../utils/dailyKitService.js');
const actualRequire = createRequire(file);
const source = fs.readFileSync(file, 'utf8');
const T = '507f1f77bcf86cd799439011', B = '507f1f77bcf86cd799439012', A = '507f1f77bcf86cd799439013';
const K = '507f1f77bcf86cd799439014', E = '507f1f77bcf86cd799439015', I = '507f1f77bcf86cd799439016';
const U = '507f1f77bcf86cd799439017', OTHER = '507f1f77bcf86cd799439018';
const NOW = new Date('2026-10-11T05:00:00Z'), DATE = '2026-10-11';
function clone(value) {
  if (value instanceof Date) return new Date(value);
  if (value instanceof mongoose.Types.ObjectId) return new mongoose.Types.ObjectId(value.toString());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}
const get = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
function expression(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return get(row, value.slice(1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const [op, input] = Object.entries(value)[0], args = input.map(entry => expression(entry, row));
  if (op === '$ifNull') return args[0] ?? args[1];
  if (op === '$subtract') return args[0] - args[1];
  if (op === '$gte') return args[0] >= args[1];
  throw Error('Unknown expression ' + op);
}
function match(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(entry => match(row, entry));
    if (key === '$expr') return expression(expected, row);
    const value = get(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof mongoose.Types.ObjectId)) {
      return Object.entries(expected).every(([op, target]) => {
        if (op === '$in') return target.some(entry => String(entry) === String(value));
        if (op === '$nin') return target.every(entry => String(entry) !== String(value));
        if (op === '$ne') return value !== target;
        if (op === '$gte') return value >= target;
        if (op === '$lt') return value < target;
        throw Error('Unknown filter ' + op);
      });
    }
    return String(value) === String(expected);
  });
}
function fixture({ quantity = 1, items = 1, standard = false } = {}) {
  let data = Object.fromEntries(['Assignment', 'BookingService', 'DailyAssignment', 'DailyKit', 'EquipmentAssignment', 'Order', 'ServiceToolUsage', 'StockReservation', 'Tool', 'WorkOrder', 'Technician', 'Project'].map(name => [name, []]));
  data.Technician = [{ _id: T, user: U }];
  const requirement = (id, name, kind = 'equipment') => ({ inventoryId: id, name, kind, quantity: 1, unit: 'pcs' });
  data.Tool = [{ _id: E, itemName: 'Pump', quantity, reservedQuantity: 0, checkedOutQuantity: 0, type: 'equipment', active: true, assignable: true, assetStatus: 'available', standardTechnicianKit: standard, standardKitQuantity: 1 }];
  data.Assignment = [{ _id: A, bookingId: B, technicianId: T, bookingDate: new Date('2026-10-11T00:00:00+08:00'), status: 'accepted', quantity: 1 }];
  data.BookingService = [{ _id: B, status: 'confirmed', requirements: [requirement(E, 'Pump')] }];
  const item = { _id: I, name: 'Pump', toolId: E, quantity: 1, category: 'equipment', checkoutStatus: 'pending', preparedChecked: true, assignmentIds: [A], bookingIds: [B], orderIds: [], projectIds: [] };
  data.DailyKit = [{ _id: K, __v: 0, technicianId: T, workDate: new Date('2026-10-11T00:00:00+08:00'), status: 'draft', items: [item], assignmentIds: [A], bookingIds: [B], orderIds: [], dailyAssignmentIds: [], deltaItems: [] }];
  if (items === 2) {
    data.Tool.push({ _id: OTHER, itemName: 'Cleaner', quantity: 1, reservedQuantity: 0, active: true, type: 'consumable' });
    data.BookingService[0].requirements.push(requirement(OTHER, 'Cleaner', 'consumable'));
    data.DailyKit[0].items.push({ ...item, _id: U, name: 'Cleaner', toolId: OTHER, category: 'consumable' });
  }
  const calls = []; let failure = '', failItem = '', serial = 30, tail = Promise.resolve(), reserveAtCheckout = false, injectRetry = false, failAfterKitSaves = null;
  function plain(doc) { return Object.fromEntries(Object.entries(doc).filter(([key, value]) => key !== '$locals' && typeof value !== 'function')); }
  function document(name, row) {
    if (!row) return null;
    const doc = clone(row); doc.$locals = {};
    doc.toObject = () => clone(plain(doc));
    doc.save = async ({ session } = {}) => {
      if (!session) throw Error('Nontransactional save ' + name);
      if (failure === name || (failure === 'FinalKit' && name === 'DailyKit' && doc.status === 'confirmed')) throw Error('Injected ' + name + ' failure');
      if (name === 'DailyKit' && failAfterKitSaves !== null && calls.filter(call => call === 'DailyKit.save').length >= failAfterKitSaves) throw Error('Injected later kit save failure');
      if (name === 'DailyKit') for (const item of [...(doc.items || []), ...(doc.deltaItems || [])]) {
        item._id ||= (++serial).toString(16).padStart(24, '0');
        item.preparedChecked ??= false;
        item.manualQuantity ??= 0;
        item.requiredQuantity ??= 0;
      }
      const at = data[name].findIndex(entry => String(entry._id) === String(doc._id));
      if (name === 'DailyKit' && (data[name][at].__v || 0) !== (doc.__v || 0)) throw Object.assign(Error('Stale kit'), { name: 'VersionError' });
      doc.__v = (doc.__v || 0) + 1;
      data[name][at] = clone(plain(doc)); calls.push(name + '.save'); return doc;
    };
    return doc;
  }
  function query(name, filter, one = false) {
    let session, lean = false;
    const run = () => {
      const found = data[name].filter(row => match(row, filter));
      return one ? (lean ? clone(found[0] || null) : document(name, found[0])) : found.map(row => lean ? clone(row) : document(name, row));
    };
    return { session(value) { session = value; return this; }, select() { return this; }, populate() { return this; }, sort() { return this; },
      lean() { lean = true; return Promise.resolve(run()); }, then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); } };
  }
  function update(row, patch) {
    for (const [key, value] of Object.entries(patch.$inc || {})) row[key] = Number(row[key] || 0) + value;
    for (const [key, value] of Object.entries(patch.$set || {})) {
      const parts = key.split('.'); let parent = row;
      for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
      parent[parts.at(-1)] = value;
    }
  }
  const models = Object.fromEntries(Object.keys(data).map(name => [name, {
    find: filter => query(name, filter), findOne: filter => query(name, filter, true), findById: id => query(name, { _id: id }, true),
    async create(rows, { session } = {}) {
      assert.ok(session); if (failure === name) throw Error('Injected ' + name + ' failure');
      return rows.map(row => { const stored = clone({ ...(name === 'DailyKit' ? { status: 'draft', __v: 0, deltaItems: [] } : {}), ...row, _id: row._id || (++serial).toString(16).padStart(24, '0') }); data[name].push(stored); calls.push(name + '.create'); return document(name, stored); });
    },
    async findOneAndUpdate(filter, patch, { session } = {}) {
      assert.ok(session); if (failure === name) throw Error('Injected ' + name + ' failure');
      if (String(filter._id) === failItem) return null;
      if (reserveAtCheckout && name === 'Tool') data.Tool[0].reservedQuantity = 1;
      const row = data[name].find(row => match(row, filter)); if (!row) return null;
      update(row, patch); calls.push(name + '.update'); return document(name, row);
    },
    async updateMany(filter, patch, { session } = {}) {
      assert.ok(session); if (failure === name) throw Error('Injected ' + name + ' failure');
      const rows = data[name].filter(row => match(row, filter)); rows.forEach(row => update(row, patch)); calls.push(name + '.update'); return { modifiedCount: rows.length, matchedCount: rows.length };
    },
    async updateOne(filter, patch, options) { return this.updateMany(filter, patch, options); },
  }]));
  models.Tool.effectiveInventoryClass = row => ['equipment', 'tool'].includes(row.type) ? 'operational_asset' : 'merchandise';
  const db = { isValidObjectId: mongoose.isValidObjectId, Types: mongoose.Types, async startSession() {
    const session = { async withTransaction(callback) {
      const prior = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await prior;
      const before = clone(data);
      try { await callback(); if (injectRetry) { injectRetry = false; data = clone(before); await callback(); } }
      catch (error) { data = before; throw error; } finally { unlock(); }
    }, async endSession() {} }; return session;
  } };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } }
  const context = { module: { exports: {} }, Date: FixedDate, console, global: {}, require(name) {
    if (name === 'mongoose') return db;
    if (name.startsWith('../models/')) return models[name.split('/').at(-1)];
    if (name === './servicePreparation') return { buildServicePreparation: async booking => ({ recommendations: booking.requirements || [] }) };
    return actualRequire(name);
  } };
  vm.runInNewContext(source, context, { filename: file });
  return { api: context.module.exports, models, calls, get data() { return data; }, fail(name) { failure = name; }, failItem(id) { failItem = id; }, competingReservation() { reserveAtCheckout = true; }, retry() { injectRetry = true; }, failAfterKitSaves(count) { failAfterKitSaves = count; } };
}
const confirmation = (f, extra = {}) => f.api.confirmDailyKit({ technicianId: T, userId: U, date: DATE, ...extra });
const addExtra = (f, extra = {}) => f.api.addDailyKitItem({ technicianId: T, userId: U, date: DATE,
  inventoryItemId: E, quantity: 2, jobType: 'booking', jobId: A, note: 'Extra equipment for this installation', ...extra });
const removeExtra = (f, itemId, extra = {}) => f.api.removeDailyKitItem({ technicianId: T, userId: U, date: DATE,
  itemId, note: 'Extra no longer needed', ...extra });

test('a manual packing quantity survives repeated refreshes without duplicating a required item or issuing stock', async () => {
  const f = fixture({ quantity: 3 });
  const kit = await addExtra(f);
  assert.equal(kit.items.length, 1);
  assert.equal(kit.items[0].quantity, 2);
  assert.equal(kit.items[0].requiredQuantity, 1);
  assert.equal(kit.items[0].manualQuantity, 2);
  assert.equal(kit.items[0].preparedChecked, false);
  assert.equal(String(kit.items[0]._id), I);
  await addExtra(f);
  const refreshed = await f.api.syncDailyKit(T, DATE);
  assert.equal(refreshed.items.length, 1);
  assert.equal(refreshed.items[0].quantity, 2);
  assert.equal(f.data.Tool[0].quantity, 3);
  assert.equal(f.data.EquipmentAssignment.length, 0);
  assert.match(refreshed.notes, /Extra Pump/);
});

test('a standalone consumable extra remains linked to its selected booking and is issued only on confirmation', async () => {
  const f = fixture({ quantity: 2 });
  f.data.Tool.push({ _id: OTHER, itemName: 'Tape', quantity: 4, reservedQuantity: 0, type: 'consumable', active: true });
  let kit = await addExtra(f, { inventoryItemId: OTHER, quantity: 2 });
  const extra = kit.items.find(item => String(item.toolId) === OTHER);
  assert.equal(extra.source, 'manual');
  assert.equal(extra.requiredQuantity, 0);
  assert.equal(extra.bookingIds.map(String).join(','), B);
  assert.equal(extra.assignmentIds.map(String).join(','), A);
  assert.equal(f.data.Tool[1].quantity, 4);
  kit = await f.api.setDailyKitItemChecked({ technicianId: T, userId: U, date: DATE, itemId: extra._id, checked: true });
  const confirmed = await confirmation(f);
  assert.equal(confirmed.items.find(item => String(item.toolId) === OTHER).quantityIssued, 2);
  assert.equal(f.data.Tool[1].quantity, 2);
  await confirmation(f);
  assert.equal(f.data.Tool[1].quantity, 2);
});

test('manual extras recheck current unreserved stock and cannot keep a stale available flag', async () => {
  const f = fixture({ quantity: 3 });
  await addExtra(f);
  f.data.Tool[0].reservedQuantity = 2;
  const kit = await f.api.syncDailyKit(T, DATE);
  assert.equal(kit.items[0].quantity, 2);
  assert.equal(kit.items[0].checkoutStatus, 'unavailable');
  assert.equal(kit.items[0].preparedChecked, false);
  await assert.rejects(confirmation(f), error => error.status === 409);
  assert.equal(f.data.Tool[0].quantity, 3);
});

test('removing an extra restores the generated minimum and requires a fresh physical check', async () => {
  const f = fixture({ quantity: 3 });
  const kit = await addExtra(f);
  await f.api.setDailyKitItemChecked({ technicianId: T, userId: U, date: DATE, itemId: I, checked: true });
  const removed = await removeExtra(f, kit.items[0]._id);
  assert.equal(removed.items.length, 1);
  assert.equal(removed.items[0].quantity, 1);
  assert.equal(removed.items[0].manualQuantity, 0);
  assert.equal(removed.items[0].preparedChecked, false);
  assert.match(removed.notes, /Removed extra Pump/);
  assert.equal(f.data.Tool[0].quantity, 3);
});

test('removing an unissued standalone extra deletes only that extra and never increases stock', async () => {
  const f = fixture({ quantity: 2 });
  f.data.Tool.push({ _id: OTHER, itemName: 'Tape', quantity: 2, type: 'consumable', active: true });
  const kit = await addExtra(f, { inventoryItemId: OTHER, quantity: 1 });
  const extra = kit.items.find(item => String(item.toolId) === OTHER);
  const removed = await removeExtra(f, extra._id);
  assert.equal(removed.items.length, 1);
  assert.equal(String(removed.items[0].toolId), E);
  assert.equal(f.data.Tool[1].quantity, 2);
  assert.equal(f.data.EquipmentAssignment.length, 0);
});

test('generated job requirements cannot be deleted, and requested quantities cannot lower them', async () => {
  const f = fixture({ quantity: 3 });
  await assert.rejects(removeExtra(f, I), /required by a job/);
  f.data.BookingService[0].requirements[0].quantity = 2;
  await assert.rejects(addExtra(f, { quantity: 1 }), error => error.status === 400);
  assert.equal(f.data.DailyKit[0].items.length, 1);
});

test('add and remove reject other work dates before any model write', async () => {
  const f = fixture();
  for (const date of ['2026-10-10', '2026-10-12', '2026-10-11T16:00:00Z']) {
    await assert.rejects(addExtra(f, { date }), error => error.status === 409);
    await assert.rejects(removeExtra(f, I, { date }), error => error.status === 409);
  }
  assert.deepEqual(f.calls, []);
});

test('confirmed or issued equipment cannot be erased or edited through an extra-item request', async () => {
  const f = fixture({ quantity: 3 });
  await addExtra(f);
  await f.api.setDailyKitItemChecked({ technicianId: T, userId: U, date: DATE, itemId: I, checked: true });
  await confirmation(f);
  await assert.rejects(removeExtra(f, I), /already confirmed/);
  await assert.rejects(addExtra(f), /already confirmed/);
  assert.equal(f.data.EquipmentAssignment.length, 1);
  assert.equal(f.data.Tool[0].quantity, 1);
  f.data.DailyKit[0].status = 'draft';
  await assert.rejects(removeExtra(f, I), /custody record/);
  assert.equal(f.data.EquipmentAssignment.length, 1);
});

test('manual changes validate ownership, catalog type, equipment condition, quantity and reason', async () => {
  const f = fixture({ quantity: 3 });
  await assert.rejects(addExtra(f, { jobId: OTHER }), error => error.status === 403);
  await assert.rejects(addExtra(f, { inventoryItemId: OTHER }), error => error.status === 404);
  for (const quantity of [0, -1, Infinity, 10001, 1.5]) await assert.rejects(addExtra(f, { quantity }), error => error.status === 400);
  for (const note of ['', 'a', 'x'.repeat(301)]) await assert.rejects(addExtra(f, { note }), error => error.status === 400);
  f.data.Tool[0].type = 'part';
  await assert.rejects(addExtra(f), /approved repair quotation/);
  f.data.Tool[0].type = 'equipment'; f.data.Tool[0].assetStatus = 'damaged';
  await assert.rejects(addExtra(f), error => error.status === 400);
});

test('manual edits roll back the whole plan when a later rehydration save fails', async () => {
  const f = fixture({ quantity: 3 });
  const before = JSON.stringify(f.data);
  f.failAfterKitSaves(2);
  await assert.rejects(addExtra(f), /later kit save failure/);
  assert.equal(JSON.stringify(f.data), before);
});

test('a cancelled job drops its unissued manual extras and cannot be chosen again', async () => {
  const f = fixture({ quantity: 2 });
  f.data.Tool.push({ _id: OTHER, itemName: 'Tape', quantity: 2, type: 'consumable', active: true });
  await addExtra(f, { inventoryItemId: OTHER, quantity: 1 });
  f.data.BookingService[0].status = 'cancelled';
  const kit = await f.api.syncDailyKit(T, DATE);
  assert.equal(kit.items.length, 0);
  await assert.rejects(addExtra(f), /Accept a scheduled job/);
  assert.equal(f.data.Tool[1].quantity, 2);
});

function editHandler(f, endpoint, method = 'post', kitModel = f.models.DailyKit) {
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/technicianApi.js'), 'utf8');
  const start = routeSource.indexOf(`router.${method}("${endpoint}",`);
  const tail = routeSource.slice(start);
  const end = /\r?\n ?\}\);/.exec(tail);
  assert.ok(start >= 0 && end, 'actual handler exists');
  let handler;
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } }
  const context = {
    router: { [method]: (_path, callback) => { handler = callback; } },
    Technician: f.models.Technician, Date: FixedDate,
    addDailyKitItem: f.api.addDailyKitItem, removeDailyKitItem: f.api.removeDailyKitItem,
    dailyKitDayBounds: f.api.dayBounds,
    NOT_REQUIRED_REASONS: ['job_condition_not_required'], NOT_REQUIRED_REASON_LABELS: { job_condition_not_required: 'Job condition does not require it' },
    audit: { logEvent() {} }, console,
    require: name => name === '../models/DailyKit' ? kitModel : failUnexpected(name),
  };
  function failUnexpected(name) { throw Error('Unexpected dependency ' + name); }
  vm.runInNewContext(tail.slice(0, end.index + end[0].length), context);
  return async (body, userId = U) => {
    let response;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { response = { status: this.statusCode, body: value }; return this; } };
    await handler({ body, user: { _id: userId } }, res, error => { throw error; });
    return response;
  };
}

test('actual add/remove routes use the authenticated technician and return a saved canonical kit', async () => {
  const f = fixture({ quantity: 3 });
  const add = editHandler(f, '/daily-kit/add-item');
  const response = await add({ date: DATE, inventoryItemId: E, quantity: 2, jobType: 'booking', jobId: A, note: 'Extra equipment for installation', technicianId: OTHER });
  assert.equal(response.status, 200);
  assert.equal(String(response.body.kit.technicianId), T);
  assert.equal(response.body.kit.items[0].quantity, 2);
  const remove = editHandler(f, '/daily-kit/remove-item', 'delete');
  const removed = await remove({ date: DATE, itemId: I, note: 'Extra no longer needed', technicianId: OTHER });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.kit.items[0].quantity, 1);
  assert.equal(f.data.Tool[0].quantity, 3);
  assert.equal((await add({ date: DATE }, OTHER)).status, 404);
});

test('actual item-edit routes expose useful validation errors rather than generic 500 responses', async () => {
  const f = fixture({ quantity: 3 });
  const add = editHandler(f, '/daily-kit/add-item');
  assert.equal((await add({ date: DATE, inventoryItemId: E, quantity: 1, jobType: 'booking', jobId: OTHER, note: 'Foreign job' })).status, 403);
  assert.equal((await add({ date: '2026-10-12', inventoryItemId: E, quantity: 1, jobType: 'booking', jobId: A, note: 'Future date' })).status, 409);
  const remove = editHandler(f, '/daily-kit/remove-item', 'delete');
  const required = await remove({ date: DATE, itemId: I, note: 'Trying to remove required item' });
  assert.equal(required.status, 409);
  assert.match(required.body.error, /Not needed/);
});

test('item decisions cannot modify a future preview or confirmed custody rows', async () => {
  const f = fixture();
  const resolve = editHandler(f, '/daily-kit/resolve-item');
  const body = { date: DATE, itemName: 'Pump', itemId: I, resolution: 'not_required', reasonCode: 'job_condition_not_required' };
  assert.equal((await resolve({ ...body, date: '2026-10-12' })).status, 409);
  f.data.DailyKit[0].status = 'confirmed';
  assert.equal((await resolve(body)).status, 409);
  f.data.DailyKit[0].hasDelta = true;
  f.data.DailyKit[0].deltaItems = [{ ...f.data.DailyKit[0].items[0], _id: OTHER }];
  assert.equal((await resolve(body)).status, 404, 'a pending delta cannot make the historical main row editable');
});

test('Not needed keeps the actual schema row and reason without deducting inventory', async () => {
  const f = fixture();
  const Kit = require('../models/DailyKit');
  const kit = new Kit({ ...f.data.DailyKit[0], items: [{ ...f.data.DailyKit[0].items[0], requiredQuantity: 1 }] });
  let saved = false;
  kit.save = async () => { await kit.validate(); saved = true; return kit; };
  const resolve = editHandler(f, '/daily-kit/resolve-item', 'post', { findOne: async () => kit });
  const response = await resolve({ date: DATE, itemName: 'Pump', itemId: I, resolution: 'not_required',
    reasonCode: 'job_condition_not_required', note: 'Customer already has suitable equipment' });
  assert.equal(response.status, 200);
  assert.equal(saved, true);
  assert.equal(kit.items.length, 1);
  assert.equal(kit.items[0].resolution.status, 'not_required');
  assert.match(kit.items[0].resolution.resolutionNote, /Customer already has suitable equipment/);
  assert.equal(kit.items[0].checkoutStatus, 'exception');
  assert.equal(f.data.Tool[0].quantity, 1);
});

test('past and future preparation reject before any writes, including under a UTC host', async () => {
  const f = fixture();
  for (const date of ['2026-10-10', '2026-10-12', '2026-10-11T16:00:00Z']) {
    await assert.rejects(confirmation(f, { date }), error => error.status === 409);
    await assert.rejects(f.api.setDailyKitItemChecked({ technicianId: T, userId: U, date, itemId: I, checked: true }), error => error.status === 409);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.api.dayBounds('2026-10-12').start.toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(f.api.dayBounds('2026-10-12').end.toISOString(), '2026-10-12T16:00:00.000Z');
  assert.throws(() => f.api.dayBounds('2026-02-30'), error => error.status === 400);
});

test('confirmation checks out once, and repeated concurrent requests return the saved kit', async () => {
  const f = fixture({ quantity: 2 });
  const kits = await Promise.all([confirmation(f), confirmation(f)]);
  assert.ok(kits.every(kit => kit.status === 'confirmed'));
  assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 1);
});

test('a failure at any later inventory, ledger, kit or booking write rolls back the entire checkout', async () => {
  for (const failure of ['EquipmentAssignment', 'Assignment', 'BookingService', 'Order', 'FinalKit']) {
    const f = fixture({ items: 2 }); f.fail(failure);
    await assert.rejects(confirmation(f), /Injected/);
    assert.equal(f.data.Tool[0].quantity, 1, failure);
    assert.equal(f.data.Tool[1].quantity, 1, failure);
    assert.equal(f.data.EquipmentAssignment.length, 0, failure);
    assert.equal(f.data.DailyKit[0].status, 'draft', failure);
  }
});

test('another technician cannot take the last pump and multiple physical units remain usable', async () => {
  for (const quantity of [1, 2]) {
    const f = fixture({ quantity });
    f.data.Assignment.push({ ...f.data.Assignment[0], _id: OTHER, technicianId: OTHER, bookingId: OTHER });
    f.data.BookingService.push({ ...clone(f.data.BookingService[0]), _id: OTHER });
    f.data.DailyKit.push({ ...clone(f.data.DailyKit[0]), _id: OTHER, technicianId: OTHER, assignmentIds: [OTHER], bookingIds: [OTHER] });
    const results = await Promise.allSettled([confirmation(f), confirmation(f, { technicianId: OTHER })]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, quantity);
    assert.equal(f.data.EquipmentAssignment.length, quantity);
    assert.equal(f.data.Tool[0].quantity, 0);
  }
});

test('a competing reservation cannot be consumed during the final write', async () => {
  const f = fixture(); f.competingReservation();
  await assert.rejects(confirmation(f), /became unavailable/);
  assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 0);
});

test('owned equipment reservations are issued once and another jobs hold is preserved', async () => {
  const f = fixture({ quantity: 2 }); f.data.Tool[0].reservedQuantity = 2;
  f.data.EquipmentAssignment.push({ _id: OTHER, technicianId: T, bookingId: B, equipmentId: E, equipmentName: 'Pump', quantity: 1, workDate: f.data.DailyKit[0].workDate, status: 'reserved' });
  await confirmation(f);
  assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.Tool[0].reservedQuantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 1);
  assert.equal(f.data.EquipmentAssignment[0].status, 'checked_out');
  await confirmation(f);
  assert.equal(f.data.Tool[0].quantity, 1);
});

test('standard kit flags do not exempt company equipment from stock and custody checks', async () => {
  const f = fixture({ quantity: 0, standard: true });
  await assert.rejects(confirmation(f), /unavailable/);
  assert.equal(f.data.EquipmentAssignment.length, 0);
});

test('equipment already held by this technician from yesterday is reused without a second checkout', async () => {
  const f = fixture({ quantity: 0 });
  f.data.DailyKit[0].items[0].checkoutStatus = 'in_custody';
  f.data.DailyKit[0].items[0].quantityToCheckout = 0;
  f.data.EquipmentAssignment.push({ _id: OTHER, technicianId: T, equipmentId: E, quantity: 1, workDate: new Date('2026-10-10T00:00:00+08:00'), status: 'checked_out' });
  await confirmation(f);
  assert.equal(f.data.EquipmentAssignment.length, 1);
  assert.equal(f.data.Tool[0].quantity, 0);
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, 'in_custody');
});

test('future previews write a draft without issuing stock and cancelled work cannot confirm', async () => {
  const f = fixture();
  f.data.Assignment[0].bookingDate = new Date('2026-10-12T00:00:00+08:00');
  const kit = await f.api.syncDailyKit(T, '2026-10-12');
  assert.equal(kit.status, 'draft'); assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 0);
  f.data.Assignment[0].bookingDate = f.data.DailyKit[0].workDate;
  f.data.BookingService[0].status = 'cancelled';
  await assert.rejects(confirmation(f), /no accepted jobs/);
});

test('transaction callback retries do not issue duplicate stock or checkout records', async () => {
  const f = fixture({ quantity: 2 }); f.retry();
  await confirmation(f);
  assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 1);
});

test('legacy routes delegate physical checkout to the same kit gate instead of writing stock', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../routes/technicianApi.js'), 'utf8');
  for (const route of ["router.post('/assignments/checkout-batch'", 'router.post("/assignments/:id/checkout"', 'router.post("/equipment/:assignmentId/checkout"']) {
    const at = routes.indexOf(route), end = routes.indexOf('\n});', at), handler = routes.slice(at, end);
    assert.match(handler, /confirmDailyKit\(/);
    assert.doesNotMatch(handler, /tool\.save|tool\.quantity\s*-=|EquipmentAssignment\.create/);
  }
});

test('stock already deducted for approved repair parts is not deducted again; soft holds are deducted once', async () => {
  for (const stockTreatment of ['deducted', 'soft_hold']) {
    const f = fixture();
    f.data.Tool[0].type = 'part';
    f.data.Tool[0].quantity = stockTreatment === 'deducted' ? 0 : 1;
    f.data.Tool[0].reservedQuantity = stockTreatment === 'deducted' ? 0 : 1;
    f.data.BookingService[0].requirements = [];
    Object.assign(f.data.BookingService[0], { serviceType: 'repair', status: 'repair_scheduled', quotation: { parts: [{ name: 'Pump', toolId: E, quantity: 1 }] } });
    f.data.DailyKit[0].items[0].category = 'repair_part';
    f.data.StockReservation.push({ _id: OTHER, toolId: E, bookingId: B, quantity: 1, status: 'reserved', stockTreatment });
    await confirmation(f);
    assert.equal(f.data.Tool[0].quantity, 0, stockTreatment);
    assert.equal(f.data.Tool[0].reservedQuantity, 0, stockTreatment);
    assert.equal(f.data.StockReservation[0].status, 'checked_out');
    assert.equal(f.data.DailyKit[0].items[0].quantityIssued, 1);
    await confirmation(f);
    assert.equal(f.data.Tool[0].quantity, 0);
  }
});

test('a later unavailable material undoes the earlier successful equipment checkout', async () => {
  const f = fixture({ items: 2 }); f.failItem(OTHER);
  await assert.rejects(confirmation(f), /Cleaner became unavailable/);
  assert.equal(f.data.Tool[0].quantity, 1);
  assert.equal(f.data.Tool[1].quantity, 1);
  assert.equal(f.data.EquipmentAssignment.length, 0);
  assert.equal(f.data.DailyKit[0].status, 'draft');
});

test('partial existing custody issues only the missing quantity and includes both custody records', async () => {
  const f = fixture();
  f.data.BookingService[0].requirements[0].quantity = 2;
  f.data.DailyKit[0].items[0].quantity = 2;
  f.data.DailyKit[0].items[0].quantityToCheckout = 1;
  f.data.EquipmentAssignment.push({ _id: OTHER, technicianId: U, equipmentId: E, quantity: 1, workDate: new Date('2026-10-10T00:00:00+08:00'), status: 'checked_out' });
  await confirmation(f);
  assert.equal(f.data.Tool[0].quantity, 0);
  assert.equal(f.data.EquipmentAssignment.length, 2);
  assert.equal(f.data.DailyKit[0].items[0].custodyAssignmentIds.length, 2);
});

test('foreign assignments and equipment cannot trigger a checkout', async () => {
  const f = fixture();
  await assert.rejects(confirmation(f, { expectedAssignmentIds: [OTHER] }), error => error.status === 409);
  f.data.EquipmentAssignment.push({ _id: OTHER, technicianId: OTHER, equipmentId: E, workDate: f.data.DailyKit[0].workDate, status: 'reserved', quantity: 1 });
  await assert.rejects(confirmation(f, { equipmentAssignmentId: OTHER }), error => error.status === 403);
  assert.equal(f.data.Tool[0].quantity, 1);
  const reassigned = fixture();
  reassigned.data.BookingService[0].technicianId = OTHER;
  await assert.rejects(confirmation(reassigned), /no accepted jobs/);
  assert.equal(reassigned.data.Tool[0].quantity, 1);
});

test('notify admin executes the real handler and saves a valid DailyKit notification', async () => {
  const routes = fs.readFileSync(path.join(__dirname, '../routes/technicianApi.js'), 'utf8').replace(/\r\n/g, '\n');
  const begin = routes.indexOf('router.post("/daily-kit/notify-admin-item",');
  const start = routes.indexOf('async (req, res, next) => {', begin), end = routes.indexOf('\n});', start);
  const payloads = []; let saved = false;
  const kit = { _id: K, workDate: new Date('2026-10-11T00:00:00+08:00'), items: [{ name: 'Pump', checkoutStatus: 'unavailable' }], deltaItems: [], save: async () => { saved = true; } };
  const handler = vm.runInNewContext('(' + routes.slice(start, end + 2) + ')', {
    Date, console, Technician: { findOne: async () => ({ _id: T, name: 'Technician' }) },
    dailyKitDayBounds: fixture().api.dayBounds,
    require(name) {
      if (name === '../models/DailyKit') return { findOne: async () => kit };
      if (name === '../utils/notify') return { createNotification: async payload => { await new (actualRequire('../models/Notification'))(payload).validate(); payloads.push(payload); } };
      return actualRequire(name);
    },
  });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ user: { _id: U }, body: { itemName: 'Pump', date: DATE }, app: { get() {} } }, response);
  assert.equal(response.code, 200); assert.equal(saved, true);
  assert.equal(payloads.length, 1); assert.equal(payloads[0].referenceModel, 'DailyKit');
  assert.equal(payloads[0].link, '/admin/inventory/technician-tools?date=2026-10-11');
  assert.equal(response.body.notificationDelivered, true);
});

test('additional work requires a new physical check and issues only the extra equipment', async () => {
  const f = fixture({ quantity: 2 });
  await confirmation(f);
  f.data.BookingService[0].requirements[0].quantity = 2;
  const updated = await f.api.syncDailyKit(T, DATE);
  assert.equal(updated.hasDelta, true);
  assert.equal(updated.deltaItems[0].quantity, 1);
  await assert.rejects(confirmation(f), /Check 1 required/);
  const itemId = f.data.DailyKit[0].deltaItems[0]._id;
  await f.api.setDailyKitItemChecked({ technicianId: T, userId: U, date: DATE, itemId, checked: true });
  await confirmation(f);
  assert.equal(f.data.Tool[0].quantity, 0);
  assert.equal(f.data.EquipmentAssignment.length, 2);
  assert.equal(f.data.DailyKit[0].items[0].quantity, 2);
  assert.equal(f.data.DailyKit[0].items[0].custodyAssignmentIds.length, 2);
});

test('a changed exact catalog rule creates a new delta rather than substituting issued equipment with the same name', async () => {
  const f = fixture();
  await confirmation(f);
  f.data.Tool.push({ ...f.data.Tool[0], _id: OTHER, quantity: 1, reservedQuantity: 0, checkedOutQuantity: 0 });
  f.data.BookingService[0].requirements = [{ inventoryId: OTHER, name: 'Pump', kind: 'equipment', quantity: 1, quantityApplied: true, ruleRevision: 2 }];
  const kit = await f.api.syncDailyKit(T, DATE);
  assert.equal(kit.items[0].toolId.toString(), E);
  assert.equal(kit.items[0].checkoutStatus, 'checked_out');
  assert.equal(kit.deltaItems.length, 1);
  assert.equal(kit.deltaItems[0].toolId.toString(), OTHER);
  assert.equal(kit.deltaItems[0].catalogLocked, true);
  assert.equal(f.data.Tool[1].quantity, 1);
  await assert.rejects(confirmation(f), /Check 1 required/);
  assert.equal(f.data.Tool[1].quantity, 1);
});
test('active project work checks out its daily resources and cancelled projects cannot checkout', async () => {
  for (const status of ['active', 'cancelled']) {
    const f = fixture();
    f.data.Assignment = []; f.data.BookingService = [];
    f.data.Project = [{ _id: B, status }];
    f.data.WorkOrder = [{ _id: A, projectId: B, status: 'pending', resourceRequirements: [{ itemName: 'Pump', toolId: E, type: 'equipment', quantity: 1 }] }];
    f.data.DailyAssignment = [{ _id: OTHER, projectId: B, workOrderId: A, technicianId: T, date: new Date('2026-10-11T00:00:00+08:00'), status: 'pending', targetUnits: 1 }];
    f.data.DailyKit[0].items[0].bookingIds = []; f.data.DailyKit[0].items[0].assignmentIds = [];
    f.data.DailyKit[0].assignmentIds = []; f.data.DailyKit[0].bookingIds = [];
    if (status === 'cancelled') await assert.rejects(confirmation(f), /no accepted jobs/);
    else {
      await confirmation(f);
      assert.equal(String(f.data.EquipmentAssignment[0].projectId), B);
      assert.equal(String(f.data.EquipmentAssignment[0].dailyAssignmentIds[0]), OTHER);
    }
    assert.equal(f.data.Tool[0].quantity, status === 'cancelled' ? 1 : 0);
  }
});
