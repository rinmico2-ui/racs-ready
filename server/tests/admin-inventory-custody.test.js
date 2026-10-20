'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { normalizeQuery, buildPipeline, present, createService } = require('../utils/adminInventoryCustody');
const id = value => new mongoose.Types.ObjectId(value.toString(16).padStart(24, '0'));
const T = String(id(1)), U = String(id(2)), B = String(id(3));
const collections = { tools: 'tools', kits: 'dailykits', legacy: 'toolassignments', bookings: 'bookingservices', orders: 'orders', projects: 'projects' };
const pipeline = query => buildPipeline(normalizeQuery(query), [T, U], [T, U], collections, new Date('2026-10-20T01:00:00Z'));

test('custody filters reject malformed input, limit pages, and use actual Philippine calendar dates', () => {
  for (const query of [{ category: 'service' }, { status: 'returned' }, { technicianId: 'invalid' }, { technicianId: { $ne: null } }, { date: '2026-02-30' }, { date: '2026-1-1' }, { search: ['pump'] }]) assert.throws(() => normalizeQuery(query), error => error.status === 400);
  const result = normalizeQuery({ category: 'repair_part', search: ' x '.repeat(200), page: '999999', limit: '99999', date: '2026-10-20' });
  assert.equal(result.search.length, 100); assert.equal(result.limit, 25); assert.equal(result.page, 100000);
  const stages = pipeline({ date: '2026-10-20' }), range = stages.find(stage => stage.$match?.workDate).$match.workDate;
  assert.equal(range.$gte.toISOString(), '2026-10-19T16:00:00.000Z'); assert.equal(range.$lt.toISOString(), '2026-10-20T16:00:00.000Z');
});

test('tracking includes active issues across dates, excludes reservations and avoids duplicate Daily Kit material ledgers', () => {
  const stages = pipeline({});
  assert.deepEqual(stages[0].$match.status.$in, ['checked_out', 'in_use']);
  assert.deepEqual(stages[0].$match.$or, [{ consumable: { $ne: true } }, { dailyKitId: null }]);
  assert.equal(stages.some(stage => stage.$match?.workDate), false, 'previous work dates remain visible');
  const materials = stages.find(stage => stage.$unionWith?.coll === 'dailykits').$unionWith.pipeline;
  assert.deepEqual(materials[2].$match, { 'item.category': { $in: ['repair_part', 'consumable'] }, 'item.quantityIssued': { $gt: 0 } });
  assert.deepEqual(materials[0].$project.item.$concatArrays, [{ $ifNull: ['$items', []] }, { $ifNull: ['$deltaItems', []] }]);
  assert.doesNotMatch(JSON.stringify(materials), /returnedItems|preparedChecked/);
  const legacy = stages.find(stage => stage.$unionWith?.coll === 'toolassignments').$unionWith.pipeline;
  assert.deepEqual(legacy[0].$match, { status: 'assigned', returnedDate: null });
  assert.equal(stages.some(stage => stage.$unwind === '$bookings' || stage.$unwind === '$orders'), false, 'shared jobs do not multiply a physical item');
});

test('pending receipts remain held and category filtering happens after summary counts but before pagination', () => {
  const stages = pipeline({ category: 'consumable', technicianId: T, page: 2 }), facet = stages.at(-1).$facet;
  assert.deepEqual(stages.find(stage => stage.$match?.technicianId).$match.technicianId.$in.map(String), [T, U]);
  assert.deepEqual(facet.total[0], { $match: { category: 'consumable' } });
  assert.deepEqual(facet.rows[0], facet.total[0]); assert.equal(facet.rows.at(-2).$skip, 8);
  assert.equal(facet.summary.length, 1, 'category counters include other categories under the same filters');
  const balance = stages.find(stage => stage.$unionWith?.coll === 'dailykits').$unionWith.pipeline.at(-1).$project.remaining;
  assert.doesNotMatch(JSON.stringify(balance), /returnPendingQuantity/, 'reporting a return alone does not reduce held quantity');
  for (const field of ['quantityUsed', 'quantityReturned', 'quantityDamaged', 'quantityMissing']) assert.match(JSON.stringify(balance), new RegExp(field));
});

test('literal search covers item, technician, booking and order references without exposing customer fields', () => {
  const stages = pipeline({ search: 'Pump [A]+' });
  const conditions = stages.find(stage => stage.$match?.$or?.some(term => term.name instanceof RegExp)).$match.$or;
  assert.equal(conditions[0].name.test('Pump [A]+'), true); assert.equal(conditions[0].name.test('Pump AAAAA'), false);
  assert.ok(conditions.some(term => term['bookings.bookingReference'])); assert.ok(conditions.some(term => term['orders.orderReference']));
  for (const stage of stages.filter(stage => stage.$lookup)) assert.doesNotMatch(JSON.stringify(stage.$lookup.pipeline), /phone|email|address|customer|notes/);
});

