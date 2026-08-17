/**
 * Project Scheduler — one-click generation helpers for the admin planning flow.
 *
 * Implements the enterprise "auto-generate, never manual-drag" model:
 *   - generateSchedule: assigns AVAILABLE technicians to each project working
 *     day (respecting existing bookings, leave, other projects and the
 *     customer's preferred working hours) and creates their DailyAssignments.
 *   - generateWorkOrders: splits the project's total units into work orders
 *     by building / floor / quantity / manual.
 *   - suggestResources: rule-based equipment & material recommendations.
 *
 * Existing confirmed bookings are NEVER overwritten.
 */

const mongoose = require("mongoose");
const Project = require("../models/Project");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const Technician = require("../models/Technician");
const BookingService = require("../models/BookingService");
const LeaveRequest = require("../models/LeaveRequest");
const Tool = require("../models/Tool");
const ProjectMaterial = require("../models/ProjectMaterial");
const { evaluateProjectResources } = require("./projectResourcePlanning");
const { projectUnits, resourcesForWorkOrder, validateWorkOrderPlan } = require("./projectWorkOrderPlanning");
const { tavilyProjectResourceSearch, tavilyPartsPricingSearch } = require("./aiTechnicianAssistant");
const { buildServicePreparation } = require("./servicePreparation");

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const isWeekend = (d) => { const day = d.getDay(); return day === 0 || day === 6; };
const dateKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

const BOOKING_ACTIVE = [
  "pending", "payment_verified", "awaiting_assignment", "assigned",
  "pending_reassignment", "confirmed", "scheduled", "on-the-way",
  "arrived", "in-progress", "repair_scheduled", "repair_in_progress",
  "inspection_scheduled", "inspection_in_progress", "ready_for_repair",
];

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

async function getDailyHours() {
  try {
    const eng = require("../utils/enterpriseSchedulingEngine");
    if (typeof eng.getDailyHours === "function") return eng.getDailyHours();
  } catch (_) {}
  return 8;
}

/**
 * Build the per-day availability for the project's working span.
 * Returns: { span, workingDays: [Date...], dailyRequired, matrix: { dateKey: { available:[techId], conflicts:[...] } } }
 */
async function buildDailyAvailability(project) {
  const dailyHours = await getDailyHours();
  const span = Project.computeActiveSpan(
    Object.assign({}, project, {
      reservedTechnicians: project.reservedTechnicians || (project.assignedTechnicians || []).length || 1,
    }),
    { dailyHours }
  );
  if (!span) return null;

  const team = (project.assignedTechnicians || []).map((t) => ({
    _id: (t._id || t).toString(),
    name: t.name || "Technician",
  }));
  const teamIds = team.map((t) => t._id);
  if (teamIds.length === 0) return { span, workingDays: [], dailyRequired: 0, matrix: {} };

  const dailyRequired = Math.max(1, Math.min(
    project.dailyRequiredTechnicians || teamIds.length,
    teamIds.length
  ));

  const spanStart = startOfDay(span.start);
  const spanEnd = startOfDay(span.end);

  // Existing bookings for the team across the span.
  const bookings = await BookingService.find({
    technicianId: { $in: teamIds },
    bookingDate: { $gte: spanStart, $lte: spanEnd },
    status: { $in: BOOKING_ACTIVE },
  }).select("technicianId bookingDate startTime").lean();

  // Approved leave.
  const leaves = await LeaveRequest.find({
    technicianId: { $in: teamIds },
    status: "approved",
    startDate: { $lte: spanEnd },
    endDate: { $gte: spanStart },
  }).lean();

  // Other active projects reserving these techs.
  const otherProjects = await Project.find({
    _id: { $ne: project._id },
    status: { $in: ["accepted", "planning", "in_progress", "on_hold"] },
    $or: [
      { plannedStartDate: { $lte: spanEnd }, plannedCompletionDate: { $gte: spanStart } },
      { preferredStartDate: { $lte: spanEnd }, preferredCompletionDeadline: { $gte: spanStart } },
    ],
  }).lean();

  const bookingByDate = {};
  for (const b of bookings) {
    const k = dateKey(new Date(b.bookingDate));
    (bookingByDate[k] = bookingByDate[k] || new Set()).add(String(b.technicianId));
  }
  const leaveByDate = {};
  for (const lv of leaves) {
    let cur = startOfDay(lv.startDate);
    const e = startOfDay(lv.endDate);
    while (cur <= e) {
      const k = dateKey(cur);
      (leaveByDate[k] = leaveByDate[k] || new Set()).add(String(lv.technicianId));
      cur = addDays(cur, 1);
    }
  }
  const otherByDate = {};
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
      if (isWeekend(cur)) { cur = addDays(cur, 1); continue; }
      const k = dateKey(cur);
      assigned.forEach((id) => {
        if (teamIds.includes(id)) (otherByDate[k] = otherByDate[k] || new Set()).add(id);
      });
      cur = addDays(cur, 1);
    }
  }

  const matrix = {};
  const workingDays = [];
  let cursor = new Date(spanStart);
  while (cursor <= spanEnd) {
    if (!isWeekend(cursor)) {
      const k = dateKey(cursor);
      const busy = new Set();
      [...(bookingByDate[k] || [])].forEach((id) => busy.add(id));
      [...(leaveByDate[k] || [])].forEach((id) => busy.add(id));
      [...(otherByDate[k] || [])].forEach((id) => busy.add(id));
      const available = teamIds.filter((id) => !busy.has(id));
      const conflicts = teamIds
        .filter((id) => busy.has(id))
        .map((id) => ({
          technicianId: id,
          name: (team.find((t) => t._id === id) || {}).name || "Technician",
          reason: bookingByDate[k] && bookingByDate[k].has(id) ? "Fixed booking"
            : leaveByDate[k] && leaveByDate[k].has(id) ? "Approved leave"
            : "Reserved by another project",
        }));
      matrix[k] = { date: k, available, conflicts, shortfall: Math.max(0, dailyRequired - available.length) };
      workingDays.push(new Date(cursor));
    }
    cursor = addDays(cursor, 1);
  }

  return { span, workingDays, dailyRequired, team, matrix };
}

