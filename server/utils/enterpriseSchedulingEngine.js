const mongoose = require("mongoose");
const SiteSetting = require("../models/SiteSetting");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const NonWorkingDay = require("../models/NonWorkingDay");
const LeaveRequest = require("../models/LeaveRequest");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const Project = require("../models/Project");
const {
  getBufferMinutesSync,
  parseTimeValue,
} = require("./bookingPolicy");

const DEFAULT_WORK_START = 8 * 60;
const DEFAULT_WORK_END = 19 * 60; // 7:00 PM (includes overtime)
const DEFAULT_SLOT_INTERVAL = 30;
const LARGE_SCALE_MIN_UNITS = 8;
const MAX_BOOKING_UNITS = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

const WORK_START = DEFAULT_WORK_START;
const WORK_END = DEFAULT_WORK_END;

let cachedProjectThreshold = null;
let projectThresholdTimestamp = 0;

const APPOINTMENT_WINDOWS = [
  { label: "8:00 AM Window", startMin: 8 * 60 },
  { label: "11:00 AM Window", startMin: 11 * 60 },
  { label: "1:00 PM Window", startMin: 13 * 60 },
  { label: "3:00 PM Window", startMin: 15 * 60 },
  { label: "4:00 PM Window", startMin: 16 * 60 },
];

// The largest reservation that can still fit a standard appointment is one that
// starts at the earliest window and finishes by company close. Beyond this the
// job requires project scheduling.
const MAX_WINDOW_DURATION =
  DEFAULT_WORK_END - Math.min(...APPOINTMENT_WINDOWS.map((w) => w.startMin));
const TRAFFIC_ALLOWANCE_RATIO = 0.3;
const DEFAULT_TRAVEL_TIME = 20;
const PREP_BUFFER_MINUTES = 15;
const COMPLETION_BUFFER_MINUTES = 15;

// Local-calendar date key (YYYY-MM-DD). Always derive keys from the LOCAL
// year/month/day — toISOString().slice(0,10) shifts dates one day back for
// any stored date that is not UTC-midnight (e.g. local-midnight holiday
// entries), which silently turns holidays into working days.
function toLocalDateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

async function getProjectThresholdHours() {
  const now = Date.now();
  if (cachedProjectThreshold !== null && now - projectThresholdTimestamp < CACHE_TTL_MS) {
    return cachedProjectThreshold;
  }
  try {
    const setting = await SiteSetting.findOne({ key: "largeProjectThresholdHours" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) > 0) {
      cachedProjectThreshold = Number(setting.value);
    } else {
      cachedProjectThreshold = 8;
    }
  } catch {
    cachedProjectThreshold = 8;
  }
  projectThresholdTimestamp = now;
  return cachedProjectThreshold;
}

function getProjectThresholdHoursSync() {
  return cachedProjectThreshold ?? 8;
}

function invalidateProjectThresholdCache() {
  cachedProjectThreshold = null;
  projectThresholdTimestamp = 0;
}

const BookingType = {
  CORE_SERVICE: "core_service",
  REPAIR_INSPECTION: "repair_inspection",
  PRODUCT_ONLY: "product_only",
  PRODUCT_WITH_INSTALLATION: "product_with_installation",
  LARGE_PROJECT: "large_project",
};

function classifyBooking(params) {
  const { serviceModel, serviceId, quantity, totalEstimatedMinutes, isProduct, hasInstallation } = params;

  if (isProduct && !hasInstallation) {
    return BookingType.PRODUCT_ONLY;
  }
  if (isProduct && hasInstallation) {
    return BookingType.PRODUCT_WITH_INSTALLATION;
  }

  if (serviceModel === "RepairService") {
    return BookingType.REPAIR_INSPECTION;
  }

  if (serviceModel === "CoreService") {
    return BookingType.CORE_SERVICE;
  }

  return BookingType.CORE_SERVICE;
}

async function isLargeProject(params) {
  const suppliedUnits = params.totalUnits ?? params.quantity;
  const exceedsUnitThreshold = suppliedUnits !== undefined && suppliedUnits !== null
    ? Number(suppliedUnits) >= LARGE_SCALE_MIN_UNITS
    : false;
  const totalEstimatedMinutes = Number(params.totalEstimatedMinutes) || 0;
  if (exceedsUnitThreshold) return true;
  if (totalEstimatedMinutes <= 0) return false;
  const thresholdMinutes = (await getProjectThresholdHours()) * 60;
  return totalEstimatedMinutes > thresholdMinutes;
}

/**
 * Calculate the full workload breakdown for a service booking.
 *
 * @param {Object} params
 * @param {string} params.serviceId - CoreService or RepairService ID
 * @param {number} params.quantity - Number of units
 * @param {string} params.serviceModel - "CoreService" or "RepairService"
 * @param {number} [params.travelTime] - Travel time in minutes (from geocoding)
 * @param {string} [params.hp] - HP rating for aircon services
 * @param {string} [params.airconType] - Aircon type for duration lookup
 * @returns {Object} Workload breakdown with feasibility check
 */
async function calculateWorkload(params) {
  const { serviceId, quantity, serviceModel, travelTime, hp, airconType } = params;

  const { durationPerUnit, totalMinutes, quantity: qty } =
    await calculateTotalEstimatedDuration(serviceId, quantity, serviceModel, hp, airconType);

  const travelMinutes = Math.max(0, Number(travelTime) || DEFAULT_TRAVEL_TIME);
  const trafficAllowance = Math.ceil(travelMinutes * TRAFFIC_ALLOWANCE_RATIO);
  const prepBuffer = PREP_BUFFER_MINUTES;
  const completionBuffer = COMPLETION_BUFFER_MINUTES;

  const totalWorkloadMinutes =
    totalMinutes + travelMinutes + trafficAllowance + prepBuffer + completionBuffer;

  const fitsInStandardAppointment = totalWorkloadMinutes <= MAX_WINDOW_DURATION;

  return {
    durationPerUnit,
    durationMinutes: totalMinutes,
    travelMinutes,
    trafficAllowance,
    prepBuffer,
    completionBuffer,
    totalWorkloadMinutes,
    reservationMinutes: totalWorkloadMinutes,
    fitsInStandardAppointment,
    quantity: qty,
  };
}

