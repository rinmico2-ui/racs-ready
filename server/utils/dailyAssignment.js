const mongoose = require("mongoose");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const Project = require("../models/Project");

// Skip weekends for daily-plan generation (company working days).
function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Count working days (Mon–Fri) in [start, end] inclusive.
function workingDaysBetween(start, end) {
  let cur = startOfDay(start);
  const last = startOfDay(end);
  let count = 0;
  while (cur <= last) {
    if (!isWeekend(cur)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

// Next working day strictly after `d`.
function nextWorkingDay(d) {
  let cur = addDays(startOfDay(d), 1);
  while (isWeekend(cur)) cur = addDays(cur, 1);
  return cur;
}

/**
 * Build / repair the daily assignment plan for a work order.
 *
 * The work order defines the SCOPE (total units). This splits the REMAINING
 * units into an even daily plan:
 *   daysNeeded = ceil(remaining / dailyCapacity)   (dailyCapacity default 2)
 *   spread remaining as evenly as possible across those working days
 *   (e.g. 8 units → 4 days → 2,2,2,2).
 *
 * If the project's due date leaves fewer working days than daysNeeded, the
 * daily target is raised to fit (and the caller/notification flags the risk).
 * Completed days are never overwritten.
 *
 * @returns {Promise<{assignments: Array, remaining: Number, daysUsed: Number, dailyCapacity: Number}>}
 */
async function ensureDailyAssignments(workOrderId, opts = {}) {
  const workOrder = await WorkOrder.findById(workOrderId);
  if (!workOrder) throw new Error("Work order not found");

  const techs = (workOrder.assignedTechnicians || []).filter((t) => t && t._id);
  if (techs.length === 0) return { assignments: [], remaining: workOrder.unitCount - workOrder.completedUnitCount, daysUsed: 0, dailyCapacity: opts.dailyRate || 2 };

  const totalUnits = workOrder.unitCount || 0;
  const completedUnits = workOrder.completedUnitCount || 0;
  const remaining = Math.max(0, totalUnits - completedUnits);

  const project = await Project.findById(workOrder.projectId).lean().catch(() => null);
  const dueStr = project ? (project.preferredCompletionDeadline || project.plannedCompletionDate) : null;

  // Plan starts at the scheduled start date (or today if none / already past).
  const today = startOfDay(new Date());
  let fromDate = workOrder.scheduledDate ? startOfDay(workOrder.scheduledDate) : new Date(today);
  // Only clamp to today when the scheduled start is already in the past.
  if (fromDate < today) fromDate = new Date(today);

  // The WO's daily target is shared by the whole crew — split it across techs.
  const perTechCapacity = Math.max(1, Math.ceil((opts.dailyRate || 2) / techs.length));

  const result = [];

  if (remaining <= 0) {
    for (const tech of techs) {
      await DailyAssignment.updateMany(
        { workOrderId, technicianId: tech._id, date: { $gte: fromDate }, status: { $in: ["pending", "in_progress"] } },
        { $set: { status: "skipped", targetUnits: 0 } }
      );
    }
    const existing = await DailyAssignment.find({ workOrderId }).lean();
    return { assignments: existing, remaining: 0, daysUsed: 0, dailyCapacity: opts.dailyRate || 2 };
  }

  // How many working days are available until the project is due?
  let windowEnd = dueStr ? startOfDay(dueStr) : null;
  if (windowEnd && windowEnd < fromDate) windowEnd = null;
  let availableDays = windowEnd ? workingDaysBetween(fromDate, windowEnd) : 0;
  const dailyCapacity = Math.max(1, opts.dailyRate || 2);

  if (!windowEnd || availableDays < 1) {
    availableDays = Math.max(1, Math.ceil(remaining / dailyCapacity));
  }
  // Days needed at the chosen daily capacity — never more than the window allows.
  const daysNeeded = Math.min(Math.max(1, Math.ceil(remaining / dailyCapacity)), Math.max(1, availableDays));
  availableDays = daysNeeded;

  // Build the ordered list of working days starting at fromDate.
  const days = [];
  let cur = new Date(fromDate);
  while (days.length < availableDays) {
    if (!isWeekend(cur)) days.push(new Date(cur));
    cur = addDays(cur, 1);
    if (days.length > 400) break;
  }

  // Even split of the WO's remaining units across the days.
  const base = Math.floor(remaining / days.length);
  let extra = remaining - base * days.length; // 0..days.length-1
  const targets = days.map(() => {
    const t = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    return t;
  });

  // Per-technician share of each day's target.
  const perTechTarget = (tgt) => Math.max(1, Math.ceil(tgt / techs.length));

  // Fetch work order to inherit appliance type info
  const woApplianceType = workOrder.applianceType || '';
  const woApplianceTypeName = workOrder.applianceTypeName || '';
  const woUnitGroupId = workOrder.unitGroupId != null ? workOrder.unitGroupId : undefined;

  for (const tech of techs) {
    const techId = tech._id;
    const existing = await DailyAssignment.find({ workOrderId, technicianId: techId }).lean();
    const byDate = {};
    existing.forEach((a) => { byDate[startOfDay(a.date).toISOString()] = a; });

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const key = startOfDay(day).toISOString();
      const tgt = perTechTarget(targets[i]);
      const prev = byDate[key];
      if (prev) {
        if (prev.completedUnits > 0) { result.push(prev); continue; }
        if (prev.generatedBy === "admin" && typeof prev.targetUnits === "number" && prev.targetUnits > 0) { result.push(prev); continue; }
        const upd = await DailyAssignment.findOneAndUpdate(
          { workOrderId, technicianId: techId, date: day },
          { $set: { targetUnits: tgt, status: tgt > 0 ? "in_progress" : "pending" } },
          { returnDocument: "after" }
        );
        result.push(upd.toObject ? upd.toObject() : upd);
      } else {
        const created = await DailyAssignment.findOneAndUpdate(
          { workOrderId, technicianId: techId, date: day },
          { $set: { projectId: workOrder.projectId, targetUnits: tgt, status: tgt > 0 ? "in_progress" : "pending", generatedBy: "system", applianceType: woApplianceType, applianceTypeName: woApplianceTypeName, unitGroupId: woUnitGroupId }, $setOnInsert: { completedUnits: 0 } },
          { returnDocument: "after", upsert: true }
        );
        result.push(created.toObject ? created.toObject() : created);
      }
    }

    // Skip any future system days outside the new plan.
    if (days.length) {
      await DailyAssignment.updateMany(
        { workOrderId, technicianId: techId, date: { $gt: days[days.length - 1] }, status: { $in: ["pending", "in_progress"] }, generatedBy: "system" },
        { $set: { status: "skipped", targetUnits: 0 } }
      );
    }
  }

  return { assignments: result, remaining, daysUsed: days.length, dailyCapacity };
}

/**
 * Record a technician's end-of-day completion for a work order.
 * Updates the work order's completed count, recalculates future daily targets
 * (carryover), and flags schedule risk when behind.
 *
 * @returns {Promise<{ workOrder, today, tomorrow, behindSchedule, riskNote }>}
 */
async function completeDay(workOrderId, technicianId, date, completedUnits) {
  const workOrder = await WorkOrder.findById(workOrderId);
  if (!workOrder) throw new Error("Work order not found");

  const day = startOfDay(date || new Date());
  const completed = Math.max(0, Math.floor(Number(completedUnits) || 0));
  const target = Math.max(0, Math.floor(Number(completedUnits) || 0));

  // Persist today's daily assignment.
  const da = await DailyAssignment.findOneAndUpdate(
    { workOrderId, technicianId, date: day },
    { $set: { completedUnits: completed, status: completed > 0 ? "completed" : "in_progress", completedAt: completed > 0 ? new Date() : null }, $setOnInsert: { targetUnits: 0 } },
    { returnDocument: "after", upsert: true }
  );

  // Recompute work order completed total from daily assignments.
  const agg = await DailyAssignment.aggregate([
    { $match: { workOrderId: workOrder._id } },
    { $group: { _id: null, total: { $sum: "$completedUnits" } } },
  ]);
  const newCompleted = agg.length ? agg[0].total : completed;
  workOrder.completedUnitCount = Math.min(workOrder.unitCount || 0, newCompleted);
  if (workOrder.completedUnitCount >= (workOrder.unitCount || 0)) {
    workOrder.status = "awaiting_review";
    workOrder.actualCompletionDate = null;
  }
  await workOrder.save();

  const project = await Project.findById(workOrder.projectId).lean().catch(() => null);
  const enterpriseSchedule = ["ready", "confirmed"].includes(project?.schedulePlan?.status);
  // Never replace the confirmed Step 4 allocation with the legacy even-split
  // planner. Legacy projects still receive the historical carry-forward logic.
  if (!enterpriseSchedule) await ensureDailyAssignments(workOrderId);

  const tomorrow = nextWorkingDay(day);
  const nextDa = enterpriseSchedule
    ? await DailyAssignment.findOne({ workOrderId, technicianId, date: { $gt: day }, status: { $in: ["pending", "in_progress"] } }).sort({ date: 1 }).lean()
    : await DailyAssignment.findOne({ workOrderId, technicianId, date: tomorrow }).lean();

  // Schedule risk: if completed today < today's original target, we are behind
  // relative to an even spread across the remaining project window.
  const dueStr = project ? (project.preferredCompletionDeadline || project.plannedCompletionDate) : null;
  let behindSchedule = false;
  let riskNote = "";
  if (dueStr) {
    const remaining = Math.max(0, (workOrder.unitCount || 0) - (workOrder.completedUnitCount || 0));
    if (remaining > 0) {
      const daysLeft = workingDaysBetween(tomorrow, startOfDay(dueStr));
      const neededPerDay = daysLeft > 0 ? remaining / daysLeft : remaining;
      const todayTarget = da.targetUnits || 0;
      if (completed < todayTarget) {
        behindSchedule = true;
        riskNote = `Technician completed ${completed} of ${todayTarget} target units. ${remaining} unit(s) remain with ${daysLeft} working day(s) left — project risks falling behind schedule.`;
      } else if (neededPerDay > (nextDa ? nextDa.targetUnits : 0) && nextDa) {
        behindSchedule = true;
        riskNote = `Remaining ${remaining} unit(s) over ${daysLeft} day(s) needs ~${neededPerDay.toFixed(1)}/day; current plan is light.`;
      }
    }
  }

  return { workOrder, today: da, tomorrow: nextDa, behindSchedule, riskNote };
}

module.exports = {
  DailyAssignment,
  ensureDailyAssignments,
  completeDay,
  workingDaysBetween,
  nextWorkingDay,
  startOfDay,
  addDays,
};
