/**
 * Booking Policy — Scheduling Configuration
 *
 * Provides three configurable policies:
 *   1. Minimum Advance Booking Notice — how far in advance a customer must book
 *   2. Operational Buffer Time — padding between bookings to absorb service overruns
 *   3. Default working hours — company-wide working window
 *
 * Defaults:
 *   - Minimum advance notice: 2 hours (120 minutes)
 *   - Operational buffer: 30 minutes
 */

const SiteSetting = require("../models/SiteSetting");

const DEFAULT_MIN_ADVANCE_MINUTES = 2 * 60; // 2 hours
// Operational buffer padding applied to a booking's capacity end so that a
// service which runs overtime bleeds into the next window instead of allowing
// a conflicting double-booking on the same technician.
const DEFAULT_BUFFER_MINUTES = 45; // 45 minutes operational buffer
const DEFAULT_INSPECTION_DURATION_MINUTES = 90; // 90 minutes for repair inspection

let cachedMinutes = null;
let cacheTimestamp = 0;
let cachedBufferMinutes = null;
let bufferCacheTimestamp = 0;
let cachedInspectionDuration = null;
let inspectionCacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // refresh from DB every 5 minutes

/**
 * Get the configured minimum advance booking notice (in minutes).
 * Reads from SiteSetting (key: "minAdvanceNoticeMinutes") with a short
 * in-memory cache to avoid hitting the DB on every request.
 */
async function getMinAdvanceMinutes() {
  const now = Date.now();
  if (cachedMinutes !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMinutes;
  }
  try {
    const setting = await SiteSetting.findOne({ key: "minAdvanceNoticeMinutes" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) >= 0) {
      cachedMinutes = Number(setting.value);
    } else {
      cachedMinutes = DEFAULT_MIN_ADVANCE_MINUTES;
    }
  } catch {
    cachedMinutes = DEFAULT_MIN_ADVANCE_MINUTES;
  }
  cacheTimestamp = now;
  return cachedMinutes;
}

/**
 * Synchronous fallback — returns the cached value or the default.
 * Use when an async DB call is not practical (e.g. inside tight loops).
 */
function getMinAdvanceMinutesSync() {
  return cachedMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
}

/**
 * Check whether a proposed booking datetime satisfies the minimum advance notice.
 *
 * @param {Date} bookingDateTime — the date + time the customer wants to book
 * @param {number} [minAdvanceMinutes] — override (minutes); if omitted, uses configured value
 * @returns {{ allowed: boolean, requiredMinutes: number, actualMinutes: number, message: string }}
 */
function checkAdvanceNotice(bookingDateTime, minAdvanceMinutes) {
  const required = minAdvanceMinutes ?? getMinAdvanceMinutesSync();
  const now = new Date();
  const diffMs = bookingDateTime.getTime() - now.getTime();
  const actualMinutes = Math.floor(diffMs / 60000);

  if (actualMinutes < required) {
    const hrs = Math.floor(required / 60);
    const mins = required % 60;
    const reqLabel = mins > 0 ? `${hrs} hour${hrs !== 1 ? "s" : ""} and ${mins} minute${mins !== 1 ? "s" : ""}` : `${hrs} hour${hrs !== 1 ? "s" : ""}`;
    return {
      allowed: false,
      requiredMinutes: required,
      actualMinutes,
      message: `This time slot is unavailable because bookings must be made at least ${reqLabel} in advance.`,
    };
  }

  return { allowed: true, requiredMinutes: required, actualMinutes, message: "" };
}

/**
 * Build the earliest allowed booking Date given the current time and
 * the configured minimum advance notice.
 */
function earliestAllowedDateTime(minAdvanceMinutes) {
  const required = minAdvanceMinutes ?? getMinAdvanceMinutesSync();
  const now = new Date();
  return new Date(now.getTime() + required * 60000);
}

/**
 * Get the configured operational buffer time (in minutes).
 * This is padding added between bookings to absorb service duration overruns.
 * Reads from SiteSetting (key: "schedulingBufferMinutes") with an in-memory cache.
 */
