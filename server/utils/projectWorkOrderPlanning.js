const WorkOrder = require("../models/WorkOrder");

function projectUnits(project, booking) {
  const groups = project.unitGroups?.length
    ? project.unitGroups
    : (booking?.services || []).map((service, index) => ({
        groupIndex: index, serviceId: service.serviceId, serviceName: service.name,
        serviceType: service.type || booking.serviceType || "core",
        unitType: service.airconTypeName || service.applianceTypeName || service.name,
        applianceType: service.applianceType || service.airconType,
        brand: service.brand, model: service.model, quantity: service.quantity,
        duration: service.duration || booking.serviceDurationMinutes,
      }));
  const fallback = !groups.length ? [{
    groupIndex: 0, serviceName: project.service?.name || booking?.service?.name || "HVAC Service",
    serviceType: project.repair?.serviceType || booking?.serviceType || "core",
    unitType: project.repair?.unitInfo?.unitType || booking?.applianceTypeName || "HVAC Unit",
    brand: project.repair?.unitInfo?.brand || booking?.brand,
    model: project.repair?.unitInfo?.model || booking?.model,
    quantity: project.totalUnits || project.quantity || 1,
    duration: project.estimatedDurationPerUnit ? project.estimatedDurationPerUnit * 60 : booking?.serviceDurationMinutes,
  }] : groups;
  const result = [];
  fallback.forEach((group, groupPosition) => {
    const count = Math.max(1, Number(group.quantity) || 1);
    for (let index = 1; index <= count; index++) {
      const groupIndex = group.groupIndex ?? groupPosition;
      result.push({
        unitKey: `G${groupIndex + 1}-U${String(index).padStart(3, "0")}`,
        label: `${group.unitType || group.serviceName || "Unit"} ${index}`,
        groupIndex, serviceId: group.serviceId,
        serviceType: group.serviceType === "repair" ? "repair" : "core",
        serviceName: group.serviceName || project.service?.name || "HVAC Service",
        applianceType: group.applianceType || group.unitType || "",
        brand: group.brand || "", model: group.model || "",
        location: group.location || group.section || project.location?.address || booking?.location?.address || "Customer site",
        durationMinutes: Math.max(15, Number(group.duration || booking?.serviceDurationMinutes || (project.estimatedDurationPerUnit || 1) * 60)),
      });
    }
  });
  return result.slice(0, Math.max(1, Number(project.totalUnits || project.quantity) || result.length));
}

function hasCycle(workOrders) {
  const graph = new Map(workOrders.map(order => [String(order._id), (order.dependencies || []).map(String)]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  return [...graph.keys()].some(visit);
}

async function validateWorkOrderPlan(project, booking) {
  const workOrders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } }).sort({ sortOrder: 1 }).lean();
  const expected = projectUnits(project, booking);
  const expectedKeys = new Set(expected.map(unit => unit.unitKey));
  const counts = new Map();
  workOrders.forEach(order => (order.units || []).forEach(unit => counts.set(unit.unitKey, (counts.get(unit.unitKey) || 0) + 1)));
  const legacyAssigned = workOrders.filter(order => !(order.units || []).length).reduce((sum, order) => sum + Number(order.unitCount || 0), 0);
  const covered = [...expectedKeys].filter(key => counts.has(key)).length + Math.min(legacyAssigned, expectedKeys.size);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  const uncovered = expected.filter(unit => !counts.has(unit.unitKey)).slice(legacyAssigned);
  const errors = [];
  const siblingIds = new Set(workOrders.map(row => String(row._id)));
  const plannedResources = (project.planningDraft?.resources || []).filter(resource => resource.recommendationState !== "rejected");
  if (covered < expected.length) errors.push(`${expected.length - covered} project unit(s) are not assigned to a work order`);
  if (duplicates.length) errors.push(`${duplicates.length} unit(s) are assigned more than once`);
  workOrders.forEach(order => {
    const number = order.workOrderNumber || order.title || "Work order";
    if (!order.serviceType) errors.push(`${number} has no service type`);
    if (!(order.location?.label || order.section || order.location?.address)) errors.push(`${number} has no location`);
    if (!(Number(order.estimatedHours) > 0)) errors.push(`${number} has no estimated duration`);
    if ((order.dependencies || []).some(id => String(id) === String(order._id) || !siblingIds.has(String(id)))) errors.push(`${number} has an invalid dependency`);
    for (const dependencyId of order.dependencies || []) {
      const prerequisite = workOrders.find(row => String(row._id) === String(dependencyId));
      if (order.scheduledDate && prerequisite?.scheduledDate && new Date(order.scheduledDate) <= new Date(prerequisite.scheduledDate)) {
        errors.push(`${number} must be scheduled after ${prerequisite.workOrderNumber || prerequisite.title || "its prerequisite"}`);
      }
    }
    if (plannedResources.length && !(order.resourceRequirements || []).length) errors.push(`${number} has no linked resource requirements`);
  });
  if (hasCycle(workOrders)) errors.push("Work-order dependencies contain a circular reference");
  return {
    ready: workOrders.length > 0 && errors.length === 0,
    totalUnits: expected.length, assignedUnits: Math.min(expected.length, covered),
    uncoveredUnits: Math.max(0, expected.length - covered), duplicateUnits: duplicates.length,
    workOrderCount: workOrders.length, errors,
    units: expected, workOrders,
  };
}

function resourcesForWorkOrder(project, workOrder) {
  return (project.planningDraft?.resources || []).filter(resource => {
    if (["rejected"].includes(resource.recommendationState)) return false;
    const ids = (resource.affectedWorkOrderIds || []).map(String);
    return !ids.length || ids.includes(String(workOrder._id));
  }).map(resource => ({
    planningResourceId: resource._id, toolId: resource.toolId || null,
    itemName: resource.itemName, type: resource.type,
    quantity: resource.requirementRule === "per_unit"
      ? Math.max(1, Math.ceil(Number(resource.baseQuantity || 1) * Number(workOrder.unitCount || 1)))
      : Math.max(1, Number(resource.quantity || 1)),
    unit: resource.unit || "pcs",
  }));
}

module.exports = { projectUnits, validateWorkOrderPlan, resourcesForWorkOrder, hasCycle };
