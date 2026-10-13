'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inventoryNavigationSources } = require('../utils/inventoryNavigationCounts');

test('inventory counts read the actual catalogs and keep counter sales separate from web orders', async t => {
  const now = new Date('2026-10-13T01:30:00Z');
  t.mock.method(require('../models/HVACProduct'), 'aggregate', async pipeline => {
    assert.deepEqual(pipeline[0].$match, { active: true, archivedAt: null });
    assert.equal(pipeline[1].$unwind, '$variants');
    assert.deepEqual(pipeline[2].$match['variants.status'].$nin, ['discontinued', 'coming_soon']);
    assert.deepEqual(pipeline[2].$match.$expr.$lte, [{ $ifNull: ['$variants.quantity', 0] }, { $ifNull: ['$variants.minStockLevel', 3] }]);
    assert.equal(pipeline[2].$match['variants.active'].$ne, false);
    return [{ count: 8 }];
  });
  t.mock.method(require('../models/Tool'), 'countDocuments', async filter => {
    assert.equal(filter.active, true);
    assert.equal(filter.archivedAt, null);
    assert.deepEqual(filter.$expr.$lte, [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$minStockLevel', 3] }]);
    assert.deepEqual(filter.status, { $ne: 'discontinued' });
    return 3;
  });
  t.mock.method(require('../models/DailyKit'), 'countDocuments', async filter => {
    assert.equal(filter.workDate.$gte.toISOString(), '2026-10-12T16:00:00.000Z');
    assert.equal(filter.workDate.$lt.toISOString(), '2026-10-13T16:00:00.000Z');
    assert.deepEqual(filter.$or[0], { hasDelta: true });
    for (const [index, field] of [[1, 'items'], [2, 'deltaItems']]) {
      assert.equal(filter.$or[index][field].$elemMatch['exception.approved'].$ne, true);
      assert.deepEqual(filter.$or[index][field].$elemMatch['resolution.status'].$in, [null, '', 'admin_notified']);
    }
    return 2;
  });
  for (const [name, value] of [['WalkInSale', 4], ['Order', 5], ['StockAdjustment', 10]]) {
    t.mock.method(require('../models/' + name), 'countDocuments', async filter => {
      assert.equal(filter.createdAt.$gte.toISOString(), '2026-10-12T16:00:00.000Z');
      assert.equal(filter.createdAt.$lte, now);
      if (name === 'WalkInSale') assert.equal(filter.status, 'completed');
      if (name === 'Order') {
        assert.equal(filter.salesChannel, 'walk_in');
        assert.equal(filter.archivedAt, null);
        assert.deepEqual(filter.status.$nin, ['cancelled', 'rejected']);
      }
      return value;
    });
  }
  const counts = Object.fromEntries(await Promise.all(inventoryNavigationSources(now).map(async ([key, read]) => [key, await read()])));
  assert.deepEqual(counts, { inventoryAircons: 8, inventoryParts: 3, inventoryKits: 2, inventorySales: 9, inventoryHistory: 10 });
});

test('a daily inventory source never falls back to yesterday; one failure leaves other links accurate', async t => {
  t.mock.method(require('../models/BookingService'), 'aggregate', async () => []);
  for (const model of ['Expense', 'LeaveRequest', 'Order', 'Project', 'EquipmentAssignment', 'ActivityLog', 'Tool', 'DailyKit', 'WalkInSale', 'KitReturn']) {
    t.mock.method(require('../models/' + model), 'countDocuments', async () => 0);
  }
  t.mock.method(require('../models/HVACProduct'), 'aggregate', async () => [{ count: 3 }]);
  t.mock.method(require('../utils/maintenanceSummary'), 'maintenanceSummary', async () => ({ actionable: 0 }));
  let fail = false;
  t.mock.method(require('../models/StockAdjustment'), 'countDocuments', async () => {
    if (fail) throw new Error('History unavailable');
    return 12;
  });
  const { buildAdminNavigationSummary } = require('../utils/adminNavigationSummary');
  const initial = await buildAdminNavigationSummary(new Date('2026-10-13T15:59:00Z'));
  assert.equal(initial.inventory.changesToday, 12);
  fail = true;
  const stale = await buildAdminNavigationSummary(new Date('2026-10-13T15:59:30Z'));
  assert.equal(stale.inventory.changesToday, 12);
  assert.ok(stale.staleSources.includes('inventoryHistory'));
  const nextDay = await buildAdminNavigationSummary(new Date('2026-10-13T16:00:00Z'));
  assert.equal(nextDay.inventory.changesToday, undefined);
  assert.equal(nextDay.inventory.aircons, 3);
  assert.ok(nextDay.failedSources.includes('inventoryHistory'));
  assert.ok(!nextDay.staleSources.includes('inventoryHistory'));
});