async function getBufferMinutes() {
  const now = Date.now();
  if (cachedBufferMinutes !== null && now - bufferCacheTimestamp < CACHE_TTL_MS) {
    return cachedBufferMinutes;
  }
  try {
    const setting = await SiteSetting.findOne({ key: "schedulingBufferMinutes" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) >= 0) {
      cachedBufferMinutes = Number(setting.value);
    } else {
      cachedBufferMinutes = DEFAULT_BUFFER_MINUTES;
    }
  } catch {
    cachedBufferMinutes = DEFAULT_BUFFER_MINUTES;
  }
  bufferCacheTimestamp = now;
  return cachedBufferMinutes;
}

/**
 * Synchronous fallback for operational buffer — returns cached value or default.
 */
function getBufferMinutesSync() {
  return cachedBufferMinutes ?? DEFAULT_BUFFER_MINUTES;
}

/**
 * Compute the total capacity consumption for a service slot.
 * This is the internal scheduling unit that accounts for service duration,
 * travel time, and operational buffer.
 *
 * @param {number} serviceDurationMinutes — estimated service duration
 * @param {number} travelMinutes — travel time to customer location
 * @param {number} bufferMinutes — operational buffer (optional, defaults to configured value)
 * @returns {number} total capacity consumption in minutes
 */
function computeCapacityConsumption(serviceDurationMinutes, travelMinutes, bufferMinutes) {
  const buffer = bufferMinutes ?? getBufferMinutesSync();
  return (serviceDurationMinutes || 0) + (travelMinutes || 0) + buffer;
}

/**
 * Invalidate all caches. Call after an admin updates scheduling settings.
 */
function invalidateCache() {
  cachedMinutes = null;
  cacheTimestamp = 0;
  cachedBufferMinutes = null;
  bufferCacheTimestamp = 0;
  cachedInspectionDuration = null;
  inspectionCacheTimestamp = 0;
}

/**
 * Get the configured inspection duration (in minutes) for repair services.
 * Reads from SiteSetting (key: "inspectionDurationMinutes") with an in-memory cache.
 * Default: 90 minutes
 */
async function getInspectionDurationMinutes() {
  const now = Date.now();
  if (cachedInspectionDuration !== null && now - inspectionCacheTimestamp < CACHE_TTL_MS) {
    return cachedInspectionDuration;
  }
  try {
    const setting = await SiteSetting.findOne({ key: "inspectionDurationMinutes" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) > 0) {
      cachedInspectionDuration = Number(setting.value);
    } else {
      cachedInspectionDuration = DEFAULT_INSPECTION_DURATION_MINUTES;
    }
  } catch {
    cachedInspectionDuration = DEFAULT_INSPECTION_DURATION_MINUTES;
  }
  inspectionCacheTimestamp = now;
  return cachedInspectionDuration;
}

/**
 * Synchronous fallback for inspection duration — returns cached value or default.
 */
function getInspectionDurationMinutesSync() {
  return cachedInspectionDuration ?? DEFAULT_INSPECTION_DURATION_MINUTES;
}

/**
 * Assert that the company has sufficient capacity for a proposed booking slot.
 *
 * This is the core guard against overbooking.  It counts ALL existing bookings
 * that overlap with the proposed time window and compares them against the
 * number of active technicians.  If overlapping bookings >= active technicians,
 * the slot is rejected.
 *
 * Capacity is reserved at booking creation — NOT at payment verification or
 * technician assignment.  Every active-status booking (pending, payment_verified,
 * awaiting_assignment, assigned, etc.) consumes one unit of capacity.
 *
 * @param {Date} bookingDate - The date of the proposed booking
 * @param {number} startMin - Start time in minutes from midnight
 * @param {number} endMin - End time in minutes from midnight (service + travel + buffer)
 * @param {string} [excludeBookingId] - Optional booking ID to exclude (for reschedule/update)
 * @throws {Error} If capacity is exceeded
 */
