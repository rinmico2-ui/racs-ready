"use strict";

function positiveLimit(value, fallback, maximum = 100000) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

// A process-local counter with a hard memory bound. When full, reject new
// identities rather than evicting active counters and resetting their limits.
function createBoundedWindow({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
  const entries = new Map();
  let lastSweep = -Infinity;
  return {
    consume(key) {
      const timestamp = now();
      let entry = entries.get(key);
      if (entry && entry.resetAt <= timestamp) {
        entries.delete(key);
        entry = null;
      }
      if (!entry) {
        if (entries.size >= maxKeys && timestamp - lastSweep >= 1000) {
          lastSweep = timestamp;
          for (const [id, item] of entries) {
            if (item.resetAt <= timestamp) entries.delete(id);
          }
        }
        if (entries.size >= maxKeys) return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
        entry = { hits: 0, resetAt: timestamp + windowMs };
        entries.set(key, entry);
      }
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000));
      if (entry.hits >= limit) return { allowed: false, retryAfter };
      entry.hits += 1;
      return { allowed: true, retryAfter };
    },
    get size() { return entries.size; },
  };
}

module.exports = { createBoundedWindow, positiveLimit };