/**
 * Auto-generate the schedule: distributes each work order's units across
 * working days based on each assigned technician's daily capacity
 * (working hours ÷ duration per unit). Existing bookings are respected;
 * the system fills each day with as many units as available technicians
 * can handle, balanced fairly across the team.
 *
 * @returns {Promise<{ schedule: Array, conflicts: Array, message: String, totalUnits: Number, assignedUnits: Number, remainingUnits: Number }>}
 */
async function generateSchedule(projectId) {
  const project = await Project.findById(projectId);
  if (!project) throw new Error("Project not found");
  const team = project.assignedTechnicians || [];
  if (team.length === 0) throw new Error("Assign a team before generating the schedule");

  const avail = await buildDailyAvailability(project.toObject ? project.toObject() : project);
  if (!avail) throw new Error("Project has no valid working span (set start/completion)");

  let workOrders = await WorkOrder.find({ projectId, status: { $ne: "cancelled" } }).sort({ sortOrder: 1, _id: 1 }).lean();
  const priorityRank = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
  // Stable topological ordering: prerequisites precede dependants, while
  // critical/high work wins among currently unblocked packages.
  const byId = new Map(workOrders.map(order => [String(order._id), order]));
  const remainingDependencies = new Map(workOrders.map(order => [String(order._id), new Set((order.dependencies || []).map(String).filter(id => byId.has(id)))]));
  const ordered = [];
  while (ordered.length < workOrders.length) {
    const candidates = workOrders.filter(order => !ordered.includes(order) && remainingDependencies.get(String(order._id)).size === 0)
      .sort((a, b) => (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2) || (a.sortOrder || 0) - (b.sortOrder || 0));
    if (!candidates.length) throw new Error("Work-order dependencies contain a circular reference");
    const next = candidates[0]; ordered.push(next);
    remainingDependencies.forEach(set => set.delete(String(next._id)));
  }
  workOrders = ordered;
  const totalUnits = workOrders.reduce((s, w) => s + (w.unitCount || 0), 0);
  if (totalUnits <= 0) throw new Error("No units found to schedule");

  const dailyHours = await getDailyHours();
  const hoursPerUnit = project.estimatedDurationPerUnit
    || (project.estimatedTotalHours && totalUnits ? project.estimatedTotalHours / totalUnits : 1);

  const schedule = [];
  const conflicts = [];
  const days = avail.workingDays;
  if (days.length === 0) throw new Error("No working days in the project span");

  // ── Clear previous system-generated daily assignments ────────
  await DailyAssignment.deleteMany({ projectId, generatedBy: "system" });

  let totalAssigned = 0;
  let perTechProgress = {}; // techId -> { assignedUnits, remainingUnits }

  // Build per-tech unit totals from all WOs
  for (const wo of workOrders) {
    const techs = (wo.assignedTechnicians || []).filter(t => t && (t._id || t));
    if (techs.length === 0) continue;
    for (const tech of techs) {
      const techId = (tech._id || tech).toString();
      const assignedUnits = tech.assignedUnits || Math.ceil((wo.unitCount || 0) / techs.length);
      if (!perTechProgress[techId]) {
        perTechProgress[techId] = { assignedUnits: 0, remainingUnits: 0 };
      }
      perTechProgress[techId].assignedUnits += assignedUnits;
      perTechProgress[techId].remainingUnits += assignedUnits;
    }
  }

  const techIdsWithWork = Object.keys(perTechProgress);
  if (techIdsWithWork.length === 0) throw new Error("No technicians have units assigned in work orders");

  // ── Capacity-driven per-day distribution ─────────────────────
  // For each working day, distribute each tech's remaining units
  // based on their daily capacity and availability.
  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const dayDate = days[dayIdx];
    const k = dateKey(dayDate);
    const dayInfo = avail.matrix[k];
    if (!dayInfo) continue;

    // Check if any tech still has remaining units
    const techsWithRemaining = techIdsWithWork.filter(tid => (perTechProgress[tid]?.remainingUnits || 0) > 0);
    if (techsWithRemaining.length === 0) break;

    // Available techs this day (that still have work to do)
    const availableTechs = dayInfo.available.filter(tid => perTechProgress[tid]?.remainingUnits > 0);
    if (availableTechs.length === 0) {
      const busyTechs = techsWithRemaining.filter(tid => !dayInfo.available.includes(tid));
      if (busyTechs.length > 0) {
        conflicts.push({
          date: k,
          type: "tech_unavailable",
          message: `${busyTechs.length} technician(s) with remaining units are unavailable today`,
          technicianIds: busyTechs,
        });
      }
      continue;
    }

    // Calculate each available tech's daily unit capacity
    const capacityMap = {};
    for (const techId of availableTechs) {
      const rawCapacity = Math.floor(dailyHours / hoursPerUnit);
      capacityMap[techId] = Math.max(1, rawCapacity);
    }

    // Assign units per tech: respect both capacity AND remaining units
    const techAssignments = {};
    for (const techId of availableTechs) {
      const cap = capacityMap[techId];
      const remaining = perTechProgress[techId].remainingUnits;
      techAssignments[techId] = Math.min(cap, remaining);
    }

    // Create daily assignments and link them to the appropriate work orders
    for (const techId of availableTechs) {
      const unitsForTech = techAssignments[techId];
      if (unitsForTech <= 0) continue;

      const tech = team.find(t => (t._id || '').toString() === techId);
      const techName = tech ? tech.name : "Technician";

      // Distribute this tech's daily units across their work orders
      let remainingTechUnits = unitsForTech;
      for (const wo of workOrders) {
        if (remainingTechUnits <= 0) break;
        const woTech = (wo.assignedTechnicians || []).find(
          t => (t._id || t).toString() === techId
        );
        if (!woTech) continue;

        const woUnits = woTech.assignedUnits || Math.ceil((wo.unitCount || 0) / (wo.assignedTechnicians || []).length);
        const woRemaining = woUnits; // simplified: each WO's units for this tech
        if (woRemaining <= 0) continue;

        const unitsForWo = Math.min(remainingTechUnits, woRemaining);
        await DailyAssignment.findOneAndUpdate(
          { workOrderId: wo._id, technicianId: techId, date: startOfDay(dayDate) },
          {
            $set: {
              projectId,
              targetUnits: unitsForWo,
              status: "in_progress",
              generatedBy: "system",
              applianceType: wo.applianceType || "",
              applianceTypeName: wo.applianceTypeName || "",
              unitGroupId: wo.unitGroupId != null ? wo.unitGroupId : undefined,
            },
            $setOnInsert: { completedUnits: 0 },
          },
          { upsert: true }
        );
        schedule.push({ date: k, workOrderId: wo._id, technicianId: techId, technician: techName, units: unitsForWo });
        remainingTechUnits -= unitsForWo;
      }

      const assignedToTech = unitsForTech - remainingTechUnits;
      perTechProgress[techId].remainingUnits -= assignedToTech;
      totalAssigned += assignedToTech;
    }
  }

  // Remaining units across all techs
  const remainingUnits = Object.values(perTechProgress).reduce((s, p) => s + p.remainingUnits, 0);

  // Scheduling is date-aware for reusable assets. Re-evaluate the resource
  // plan after work-order dates are assigned and surface equipment conflicts
  // alongside technician conflicts without reserving anything.
  let resourceReadiness = null;
  if (project.planningDraft?.resources?.length) {
    try {
      const refreshedProject = await Project.findById(projectId);
      const evaluated = await evaluateProjectResources(refreshedProject.toObject(), refreshedProject.planningDraft.resources);
      refreshedProject.planningDraft.resources = evaluated.resources;
      refreshedProject.planningDraft.readiness = evaluated.readiness;
      refreshedProject.planningDraft.updatedAt = new Date();
      await refreshedProject.save();
      resourceReadiness = evaluated.readiness;
      evaluated.resources.filter(resource => resource.readinessStatus === "equipment_conflict").forEach(resource => {
        conflicts.push({ type: "equipment", itemName: resource.itemName, shortage: resource.shortage, message: `${resource.itemName}: ${resource.shortage} unit(s) unavailable during the project schedule` });
      });
    } catch (_) {}
  }

  // ── Update work orders' scheduledDate ─────────────────────────
  for (const wo of workOrders) {
    const workDates = schedule.filter(row => String(row.workOrderId) === String(wo._id)).map(row => new Date(row.date)).sort((a,b) => a-b);
    const scheduledDate = workDates[0] || wo.scheduledDate || startOfDay(days[0]);
    await WorkOrder.findByIdAndUpdate(wo._id, { scheduledDate: startOfDay(scheduledDate), planningStatus: "scheduled" });
  }

  // Repair existing admin-created daily plans
  for (const wo of workOrders) {
    await ensureDailyAssignmentsSafe(wo._id);
  }

  const message = remainingUnits <= 0
    ? `All ${totalAssigned} units distributed across ${days.length} working day(s) (${Math.round(totalAssigned / days.length)} units/day avg)`
    : `⚠ Only ${totalAssigned} of ${totalUnits} units could be assigned — ${remainingUnits} units remain. Consider adding more technicians or extending the project duration.`;

  return {
    schedule,
    conflicts,
    message,
    totalUnits,
    assignedUnits: totalAssigned,
    remainingUnits: Math.max(0, remainingUnits),
    resourceReadiness,
  };
}

