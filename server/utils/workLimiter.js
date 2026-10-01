"use strict";

function busyError() {
  const error = new Error("The service is busy. Please try again in a few seconds.");
  error.code = "WORK_CAPACITY_EXCEEDED";
  error.status = 503;
  return error;
}

// Holds a slot until the actual task settles, even if its HTTP client leaves.
// It deliberately has no queue: excess work receives backpressure immediately.
function createWorkLimiter({ limit, perKeyLimit = limit }) {
  let active = 0;
  const byKey = new Map();
  return {
    async run(key, task) {
      const current = byKey.get(key) || 0;
      if (active >= limit || current >= perKeyLimit) throw busyError();
      active += 1;
      byKey.set(key, current + 1);
      try {
        return await task();
      } finally {
        active -= 1;
        const remaining = byKey.get(key) - 1;
        if (remaining) byKey.set(key, remaining);
        else byKey.delete(key);
      }
    },
    get active() { return active; },
  };
}

module.exports = { createWorkLimiter, busyError };
