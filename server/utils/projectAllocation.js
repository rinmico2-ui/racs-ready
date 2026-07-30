/**
 * Project Allocation — Daily Resource Calendar
 *
 * Builds a project's schedule AROUND each technician's existing
 * commitments instead of locking a fixed team to the whole project.
 *
 * For every project WORKING day (Mon–Fri, skipping weekends + non-working
 * days) we compute:
 *   - totalTechs:   active technicians who work that weekday
 *   - otherProjectReserved: techs already reserved by ANOTHER project that day
 *   - onLeave:     techs on approved leave that day
 *   - remaining:    totalTechs - otherProjectReserved - onLeave
 *   - per tech:  'free' | 'booking' | 'leave' | 'other-project'
 *
 * Standard bookings always win (highest priority) — we NEVER auto-cancel
 * or move an existing booking; conflicts surface as suggestions instead.
 */

const mongoose = require("mongoose");
const Project = require("../models/Project");
const Technician = require("../models/Technician");
const BookingService = require("../models/BookingService");
const LeaveRequest = require("../models/LeaveRequest");
const NonWorkingDay = require("../models/NonWorkingDay");

const BOOKING_ACTIVE = [
  "pending", "payment_verified", "awaiting_assignment", "assigned",
  "pending_reassignment", "confirmed", "scheduled", "on-the-way",
  "arrived", "in-progress", "repair_scheduled", "repair_in_progress",
  "inspection_scheduled", "inspection_in_progress", "ready_for_repair",
];

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

/**
 * Build the daily allocation calendar for a project.
 * @param {String|ObjectId} projectId
 * @param {Object} [opts]
 * @param {Array} [opts.candidateTechIds] - technicians to evaluate (defaults to project.assignedTechnicians + all active)
 * @returns {Promise<{projectSpan, workingDays, days: Array, technicians: Array, conflicts: Array}>}
 */
