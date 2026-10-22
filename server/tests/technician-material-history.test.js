'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { historyQuery, materialHistory } = require('../utils/technicianMaterialHistory');
const T = '507f1f77bcf86cd799439011', U = '507f1f77bcf86cd799439012', B = '507f1f77bcf86cd799439013';

test('history is scoped to the signed-in technician and excludes voided records, equipment and zero usage', () => {
  const { pipeline } = historyQuery([T, U], { technicianId: B, source: 'order', type: 'consumable', from: '2026-10-22', to: '2026-10-22', q: 'ORD.*' });
  const filter = pipeline[0].$match;
  assert.deepEqual(filter.technicianId.$in.map(String), [T, U]);
  assert.equal(filter.lifecycleStatus.$ne, 'voided');
  assert.equal(filter.itemType, 'consumable');
  assert.deepEqual(filter.quantityUsed, { $gt: 0 });
  assert.equal(filter.usedAt.$gte.toISOString(), '2026-10-21T16:00:00.000Z');
  assert.equal(filter.usedAt.$lt.toISOString(), '2026-10-22T16:00:00.000Z');
  const search = pipeline.find(stage => stage.$match?.$or).$match.$or;
  assert.equal(search[0].reference.$regex, 'ORD\\.\\*');
});

test('invalid filters cannot run a history query', async () => {
  for (const input of [{ from: '2026-02-30' }, { to: 'not-a-date' }, { from: '2026-10-25', to: '2026-10-15' },
    { q: { $ne: '' } }, { q: 'a'.repeat(101) }, { type: 'equipment' }, { source: 'customer' }, { page: -1 }, { page: 1.5 }, { page: 10001 }]) {
    await assert.rejects(materialHistory([T], input, { Usage: { aggregate() { assert.fail('Must validate first'); } } }), e => e.status === 400);
  }
});

test('history returns usage snapshots and page counts without financial or customer contact fields', async () => {
  let diskUse, options;
  const result = await materialHistory([T], { page: 2 }, { Usage: { aggregate() { return {
    allowDiskUse(value) { diskUse = value; return this; }, option(value) { options = value; return [{ total: [{ count: 9 }], jobs: [
      { _id: { source: 'booking', id: B }, reference: 'RACS-TEST', lastUsedAt: '2026-10-22', recordCount: 2,
        customer: { email: 'private@test' }, total: 1000, items: [{ name: 'Tape', type: 'consumable', quantity: .25, unit: 'roll', usedAt: '2026-10-22', unitPrice: 500, notes: 'Internal', stage: 'repair' }] },
    ] }]; },
  }; } } });
  assert.equal(diskUse, true); assert.equal(options.maxTimeMS, 10000);
  assert.deepEqual(result.pagination, { page: 2, pageSize: 8, total: 9, pages: 2 });
  assert.equal(result.items[0].items[0].quantity, .25);
  assert.equal(result.items[0].items[0].stage, 'repair');
  assert.equal(result.items[0].reference, 'RACS-TEST');
  assert.doesNotMatch(JSON.stringify(result), /private|unitPrice|Internal|customer|1000/);
});

test('an empty history still returns usable pagination and missing work references keep a clear fallback', async () => {
  const fake = jobs => ({ aggregate: () => ({ allowDiskUse() { return this; }, option: async () => [{ total: [{ count: jobs.length }], jobs }] }) });
  const empty = await materialHistory([T], {}, { Usage: fake([]) });
  assert.deepEqual(empty, { items: [], pagination: { page: 1, pageSize: 8, total: 0, pages: 1 } });
  const missing = await materialHistory([T], {}, { Usage: fake([{ _id: { source: 'order', id: B }, items: [] }, { _id: { source: 'unlinked', id: U }, items: [] }]) });
  assert.equal(missing.items[0].reference, 'Order #439013');
  assert.equal(missing.items[1].reference, 'Work reference not recorded');
});

test('the real history route uses account context and never trusts a requested technician identity', async () => {
  const source = fs.readFileSync(require.resolve('../routes/technicianApi'), 'utf8');
  const start = source.indexOf('router.get("/tools/material-history"'), end = source.indexOf('\nrouter.', start + 5);
  let handler, captured;
  vm.runInNewContext(source.slice(start, end), {
    router: { get(path, fn) { handler = fn; } },
    loadTechnicianContext: async userId => { assert.equal(userId, U); return { tech: { _id: T }, technicianIds: [T, U] }; },
    require: () => ({ materialHistory: async (ids, input) => { captured = { ids, input }; return { items: [] }; } }),
  });
  const response = { set(key, value) { this.cache = [key, value]; }, json(value) { this.body = value; } };
  await handler({ user: { _id: U }, query: { technicianId: B } }, response, error => { throw error; });
  assert.deepEqual(Array.from(captured.ids), [T, U]);
  assert.deepEqual(response.cache, ['Cache-Control', 'private, no-store']);
  assert.deepEqual(response.body, { items: [] });
});