/**
 * Compute the full reservation duration for a service.
 * Reservation = (serviceDuration x quantity) + travel + traffic + prep + completion + operational buffer.
 * This is the single source of truth used by window generation.
 */
function computeReservationMinutes(params) {
  const { totalEstimatedMinutes, travelTime } = params;
  const travelMinutes = Math.max(0, Number(travelTime) || DEFAULT_TRAVEL_TIME);
  const trafficAllowance = Math.ceil(travelMinutes * TRAFFIC_ALLOWANCE_RATIO);
  const prepBuffer = PREP_BUFFER_MINUTES;
  const completionBuffer = COMPLETION_BUFFER_MINUTES;
  const operationalBuffer = getBufferMinutesSync();

  const reservationMinutes =
    Number(totalEstimatedMinutes || 0) +
    travelMinutes +
    trafficAllowance +
    prepBuffer +
    completionBuffer +
    operationalBuffer;

  return {
    reservationMinutes,
    serviceMinutes: Number(totalEstimatedMinutes || 0),
    travelMinutes,
    trafficAllowance,
    prepBuffer,
    completionBuffer,
    operationalBuffer,
  };
}

async function calculateTotalEstimatedDuration(serviceId, quantity, serviceModel, hp, airconType) {
  let durationPerUnit = 60;

  try {
    if (serviceModel === "CoreService" && mongoose.Types.ObjectId.isValid(serviceId)) {
      const cs = await CoreService.findById(serviceId).lean();
      if (cs) {
        const { findDurationForHpAndType } = require("./serviceHelpers");
        durationPerUnit = findDurationForHpAndType(cs, hp, airconType) || cs.durationMinutes || 60;
      }
    } else if (serviceModel === "RepairService" && mongoose.Types.ObjectId.isValid(serviceId)) {
      const rs = await RepairService.findById(serviceId).lean();
      if (rs) {
        durationPerUnit = rs.estimatedDurationMinutes || 90;
      }
    }
  } catch (e) {
    durationPerUnit = 60;
  }

  const qty = Math.max(1, Number(quantity) || 1);
  return {
    durationPerUnit,
    totalMinutes: durationPerUnit * qty,
    totalHours: (durationPerUnit * qty) / 60,
    quantity: qty,
  };
}

async function getCompanyCapacity(date) {
  const activeTechs = await Technician.countDocuments({ active: { $ne: false } });
  if (activeTechs === 0) return { total: 0, available: 0, reason: "No active technicians" };

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const onLeave = await LeaveRequest.countDocuments({
    status: "approved",
    startDate: { $lte: dayEnd },
    endDate: { $gte: dayStart },
  });

  const absent = await Technician.countDocuments({
    active: { $ne: false },
    availabilityStatus: "Unavailable",
  });

  const activeStatuses = [
    "pending", "payment_verified", "awaiting_assignment", "assigned",
    "pending_reassignment", "confirmed", "scheduled", "on-the-way",
    "arrived", "in-progress", "repair_requested", "inspection_scheduled",
    "inspection_in_progress", "repair_approved", "ready_for_repair",
    "repair_scheduled", "repair_in_progress",
  ];

  const existingBookings = await BookingService.find({
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: { $in: activeStatuses },
  }).select("_id").lean();

  const unavailable = onLeave + absent;
  const available = Math.max(0, activeTechs - unavailable);

  return {
    total: activeTechs,
    onLeave,
    absent,
    unavailable,
    available,
    existingBookingCount: existingBookings.length,
    hasCapacity: existingBookings.length < available,
  };
}

async function generateAvailableDates(params) {
  const {
    totalEstimatedMinutes,
    serviceId,
    quantity,
    serviceModel,
    minDate,
    maxDate,
    travelTime = 20,
  } = params;

  if (Number(quantity) >= LARGE_SCALE_MIN_UNITS) {
    return {
      isLargeProject: true,
      dates: [],
      message: "This request exceeds the capacity of a standard appointment and requires project scheduling.",
    };
  }

  const durationPerSlot = totalEstimatedMinutes + (travelTime || 20) + getBufferMinutesSync();
  let startDate = minDate ? new Date(minDate) : new Date();
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() + 1);

  const endDate = maxDate ? new Date(maxDate) : new Date(startDate);
  endDate.setDate(endDate.getDate() + 60);

  const nonWorkingDays = await NonWorkingDay.find({
    date: { $gte: startDate, $lte: endDate },
  }).lean();
  const nwdSet = new Set(nonWorkingDays.map((d) => toLocalDateKey(d.date)));

  const allTechs = await Technician.find({ active: { $ne: false } }).select("_id").lean();
  const techIds = allTechs.map((t) => t._id);
  const schedules = await TechnicianSchedule.find({
    technicianId: { $in: techIds },
  }).lean();

  const scheduleMap = {};
  for (const sched of schedules) {
    scheduleMap[String(sched.technicianId)] = sched;
  }

  const availableDates = [];

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = toLocalDateKey(d);
    if (nwdSet.has(dateStr)) continue;

    const dow = d.getDay();
    let anyTechWorking = false;

    for (const techId of techIds) {
      const sched = scheduleMap[String(techId)];
      if (!sched || !Array.isArray(sched.workingDays)) {
        anyTechWorking = true;
        break;
      }
      const dayConfig = sched.workingDays.filter((w) => w.dayOfWeek === dow);
      if (dayConfig.length > 0) {
        anyTechWorking = true;
        break;
      }
    }

    if (!anyTechWorking) continue;

    const { windows } = await generateTimeWindowsForDate(d, {
      totalEstimatedMinutes,
      travelTime,
    });

    if (windows.length > 0) {
      availableDates.push({
        date: dateStr,
        displayDate: d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" }),
        windows: windows,
      });
    }
  }

  return {
    isLargeProject: false,
    dates: availableDates,
    message: "",
  };
}