async function assertCompanyCapacity(bookingDate, startMin, endMin, excludeBookingId) {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    throw new Error("Invalid time range for capacity check.");
  }

  const Technician = require("../models/Technician");
  const BookingService = require("../models/BookingService");

  // ── 1. Count active technicians ──────────────────────────────────────────
  const activeTechCount = await Technician.countDocuments({ active: { $ne: false } });
  if (activeTechCount === 0) {
    throw new Error("No active technicians available. Booking cannot be accepted at this time.");
  }

  // ── 2. Build query for overlapping bookings ──────────────────────────────
  const dayStart = new Date(bookingDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(bookingDate);
  dayEnd.setHours(23, 59, 59, 999);

  const activeStatuses = [
    "pending",
    "payment_verified",
    "awaiting_assignment",
    "assigned",
    "pending_reassignment",
    "confirmed",
    "scheduled",
    "on-the-way",
    "arrived",
    "in-progress",
    "repair_requested",
    "inspection_scheduled",
    "inspection_in_progress",
    "repair_approved",
    "ready_for_repair",
    "repair_scheduled",
    "repair_in_progress",
  ];

  const query = {
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: { $in: activeStatuses },
  };
  if (excludeBookingId) {
    query._id = { $ne: excludeBookingId };
  }

  const existingBookings = await BookingService.find(query)
    .select("technicianId startTime endTime serviceDurationMinutes travelTime")
    .lean();

  // ── 3. Per-technician overlap ──────────────────────────────────────────────
  // Both assigned AND unassigned bookings are added to each technician's busy
  // intervals with their SPECIFIC time range. This matches how the client-side
  // time-slots endpoint calculates availability — an unassigned booking at
  // 8:00 AM only blocks that window, not the entire day.
  const techBusy = new Map(); // techId -> array of [startMin, endMin]
  const unassignedIntervals = []; // time ranges for unassigned bookings

  for (const b of existingBookings) {
    const bStart = parseTimeValue(b.startTime);
    if (!Number.isFinite(bStart)) continue;
    const bEnd = deriveCapacityEnd(b, 60);
    if (!Number.isFinite(bEnd) || bEnd <= bStart) continue;

    if (b.technicianId) {
      // Assigned booking: only blocks that specific technician
      const tid = String(b.technicianId);
      if (!techBusy.has(tid)) techBusy.set(tid, []);
      techBusy.get(tid).push([bStart, bEnd]);
    } else {
      // Unassigned booking consumes one pooled technician for this interval.
      unassignedIntervals.push([bStart, bEnd]);
    }
  }

  // Fetch all active technicians once
  const allTechs = await Technician.find({ active: { $ne: false } }).select("_id").lean();

  // A new booking needs at least one technician whose entire busy timeline
  // does NOT intersect [startMin, endMin]. Count how many techs are free.
  let freeTechs = 0;
  for (const tech of allTechs) {
    const tid = String(tech._id);
    const ranges = techBusy.get(tid) || [];
    const conflicts = ranges.some(([s, e]) => startMin < e && endMin > s);
    if (!conflicts) freeTechs++;
  }

  // One unassigned booking reserves one capacity unit. It must not make every
  // technician appear busy, which previously made a two-tech slot full after
  // only one standard booking.
  const overlappingUnassigned = unassignedIntervals.filter(
    ([s, e]) => startMin < e && endMin > s
  ).length;
  freeTechs = Math.max(0, freeTechs - overlappingUnassigned);

  // ── 4. Subtract project-reserved technicians ─────────────────────────────
  // Large-scale commercial projects reserve technicians for their working
  // days. These techs are not available for standard bookings.
  let projectReservedTechs = 0;
  try {
    const schedulingEngine = require("./enterpriseSchedulingEngine");
    const proj = await schedulingEngine.getProjectReservationsForDate(bookingDate);
    projectReservedTechs = proj.reservedTechnicians || 0;
  } catch (_) { /* non-fatal */ }

  const effectiveFree = Math.max(0, freeTechs - projectReservedTechs);

  // ── 5. Compare against capacity ──────────────────────────────────────────
  if (effectiveFree <= 0) {
    throw new Error(
      `Sorry, this time slot is no longer available. All ${activeTechCount} technician(s) are already booked for this period. Please choose a different time.`
    );
  }
}

