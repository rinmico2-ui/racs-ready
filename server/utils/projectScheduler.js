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
const { tavilyProjectResourceSearch, tavilyPartsPricingSearch } = require("./aiTechnicianAssistant");

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

  const workOrders = await WorkOrder.find({ projectId }).sort({ sortOrder: 1, _id: 1 }).lean();
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

  // ── Update work orders' scheduledDate ─────────────────────────
  for (const wo of workOrders) {
    if (!wo.scheduledDate) {
      await WorkOrder.findByIdAndUpdate(wo._id, { scheduledDate: startOfDay(days[0]) });
    }
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

  // Replace existing auto-generated work orders and clean up daily assignments
  const oldWos = await WorkOrder.find({ projectId }).select('_id').lean();
  const oldWoIds = oldWos.map(w => w._id);
  await WorkOrder.deleteMany({ projectId });
  if (oldWoIds.length) {
    await DailyAssignment.deleteMany({ workOrderId: { $in: oldWoIds } });
  }

  // ── Capacity-weighted technician assignment ───────────────────
  // Distribute units across team members proportionally to their
  // individual daily capacity, rather than an even split.
  const hoursPerUnit = project.estimatedDurationPerUnit
    || (estimatedTotalHours && totalUnits ? estimatedTotalHours / totalUnits : 1);
  const dailyHours = 8;
  const techWeights = team.map(() => Math.max(1, Math.floor(dailyHours / hoursPerUnit)));
  const totalWeight = techWeights.reduce((s, w) => s + w, 0);

  const created = [];
  specs.forEach((sp, idx) => {
    let remaining = sp.unitCount;
    const assigned = team.map((tech, ti) => {
      const share = totalWeight > 0
        ? Math.max(1, Math.floor((techWeights[ti] / totalWeight) * sp.unitCount))
        : Math.ceil(sp.unitCount / Math.max(1, teamSize));
      const actualUnits = Math.min(share, remaining);
      remaining = Math.max(0, remaining - actualUnits);
      return { _id: tech._id, name: tech.name, phone: tech.phone, assignedUnits: actualUnits };
    });
    // Give any remaining units to the first tech
    if (remaining > 0 && assigned.length > 0) assigned[0].assignedUnits += remaining;

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
    ? ` distributed across ${teamSize} technician(s) by capacity${capacityNote}`
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
    recs.push({ itemName: pressureWasher.itemName, type: "equipment", quantity: round(crew / 2), unit: pressureWasher.unit || "pcs", scope: "shared", reason: `${crew} technicians on site`, toolId: pressureWasher._id, available: (pressureWasher.quantity || 0) });
  } else {
    recs.push({ itemName: "Pressure Washer", type: "equipment", quantity: round(crew / 2), unit: "pcs", scope: "shared", reason: `${crew} technicians on site`, available: 0 });
  }

  const ladders = findTools(["ladder", "step ladder", "extension ladder"]);
  if (ladders.length) {
    recs.push({ itemName: ladders[0].itemName, type: "equipment", quantity: round(crew / 2), unit: ladders[0].unit || "pcs", scope: "shared", reason: "Shared access equipment", toolId: ladders[0]._id, available: (ladders[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Ladder", type: "equipment", quantity: round(crew / 2), unit: "pcs", scope: "shared", reason: "Shared access equipment", available: 0 });
  }

  // Consumables from catalog
  const cleaningSolutions = findTools(["cleaning solution", "cleaner", "coil cleaner", "foam cleaner"]);
  if (cleaningSolutions.length) {
    recs.push({ itemName: cleaningSolutions[0].itemName, type: "part", quantity: round(totalUnits / 4) * 5, unit: cleaningSolutions[0].unit || "pcs", scope: "consumable", reason: `~${(totalUnits / 4).toFixed(1)} units per 5L`, toolId: cleaningSolutions[0]._id, available: (cleaningSolutions[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Cleaning Solution", type: "part", quantity: round(totalUnits / 4) * 5, unit: "L", scope: "consumable", reason: `~${(totalUnits / 4).toFixed(1)} units per 5L`, available: 0 });
  }

  const cloths = findTools(["microfiber", "cloth", "rag", "wipe"]);
  if (cloths.length) {
    recs.push({ itemName: cloths[0].itemName, type: "part", quantity: round(totalUnits), unit: cloths[0].unit || "pcs", scope: "consumable", reason: "One per unit", toolId: cloths[0]._id, available: (cloths[0].quantity || 0) });
  } else {
    recs.push({ itemName: "Microfiber Cloths", type: "part", quantity: round(totalUnits), unit: "pcs", scope: "consumable", reason: "One per unit", available: 0 });
  }

  // Common repair parts from catalog
  const capacitors = findTools(["capacitor"]);
  if (capacitors.length) {
    recs.push({ itemName: capacitors[0].itemName, type: "part", quantity: Math.max(1, Math.round(totalUnits * 0.1)), unit: capacitors[0].unit || "pcs", scope: "spare", reason: "Common failure part (~10% of units)", toolId: capacitors[0]._id, available: (capacitors[0].quantity || 0) });
  }

  const filters = findTools(["filter", "air filter", "filter drier"]);
  if (filters.length) {
    recs.push({ itemName: filters[0].itemName, type: "part", quantity: round(totalUnits), unit: filters[0].unit || "pcs", scope: "consumable", reason: "One per unit", toolId: filters[0]._id, available: (filters[0].quantity || 0) });
  }

  const refrigerants = findTools(["refrigerant", "freon", "r410", "r22", "r32"]);
  if (refrigerants.length) {
    recs.push({ itemName: refrigerants[0].itemName, type: "part", quantity: round(totalUnits / 3), unit: refrigerants[0].unit || "kg", scope: "consumable", reason: "~1kg per 3 units", toolId: refrigerants[0]._id, available: (refrigerants[0].quantity || 0) });
  }

  const copperPipes = findTools(["copper pipe", "copper tubing", "refrigerant pipe"]);
  if (copperPipes.length) {
    recs.push({ itemName: copperPipes[0].itemName, type: "part", quantity: round(totalUnits * 2), unit: copperPipes[0].unit || "pcs", scope: "consumable", reason: "~2m per unit", toolId: copperPipes[0]._id, available: (copperPipes[0].quantity || 0) });
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
