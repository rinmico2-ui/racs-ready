'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { createDailyKitScheduler, generationPipeline, CHECK_INTERVAL_MS } = require('../utils/dailyKitScheduler');
const { manilaDateKey } = require('../utils/bookingDateTime');

const T = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const U = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const NOW = new Date('2026-10-13T16:05:00Z'); // 14 October in Manila.
const target = (date = '2026-10-14', technicianId = T, automaticSyncedAt = null) => ({ _id: { technicianId, date }, automaticSyncedAt });

function fixture(targets = [target()], extra = {}) {
  const calls = [], timers = new Map(), warnings = [];
  let nextTimer = 0, time = new Date(NOW), connected = true, closed = 0, persisted = null;
  const clock = () => new Date(time);
  const models = Object.fromEntries(['Order', 'DailyAssignment', 'DailyKit'].map(name => [name, { collection: { name: name.toLowerCase() + 's' } }]));
  models.DailyKit.exists = filter => ({ maxTimeMS(ms) { calls.push(['recent', filter, ms]); return Promise.resolve(persisted); } });
  const db = { connection: { get readyState() { return connected ? 1 : 0; } } };
  const options = {
    mongoose: db, ...models, now: clock, logger: { warn(...args) { warnings.push(args); } },
    Assignment: { aggregate(pipeline) {
      calls.push(['discover', pipeline]);
      return { option(value) { assert.equal(value.maxTimeMS, 20000); return this; }, cursor(value) {
        assert.equal(value.batchSize, 25);
        return { async *[Symbol.asyncIterator]() { for (const row of targets) yield row; }, async close() { closed++; } };
      } };
    } },
    async syncDailyKit(...args) { calls.push(['sync', ...args]); return {}; },
    async withOperationLock(key, work, settings) { calls.push(['lock', key, settings]); return work(); },
    setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; timers.set(++nextTimer, timer); return nextTimer; },
    clearTimeout(timer) { timers.delete(timer); }, ...extra,
  };
  const scheduler = createDailyKitScheduler(options);
  async function tick() { const [key, timer] = timers.entries().next().value; timers.delete(key); await timer.fn(); }
  return { scheduler, calls, timers, warnings, tick, models, get closed() { return closed; },
    set time(value) { time = value; }, set connected(value) { connected = value; }, set persisted(value) { persisted = value; } };
}

test('startup generates service, installation and project day kits without a technician page request', async () => {
  const f = fixture([target(), target('2026-10-15', U)]);
  f.scheduler.start(); f.scheduler.start();
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 0);
  await f.tick();
  const syncs = f.calls.filter(call => call[0] === 'sync');
  assert.equal(syncs.length, 2);
  assert.equal(syncs[0][1], T); assert.equal(syncs[0][2], '2026-10-14'); assert.deepEqual(syncs[0][3], { automatic: true });
  assert.equal(f.closed, 1);
  assert.equal([...f.timers.values()][0].delay, CHECK_INTERVAL_MS);
  await f.scheduler.stop(); assert.equal(f.timers.size, 0);
});

test('discovery uses Manila days, accepted work, confirmed project schedules and old kit targets', () => {
  const pipeline = generationPipeline({ orders:'orders', dailyAssignments:'dailyassignments', kits:'dailykits' }, NOW);
  assert.deepEqual(pipeline[0].$match.status.$in, ['accepted','en_route','on_site','in_progress']);
  assert.equal(pipeline[0].$match.serviceType.$ne, 'project');
  assert.equal(pipeline[0].$match.bookingDate.$gte.toISOString(), '2026-10-13T16:00:00.000Z');
  assert.equal(manilaDateKey(new Date(pipeline[0].$match.bookingDate.$lt.getTime() - 1)), '2026-12-13');
  assert.equal(pipeline[1].$project.date.$dateToString.timezone, 'Asia/Manila');
  const unions = pipeline.filter(stage => stage.$unionWith).map(stage => stage.$unionWith);
  assert.equal(unions[0].pipeline[0].$match.fulfillmentType, 'delivery_installation');
  assert.deepEqual(unions[0].pipeline[0].$match.status.$in, ['technician_accepted','out_for_delivery','arrived','installing']);
  assert.equal(unions[1].pipeline[0].$match.planningOnly.$ne, true);
  assert.deepEqual(unions[1].pipeline[0].$match.status.$in, ['pending','in_progress']);
  assert.deepEqual(unions[2].pipeline[0].$match.status.$in, ['draft','prepared','confirmed','in_progress']);
  assert.equal(unions[2].pipeline[0].$match.workDate.$type, 'date');
  assert.deepEqual(pipeline.at(-2).$group._id, { technicianId:'$technicianId', date:'$date' });
});

