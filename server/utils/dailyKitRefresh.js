'use strict';

// Reading a preparation screen must not wait for a stock-planning transaction.
// Keep a bounded queue and use the same cross-process lease as the monitor.
function createQueue({ sync = (...args) => require('./dailyKitService').syncDailyKit(...args),
  lock = (...args) => require('./operationLock').withOperationLock(...args),
  schedule = work => setImmediate(work), warn = (...args) => console.warn(...args), limit = 128 } = {}) {
  const pending = new Map();
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.size) {
        const [key, job] = pending.entries().next().value;
        try {
          await lock(key, () => sync(job.technicianId, job.date, { automatic: true }), { leaseMs: 120000, waitMs: 250 });
        } catch (error) {
          if (error.code !== 'OPERATION_LOCK_TIMEOUT') warn('[daily-kit-refresh] Preparation will retry:', error.message);
        } finally { pending.delete(key); }
      }
    } finally { running = false; }
  }
  function enqueue(technicianId, value) {
    const { manilaDateKey } = require('./bookingDateTime');
    const date = manilaDateKey(value);
    if (!date || !technicianId) return false;
    const key = `daily-kit-generation:${technicianId}:${date}`;
    if (pending.has(key)) return true;
    if (pending.size >= limit) return false;
    pending.set(key, { technicianId, date });
    if (!running && pending.size === 1) schedule(drain);
    return true;
  }
  return { enqueue, drain, get size() { return pending.size; } };
}

const queue = createQueue();
module.exports = { createQueue, requestDailyKitRefresh: (...args) => queue.enqueue(...args) };