/**
 * Generate the available appointment windows for a given date.
 *
 * For each configured window the engine (per the scheduling model):
 *   1. Computes the finish time from the real reservation duration.
 *   2. Hides the window if the finish time falls beyond working hours.
 *   3. Computes remaining technician capacity for that day.
 *   4. Counts reservations that overlap the window and hides it when
 *      no technician remains free for the window's time span.
 */
async function generateTimeWindowsForDate(date, params) {
  const {
    totalEstimatedMinutes,
    travelTime = DEFAULT_TRAVEL_TIME,
    workEnd = WORK_END,
  } = params;

  const {
    reservationMinutes,
    serviceMinutes,
    travelMinutes,
    trafficAllowance,
    prepBuffer,
    completionBuffer,
    operationalBuffer,
  } = computeReservationMinutes({ totalEstimatedMinutes, travelTime });

  const availableWindows = [];
  const dayStr = toLocalDateKey(date);

  const capacity = await getCompanyCapacity(date);
  const remainingTechnicians = capacity.available || 0;
  if (remainingTechnicians <= 0) {
    return { windows: [], reservationMinutes };
  }

  const activeBookings = await getActiveBookingsForDate(dayStr);

  // Tie each booking to the discrete window its start time falls in, so a
  // booking in the 8AM slot does not consume capacity in 11AM / 1PM.
  const winOfMinute = (m) => {
    let best = null;
    for (const win of APPOINTMENT_WINDOWS) {
      if (m >= win.startMin && (best === null || win.startMin > best.startMin)) best = win;
    }
    return best;
  };
  // Track which windows each technician is still active in. A technician
  // active in an earlier window (e.g. an overrun 8AM job not yet marked
  // completed) cannot be re-dispatched in a later window.
  const techWindows = new Map();
  const bookingsByWindow = new Map();
  for (const b of activeBookings) {
    const bStart = bookingStartMinutes(b);
    if (bStart === null) continue;
    const win = winOfMinute(bStart);
    if (!win) continue;
    if (!bookingsByWindow.has(win.startMin)) bookingsByWindow.set(win.startMin, 0);
    bookingsByWindow.set(win.startMin, bookingsByWindow.get(win.startMin) + 1);
    if (b.technicianId) {
      const key = String(b.technicianId);
      if (!techWindows.has(key)) techWindows.set(key, new Set());
      techWindows.get(key).add(win.startMin);
    }
  }

  // Effective free technicians per window: a tech free in this window is
  // still blocked if active in any earlier window that day. techWindows is
  // keyed by real technician IDs — count idle techs (no bookings today)
  // plus booked techs whose windows all start after this one.
  function freeTechCount(winStart) {
    let freeBooked = 0;
    for (const [, wins] of techWindows.entries()) {
      const blockedEarlier = Array.from(wins).some((s) => s < winStart);
      if (!blockedEarlier && !wins.has(winStart)) freeBooked++;
    }
    const idleTechs = Math.max(0, remainingTechnicians - techWindows.size);
    return idleTechs + freeBooked;
  }

  for (const window of APPOINTMENT_WINDOWS) {
    const wStart = window.startMin;
    const wEnd = wStart + reservationMinutes;

    if (wEnd > workEnd) continue;

    const overlappingCount = bookingsByWindow.get(wStart) || 0;
    const availableTechs = Math.max(0, freeTechCount(wStart) - overlappingCount);
    if (availableTechs <= 0) continue;

    availableWindows.push({
      label: window.label,
      startMin: wStart,
      endMin: wEnd,
      displayStart: minutesTo12h(wStart),
      displayEnd: minutesTo12h(wEnd),
      remainingCapacity: availableTechs,
      details:
        `${serviceMinutes} min service · ${travelMinutes} min travel · ` +
        `${trafficAllowance} min traffic · ${prepBuffer + completionBuffer} min prep/completion · ` +
        `${operationalBuffer} min buffer`,
    });
  }

  return { windows: availableWindows, reservationMinutes };
}

const OVERLAP_ACTIVE_STATUSES = [
  "pending", "payment_verified", "awaiting_assignment", "assigned",
  "pending_reassignment", "confirmed", "scheduled", "on-the-way",
  "arrived", "in-progress", "repair_requested", "inspection_scheduled",
  "inspection_in_progress", "repair_approved", "ready_for_repair",
  "repair_scheduled", "repair_in_progress",
];

async function getActiveBookingsForDate(dateStr) {
  const dayStart = new Date(dateStr + "T00:00:00");
  const dayEnd = new Date(dateStr + "T23:59:59");

  return BookingService.find({
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: { $in: OVERLAP_ACTIVE_STATUSES },
  })
    .select("startTime endTime serviceDurationMinutes travelTime")
    .lean();
}

function countOverlappingBookings(bookings, startMin, endMin) {
  let count = 0;
  for (const b of bookings) {
    const bStart = bookingStartMinutes(b);
    if (bStart === null) continue;
    const bEnd = bookingEndMinutes(b, bStart);
    if (startMin < bEnd && endMin > bStart) count += 1;
  }
  return count;
}