async function buildAllocationCalendar(projectId, opts = {}) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error("Project not found");

  const dailyHours = await getDailyHours();
  const span = Project.computeActiveSpan(
    Object.assign({}, project, { reservedTechnicians: project.reservedTechnicians || (project.assignedTechnicians || []).length || 1 }),
    { dailyHours }
  );
  if (!span) {
    return { projectSpan: null, workingDays: 0, days: [], technicians: [], conflicts: [] };
  }

  const spanStart = startOfDay(span.start);
  const spanEnd = startOfDay(span.end);

  // Non-working company days (global holidays/etc.)
  const nwds = await NonWorkingDay.find({ service: null }).lean();
  const nwdSet = new Set(nwds.map((d) => dateKey(new Date(d.date))));

  // Candidate technicians for the matrix.
  let candidateIds = opts.candidateTechIds;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    candidateIds = (project.assignedTechnicians || []).map((t) => t._id);
  }
  // Default to all active techs so the calendar is useful even before assignment.
  if (candidateIds.length === 0) {
    const all = await Technician.find({ active: { $ne: false } }).select("_id").lean();
    candidateIds = all.map((t) => t._id);
  }

  const techs = await Technician.find({ _id: { $in: candidateIds }, active: { $ne: false } })
    .select("_id name email").lean();
  const techIds = techs.map((t) => t._id);

  // Working-weekday map per technician (for totalTechs each day).
  const schedules = await require("../models/TechnicianSchedule").find({
    technicianId: { $in: techIds },
  }).lean();
  const schedMap = {};
  schedules.forEach((s) => { schedMap[String(s.technicianId)] = s; });
  const DEFAULT_WORKING = [
    { dayOfWeek: 1 }, { dayOfWeek: 3 }, { dayOfWeek: 4 }, { dayOfWeek: 5 },
  ];

  // Other ACTIVE projects reserving technicians (source of "other-project" conflict).
  const otherProjects = await Project.find({
    _id: { $ne: project._id },
    status: { $in: ["accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: spanEnd }, plannedCompletionDate: { $gte: spanStart } },
      { preferredStartDate: { $lte: spanEnd }, preferredCompletionDeadline: { $gte: spanStart } },
    ],
  }).lean();

  // Leaves overlapping the span.
  const leaves = await LeaveRequest.find({
    technicianId: { $in: techIds },
    status: "approved",
    startDate: { $lte: spanEnd },
    endDate: { $gte: spanStart },
  }).lean();

  // Fixed standard bookings for candidate techs across the span.
  const bookings = await BookingService.find({
    technicianId: { $in: techIds },
    bookingDate: { $gte: spanStart, $lte: spanEnd },
    status: { $in: BOOKING_ACTIVE },
  }).select("technicianId bookingDate startTime").lean();

  // Index helpers by dateKey.
  const leaveByDate = {}; // dateKey -> Set(techId)
  for (const lv of leaves) {
    let cur = startOfDay(lv.startDate);
    const e = startOfDay(lv.endDate);
    while (cur <= e) {
      const k = dateKey(cur);
      (leaveByDate[k] = leaveByDate[k] || new Set()).add(String(lv.technicianId));
      cur.setDate(cur.getDate() + 1);
    }
  }
  const bookingByDate = {}; // dateKey -> Set(techId)
  for (const b of bookings) {
    const k = dateKey(new Date(b.bookingDate));
    (bookingByDate[k] = bookingByDate[k] || new Set()).add(String(b.technicianId));
  }
  // other-project reserved techs per dateKey (only those in our candidate set matter for the matrix)
  const otherProjByDate = {}; // dateKey -> Set(techId)
  for (const p of otherProjects) {
    const assigned = (p.assignedTechnicians || []).map((t) => String(t._id));
    const sp = Project.computeActiveSpan(
      Object.assign({}, p, { reservedTechnicians: p.reservedTechnicians || assigned.length || 1 }),
      { dailyHours }
    );
    if (!sp) continue;
    let cur = startOfDay(Math.max(startOfDay(sp.start).getTime(), spanStart.getTime()));
    const e = startOfDay(Math.min(startOfDay(sp.end).getTime(), spanEnd.getTime()));
    while (cur <= e) {
      const dow = cur.getDay();
      if (dow === 0 || dow === 6) continue;
      const k = dateKey(cur);
      (otherProjByDate[k] = otherProjByDate[k] || new Set()).add(...assigned);
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Walk the span, building a row per working weekday.
  const days = [];
  const conflicts = [];
  const requiredPerDay = Math.max(1, project.reservedTechnicians || (project.assignedTechnicians || []).length || 1);

  let cursor = new Date(spanStart);
  while (cursor <= spanEnd) {
    const dow = cursor.getDay();
    const k = dateKey(cursor);
    const isWeekend = dow === 0 || dow === 6;
    const isNwd = nwdSet.has(k);
    if (!isWeekend && !isNwd) {
      // total techs who work this weekday
      let total = 0;
      const workingTechIds = [];
      for (const t of techs) {
        const sc = schedMap[String(t._id)];
        const wd = sc && Array.isArray(sc.workingDays) ? sc.workingDays : DEFAULT_WORKING;
        if (wd.some((w) => w.dayOfWeek === dow)) { total++; workingTechIds.push(String(t._id)); }
      }
      const otherReserved = new Set([...(otherProjByDate[k] || [])].filter((id) => workingTechIds.includes(id)));
      const onLev = new Set([...(leaveByDate[k] || [])].filter((id) => workingTechIds.includes(id)));
      const remaining = Math.max(0, total - otherReserved.size - onLev.size);

      const matrix = techs.map((t) => {
        const id = String(t._id);
        let status = "free";
        let detail = "";
        if (onLev.has(id)) { status = "leave"; detail = "Approved leave"; }
        else if (otherReserved.has(id)) { status = "other-project"; detail = "Reserved by another project"; }
        else if (bookingByDate[k] && bookingByDate[k].has(id)) { status = "booking"; detail = "Fixed booking"; }
        return { _id: id, name: t.name || t.email || "Unknown", status, detail };
      });

      days.push({
        date: k,
        display: cursor.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" }),
        totalTechs: total,
        reservedByOthers: otherReserved.size,
        onLeave: onLev.size,
        remaining,
        required: requiredPerDay,
        matrix,
      });

      // Conflict: not enough free techs for the required daily reservation.
      if (remaining < requiredPerDay) {
        const missing = requiredPerDay - remaining;
        conflicts.push({
          date: k,
          required: requiredPerDay,
          available: remaining,
          missing,
          suggestions: buildSuggestions({ project, date: k, missing, onLev: [...onLev], otherReserved: [...otherReserved], bookingByDate: bookingByDate[k] ? [...bookingByDate[k]] : [] }),
        });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    projectSpan: { start: span.start, end: span.end, locked: !!span.locked },
    workingDays: days.length,
    requiredPerDay,
    days,
    technicians: techs.map((t) => ({ _id: String(t._id), name: t.name || t.email || "Unknown" })),
    conflicts,
  };
}

/**
 * Rule-based conflict suggestions (NO auto-mutation of existing bookings).
 */
function buildSuggestions({ project, date, missing, onLev, otherReserved, bookingByDate }) {
  const out = [];
  out.push({ action: "add_technician", label: `Assign ${missing} more technician(s) for ${date}` });
  out.push({ action: "extend_completion", label: "Extend project completion date to free up daily capacity" });
  out.push({ action: "move_start", label: "Move project start to a date with more free technicians" });
  if (bookingByDate && bookingByDate.length) {
    out.push({ action: "reschedule_booking", label: `Reschedule the conflicting standard booking(s) on ${date} (manual)` });
  }
  return out;
}

// Reuse the engine's cached daily-hours lookup if available.
async function getDailyHours() {
  try {
    const eng = require("../utils/enterpriseSchedulingEngine");
    if (typeof eng.getDailyHours === "function") return eng.getDailyHours();
  } catch {}
  return 8;
}

/**
 * Return each assigned technician's busy dates across the project's customer
 * window, so the admin schedule modal can flag double-booking BEFORE saving.
 *
 * A technician is "busy" on a date if they have:
 *   - a fixed standard booking (BOOKING_ACTIVE),
 *   - approved leave, or
 *   - a reservation on ANOTHER active project that day.
 *
 * @returns {Promise<Object>} { windowStart, windowEnd, conflicts: { techId: { dateKey: reason } } }
 */
async function getTechnicianScheduleConflicts(projectId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error("Project not found");

  const winStart = startOfDay(project.preferredStartDate || project.plannedStartDate || project.plannedStartDate);
  const winEnd = startOfDay(project.preferredCompletionDeadline || project.plannedCompletionDate || project.plannedCompletionDate);
  if (!winStart || !winEnd) {
    return { windowStart: null, windowEnd: null, conflicts: {} };
  }

  const techIds = (project.assignedTechnicians || []).map((t) => (t._id || t));
  if (techIds.length === 0) return { windowStart: dateKey(winStart), windowEnd: dateKey(winEnd), conflicts: {} };

  // Fixed standard bookings for the team across the window.
  const bookings = await BookingService.find({
    technicianId: { $in: techIds },
    bookingDate: { $gte: winStart, $lte: winEnd },
    status: { $in: BOOKING_ACTIVE },
  }).select("technicianId bookingDate").lean();

  // Approved leaves.
  const leaves = await LeaveRequest.find({
    technicianId: { $in: techIds },
    status: "approved",
    startDate: { $lte: winEnd },
    endDate: { $gte: winStart },
  }).lean();

  // Other active projects reserving these techs across the window.
  const otherProjects = await Project.find({
    _id: { $ne: project._id },
    status: { $in: ["accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: winEnd }, plannedCompletionDate: { $gte: winStart } },
      { preferredStartDate: { $lte: winEnd }, preferredCompletionDeadline: { $gte: winStart } },
    ],
  }).lean();

  const conflicts = {};
  const addConflict = (techId, k, reason) => {
    const s = String(techId);
    conflicts[s] = conflicts[s] || {};
    conflicts[s][k] = conflicts[s][k] ? conflicts[s][k] + "; " + reason : reason;
  };

  for (const b of bookings) {
    addConflict(b.technicianId, dateKey(new Date(b.bookingDate)), "Standard booking");
  }
  for (const lv of leaves) {
    let cur = startOfDay(lv.startDate);
    const e = startOfDay(lv.endDate);
    while (cur <= e) {
      addConflict(lv.technicianId, dateKey(cur), "Approved leave");
      cur.setDate(cur.getDate() + 1);
    }
  }
  for (const p of otherProjects) {
    const assigned = (p.assignedTechnicians || []).map((t) => String(t._id));
    const overlapStart = startOfDay(Math.max(startOfDay(p.preferredStartDate || p.plannedStartDate || winStart).getTime(), winStart.getTime()));
    const overlapEnd = startOfDay(Math.min(startOfDay(p.preferredCompletionDeadline || p.plannedCompletionDate || winEnd).getTime(), winEnd.getTime()));
    let cur = new Date(overlapStart);
    while (cur <= overlapEnd) {
      const k = dateKey(cur);
      assigned.forEach((id) => { if (techIds.some((t) => String(t) === id)) addConflict(id, k, "Reserved by another project"); });
      cur.setDate(cur.getDate() + 1);
    }
  }

  return { windowStart: dateKey(winStart), windowEnd: dateKey(winEnd), conflicts };
}

module.exports = { buildAllocationCalendar, getTechnicianScheduleConflicts };
