// ─── Progressive Login Rate Limiter ─────────────────────────────────────────
// Progressive lockout system with 5-attempt cycles and increasing durations.
//
// Progressive lockout pattern (per IP or email):
//   Cycle 1: 5 failed attempts → 3 minutes lockout
//   Cycle 2: 5 failed attempts → 5 minutes lockout  
//   Cycle 3: 5 failed attempts → 10 minutes lockout
//   Cycle 4+: 5 failed attempts → 30 minutes lockout
//   After 24 hours of inactivity → reset to cycle 1
//
// A successful login resets everything immediately.
// Records auto-expire after 24 hours of inactivity (memory hygiene).

const MAX_ATTEMPTS_PER_CYCLE = 5;
const CYCLE_LOCKOUTS = [
  3 * 60 * 1000,    // Cycle 1: 3 minutes
  5 * 60 * 1000,    // Cycle 2: 5 minutes  
  10 * 60 * 1000,   // Cycle 3: 10 minutes
  30 * 60 * 1000,   // Cycle 4+: 30 minutes
];
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours

const store = new Map();

function _key(type, identifier) {
  return `${type}:${String(identifier || "").toLowerCase()}`;
}

function _now() {
  return Date.now();
}

function _getLockoutDuration(cycle) {
  // Get lockout duration for current cycle (1-indexed)
  if (cycle <= 0) return 0;
  const index = Math.min(cycle - 1, CYCLE_LOCKOUTS.length - 1);
  return CYCLE_LOCKOUTS[index];
}

function _getOrCreate(key) {
  let rec = store.get(key);
  if (!rec || (_now() - (rec.lastActivity || 0) > RECORD_TTL_MS)) {
    rec = {
      currentCycleAttempts: 0,  // attempts in current cycle
      currentCycle: 1,          // current cycle number (1, 2, 3, 4+)
      lockedUntil: 0,           // timestamp when lockout expires
      lastActivity: _now(),
    };
    store.set(key, rec);
  }
  return rec;
}

/**
 * Record a failed login attempt.
 * Lockout duration increases based on cycle number.
 */
function recordFailed(type, identifier) {
  const key = _key(type, identifier);
  const rec = _getOrCreate(key);
  const now = _now();
  rec.lastActivity = now;

  // If currently locked, each additional attempt during lockout extends
  // the lockout by 30 seconds (punishment for hammering during lockout)
  // BUT do not increment attempts during lockout
  if (rec.lockedUntil && now < rec.lockedUntil) {
    rec.lockedUntil += 30 * 1000;
    store.set(key, rec);
    return rec;
  }

  // If lockout just expired, reset for new cycle
  if (rec.lockedUntil && now >= rec.lockedUntil) {
    rec.currentCycleAttempts = 0;
    rec.currentCycle += 1; // Move to next cycle
    rec.lockedUntil = 0;
  }

  // Increment attempts in current cycle
  rec.currentCycleAttempts += 1;

  // Check if we need to lock based on cycle attempts
  if (rec.currentCycleAttempts >= MAX_ATTEMPTS_PER_CYCLE) {
    const lockoutDuration = _getLockoutDuration(rec.currentCycle);
    rec.lockedUntil = now + lockoutDuration;
  }

  store.set(key, rec);
  return rec;
}

/**
 * Check if an identifier is currently blocked.
 * Returns { blocked, retryAfter (ms), attemptsRemaining, currentCycle }.
 */
function isBlocked(type, identifier) {
  const key = _key(type, identifier);
  const rec = store.get(key);
  if (!rec) {
    return { blocked: false, attemptsRemaining: MAX_ATTEMPTS_PER_CYCLE, currentCycle: 1 };
  }

  const now = _now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const retryAfter = rec.lockedUntil - now;
    return {
      blocked: true,
      retryAfter,
      currentCycle: rec.currentCycle,
      retryAfterSeconds: Math.ceil(retryAfter / 1000),
      retryAfterLabel: _formatDuration(retryAfter),
    };
  }

  // If lockout just expired, keep the cycle info for the new cycle
  return {
    blocked: false,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS_PER_CYCLE - rec.currentCycleAttempts),
    currentCycle: rec.currentCycle,
  };
}

/**
 * Reset all rate-limiter state for an identifier (on successful login).
 */
function reset(type, identifier) {
  const key = _key(type, identifier);
  store.delete(key);
}

/**
 * Human-readable duration label (e.g. "5 minutes", "1 hour 30 minutes").
 */
function _formatDuration(ms) {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec} second${totalSec !== 1 ? "s" : ""}`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec > 0 ? `${min} min ${sec} sec` : `${min} minute${min !== 1 ? "s" : ""}`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0
    ? `${hr} hour${hr !== 1 ? "s" : ""} ${remMin} min`
    : `${hr} hour${hr !== 1 ? "s" : ""}`;
}

// Periodic cleanup of stale records (every 15 minutes)
setInterval(() => {
  const now = _now();
  for (const [key, rec] of store) {
    if (now - (rec.lastActivity || 0) > RECORD_TTL_MS) {
      store.delete(key);
    }
  }
}, 15 * 60 * 1000).unref();

module.exports = {
  recordFailed,
  isBlocked,
  reset,
};