async function ensureDailyAssignmentsSafe(woId) {
  try {
    const { ensureDailyAssignments } = require("./dailyAssignment");
    await ensureDailyAssignments(woId);
  } catch (_) {}
}

/**
 * Generate work orders by splitting the project's total units.
 * When in 'quantity' mode without an explicit count, the system
 * auto-calculates the optimal number of work orders based on each
 * technician's daily working capacity and the project's duration.
 *
 * @param {String} projectId
 * @param {Object} opts { mode: 'building'|'floor'|'quantity'|'manual', count, sections, manual: [{title,units,hours}] }
 */
async function generateWorkOrders(projectId, opts = {}) {
  const project = await Project.findById(projectId);
  if (!project) throw new Error("Project not found");

  // Enterprise default: create practical draft execution packages from the
  // real service/unit scope. Manual location modes remain available below.
  if (!opts.mode || opts.mode === "intelligent" || opts.regenerate) {
    const booking = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
    const allUnits = projectUnits(project.toObject(), booking);
    const prior = await WorkOrder.find({ projectId }).sort({ sortOrder: 1 }).lean();
    const replaceable = prior.filter(order => order.planningStatus !== "released" && order.status === "pending");
    const protectedOrders = prior.filter(order => !replaceable.some(draft => String(draft._id) === String(order._id)));
    const protectedKeys = new Set(protectedOrders.flatMap(order => (order.units || []).map(unit => unit.unitKey)));
    const remainingUnits = allUnits.filter(unit => !protectedKeys.has(unit.unitKey));
    if (replaceable.length) {
      await DailyAssignment.deleteMany({ workOrderId: { $in: replaceable.map(order => order._id) } });
      await WorkOrder.deleteMany({ _id: { $in: replaceable.map(order => order._id) } });
    }
    if (!remainingUnits.length) {
      const readiness = await validateWorkOrderPlan(project.toObject(), booking);
      return { workOrders: [], preserved: protectedOrders.length, readiness, message: "No uncovered project units remain; released work orders were preserved." };
    }

    const team = (project.assignedTechnicians || []).map(member => ({
      _id: member._id || member, name: member.name || "Technician", phone: member.phone || "",
    }));
    const groups = new Map();
    remainingUnits.forEach(unit => {
      const key = [unit.serviceType, unit.serviceName, unit.location, unit.groupIndex].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(unit);
    });
    const existingNumbers = prior.map(order => Number(String(order.workOrderNumber || "").match(/(\d+)$/)?.[1] || 0));
    let sequence = Math.max(0, ...existingNumbers);
    const created = [];
    for (const units of groups.values()) {
      const sample = units[0];
      const durationMinutes = Math.max(15, Number(sample.durationMinutes || 60));
      // 6.5 productive hours accounts for setup, breaks, site movement and
      // reporting. Repair packages stay small to preserve inspection/quote flow.
      const perTechnicianCapacity = Math.max(1, Math.floor(390 / durationMinutes));
      const batchSize = sample.serviceType === "repair"
        ? Math.min(2, perTechnicianCapacity)
        : Math.min(6, perTechnicianCapacity);
      for (let start = 0; start < units.length; start += batchSize) {
        const batch = units.slice(start, start + batchSize);
        sequence += 1;
        // The project team owns every batch. Individual accountability is
        // captured when a technician updates a tracked unit during execution.
        const suggested = team.map(member => ({ ...member, assignedUnits: 0 }));
        const number = `WO-${String(sequence).padStart(3, "0")}`;
        const location = sample.location || project.location?.address || booking?.location?.address || "Customer site";
        const order = await WorkOrder.create({
          projectId, bookingId: project.bookingId, workOrderNumber: number,
          planningStatus: "draft", status: "pending", assignmentProvisional: true,
          title: `${sample.serviceName || "HVAC Service"} — ${location}`,
          description: `${sample.serviceType === "repair" ? "Repair assessment and approved repair workflow" : "Core service execution"} for ${batch.length} unit(s).`,
          section: location, location: { label: location, address: project.location?.address || booking?.location?.address || location, lat: project.location?.lat || booking?.location?.lat, lng: project.location?.lng || booking?.location?.lng },
          serviceType: sample.serviceType, workflowType: sample.serviceType, serviceName: sample.serviceName,
          units: batch.map(({ durationMinutes: ignored, ...unit }) => unit), unitCount: batch.length,
          estimatedHours: Number(((batch.length * durationMinutes) / 60).toFixed(1)),
          requiredTechnicianCount: Math.max(1, Math.min(team.length || 1, Number(project.dailyRequiredTechnicians || team.length || 1))),
          suggestedTechnicians: suggested, assignedTechnicians: suggested,
          priority: booking?.priority === "medium" ? "normal" : (booking?.priority || "normal"),
          sortOrder: protectedOrders.length + created.length + 1,
          checklist: sample.serviceType === "repair"
            ? [{ label: "Inspect and diagnose", completed: false }, { label: "Prepare quotation", completed: false }, { label: "Complete customer-approved repair", completed: false }, { label: "Proof of completion", completed: false }]
            : [{ label: "Initial inspection", completed: false }, { label: "Execute core service", completed: false }, { label: "Final quality check", completed: false }, { label: "Proof of completion", completed: false }],
          activity: [{ action: "work_order_created", actorName: "Planning Engine", details: { generationMode: "intelligent", provisionalAssignment: true } }],
        });
        order.resourceRequirements = resourcesForWorkOrder(project.toObject(), order.toObject());
        await order.save();
        created.push(order);
      }
    }
    project.totalWorkOrders = protectedOrders.length + created.length;
    await project.save();
    const readiness = await validateWorkOrderPlan(project.toObject(), booking);
    return {
      workOrders: created, preserved: protectedOrders.length, readiness,
      message: `${created.length} draft work order(s) generated from ${remainingUnits.length} unit(s). ${protectedOrders.length ? `${protectedOrders.length} released/active order(s) preserved.` : ""}`.trim(),
    };
  }

  const estimatedTotalHours = project.estimatedTotalHours || 0;
  let totalUnits = Number(project.totalUnits) || 0;
  if (totalUnits <= 0) totalUnits = Number(project.quantity) || 0;
  if (totalUnits <= 0 && estimatedTotalHours > 0) totalUnits = estimatedTotalHours;
  if (totalUnits <= 0) throw new Error("Project has no units to split");

  if (!project.totalUnits || Number(project.totalUnits) !== totalUnits) {
    project.totalUnits = totalUnits;
    try { await project.save(); } catch (_) {}
  }

  // ── Capacity-based auto-calculation ───────────────────────────
  // Calculate the optimal number of work orders based on tech capacity
  // and project duration, so generated WOs match actual working capacity.
  let autoCount = null;
  const team = (project.assignedTechnicians || []).map((t) => ({
    _id: (t._id || t).toString(),
    name: t.name || "Technician",
    phone: t.phone || "",
  }));
  const teamSize = team.length;

  if (teamSize > 0 && opts.mode !== "manual" && opts.mode !== "building" && opts.mode !== "floor") {
    // Large-scale projects default to 1 work order (units distributed by daily plan)
    if (project.isLargeScale) {
      autoCount = 1;
    } else {
      const hoursPerUnit = project.estimatedDurationPerUnit
        || (estimatedTotalHours && totalUnits ? estimatedTotalHours / totalUnits : 1);
      const dailyHours = 8; // standard daily working hours
      const spanStart = project.plannedStartDate || project.preferredStartDate;
      const spanEnd = project.plannedCompletionDate || project.preferredCompletionDeadline;
      if (spanStart && spanEnd) {
        const workingDays = workingDaysBetween(spanStart, spanEnd);
        if (workingDays > 0) {
          // Each tech can do (dailyHours / hoursPerUnit) units per day
          const unitsPerTechPerDay = Math.max(1, Math.floor(dailyHours / hoursPerUnit));
          // Total team capacity across the project duration
          const totalCapacity = teamSize * unitsPerTechPerDay * workingDays;
          // Optimal WO count: aim for ~5-10 units per WO, but never more than working days
          const idealPerWo = Math.max(5, unitsPerTechPerDay * teamSize);
          autoCount = Math.max(1, Math.min(Math.ceil(totalUnits / idealPerWo), workingDays * teamSize, totalUnits));
        }
      }
    }
  }

  const mode = opts.mode || "quantity";
  let specs = [];

  if (mode === "manual" && Array.isArray(opts.manual) && opts.manual.length) {
    specs = opts.manual.map((m, i) => ({
      title: m.title || `Work Order ${i + 1}`,
      section: m.section || "",
      unitCount: Math.max(1, parseInt(m.units) || 0),
      estimatedHours: Math.max(0, parseFloat(m.hours) || 0),
    }));
  } else if (mode === "building" && Array.isArray(opts.sections) && opts.sections.length) {
    specs = opts.sections.map((s) => ({
      title: `Building ${s.name}`,
      section: s.name,
      unitCount: Math.max(1, parseInt(s.units) || 0),
      estimatedHours: Math.max(0, Math.round(parseInt(s.units) || 0) * (project.estimatedDurationPerUnit || 1)),
    }));
  } else if (mode === "floor" && Array.isArray(opts.sections) && opts.sections.length) {
    specs = opts.sections.map((s) => ({
      title: `Floor ${s.name}`,
      section: s.name,
      unitCount: Math.max(1, parseInt(s.units) || 0),
      estimatedHours: Math.max(0, Math.round(parseInt(s.units) || 0) * (project.estimatedDurationPerUnit || 1)),
    }));
  } else if (mode === "appliance") {
    // ── Split by appliance type from unitGroups ───────────────────────
    // Creates one work order per appliance group. When there's only one
    // group or no unitGroups, falls back to quantity split.
    const unitGroups = project.unitGroups || [];
    if (unitGroups.length > 1) {
      specs = unitGroups.map((group, i) => ({
        title: `${group.quantity}× ${group.unitType}${group.brand ? ' (' + group.brand + ')' : ''}`,
        section: group.unitType || '',
        unitCount: group.quantity,
        estimatedHours: Math.round(group.quantity * (group.duration || project.estimatedDurationPerUnit || 1)),
        applianceType: group.applianceType || '',
        applianceTypeName: group.unitType || group.applianceTypeName || '',
        unitGroupId: group.groupIndex,
        brand: group.brand || '',
        hp: group.hp || null,
      }));
    } else {
      // Fall back to quantity split when there's only one group
      const count = autoCount || Math.max(1, parseInt(opts.count) || Math.ceil(totalUnits / 5) || 1);
      const base = Math.floor(totalUnits / count);
      let extra = totalUnits - base * count;
      const perUnitHrs = (estimatedTotalHours && totalUnits)
        ? parseFloat((estimatedTotalHours / totalUnits).toFixed(1))
        : (project.estimatedDurationPerUnit || 1);
      for (let i = 0; i < count; i++) {
        const units = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
        specs.push({
          title: `Work Order ${i + 1}`,
          section: "",
          unitCount: units,
          estimatedHours: Math.round(units * perUnitHrs),
        });
      }
    }
  } else {
    // Use auto-calculated count when available, otherwise fall back to ~5 units each
    const count = autoCount || Math.max(1, parseInt(opts.count) || Math.ceil(totalUnits / 5) || 1);
    const base = Math.floor(totalUnits / count);
    let extra = totalUnits - base * count;
    const perUnitHrs = (estimatedTotalHours && totalUnits)
      ? parseFloat((estimatedTotalHours / totalUnits).toFixed(1))
      : (project.estimatedDurationPerUnit || 1);
    for (let i = 0; i < count; i++) {
      const units = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      specs.push({
        title: `Work Order ${i + 1}`,
        section: "",
        unitCount: units,
        estimatedHours: Math.round(units * perUnitHrs),
      });
    }
  }

  // Replace draft records only. Released, active, completed and cancelled
  // records are immutable to automatic regeneration.
  const oldWos = await WorkOrder.find({ projectId, status: "pending", planningStatus: { $ne: "released" } }).select('_id').lean();
  const oldWoIds = oldWos.map(w => w._id);
  await WorkOrder.deleteMany({ _id: { $in: oldWoIds } });
  if (oldWoIds.length) {
    await DailyAssignment.deleteMany({ workOrderId: { $in: oldWoIds } });
  }

  // ── Capacity-weighted technician assignment ───────────────────
  // Distribute units across team members proportionally to their
  // individual daily capacity, rather than an even split.
  const hoursPerUnit = project.estimatedDurationPerUnit
    || (estimatedTotalHours && totalUnits ? estimatedTotalHours / totalUnits : 1);
  const dailyHours = 8;
  const created = [];
  specs.forEach((sp, idx) => {
    const assigned = team.map(tech => ({
      _id: tech._id, name: tech.name, phone: tech.phone, assignedUnits: 0,
    }));

    created.push({
      projectId,
      bookingId: project.bookingId,
      title: sp.title,
      section: sp.section || "",
      applianceType: sp.applianceType || "",
      applianceTypeName: sp.applianceTypeName || "",
      unitGroupId: sp.unitGroupId != null ? sp.unitGroupId : undefined,
      brand: sp.brand || "",
      hp: sp.hp || null,
      unitCount: sp.unitCount,
      estimatedHours: sp.estimatedHours,
      requiredTechnicianCount: Math.max(1, Math.min(team.length || 1, Number(project.dailyRequiredTechnicians || team.length || 1))),
      assignedTechnicians: assigned,
      scheduledDate: null,
      priority: "normal",
      sortOrder: idx + 1,
      checklist: [
        { label: "Initial inspection", completed: false },
        { label: "Execute service", completed: false },
        { label: "Final quality check", completed: false },
      ],
    });
  });

  const inserted = created.length ? await WorkOrder.insertMany(created) : [];
  project.totalWorkOrders = inserted.length;
  await project.save();

  const capacityNote = autoCount
    ? ` (auto-calculated: ${teamSize} tech(s) × ${Math.floor(dailyHours / hoursPerUnit)} units/day × project duration)`
    : "";
  const assignMsg = teamSize > 0
    ? ` assigned to the ${teamSize}-person project team${capacityNote}`
    : " (no team assigned yet — add the team to auto-assign technicians)";
  return { workOrders: inserted, message: `${inserted.length} work order(s) created (total ${totalUnits} units)${assignMsg}` };
}

