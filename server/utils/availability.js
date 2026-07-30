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
  const today = opts.today || startOfToday();
  const techId = technician._id;

  // ── 1. Check for approved leave covering today ──────────────────────────
  if (!leave) {
    leave = await LeaveRequest.findOne({
      technicianId: techId,
      status: "approved",
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).lean();
  }

  if (leave) {
    return persistStatus(technician, "Offline", opts);
  }

  // ── 2. Check today's attendance record ──────────────────────────────────
  if (!attendance) {
    attendance = await TechnicianAttendance.findOne({
      technicianId: techId,
      date: today,
    }).lean();
  }

  const isCheckedIn = attendance && AT_WORK_STATUSES.includes(attendance.status);
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
  const today = opts.today || startOfToday();
  const techIds = technicians.map(t => t._id);

  if (!techIds.length) return new Map();

  // ── Batch fetch today's attendance records ──────────────────────────────
  const attendanceRecords = await TechnicianAttendance.find({
    technicianId: { $in: techIds },
    date: today,
  }).lean();

  const attendanceMap = new Map(
    attendanceRecords.map(r => [r.technicianId.toString(), r])
  );

  // ── Batch fetch active leave requests ───────────────────────────────────
  const leaveRecords = await LeaveRequest.find({
    technicianId: { $in: techIds },
    status: "approved",
    startDate: { $lte: today },
    endDate: { $gte: today },
  }).lean();

  const leaveMap = new Map(
    leaveRecords.map(l => [l.technicianId.toString(), l])
  );

  // ── Resolve each technician ─────────────────────────────────────────────
  const results = new Map();

  for (const tech of technicians) {
    const idStr = tech._id.toString();
    const attendance = attendanceMap.get(idStr) || null;
    const leave = leaveMap.get(idStr) || null;

    const status = await resolveAvailabilityStatus(tech, attendance, leave, {
      today,
      syncDb: opts.syncDb,
    });

    results.set(idStr, status);
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

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

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
