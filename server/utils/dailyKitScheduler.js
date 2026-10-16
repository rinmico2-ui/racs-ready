'use strict';

const { ACTIVE_ASSIGNMENT_STATUSES, dayBounds } = require('./dailyKitService');
const { ACTIVE_INSTALLATION_ORDER_STATUSES } = require('./orderPreparation');

const CHECK_INTERVAL_MS = 60 * 1000;
const LOOK_AHEAD_DAYS = 60;
const KIT_STATUSES = ['draft', 'prepared', 'confirmed', 'in_progress'];

/** Discover technician/work-date pairs, never stock or checkout operations. */
function generationPipeline(collections, now = new Date()) {
  const { start } = dayBounds(now);
  const end = new Date(start.getTime() + (LOOK_AHEAD_DAYS + 1) * 86400000);
  const rows = (dateField, filter, existing = false) => [
    { $match: { ...filter, technicianId: { $type: 'objectId' }, [dateField]: { $type: 'date', $gte: start, $lt: end } } },
    { $project: { technicianId: 1, date: { $dateToString: { date: '$' + dateField, format: '%Y-%m-%d', timezone: 'Asia/Manila' } },
      automaticSyncedAt: existing ? { $cond: [{ $eq: [{ $type: '$automaticSyncedAt' }, 'date'] }, '$automaticSyncedAt', null] } : { $literal: null } } },
  ];
  return [
    ...rows('bookingDate', { status: { $in: ACTIVE_ASSIGNMENT_STATUSES }, serviceType: { $ne: 'project' }, crewRole: { $ne: 'support' } }),
    { $unionWith: { coll: collections.orders, pipeline: rows('delivery.preferredDate', { isProject: { $ne: true }, fulfillmentType: 'delivery_installation', status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES } }) } },
    { $unionWith: { coll: collections.dailyAssignments, pipeline: rows('date', { planningOnly: { $ne: true }, status: { $in: ['pending', 'in_progress'] } }) } },
    // Old kit targets also need a refresh after reassignment, rescheduling or
    // cancellation. The canonical sync preserves already-issued custody rows.
    { $unionWith: { coll: collections.kits, pipeline: rows('workDate', { status: { $in: KIT_STATUSES } }, true) } },
    { $group: { _id: { technicianId: '$technicianId', date: '$date' }, automaticSyncedAt: { $max: '$automaticSyncedAt' } } },
    { $sort: { '_id.date': 1, '_id.technicianId': 1 } },
  ];
}

function createDailyKitScheduler(overrides = {}) {
  const mongoose = overrides.mongoose || require('mongoose');
  const Assignment = overrides.Assignment || require('../models/Assignment');
  const Order = overrides.Order || require('../models/Order');
  const DailyAssignment = overrides.DailyAssignment || require('../models/DailyAssignment');
  const DailyKit = overrides.DailyKit || require('../models/DailyKit');
  const syncDailyKit = overrides.syncDailyKit || require('./dailyKitService').syncDailyKit;
  const withOperationLock = overrides.withOperationLock || require('./operationLock').withOperationLock;
  const isMaintenanceEnabled = overrides.isMaintenanceEnabled || require('./workflowSchedulerMaintenance').isWorkflowMaintenanceEnabled;
  const clock = overrides.now || (() => new Date());
  const logger = overrides.logger || console;
  const setTimer = overrides.setTimeout || setTimeout;
  const clearTimer = overrides.clearTimeout || clearTimeout;
  let running = null, timer = null, started = false, stopped = false;

  async function sweep(now) {
    const summary = { generated: 0, skipped: 0, failed: 0 };
    if (mongoose.connection.readyState !== 1) return { ...summary, disconnected: true };
    if (await isMaintenanceEnabled()) return { ...summary, pausedForMaintenance: true };
    const collections = { orders: Order.collection.name, dailyAssignments: DailyAssignment.collection.name, kits: DailyKit.collection.name };
    const cursor = Assignment.aggregate(generationPipeline(collections, now))
      .option({ maxTimeMS: 20000, allowDiskUse: true }).cursor({ batchSize: 25 });
    try {
      // One kit transaction at a time keeps preparation out of the request
      // critical path without flooding the application's MongoDB pool.
      for await (const target of cursor) {
        if (stopped) break;
        if (await isMaintenanceEnabled()) { summary.pausedForMaintenance = true; break; }
        const { technicianId, date } = target._id;
        const cutoff = new Date(clock().getTime() - CHECK_INTERVAL_MS);
        if (target.automaticSyncedAt instanceof Date && target.automaticSyncedAt > cutoff) { summary.skipped++; continue; }
        try {
          const generated = await withOperationLock(`daily-kit-generation:${technicianId}:${date}`, async () => {
            const { start, end } = dayBounds(date);
            // Check again under the lease: another application instance may
            // have generated this day after the discovery cursor was opened.
            const recent = await DailyKit.exists({ technicianId, workDate: { $gte: start, $lt: end }, automaticSyncedAt: { $gt: cutoff } }).maxTimeMS(5000);
            if (recent || stopped) return false;
            if (await isMaintenanceEnabled()) { summary.pausedForMaintenance = true; return false; }
            const kit = await syncDailyKit(technicianId, date, { automatic: true });
            return Boolean(kit);
          }, { leaseMs: 120000, waitMs: 250 });
          summary[generated ? 'generated' : 'skipped']++;
        } catch (error) {
          if (error.code === 'OPERATION_LOCK_TIMEOUT') { summary.skipped++; continue; }
          summary.failed++;
          logger.warn(`[daily-kit-monitor] Kit ${technicianId}/${date} will retry:`, error.message);
        }
      }
    } finally { await cursor.close(); }
    return summary;
  }

  function run(now = clock()) {
    if (running) return running;
    if (stopped) return Promise.resolve({ generated: 0, skipped: 0, failed: 0, stopped: true });
    running = sweep(now).finally(() => { running = null; });
    return running;
  }

  function schedule(delay) {
    timer = setTimer(async () => {
      timer = null;
      try { await run(); }
      catch (error) { logger.warn('[daily-kit-monitor] Discovery failed; retrying next minute:', error.message); }
      finally { if (started && !stopped) schedule(CHECK_INTERVAL_MS); }
    }, delay);
    timer?.unref?.();
  }

  function start() {
    if (started) return;
    started = true; stopped = false;
    schedule(0);
  }

  async function stop() {
    stopped = true; started = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (running) await running.catch(() => {});
  }

  return { run, start, stop };
}

let scheduler;
function startDailyKitScheduler() {
  scheduler ||= createDailyKitScheduler();
  scheduler.start();
}
async function stopDailyKitScheduler() { if (scheduler) await scheduler.stop(); }

module.exports = { CHECK_INTERVAL_MS, LOOK_AHEAD_DAYS, generationPipeline, createDailyKitScheduler, startDailyKitScheduler, stopDailyKitScheduler };