test('legacy material balances stay unknown, receipt quantities are bounded, and item details use an explicit safe allowlist', () => {
  const profiles = new Map([[T, { id: T, name: 'Technician', archived: true }]]);
  const base = { _id: 'issue:1', technicianId: id(1), recordId: id(4), category: 'consumable', source: 'general_issue', quantityIssued: 5, remaining: null, checkBalance: true,
    notes: 'Private note', customer: { phone: 'private' }, bookings: [{ _id: id(3), bookingReference: 'BOOK-1', status: 'confirmed', customer: { email: 'private' } }] };
  const result = present(base, profiles);
  assert.equal(result.remaining, null); assert.equal(result.quantityUsed, null); assert.equal(result.technician.archived, true);
  assert.equal(result.jobs[0].href, '/admin/appointments?booking=' + B);
  assert.doesNotMatch(JSON.stringify(result), /Private note|private|"customer"|"notes"/);
  const pending = present({ ...base, source: 'daily_kit', checkBalance: false, remaining: 3, pendingQuantity: 9 }, profiles);
  assert.equal(pending.remaining, 3); assert.equal(pending.pendingQuantity, 3);
  const equipment = present({ ...base, category: 'equipment', source: 'equipment_assignment', checkBalance: false, remaining: 1, workDate: new Date('2026-10-19T16:00:00Z') }, profiles);
  assert.equal(equipment.expectedReturnAt.toISOString(), '2026-10-20T15:59:59.999Z');
});

test('the service resolves profile and login holders to one technician, keeps inactive holders and returns minimal data', async () => {
  let captured;
  const Technician = { find(filter) { assert.deepEqual(filter, {}); return { select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => [{ _id: id(1), name: 'Archived Technician', user: { _id: id(2), firstName: 'Yachi', lastName: '123', email: 'private' }, active: false, phone: 'private' }] }; } };
  const overrides = { Technician, EquipmentAssignment: { aggregate(stages) { captured = stages; return { allowDiskUse: async () => [{ summary: [{ equipment: 2, holders: [id(1), id(2)] }], total: [{ count: 2 }], rows: [{ _id: 'equipment:1', technicianId: id(2), category: 'equipment', remaining: 1, quantityIssued: 1 }] }] }; } } };
  for (const [key, model] of Object.entries({ tools: 'Tool', kits: 'DailyKit', legacy: 'ToolAssignment', bookings: 'BookingService', orders: 'Order', projects: 'Project' })) overrides[model] = { collection: { name: collections[key] } };
  const result = await createService(overrides).list({ technicianId: U });
  assert.deepEqual(captured.find(stage => stage.$match?.technicianId).$match.technicianId.$in.map(String), [T, U]);
  assert.equal(result.summary.technicians, 1); assert.equal(result.items[0].technician.id, T); assert.equal(result.technicians[0].archived, true);
  assert.doesNotMatch(JSON.stringify(result), /private|aliases|phone|email/);
});

test('the tracking route is admin-only, disables caching and hides database errors', async t => {
  const express = require('express'), { requireRole } = require('../middleware/authenticate');
  const source = fs.readFileSync(path.join(__dirname, '../routes/equipmentReturnRoutes.js'), 'utf8');
  const start = source.indexOf("router.get('/inventory-custody'"), end = source.indexOf('\n});', start);
  let calls = 0, failure = null;
  const app = express(); app.use((req, _res, next) => { req.user = { role: req.headers['x-test-role'] }; next(); });
  vm.runInNewContext(source.slice(start, end + 5), { router: app, requireRole, console: { error() {} }, require: name => name.includes('logPrivacy') ? { text: value => value } : { createService: () => ({ list: async () => { calls++; if (failure) throw failure; return { items: [] }; } }) } });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = role => fetch('http://127.0.0.1:' + server.address().port + '/inventory-custody', { headers: { 'x-test-role': role } });
  for (const role of ['customer', 'technician', 'secretary']) assert.equal((await get(role)).status, 403);
  assert.equal(calls, 0);
  const response = await get('admin'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  failure = new Error('private Mongo credentials'); const failed = await get('admin'); assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(await failed.json()), /credentials|Mongo/);
  failure = Object.assign(new Error('Choose a valid technician.'), { status: 400 }); assert.equal((await get('admin')).status, 400);
});