test('recent generation and another instance finishing under the lease avoid duplicate refreshes', async () => {
  const f = fixture([target('2026-10-14', T, NOW), target('2026-10-15')]);
  f.persisted = { _id:'generated-elsewhere' };
  const result = await f.scheduler.run();
  assert.equal(result.skipped, 2); assert.equal(result.generated, 0);
  assert.equal(f.calls.filter(call => call[0] === 'lock').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'sync'), false);
  const lease = f.calls.find(call => call[0] === 'lock');
  assert.equal(lease[1], `daily-kit-generation:${T}:2026-10-15`);
});

test('concurrent sweeps coalesce and kit transactions run one at a time', async () => {
  let release, active = 0, peak = 0, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture([target(), target('2026-10-15')], { async syncDailyKit() { active++; peak = Math.max(peak, active); calls++; await blocked; active--; return {}; } });
  const first = f.scheduler.run(), second = f.scheduler.run();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await first;
  assert.equal(calls, 2); assert.equal(peak, 1); assert.equal(f.closed, 1);
});

test('a failed kit retries on the next sweep without blocking other technicians', async () => {
  let fail = true; const generated = [];
  const f = fixture([target(), target('2026-10-15', U)], { async syncDailyKit(tech, date) {
    if (fail && String(tech) === String(T)) throw new Error('Temporary inventory failure');
    generated.push(date);
    return {};
  } });
  const initial = await f.scheduler.run(); assert.equal(initial.failed, 1); assert.equal(initial.generated, 1);
  assert.equal(f.warnings.length, 1);
  fail = false; const retry = await f.scheduler.run(); assert.equal(retry.generated, 2); assert.equal(retry.failed, 0);
  assert.deepEqual(generated, ['2026-10-15','2026-10-14','2026-10-15']);
});

test('lease contention and a disconnected database are deferred without creating kits', async () => {
  const f = fixture([target()], { async withOperationLock() { throw Object.assign(new Error('busy'), { code:'OPERATION_LOCK_TIMEOUT' }); } });
  assert.equal((await f.scheduler.run()).skipped, 1); assert.equal(f.warnings.length, 0);
  f.connected = false;
  assert.equal((await f.scheduler.run()).disconnected, true);
  assert.equal(f.calls.filter(call => call[0] === 'discover').length, 1);
});

test('shutdown stops new work, waits for an in-flight kit and closes the cursor', async () => {
  let release, calls = 0; const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture([target(), target('2026-10-15')], { async syncDailyKit() { calls++; await blocked; return {}; } });
  const run = f.scheduler.run(); await new Promise(resolve => setImmediate(resolve));
  let stopped = false; const stop = f.scheduler.stop().then(() => { stopped = true; });
  assert.equal(stopped, false); release(); await run; await stop;
  assert.equal(calls, 1); assert.equal(f.closed, 1); assert.equal((await f.scheduler.run()).stopped, true);
});

test('discovery failure reschedules the background worker instead of disabling automatic preparation', async () => {
  const f = fixture([], { Assignment:{ collection:{name:'assignments'}, aggregate() { throw new Error('Database temporarily unavailable'); } } });
  f.scheduler.start(); await f.tick();
  assert.equal(f.warnings.length, 1); assert.equal([...f.timers.values()][0].delay, CHECK_INTERVAL_MS);
  await f.scheduler.stop(); assert.equal(f.timers.size, 0);
});

test('application starts automatic kits only after database readiness and stops them before disconnect', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(index, /function startBackgroundSchedulers\(\)[\s\S]*?startDailyKitScheduler\(\)/);
  assert.match(index, /databaseReady\s*\.then\(\(\) => \{\s*startBackgroundSchedulers\(\)/);
  const shutdown = index.slice(index.indexOf('async function gracefulShutdown'), index.indexOf('shutdownSignals.forEach'));
  assert.ok(shutdown.indexOf('await stopDailyKitScheduler()') < shutdown.indexOf('await mongoose.disconnect()'));
});