/**
 * Parse a time string or numeric value to minutes from midnight.
 */
function parseTimeValue(value) {
  if (value === null || value === undefined) return NaN;
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  const str = String(value).trim();
  if (!str) return NaN;
  const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let hh = Number(ampm[1]) % 12;
    if (ampm[3].toUpperCase() === "PM") hh += 12;
    return hh * 60 + Number(ampm[2]);
  }
  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  return NaN;
}

/**
 * Derive the capacity end point (in minutes) for a booking.
 * Used internally for overlap detection — NOT a guaranteed completion time.
 */
function deriveCapacityEnd(booking, defaultServiceDuration) {
  const bStart = parseTimeValue(booking.startTime);
  const explicitEnd = parseTimeValue(booking.endTime);
  if (Number.isFinite(explicitEnd) && explicitEnd > bStart) return explicitEnd;
  const svcDuration = Number(booking.serviceDurationMinutes) || defaultServiceDuration || 60;
  const travel = Math.max(0, Number(booking.travelTime) || 0);
  const buffer = getBufferMinutesSync();
  if (!Number.isFinite(bStart)) return NaN;
  return bStart + svcDuration + travel + buffer;
}

/**
 * Compute the full end DateTime for a booking by combining bookingDate with
 * the explicit endTime, or falling back to startTime + serviceDurationMinutes.
 *
 * @param {object} booking — must have bookingDate, and optionally startTime,
 *   endTime, serviceDurationMinutes
 * @returns {Date|null} the computed end DateTime, or null if inputs are invalid
 */
function computeBookingEndDateTime(booking) {
  if (!booking || !booking.bookingDate) return null;
  const base = new Date(booking.bookingDate);
  if (isNaN(base.getTime())) return null;

  // Normalise to midnight of the booking day
  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();
  const localBase = new Date(y, mo, d, 0, 0, 0, 0);

  const endMin = parseTimeValue(booking.endTime);
  if (Number.isFinite(endMin)) {
    localBase.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    return localBase;
  }

  // Fallback: start + duration
  const startMin = parseTimeValue(booking.startTime);
  const duration = Number(booking.serviceDurationMinutes) || 60;
  if (!Number.isFinite(startMin)) return null;

  const totalMin = startMin + duration;
  localBase.setHours(Math.floor(totalMin / 60), totalMin % 60, 0, 0);
  return localBase;
}

/**
 * Determine whether a booking's scheduled time has fully elapsed.
 *
 * A booking is considered "past" when its computed end DateTime is strictly
 * before `now`.  This allows same-day bookings that haven't ended yet to
 * still be acted on.
 *
 * @param {object} booking — booking document (bookingDate, startTime, endTime, serviceDurationMinutes)
 * @param {Date}   [now]  — optional override for the current time (useful in tests)
 * @returns {boolean}
 */
function isBookingPast(booking, now) {
  const endDt = computeBookingEndDateTime(booking);
  if (!endDt) return false; // if we can't determine the time, don't block
  const ref = now || new Date();
  return endDt.getTime() < ref.getTime();
}

async function getLargeProjectThresholdHours() {
  try {
    const setting = await SiteSetting.findOne({ key: "largeProjectThresholdHours" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) > 0) {
      return Number(setting.value);
    }
  } catch {}
  return 8;
}

function getLargeProjectThresholdHoursSync() {
  return 8;
}

module.exports = {
  DEFAULT_MIN_ADVANCE_MINUTES,
  DEFAULT_BUFFER_MINUTES,
  DEFAULT_INSPECTION_DURATION_MINUTES,
  getMinAdvanceMinutes,
  getMinAdvanceMinutesSync,
  getBufferMinutes,
  getBufferMinutesSync,
  getInspectionDurationMinutes,
  getInspectionDurationMinutesSync,
  computeCapacityConsumption,
  checkAdvanceNotice,
  earliestAllowedDateTime,
  invalidateCache,
  assertCompanyCapacity,
  parseTimeValue,
  computeBookingEndDateTime,
  isBookingPast,
  getLargeProjectThresholdHours,
  getLargeProjectThresholdHoursSync,
};
