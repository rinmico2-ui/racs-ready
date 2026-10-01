"use strict";

const { rateLimit: expressRateLimit } = require("express-rate-limit");
const { normalizedIpKey } = require("./rateLimitIdentity");
const { positiveLimit } = require("./boundedWindow");

// Implements the public express-rate-limit Store API. Full tables fail closed
// without allocating another key or resetting existing clients' counters.
class BoundedRateLimitStore {
  constructor({ maxKeys = positiveLimit(process.env.RATE_LIMIT_MAX_KEYS, 10000), now = Date.now } = {}) {
    this.maxKeys = maxKeys;
    this.now = now;
    this.entries = new Map();
    this.localKeys = true;
    this.lastSweep = -Infinity;
  }

  init(options) {
    clearInterval(this.interval);
    this.windowMs = options.windowMs;
    this.interval = setInterval(() => this.sweep(this.now()), this.windowMs);
    this.interval.unref();
  }

  sweep(now) {
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.resetTime.getTime() <= now) this.entries.delete(key);
    }
  }

  async increment(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && entry.resetTime.getTime() <= now) { this.entries.delete(key); entry = null; }
    if (!entry) {
      if (this.entries.size >= this.maxKeys && now - this.lastSweep >= 1000) this.sweep(now);
      if (this.entries.size >= this.maxKeys) return { totalHits: Number.MAX_SAFE_INTEGER, resetTime: new Date(now + this.windowMs) };
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.entries.set(key, entry);
    }
    entry.totalHits = Math.min(Number.MAX_SAFE_INTEGER, entry.totalHits + 1);
    return { ...entry };
  }

  async decrement(key) {
    const entry = this.entries.get(key);
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  }
  async get(key) { return this.entries.get(key); }
  async resetKey(key) { this.entries.delete(key); }
  async resetAll() { this.entries.clear(); }
  shutdown() { clearInterval(this.interval); this.entries.clear(); }
}

function rateLimit(options) {
  return expressRateLimit({
    ...options,
    keyGenerator: options.keyGenerator || normalizedIpKey,
    store: options.store || new BoundedRateLimitStore(),
  });
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;
module.exports.BoundedRateLimitStore = BoundedRateLimitStore;
