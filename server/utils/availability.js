/**
 * Centralized Technician Availability Resolution
 *
 * Enterprise-level availability status computation that enforces
 * a single source of truth for technician availability across
 * the entire system.
 *
 * STATUS RULES:
 * ──────────────────────────────────────────────────────────────
 * Offline      – Not checked in, checked out, on leave/sick leave
 * Available    – Checked in (Present/Late), completed assignment, returned from Unavailable
 * Assigned     – Admin/system assigned a booking
 * On The Way   – Technician started travel to customer
 * In Progress  – Technician is performing the service
 * Unavailable  – Manual only (break, training, meeting, etc.)
 * ──────────────────────────────────────────────────────────────
 */

const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");
const LeaveRequest = require("../models/LeaveRequest");
const { attendanceDay } = require("./attendanceTime");
const { readFilter, chooseRecord, sessionState } = require("./staffAttendanceSessions");

/**
 * Statuses that indicate the technician is actively engaged
 * in a service and should NOT be overridden by attendance logic.
 */
const ACTIVE_ASSIGNMENT_STATUSES = ["Assigned", "On The Way", "In Progress"];

/**
 * Statuses that mean the technician is at work and available for assignments.
 */
const AT_WORK_STATUSES = ["Present", "Late"];

/**
 * Resolve the effective availability status for a single technician.
 *
 * @param {Object} technician     – Mongoose technician document (or lean object)
 * @param {Object} [attendance]   – Today's attendance record (optional, fetched if not provided)
 * @param {Object} [leave]        – Active leave request (optional, fetched if not provided)
 * @param {Object} [opts]         – Options
 * @param {Date}   [opts.today]   – Override "today" (for testing)
 * @param {boolean}[opts.syncDb]  – If true, persist the computed status back to the DB (default: false)
 * @returns {Promise<string>}     – The computed availability status string
 */
async function resolveAvailabilityStatus(technician, attendance, leave, opts = {}) {
  const reference = opts.today || new Date();
  const today = attendanceDay(reference).start;
  const techId = technician._id;
  if (!attendance && !opts.attendanceLoaded) {
    const records = await TechnicianAttendance.find(readFilter({ technicianId: techId }, attendanceDay(reference))).lean();
    attendance = chooseRecord(records, reference);
  }
  const session = sessionState(attendance, reference);
  // An overnight shift keeps its original leave/attendance date. Old forgotten
  // shifts need review and must not make a technician available indefinitely.
  if (session.needsAdminReview) return persistStatus(technician, "Offline", opts);
  const leaveDate = session.isOvernight ? session.workDay.start : today;
  if (!leave && !opts.leaveLoaded) {
    leave = await LeaveRequest.findOne({ technicianId: techId, status: "approved",
      startDate: { $lte: leaveDate }, endDate: { $gte: leaveDate },
    }).lean();
  }
  if (leave) return persistStatus(technician, "Offline", opts);

  const isCheckedIn = attendance && !!attendance.checkInTime && AT_WORK_STATUSES.includes(attendance.status);
  const isCheckedOut = attendance && attendance.checkOutTime;

  // ── 3. Active assignment overrides attendance logic ─────────────────────
  // If the tech has an active assignment (Assigned/On The Way/In Progress),
  // preserve that status regardless of attendance.
  if (ACTIVE_ASSIGNMENT_STATUSES.includes(technician.availabilityStatus)) {
    // But only if they're actually checked in — otherwise force Offline
    if (isCheckedIn && !isCheckedOut) {
      return technician.availabilityStatus;
    }
    // Active assignment status but not checked in / checked out → force Offline
    return persistStatus(technician, "Offline", opts);
  }

  // ── 4. Manual Unavailable status ────────────────────────────────────────
  // If the technician manually set Unavailable and is checked in, respect it.
  if (technician.availabilityStatus === "Unavailable" && isCheckedIn && !isCheckedOut) {
    return "Unavailable";
  }

  // ── 5. Compute availability from attendance state ───────────────────────
  if (!attendance || (!isCheckedIn)) {
    // Not checked in today → Offline
    return persistStatus(technician, "Offline", opts);
  }

  if (isCheckedOut) {
    // Checked out for the day → Offline
    return persistStatus(technician, "Offline", opts);
  }

  // Checked in (Present or Late) and not checked out → Available
  return persistStatus(technician, "Available", opts);
}

/**
 * Resolve availability for multiple technicians in bulk.
 * Optimized to batch DB queries instead of N+1.
 *
 * @param {Object[]} technicians       – Array of technician documents
 * @param {Object}   [opts]
 * @param {Date}     [opts.today]      – Override "today"
 * @param {boolean}  [opts.syncDb]     – Persist computed statuses to DB
 * @returns {Promise<Map<string, string>>} Map of technicianId → computed status
 */
async function resolveAvailabilityBulk(technicians, opts = {}) {
  const reference = opts.today || new Date(), day = attendanceDay(reference);
  const techIds = technicians.map(t => t._id);
  if (!techIds.length) return new Map();
  const [records, leaves] = await Promise.all([
    TechnicianAttendance.find(readFilter({ technicianId: { $in: techIds } }, day)).lean(),
    LeaveRequest.find({ technicianId: { $in: techIds }, status: "approved",
      startDate: { $lte: day.start }, endDate: { $gte: new Date(day.start.getTime() - 86400000) },
    }).lean(),
  ]);
  const attendanceMap = new Map();
  for (const record of records) {
    const key = String(record.technicianId);
    if (!attendanceMap.has(key)) attendanceMap.set(key, []);
    attendanceMap.get(key).push(record);
  }
  const results = new Map();
  for (const tech of technicians) {
    const key = String(tech._id), attendance = chooseRecord(attendanceMap.get(key) || [], reference);
    const session = sessionState(attendance, reference), date = session.isOvernight ? session.workDay.start : day.start;
    const leave = leaves.find(row => String(row.technicianId) === key && row.startDate <= date && row.endDate >= date);
    results.set(key, await resolveAvailabilityStatus(tech, attendance, leave, {
      today: reference, syncDb: opts.syncDb, attendanceLoaded: true, leaveLoaded: true,
    }));
  }
  return results;
}

/**
 * Compute the effective attendance status string for display.
 * (Separate from availability — this is about check-in state.)
 */
function computeAttendanceStatus(attendanceRecord, activeLeave) {
  if (activeLeave) {
    const reason = (activeLeave.reason || "").toLowerCase();
    return reason.includes("sick") ? "Sick Leave" : "On Leave";
  }

  if (!attendanceRecord) return "Not Checked In";

  if (AT_WORK_STATUSES.includes(attendanceRecord.status)) {
    return attendanceRecord.checkOutTime ? "Checked Out" : attendanceRecord.status;
  }

  return "Not Checked In";
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function persistStatus(technician, status, opts) {
  if (opts.syncDb && technician.availabilityStatus !== status) {
    try {
      await Technician.findByIdAndUpdate(technician._id, {
        $set: { availabilityStatus: status },
      });
      technician.availabilityStatus = status;
    } catch (e) {
      // Non-fatal: log but don't break the request
      console.warn(`[availability] Failed to sync status for tech ${technician._id}:`, e.message);
    }
  }
  return status;
}

module.exports = {
  resolveAvailabilityStatus,
  resolveAvailabilityBulk,
  computeAttendanceStatus,
  ACTIVE_ASSIGNMENT_STATUSES,
  AT_WORK_STATUSES,
};
