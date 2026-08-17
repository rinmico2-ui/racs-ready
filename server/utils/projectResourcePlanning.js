const mongoose = require("mongoose");
const Tool = require("../models/Tool");
const WorkOrder = require("../models/WorkOrder");
const EquipmentAssignment = require("../models/EquipmentAssignment");

const ACTIVE_ASSIGNMENT_STATUSES = ["reserved", "checked_out", "in_use"];
const VALID_TYPES = ["equipment", "consumable", "part"];
const VALID_RULES = ["fixed", "per_technician", "per_unit", "per_work_order", "shared"];
const VALID_STATES = ["recommended", "planned", "optional", "required", "rejected", "confirmed"];

function cleanType(value) {
  const type = value === "tool" ? "equipment" : String(value || "equipment").toLowerCase();
  return VALID_TYPES.includes(type) ? type : "equipment";
}

function calculateQuantity(resource, context) {
  const base = Math.max(0.01, Number(resource.baseQuantity ?? resource.quantity) || 1);
  switch (resource.requirementRule) {
    case "per_technician": return Math.max(1, Math.ceil(base * context.teamSize));
    case "per_unit": return Math.max(1, Math.ceil(base * context.totalUnits));
    case "per_work_order": return Math.max(1, Math.ceil(base * context.workOrderCount));
    case "shared":
    case "fixed":
    default: return Math.max(1, Math.ceil(Number(resource.quantity) || base));
  }
}

function summarize(resources) {
  const active = resources.filter(r => r.recommendationState !== "rejected");
  const summary = {
    status: "ready", total: active.length, available: 0, partial: 0,
    procurement: 0, conflicts: 0, optional: 0, blockers: [],
    estimatedDirectMaterialCost: 0,
  };
  active.forEach(resource => {
    if (resource.readinessStatus === "available" || resource.readinessStatus === "confirmed") summary.available++;
    if (resource.readinessStatus === "partially_available") summary.partial++;
    if (resource.readinessStatus === "procurement_required") summary.procurement++;
    if (resource.readinessStatus === "equipment_conflict") summary.conflicts++;
    if (resource.readinessStatus === "optional") summary.optional++;
    if (resource.type !== "equipment") summary.estimatedDirectMaterialCost += Number(resource.estimatedCost || 0);
    if (!["optional", "rejected"].includes(resource.recommendationState) &&
        ["partially_available", "procurement_required", "equipment_conflict"].includes(resource.readinessStatus)) {
      summary.blockers.push(`${resource.itemName}: ${resource.readinessStatus.replace(/_/g, " ")}${resource.shortage ? ` (${resource.shortage} ${resource.unit || "pcs"} short)` : ""}`);
    }
  });
  if (summary.blockers.length) {
    const unresolved = active.filter(resource =>
      !["optional", "rejected"].includes(resource.recommendationState) &&
      ["partially_available", "procurement_required", "equipment_conflict"].includes(resource.readinessStatus)
    );
    summary.status = unresolved.some(resource => ["ordered", "partially_received"].includes(resource.purchaseStatus)) ? "partial" : "blocked";
  }
  if (summary.status === "ready" && active.some(resource => resource.recommendationState === "recommended" && resource.type !== "part")) summary.status = "review_required";
  if (!active.length) summary.status = "not_planned";
  return summary;
}

