"use strict";
const crypto = require("crypto");
const SecurityRateBucket = require("../models/SecurityRateBucket");

async function consumeSecurityBudget({ category, key, windowMs, limit, now = Date.now() }) {
  const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
  const identity = crypto.createHash("sha256").update(String(key)).digest("hex");
  const id = `${category}:${resetAt}:${identity}`;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  try {
    const row = await SecurityRateBucket.findOneAndUpdate(
      { _id: id, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt + 60000) } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: false },
    ).select("count").maxTimeMS(1500).lean();
    return { allowed: Boolean(row) && row.count <= limit, retryAfter, remaining: Math.max(0, limit - (row?.count || limit)) };
  } catch (error) {
    // A full bucket loses the conditional upsert against its unique _id.
    if (error.code === 11000) return { allowed: false, retryAfter, remaining: 0 };
    throw error;
  }
}

module.exports = { consumeSecurityBudget };
