const crypto = require("crypto");
const OperationLock = require("../models/OperationLock");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Execute work while holding a MongoDB-backed lease.
 *
 * The lease prevents check-then-write races between processes. A crashed
 * owner cannot hold it forever because another process may take it after
 * `expiresAt`; the TTL index later removes abandoned documents as cleanup.
 */
async function withOperationLock(key, work, options = {}) {
  const owner = crypto.randomUUID();
  const leaseMs = lockNumber(options.leaseMs, 45_000);
  const waitMs = lockNumber(options.waitMs, 8_000);
  const retryMs = lockNumber(options.retryMs, 50);
  const deadline = Date.now() + waitMs;

  while (true) {
    const now = new Date();
    try {
      const lock = await OperationLock.findOneAndUpdate(
        {
          _id: key,
          $or: [{ expiresAt: { $lte: now } }, { owner }],
        },
        {
          $set: {
            owner,
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + leaseMs),
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      ).lean();

      if (lock?.owner === owner) break;
    } catch (error) {
      // An unmatched upsert against an existing `_id` loses the lock race and
      // reports duplicate key. Other failures must remain visible.
      if (error?.code !== 11000) throw error;
    }

    if (Date.now() >= deadline) {
      throw Object.assign(
        new Error("This booking slot is currently being reserved. Please try again."),
        { status: 409, code: "OPERATION_LOCK_TIMEOUT" },
      );
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }

  try {
    return await work();
  } finally {
    await OperationLock.deleteOne({ _id: key, owner }).catch(() => {});
  }
}

function bookingCapacityLockKey(bookingDate) {
  const date = new Date(bookingDate);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("Invalid booking date."), { status: 400 });
  }
  // Capacity conflicts cannot cross a calendar day in the current scheduler,
  // so day-level locking preserves parallelism across independent dates.
  return `booking-capacity:${date.toISOString().slice(0, 10)}`;
}

module.exports = { bookingCapacityLockKey, withOperationLock };