async function evaluateProjectResources(project, inputResources) {
  const workOrders = await WorkOrder.find({ projectId: project._id })
    .select("_id title section unitCount sortOrder scheduledDate").sort({ sortOrder: 1 }).lean();
  const context = {
    teamSize: Math.max(1, (project.assignedTechnicians || []).filter(member => {
      const row = (project.teamStatus || []).find(status => String(status._id) === String(member._id));
      return !row || row.status !== "declined";
    }).length),
    totalUnits: Math.max(1, Number(project.totalUnits || project.quantity) || workOrders.reduce((sum, wo) => sum + Number(wo.unitCount || 0), 0) || 1),
    workOrderCount: Math.max(1, workOrders.length),
  };
  const toolIds = inputResources.map(item => item.toolId).filter(id => mongoose.Types.ObjectId.isValid(id));
  const tools = await Tool.find({ _id: { $in: toolIds } }).lean();
  const toolMap = new Map(tools.map(tool => [String(tool._id), tool]));
  const start = project.plannedStartDate || project.preferredStartDate;
  const end = project.plannedCompletionDate || project.preferredCompletionDeadline || start;
  let conflictRows = [];
  if (toolIds.length && start && end) {
    conflictRows = await EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      projectId: { $ne: project._id },
      status: { $in: ACTIVE_ASSIGNMENT_STATUSES },
      workDate: { $gte: new Date(start), $lte: new Date(end) },
    }).select("equipmentId quantity workDate projectId equipmentName").lean();
  }

  const resources = inputResources.map(raw => {
    const item = typeof raw.toObject === "function" ? raw.toObject() : { ...raw };
    const type = cleanType(item.type);
    const requirementRule = VALID_RULES.includes(item.requirementRule) ? item.requirementRule : (item.scope === "shared" ? "shared" : "fixed");
    const recommendationState = VALID_STATES.includes(item.recommendationState) ? item.recommendationState : "recommended";
    const quantity = calculateQuantity({ ...item, requirementRule }, context);
    const tool = item.toolId ? toolMap.get(String(item.toolId)) : null;
    const owned = Number(tool?.quantity || item.owned || 0);
    const stockAvailable = Math.max(0, owned - Number(tool?.reservedQuantity || 0));
    const conflicts = type === "equipment" ? conflictRows.filter(row => String(row.equipmentId) === String(item.toolId)) : [];
    const conflictByDay = conflicts.reduce((map, row) => {
      const day = new Date(row.workDate).toISOString().slice(0, 10);
      map.set(day, (map.get(day) || 0) + Number(row.quantity || 0));
      return map;
    }, new Map());
    // The same asset assigned across several project days is counted once per
    // day; readiness is based on the peak overlapping daily requirement.
    const assignedElsewhere = Math.max(0, ...conflictByDay.values());
    const available = Math.max(0, Math.min(stockAvailable, owned - assignedElsewhere));
    const shortage = Math.max(0, quantity - available);
    let readinessStatus = "available";
    // AI repair parts stay optional until explicitly included. Equipment and
    // consumables are real planning requirements even before bulk acceptance,
    // so inventory shortages must remain visible and block final confirmation.
    if (recommendationState === "optional" || (recommendationState === "recommended" && type === "part")) readinessStatus = "optional";
    else if (type === "equipment" && shortage > 0 && owned >= quantity && assignedElsewhere > 0) readinessStatus = "equipment_conflict";
    else if (shortage >= quantity) readinessStatus = "procurement_required";
    else if (shortage > 0) readinessStatus = "partially_available";
    else if (recommendationState === "confirmed") readinessStatus = "confirmed";
    const selectedIds = (item.affectedWorkOrderIds || []).map(String);
    const affected = workOrders.filter(wo => !selectedIds.length || selectedIds.includes(String(wo._id)));
    const purchaseCost = Number(tool?.costPrice ?? item.purchaseCost) || 0;
    const sellingPrice = Number(tool?.sellingPrice ?? item.sellingPrice) || 0;
    return {
      ...item,
      type, requirementRule, recommendationState, quantity,
      baseQuantity: Math.max(0.01, Number(item.baseQuantity ?? item.quantity) || 1),
      originalQuantity: Math.max(1, Number(item.originalQuantity ?? item.quantity) || 1),
      unit: item.unit || tool?.unit || "pcs",
      itemName: item.itemName || tool?.itemName || "Resource",
      owned, available, assignedElsewhere, shortage, readinessStatus,
      affectedWorkOrderIds: affected.map(wo => wo._id),
      affectedWorkOrders: affected.map((wo, index) => ({ _id: wo._id, number: `WO-${String(index + 1).padStart(3, "0")}`, title: wo.title || wo.section || "Work Order", unitCount: wo.unitCount || 0 })),
      purchaseCost, sellingPrice,
      estimatedCost: type === "equipment" ? 0 : purchaseCost * quantity,
      conflicts: conflicts.map(row => ({ projectId: row.projectId, date: row.workDate, quantity: row.quantity || 1 })),
    };
  });
  return { resources, readiness: { ...summarize(resources), checkedAt: new Date() }, context };
}

module.exports = { cleanType, evaluateProjectResources, summarize, VALID_RULES, VALID_STATES };