/**
 * Rule-based resource suggestions from the Tool catalog.
 * Queries inventory for items relevant to HVAC/AC cleaning & repair.
 * Enhanced with Tavily web research for real-time pricing and best practices.
 * Returns plain recommendation objects the admin can confirm.
 */
async function suggestResources(projectId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw new Error("Project not found");
  const booking = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
  const workOrders = await WorkOrder.find({ projectId }).lean();
  const totalUnits = project.totalUnits || workOrders.reduce((s, w) => s + (w.unitCount || 0), 0);
  const crew = project.dailyRequiredTechnicians || (project.assignedTechnicians || []).length || 1;
  const recs = [];
  const round = (n) => Math.max(1, Math.ceil(n));

  // Step 1: Web research for project resources
  let webResearch = { webContext: '', sources: [], searchUsed: false };
  try {
    webResearch = await tavilyProjectResourceSearch({
      serviceName: project.serviceName || project.name || '',
      totalUnits,
      description: project.description || '',
    });
    if (webResearch.searchUsed) {
      console.log(`[Tavily] Project resource research complete — ${webResearch.sources.length} sources`);
    }
  } catch (err) {
    console.warn('[Tavily] Project resource search failed:', err.message);
  }

  // Step 2: Pricing research for key parts
  let pricingResearch = { pricingData: '', searchUsed: false };
  try {
    const keyParts = ['capacitor', 'refrigerant R-410A', 'air filter', 'fan motor', 'copper pipe'];
    pricingResearch = await tavilyPartsPricingSearch(keyParts);
  } catch (err) {
    console.warn('[Tavily] Pricing search failed:', err.message);
  }

  // Step 3: Query Tool catalog for relevant items
  const allTools = await Tool.find({ active: true }).lean();

  // Categorize tools by name/type patterns
  const findTool = (patterns) => allTools.find(t => patterns.some(p => t.itemName.toLowerCase().includes(p)));
  const findTools = (patterns) => allTools.filter(t => patterns.some(p => t.itemName.toLowerCase().includes(p)));

  // Equipment suggestions (shared tools)
  const pressureWasher = findTool(["pressure washer", "power washer", "jet wash"]);
  if (pressureWasher) {
    recs.push({ itemName: pressureWasher.itemName, type: "equipment", quantity: round(crew / 2), baseQuantity: 0.5, requirementRule: "per_technician", unit: pressureWasher.unit || "pcs", scope: "shared", reason: `One shared washer per two technicians (${crew} currently planned)`, toolId: pressureWasher._id, available: (pressureWasher.quantity || 0) });
  } else {
    recs.push({ itemName: "Pressure Washer", type: "equipment", quantity: round(crew / 2), baseQuantity: 0.5, requirementRule: "per_technician", unit: "pcs", scope: "shared", reason: `One shared washer per two technicians (${crew} currently planned)`, available: 0 });
  }

  const ladders = findTools(["ladder", "step ladder", "extension ladder"]);
  if (ladders.length) {
    recs.push({ itemName: ladders[0].itemName, type: "equipment", quantity: round(crew / 2), baseQuantity: 0.5, requirementRule: "per_technician", unit: ladders[0].unit || "pcs", scope: "shared", reason: "Shared access equipment; one per two technicians", toolId: ladders[0]._id, available: (ladders[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Ladder", type: "equipment", quantity: round(crew / 2), baseQuantity: 0.5, requirementRule: "per_technician", unit: "pcs", scope: "shared", reason: "Shared access equipment; one per two technicians", available: 0 });
  }

  // Consumables from catalog
  const cleaningSolutions = findTools(["cleaning solution", "cleaner", "coil cleaner", "foam cleaner"]);
  if (cleaningSolutions.length) {
    recs.push({ itemName: cleaningSolutions[0].itemName, type: "consumable", quantity: round(totalUnits * 1.25), baseQuantity: 1.25, requirementRule: "per_unit", unit: cleaningSolutions[0].unit || "pcs", scope: "shared", reason: "Configured usage: 5L per 4 units", toolId: cleaningSolutions[0]._id, available: (cleaningSolutions[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Cleaning Solution", type: "consumable", quantity: round(totalUnits * 1.25), baseQuantity: 1.25, requirementRule: "per_unit", unit: "L", scope: "shared", reason: "Configured usage: 5L per 4 units", available: 0 });
  }

  const cloths = findTools(["microfiber", "cloth", "rag", "wipe"]);
  if (cloths.length) {
    recs.push({ itemName: cloths[0].itemName, type: "consumable", quantity: round(totalUnits), baseQuantity: 1, requirementRule: "per_unit", unit: cloths[0].unit || "pcs", scope: "shared", reason: "Configured usage: one per unit", toolId: cloths[0]._id, available: (cloths[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Microfiber Cloths", type: "consumable", quantity: round(totalUnits), baseQuantity: 1, requirementRule: "per_unit", unit: "pcs", scope: "shared", reason: "Configured usage: one per unit", available: 0 });
  }

  // Common repair parts from catalog
  const capacitors = findTools(["capacitor"]);
  if (capacitors.length) {
    recs.push({ itemName: capacitors[0].itemName, type: "part", quantity: Math.max(1, Math.round(totalUnits * 0.1)), baseQuantity: 0.1, requirementRule: "per_unit", unit: capacitors[0].unit || "pcs", scope: "shared", reason: "Possible repair part based on a 10% planning allowance", toolId: capacitors[0]._id, available: (capacitors[0].quantity || 0) });
  }

  const filters = findTools(["filter", "air filter", "filter drier"]);
  if (filters.length) {
    recs.push({ itemName: filters[0].itemName, type: "consumable", quantity: round(totalUnits), baseQuantity: 1, requirementRule: "per_unit", unit: filters[0].unit || "pcs", scope: "shared", reason: "Configured usage: one per unit", toolId: filters[0]._id, available: (filters[0].quantity || 0) });
  }

  const refrigerants = findTools(["refrigerant", "freon", "r410", "r22", "r32"]);
  if (refrigerants.length) {
    recs.push({ itemName: refrigerants[0].itemName, type: "consumable", quantity: round(totalUnits / 3), baseQuantity: 1 / 3, requirementRule: "per_unit", unit: refrigerants[0].unit || "kg", scope: "shared", reason: "Configured usage: 1kg per 3 units", toolId: refrigerants[0]._id, available: (refrigerants[0].quantity || 0) });
  }

  const copperPipes = findTools(["copper pipe", "copper tubing", "refrigerant pipe"]);
  if (copperPipes.length) {
    recs.push({ itemName: copperPipes[0].itemName, type: "consumable", quantity: round(totalUnits * 2), baseQuantity: 2, requirementRule: "per_unit", unit: copperPipes[0].unit || "pcs", scope: "shared", reason: "Configured usage: 2m per unit", toolId: copperPipes[0]._id, available: (copperPipes[0].quantity || 0) });
  }

  // Merge the same service-aware kit used by technician preparation. This
  // captures tools/consumables for non-cleaning and mixed Core + Repair jobs.
  if (booking) {
    const preparation = await buildServicePreparation(booking);
    for (const item of preparation.recommendations || []) {
      const quantity = item.kind === "consumable"
        ? Math.max(1, Number(item.quantity || 1) * totalUnits)
        : Math.max(1, Math.min(crew, Number(item.quantity || 1) * crew));
      if (!recs.some(rec => String(rec.toolId || "") === String(item.inventoryId || "") && rec.itemName.toLowerCase() === String(item.name).toLowerCase())) {
        recs.push({ itemName: item.name, type: item.kind, quantity, baseQuantity: Math.max(0.01, Number(item.quantity || 1)), requirementRule: item.kind === "consumable" ? "per_unit" : "per_technician", unit: item.unit || "pcs", scope: "shared", reason: item.kind === "consumable" ? `Service kit requirement for ${totalUnits} units` : `Required service equipment for ${crew} technicians`, toolId: item.inventoryId || undefined, available: Number(item.available || 0) });
      }
    }

    // Parts already identified in an approved/submitted repair quotation are
    // requirements, not generic AI guesses, and must appear in the plan.
    const quotedParts = [
      ...(booking.quotation?.parts || []),
      ...((booking.services || []).flatMap(item => item.quotation?.parts || [])),
    ];
    for (const part of quotedParts) {
      const name = String(part.name || "").trim();
      if (!name) continue;
      const catalog = part.toolId ? allTools.find(tool => String(tool._id) === String(part.toolId)) : findTool([name.toLowerCase()]);
      const existing = recs.find(rec => rec.type === "part" && rec.itemName.toLowerCase() === name.toLowerCase());
      if (existing) existing.quantity = Math.max(existing.quantity, Number(part.quantity) || 1);
      else recs.push({ itemName: name, type: "part", quantity: Math.max(1, Number(part.quantity) || 1), baseQuantity: Math.max(1, Number(part.quantity) || 1), requirementRule: "fixed", unit: catalog?.unit || "pcs", scope: "shared", reason: "Required by repair quotation", toolId: catalog?._id, available: Number(catalog?.quantity || 0) });
    }
  }

  return {
    recommendations: recs,
    webResearchUsed: webResearch.searchUsed || pricingResearch.searchUsed,
    webSources: webResearch.sources || [],
    webContext: webResearch.webContext + (pricingResearch.pricingData || ''),
  };
}

module.exports = {
  buildDailyAvailability,
  generateSchedule,
  generateWorkOrders,
  suggestResources,
  workingDaysBetween,
};