function bookingStartMinutes(booking) {
  const raw = booking.startTime;
  if (raw == null) return null;
  const parsed = parseTimeValue(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function bookingEndMinutes(booking, startMin) {
  const end = parseTimeValue(booking.endTime);
  if (Number.isFinite(end) && end > startMin) return end;
  const dur =
    (Number(booking.serviceDurationMinutes) || 0) +
    (Number(booking.travelTime) || 0) +
    getBufferMinutesSync();
  return startMin + Math.max(dur, DEFAULT_SLOT_INTERVAL);
}

function minutesTo12h(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${String(h12).padStart(2, "0")}:${String(min).padStart(2, "0")} ${ampm}`;
}

const APPOINTMENT_WINDOWS_EXPORT = APPOINTMENT_WINDOWS;

/**
 * Aggregate technician capacity RESERVED by active commercial projects on a
 * given calendar date. This is the core of "projects reserve technicians;
 * standard bookings consume the remaining capacity" — the scheduling engine
 * subtracts this from the pool of available technicians before deciding
 * whether a date/window can accept a standard appointment.
 *
 * @param {Date} date
 * @returns {Promise<{reservedTechnicians:number, projects:Array}>}
 *   projects = minimal info for calendar rendering (id, name, start, end, techs)
 */
async function getProjectReservationsForDate(date) {
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);

  const projects = await Project.find({
    status: { $in: ["pending_project_scheduling", "accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: dayEnd }, plannedCompletionDate: { $gte: dayStart } },
      { preferredStartDate: { $lte: dayEnd } },
    ],
  }).lean();

  const dailyHours = await getDailyHours();
  let reservedTechnicians = 0;
  const bars = [];

  for (const p of projects) {
    const doc = p;
    // Derive reserved tech count: admin-assigned wins; else provisional 1.
    const assigned = Array.isArray(p.assignedTechnicians) ? p.assignedTechnicians.length : 0;
    doc.reservedTechnicians = p.reservedTechnicians || assigned || 1;
    const span = Project.computeActiveSpan(doc, { dailyHours });
    if (!span) continue;
    const s = new Date(span.start); s.setHours(0, 0, 0, 0);
    const e = new Date(span.end); e.setHours(0, 0, 0, 0);
    const d = new Date(dayStart);
    if (d < s || d > e) continue;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // non-working day
    const techs = Math.max(1, doc.reservedTechnicians);
    reservedTechnicians += techs;
    bars.push({
      _id: p._id,
      name: (p.service && p.service.name) || "Commercial Project",
      customerName: p.customer && p.customer.name ? p.customer.name : "",
      start: s,
      end: e,
      reservedTechnicians: techs,
      status: p.status,
      isLargeScale: !!p.isLargeScale,
      totalUnits: p.totalUnits || 0,
      estimatedTotalHours: p.estimatedTotalHours || 0,
    });
  }

  return { reservedTechnicians, projects: bars };
}

/** Configured company daily working hours (default 8). */
async function getDailyHours() {
  try {
    const setting = await SiteSetting.findOne({ key: "companyDailyHours" }).lean();
    if (setting && Number.isFinite(Number(setting.value)) && Number(setting.value) > 0) {
      return Number(setting.value);
    }
  } catch {}
  return 8;
}

/**
 * Return commercial-project bars that overlap the given month range, for
 * calendar rendering. Each bar carries its full [start, end] span plus a
 * per-date reserved-technician map so the UI can grey out the reserved days.
 *
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @returns {Promise<Array>} project bars
 */
async function getProjectReservationsForMonth(rangeStart, rangeEnd) {
  const dailyHours = await getDailyHours();
  const projects = await Project.find({
    status: { $in: ["pending_project_scheduling", "accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: rangeEnd }, plannedCompletionDate: { $gte: rangeStart } },
      { preferredStartDate: { $lte: rangeEnd } },
    ],
  }).lean();

  const bars = [];
  for (const p of projects) {
    const assigned = Array.isArray(p.assignedTechnicians) ? p.assignedTechnicians.length : 0;
    const doc = Object.assign({}, p, { reservedTechnicians: p.reservedTechnicians || assigned || 1 });
    const span = Project.computeActiveSpan(doc, { dailyHours });
    if (!span) continue;

    const s = new Date(span.start); s.setHours(0, 0, 0, 0);
    const e = new Date(span.end); e.setHours(0, 0, 0, 0);
    const rs = new Date(rangeStart); rs.setHours(0, 0, 0, 0);
    const re = new Date(rangeEnd); re.setHours(23, 59, 59, 999);
    if (e < rs || s > re) continue;

    // Build per-date reserved map for the visible range.
    const reservedByDate = {};
    for (let d = new Date(Math.max(s.getTime(), rs.getTime())); d <= Math.min(e.getTime(), re.getTime()); d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue;
      reservedByDate[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = Math.max(1, doc.reservedTechnicians);
    }

    bars.push({
      _id: p._id,
      name: (p.service && p.service.name) || "Commercial Project",
      customerName: p.customer && p.customer.name ? p.customer.name : "",
      start: s.toISOString(),
      end: e.toISOString(),
      reservedTechnicians: Math.max(1, doc.reservedTechnicians),
      status: p.status,
      isLargeScale: !!p.isLargeScale,
      totalUnits: p.totalUnits || 0,
      estimatedTotalHours: p.estimatedTotalHours || 0,
      preferredWorkingDays: Array.isArray(p.preferredWorkingDays) ? p.preferredWorkingDays : [],
      preferredWorkingHours: p.preferredWorkingHours || { start: "", end: "" },
      reservedByDate,
    });
  }
  return bars;
}

/**
 * Compute reserved-technician counts per date across the window in a SINGLE
 * pass (avoids 60 sequential DB queries inside available-dates). Returns a
 * Map<dateKey, number> of technicians reserved that day.
 *
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @returns {Promise<Map<string,number>>}
 */
async function getProjectReservedByDateMap(windowStart, windowEnd) {
  const dailyHours = await getDailyHours();
  const projects = await Project.find({
    status: { $in: ["pending_project_scheduling", "accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: windowEnd }, plannedCompletionDate: { $gte: windowStart } },
      { preferredStartDate: { $lte: windowEnd } },
    ],
  }).lean();

  const map = new Map();
  const rs = new Date(windowStart); rs.setHours(0, 0, 0, 0);
  const re = new Date(windowEnd); re.setHours(23, 59, 59, 999);

  for (const p of projects) {
    const assigned = Array.isArray(p.assignedTechnicians) ? p.assignedTechnicians.length : 0;
    const doc = Object.assign({}, p, { reservedTechnicians: p.reservedTechnicians || assigned || 1 });
    const span = Project.computeActiveSpan(doc, { dailyHours });
    if (!span) continue;
    const s = new Date(span.start); s.setHours(0, 0, 0, 0);
    const e = new Date(span.end); e.setHours(0, 0, 0, 0);
    if (e < rs || s > re) continue;
    let cursor = new Date(Math.max(s.getTime(), rs.getTime()));
    const end = new Date(Math.min(e.getTime(), re.getTime()));
    while (cursor <= end) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        map.set(key, (map.get(key) || 0) + Math.max(1, doc.reservedTechnicians));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return map;
}

/**
 * Validate that the entire date range has sufficient technician capacity
 * for a large-scale project.
 *
 * Checks every working day in [startDate, endDate]:
 *   - Active technicians (minus leave, absence)
 *   - Existing bookings consuming capacity that day
 *   - Existing project reservations reserving technicians that day
 *   - Compares available capacity against project's required technicians
 *
 * @param {Object} params
 * @param {Date|string} params.startDate
 * @param {Date|string} params.endDate
 * @param {number} params.requiredTechnicians - How many techs the project needs per day (default 1)
 * @param {number} [params.excludeProjectId] - Project ID to exclude (for reschedule)
 * @param {string} [params.serviceModel] - "CoreService" | "RepairService"
 * @returns {Promise<{valid:boolean, available:boolean, message:string, dailyBreakdown:Array, nextAvailableRange: {startDate:string, endDate:string}|null}>}
 */
async function validateProjectDateRange(params) {
  const {
    startDate,
    endDate,
    requiredTechnicians = 1,
    excludeProjectId = null,
    serviceModel = "CoreService",
  } = params;

  if (!startDate || !endDate) {
    return { valid: false, available: false, message: "Start date and end date are required.", dailyBreakdown: [], nextAvailableRange: null };
  }

  const sDate = new Date(startDate);
  const eDate = new Date(endDate);
  sDate.setHours(0, 0, 0, 0);
  eDate.setHours(23, 59, 59, 999);

  if (sDate > eDate) {
    return { valid: false, available: false, message: "Start date must be before end date.", dailyBreakdown: [], nextAvailableRange: null };
  }

  const dailyHours = await getDailyHours();
  const activeTechs = await Technician.find({ active: { $ne: false } }).select("_id").lean();
  const totalActiveTechs = activeTechs.length;
  if (totalActiveTechs === 0) {
    return { valid: false, available: false, message: "No active technicians available.", dailyBreakdown: [], nextAvailableRange: null };
  }

  // Fetch once for the entire range
  const nonWorkingDays = await NonWorkingDay.find({
    date: { $gte: sDate, $lte: eDate },
  }).lean();
  const nwdSet = new Set(nonWorkingDays.map((d) => toLocalDateKey(d.date)));

  const techIds = activeTechs.map((t) => t._id);
  const schedules = await TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean();
  const scheduleMap = {};
  for (const s of schedules) {
    scheduleMap[String(s.technicianId)] = s;
  }

  // Leaves in range
  const leaves = await LeaveRequest.find({
    technicianId: { $in: techIds },
    status: "approved",
    startDate: { $lte: eDate },
    endDate: { $gte: sDate },
  }).lean();
  const leaveMap = new Map();
  for (const l of leaves) {
    const tid = String(l.technicianId);
    if (!leaveMap.has(tid)) leaveMap.set(tid, []);
    leaveMap.get(tid).push({ start: new Date(l.startDate), end: new Date(l.endDate) });
  }

  // Existing project reservations (exclude self if rescheduling)
  const projectQuery = {
    status: { $in: ["pending_project_scheduling", "accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: eDate }, plannedCompletionDate: { $gte: sDate } },
      { preferredStartDate: { $lte: eDate } },
    ],
  };
  if (excludeProjectId) {
    projectQuery._id = { $ne: excludeProjectId };
  }
  const existingProjects = await Project.find(projectQuery).lean();
  const projectReservedMap = new Map();
  for (const p of existingProjects) {
    const assigned = Array.isArray(p.assignedTechnicians) ? p.assignedTechnicians.length : 0;
    const pTechs = p.reservedTechnicians || assigned || 1;
    const doc = Object.assign({}, p, { reservedTechnicians: pTechs });
    const span = Project.computeActiveSpan ? Project.computeActiveSpan(doc, { dailyHours }) : null;
    if (!span) continue;
    const ps = new Date(span.start); ps.setHours(0, 0, 0, 0);
    const pe = new Date(span.end); pe.setHours(0, 0, 0, 0);
    if (pe < sDate || ps > eDate) continue;
    let cursor = new Date(Math.max(ps.getTime(), sDate.getTime()));
    const end = new Date(Math.min(pe.getTime(), eDate.getTime()));
    while (cursor <= end) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
        projectReservedMap.set(key, (projectReservedMap.get(key) || 0) + Math.max(1, pTechs));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Active booking statuses that consume capacity
  const activeStatuses = [
    "pending", "payment_verified", "awaiting_assignment", "assigned",
    "pending_reassignment", "confirmed", "scheduled", "on-the-way",
    "arrived", "in-progress", "repair_requested", "inspection_scheduled",
    "inspection_in_progress", "repair_approved", "ready_for_repair",
    "repair_scheduled", "repair_in_progress",
  ];

  const allBookings = await BookingService.find({
    bookingDate: { $gte: sDate, $lte: eDate },
    status: { $in: activeStatuses },
  }).select("technicianId bookingDate startTime endTime serviceDurationMinutes travelTime").lean();

  // Build per-date per-tech booking intervals
  const bookingMap = new Map();
  for (const b of allBookings) {
    const bd = new Date(b.bookingDate);
    const dateKey = `${bd.getFullYear()}-${String(bd.getMonth() + 1).padStart(2, "0")}-${String(bd.getDate()).padStart(2, "0")}`;
    if (!bookingMap.has(dateKey)) bookingMap.set(dateKey, new Map());
    const techMap = bookingMap.get(dateKey);
    let techKey = b.technicianId ? String(b.technicianId) : "__unassigned__";
    if (!techMap.has(techKey)) techMap.set(techKey, []);
    const bStart = parseTimeValue(b.startTime);
    if (!Number.isFinite(bStart)) continue;
    const bDur = (Number(b.serviceDurationMinutes) || 60) + Math.max(0, Number(b.travelTime) || 0) + getBufferMinutesSync();
    const bEnd = Number.isFinite(parseTimeValue(b.endTime)) && parseTimeValue(b.endTime) > bStart ? parseTimeValue(b.endTime) : bStart + bDur;
    techMap.get(techKey).push({ start: bStart, end: bEnd });
  }

  // Technicians unavailable status
  const unavailableTechs = new Set(
    (await Technician.find({ active: { $ne: false }, availabilityStatus: "Unavailable" }).select("_id").lean())
      .map((t) => String(t._id))
  );

  // Iterate each day
  const dailyBreakdown = [];
  let hasInsufficientDay = false;
  let insufficientDay = null;
  const loopEnd = new Date(eDate);

  for (let d = new Date(sDate); d <= loopEnd; d.setDate(d.getDate() + 1)) {
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dow = d.getDay();

    if (nwdSet.has(dateKey)) {
      dailyBreakdown.push({ date: dateKey, isWorkingDay: false, availableCapacity: 0, requiredCapacity: 0, sufficient: true, reason: "Non-working day" });
      continue;
    }

    // Count working technicians this day
    let workingTechs = 0;
    let onLeaveCount = 0;
    let unavailableCount = 0;
    const workingTechIds = [];

    for (const tech of activeTechs) {
      const tid = String(tech._id);
      const sched = scheduleMap[tid];
      if (!sched || !Array.isArray(sched.workingDays)) {
        workingTechs++;
        workingTechIds.push(tid);
        continue;
      }
      const dayConfig = sched.workingDays.filter((w) => w.dayOfWeek === dow);
      if (dayConfig.length === 0) continue;
      const isNonWork = sched.nonWorkingWeekdays && sched.nonWorkingWeekdays.some((n) => n.dayOfWeek === dow);
      if (isNonWork) continue;
      const isRest = sched.restDates && sched.restDates.some((rd) => {
        return toLocalDateKey(rd.date) === dateKey;
      });
      if (isRest) continue;

      // Check leave
      const techLeaves = leaveMap.get(tid) || [];
      const isOnLeave = techLeaves.some((lr) => d >= lr.start && d <= lr.end);
      if (isOnLeave) {
        onLeaveCount++;
        continue;
      }

      if (unavailableTechs.has(tid)) {
        unavailableCount++;
        continue;
      }

      workingTechs++;
      workingTechIds.push(tid);
    }

    // Count bookings that consume this day's capacity
    const dayTechBookings = bookingMap.get(dateKey) || new Map();
    let bookingConsumedCount = 0;
    for (const [, intervals] of dayTechBookings) {
      let techHasBooking = false;
      for (const interval of intervals) {
        if (interval.end > interval.start) {
          techHasBooking = true;
          break;
        }
      }
      if (techHasBooking) bookingConsumedCount++;
    }

    // Count unassigned bookings separately
    const unassignedBookings = dayTechBookings.get("__unassigned__") || [];
    const unassignedCount = unassignedBookings.length > 0 ? 1 : 0;

    // Existing project reservations
    const projectReservedTechs = projectReservedMap.get(dateKey) || 0;

    // Available capacity = working techs - booked techs - unassigned - project reserved
    let availableCapacity = Math.max(0, workingTechs - bookingConsumedCount - unassignedCount - projectReservedTechs);

    const sufficient = availableCapacity >= requiredTechnicians;

    dailyBreakdown.push({
      date: dateKey,
      isWorkingDay: true,
      totalActiveTechs,
      workingTechs,
      onLeave: onLeaveCount,
      unavailable: unavailableCount,
      existingBookings: bookingConsumedCount,
      unassignedBookings: unassignedCount,
      projectReservedTechs,
      availableCapacity,
      requiredCapacity: requiredTechnicians,
      sufficient,
    });

    if (!sufficient) {
      hasInsufficientDay = true;
      if (!insufficientDay) insufficientDay = { date: dateKey, availableCapacity, requiredCapacity: requiredTechnicians };
    }
  }

  if (hasInsufficientDay) {
    // Find next available range: scan forward from end date to find consecutive days with enough capacity
    let nextAvailableStart = null;
    let nextAvailableEnd = null;
    const rangeLength = Math.ceil((eDate.getTime() - sDate.getTime()) / 86400000) + 1;
    const scanEnd = new Date(eDate);
    scanEnd.setDate(scanEnd.getDate() + 120); // scan up to 120 days ahead
    let consecutiveDays = 0;
    let candidateStart = null;

    for (let d = new Date(eDate); d <= scanEnd; d.setDate(d.getDate() + 1)) {
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dow = d.getDay();

      if (nwdSet.has(dateKey)) {
        if (candidateStart) {
          consecutiveDays++;
        }
        continue;
      }

      // Quick capacity estimate for suggestion
      let workingToday = 0;
      for (const tech of activeTechs) {
        const tid = String(tech._id);
        const sched = scheduleMap[tid];
        if (!sched || !Array.isArray(sched.workingDays)) { workingToday++; continue; }
        const dayConfig = sched.workingDays.filter((w) => w.dayOfWeek === dow);
        if (dayConfig.length === 0) continue;
        const isNonWork = sched.nonWorkingWeekdays && sched.nonWorkingWeekdays.some((n) => n.dayOfWeek === dow);
        if (isNonWork) continue;
        const isRest = sched.restDates && sched.restDates.some((rd) => {
          return toLocalDateKey(rd.date) === dateKey;
        });
        if (isRest) continue;
        const techLeaves = leaveMap.get(tid) || [];
        const isOnLeave = techLeaves.some((lr) => d >= lr.start && d <= lr.end);
        if (isOnLeave) continue;
        if (unavailableTechs.has(tid)) continue;
        workingToday++;
      }

      const projReserved = projectReservedMap.get(dateKey) || 0;
      const capacityToday = Math.max(0, workingToday - projReserved);

      if (capacityToday >= requiredTechnicians) {
        if (!candidateStart) candidateStart = new Date(d);
        consecutiveDays++;
        if (consecutiveDays >= rangeLength) {
          nextAvailableStart = new Date(candidateStart);
          nextAvailableEnd = new Date(d);
          break;
        }
      } else {
        candidateStart = null;
        consecutiveDays = 0;
      }
    }

    let nextAvailableRange = null;
    if (nextAvailableStart && nextAvailableEnd) {
      nextAvailableRange = {
        startDate: `${nextAvailableStart.getFullYear()}-${String(nextAvailableStart.getMonth() + 1).padStart(2, "0")}-${String(nextAvailableStart.getDate()).padStart(2, "0")}`,
        endDate: `${nextAvailableEnd.getFullYear()}-${String(nextAvailableEnd.getMonth() + 1).padStart(2, "0")}-${String(nextAvailableEnd.getDate()).padStart(2, "0")}`,
      };
    }

    return {
      valid: false,
      available: false,
      message: `The selected date range cannot be accommodated. On ${insufficientDay.date}, only ${insufficientDay.availableCapacity} technician(s) are available but ${insufficientDay.requiredCapacity} are required.${nextAvailableRange ? ` The next available date range starts on ${nextAvailableRange.startDate}.` : " No suitable alternative was found within 120 days."}`,
      dailyBreakdown,
      nextAvailableRange,
      insufficientDay,
    };
  }

  return {
    valid: true,
    available: true,
    message: "The selected date range has sufficient technician capacity.",
    dailyBreakdown,
    nextAvailableRange: null,
  };
}

/**
 * Per-day project capacity snapshot for a date range.
 *
 * Thin adapter over validateProjectDateRange with requiredTechnicians = 0:
 * the day loop runs identically (schedules, leaves, bookings, project
 * reservations, non-working days) but no per-day requirement is enforced and
 * the expensive "next available range" suggestion scan is skipped, so this is
 * safe to call for wide horizons (e.g. a 75-day calendar map).
 *
 * @param {Object} params
 * @param {Date|string} params.startDate
 * @param {Date|string} params.endDate
 * @returns {Promise<{dailyHours:number, days:Array<Object>}>}
 */
async function computeProjectDailyCapacity(params) {
  const { startDate, endDate } = params;
  const result = await validateProjectDateRange({
    startDate,
    endDate,
    requiredTechnicians: 0, // pure availability snapshot — nothing is "insufficient"
  });
  const dailyHours = await getDailyHours();
  const rows = Array.isArray(result.dailyBreakdown) ? result.dailyBreakdown : [];
  const days = rows.map((row) => {
    const isWorkingDay = row.isWorkingDay !== false;
    const totalTechs = row.totalActiveTechs ?? 0;
    const avail = isWorkingDay ? Math.max(0, row.availableCapacity ?? 0) : 0;
    return {
      date: row.date,
      isWorkingDay,
      reason: row.reason || null,
      totalTechnicians: totalTechs,
      workingTechnicians: isWorkingDay ? (row.workingTechs ?? 0) : 0,
      bookedTechnicians: isWorkingDay ? (row.existingBookings ?? 0) : 0,
      unassignedBookings: isWorkingDay ? (row.unassignedBookings ?? 0) : 0,
      projectReserved: isWorkingDay ? (row.projectReservedTechs ?? 0) : 0,
      availableTechnicians: avail,
      // One technician contributes `dailyHours` work-hours per day.
      capacityHours: round1(avail * dailyHours),
      status: !isWorkingDay ? "nonworking"
        : avail <= 0 ? "none"
        : avail < totalTechs ? "partial"
        : "full",
    };
  });
  return { dailyHours, days };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Preferred-window capacity analysis for large-scale projects.
 *
 * The customer-selected [startDate, endDate] range is a PREFERRED WINDOW, not
 * a continuous schedule: unavailable dates inside it are simply skipped, and
 * the project may finish before the window's end. Feasibility is judged by
 * comparing required labor hours against the SUM of available technician
 * capacity across all workable dates in the window.
 *
 * @param {Object} params
 * @param {string} params.startDate - YYYY-MM-DD preferred start
 * @param {string} params.endDate - YYYY-MM-DD latest acceptable completion
 * @param {number} [params.requiredHours] - Total estimated labor hours
 * @param {number} [params.totalUnits] - Units of work (for per-day unit preview)
 * @returns {Promise<Object>} per-day availability + verdict + draft schedule
 */
async function getProjectWindowAvailability(params) {
  const {
    startDate,
    endDate,
    requiredHours = null,
    totalUnits = null,
  } = params;

  if (!startDate || !endDate) {
    return { error: "Start date and end date are required." };
  }

  const sDate = new Date(startDate + "T00:00:00");
  const eDate = new Date(endDate + "T00:00:00");
  if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) {
    return { error: "Invalid start or end date." };
  }
  sDate.setHours(0, 0, 0, 0);
  eDate.setHours(0, 0, 0, 0);
  if (eDate < sDate) {
    return { error: "End date must be on or after the start date." };
  }

  // Snapshot a wide horizon once so the earliest-completion scan never needs
  // extra queries.
  const scanEnd = new Date(eDate);
  scanEnd.setDate(scanEnd.getDate() + 180);
  const snap = await computeProjectDailyCapacity({ startDate: sDate, endDate: scanEnd });
  const dailyHours = snap.dailyHours || 8;

  const startKey = toLocalDateKey(sDate);
  const endKey = toLocalDateKey(eDate);
  const allDays = snap.days || [];
  const windowDays = allDays.filter((d) => d.date >= startKey && d.date <= endKey);

  const totalTechs = allDays.reduce((m, d) => Math.max(m, d.totalTechnicians || 0), 0);
  const teamDailyCapacity = round1(Math.max(1, totalTechs) * dailyHours);

  const totals = {
    calendarDays: windowDays.length,
    workableDays: 0,
    fullDays: 0,
    partialDays: 0,
    noCapacityDays: 0,
    nonWorkingDays: 0,
    totalAvailableHours: 0,
    teamDailyCapacity,
  };
  for (const d of windowDays) {
    if (!d.isWorkingDay) { totals.nonWorkingDays++; continue; }
    if (d.status === "full") totals.fullDays++;
    else if (d.status === "partial") totals.partialDays++;
    else totals.noCapacityDays++;
    if (d.capacityHours > 0) {
      totals.workableDays++;
      totals.totalAvailableHours += d.capacityHours;
    }
  }
  totals.totalAvailableHours = round1(totals.totalAvailableHours);

  const response = {
    totalActiveTechnicians: totalTechs,
    dailyHours,
    window: { startDate: startKey, endDate: endKey },
    days: windowDays,
    totals,
  };

  const req = Number(requiredHours);
  if (!Number.isFinite(req) || req <= 0) {
    return response; // availability-map mode (calendar rendering)
  }

  // ── Capacity verdict ────────────────────────────────────────────────────
  const required = round1(req);
  const sufficient = totals.totalAvailableHours + 1e-9 >= required;
  response.requiredHours = required;
  response.sufficient = sufficient;
  response.minimumRequiredDays = Math.max(1, Math.ceil(required / teamDailyCapacity));

  // Greedy allocation across the preferred window — skips days without
  // capacity; the project finishes as soon as all required hours fit.
  const unitsTotal = Number(totalUnits);
  const hasUnits = Number.isFinite(unitsTotal) && unitsTotal > 0;
  const hoursPerUnit = hasUnits ? required / unitsTotal : 0;
  let remainingHours = required;
  let remainingUnits = hasUnits ? unitsTotal : 0;
  let completionDate = null;
  const draftSchedule = [];

  for (const d of windowDays) {
    if (!d.isWorkingDay) {
      draftSchedule.push({ date: d.date, status: "skipped", reason: d.reason || "Non-working day" });
      continue;
    }
    if (d.capacityHours <= 0) {
      draftSchedule.push({ date: d.date, status: "skipped", reason: "No project capacity available" });
      continue;
    }
    const take = Math.min(d.capacityHours, remainingHours);
    const entry = {
      date: d.date,
      status: "work",
      hours: round1(take),
      technicians: d.availableTechnicians,
    };
    if (hasUnits && hoursPerUnit > 0) {
      // Ceil so the taken hours are always covered by allocated units; the
      // last work day absorbs any rounding remainder.
      const units = Math.min(remainingUnits, Math.ceil(take / hoursPerUnit - 1e-9));
      entry.units = units;
      remainingUnits -= units;
    }
    draftSchedule.push(entry);
    remainingHours = round1(remainingHours - take);
    completionDate = d.date;
    if (remainingHours <= 1e-9) break;
  }

  response.draftSchedule = draftSchedule;

  if (remainingHours <= 1e-9) {
    // Fits inside the window — may finish earlier than the preferred end.
    response.estimatedCompletionDate = completionDate;
  } else {
    // Window too short — find earliest realistic completion scanning forward
    // from the preferred start using the already-loaded horizon data.
    let acc = 0;
    let earliest = null;
    for (const d of allDays) {
      acc += d.capacityHours || 0;
      if (acc + 1e-9 >= required) { earliest = d.date; break; }
    }
    response.earliestCompletionDate = earliest; // null → not feasible within 180 days
    response.shortfallHours = round1(remainingHours);
  }

  return response;
}

/**
 * Reserve technician capacity for a pending project booking to prevent
 * double-booking while the request is awaiting admin scheduling.
 *
 * Creates a temporary reservation document in the Project collection with
 * a "pending_reservation" status, or updates the existing project.
 *
 * @param {Object} params
 * @param {string} params.bookingId - The BookingService ID
 * @param {Date|string} params.startDate
 * @param {Date|string} params.endDate
 * @param {number} params.reservedTechnicians - Number of techs to reserve (default 1)
 * @returns {Promise<Object>}
 */
async function reserveProjectCapacity(params) {
  const { bookingId, startDate, endDate, reservedTechnicians = 1 } = params;

  if (!bookingId || !startDate || !endDate) {
    throw new Error("bookingId, startDate, and endDate are required to reserve capacity.");
  }

  // Try to find existing project for this booking
  let project = await Project.findOne({ bookingId }).lean();

  if (project) {
    // Update existing project with capacity reservation
    await Project.updateOne(
      { _id: project._id },
      {
        $set: {
          reservedTechnicians: Math.max(reservedTechnicians, project.reservedTechnicians || 1),
          plannedStartDate: new Date(startDate),
          plannedCompletionDate: new Date(endDate),
        },
      }
    );
  } else {
    // Create a temporary reservation document in Project collection.
    // This prevents double-booking: other booking flows will see this project
    // when they query getProjectReservedByDateMap or getProjectReservationsForDate.
    const Booking = require("../models/BookingService");
    const booking = await Booking.findById(bookingId).lean();
    if (!booking) throw new Error("Booking not found for capacity reservation.");

    const User = require("../models/User");
    const user = await User.findById(booking.customerId).lean();

    const tempProject = {
      bookingId,
      customerId: booking.customerId,
      customer: {
        _id: booking.customerId,
        name: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Customer" : "Customer",
        email: user?.email || "",
      },
      service: {
        name: booking.service?.name || booking.serviceName || "Service",
      },
      status: "pending_project_scheduling",
      reservedTechnicians,
      plannedStartDate: new Date(startDate),
      plannedCompletionDate: new Date(endDate),
      preferredStartDate: new Date(startDate),
      totalUnits: booking.quantity || 1,
      estimatedTotalHours: booking.projectScheduling?.estimatedTotalHours || 0,
      isLargeScale: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await Project.create(tempProject);
  }

  return { reserved: true, reservedTechnicians };
}

module.exports = {
  LARGE_SCALE_MIN_UNITS,
  MAX_BOOKING_UNITS,
  BookingType,
  APPOINTMENT_WINDOWS: APPOINTMENT_WINDOWS_EXPORT,
  classifyBooking,
  isLargeProject,
  calculateWorkload,
  computeReservationMinutes,
  calculateTotalEstimatedDuration,
  getCompanyCapacity,
  generateAvailableDates,
  generateTimeWindowsForDate,
  getProjectThresholdHours,
  getProjectThresholdHoursSync,
  invalidateProjectThresholdCache,
  getProjectReservationsForDate,
  getProjectReservationsForMonth,
  getProjectReservedByDateMap,
  validateProjectDateRange,
  computeProjectDailyCapacity,
  getProjectWindowAvailability,
  reserveProjectCapacity,
};
