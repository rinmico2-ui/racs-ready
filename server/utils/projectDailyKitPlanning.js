function id(value) {
  return String(value?._id || value || "");
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : fallback;
}

/**
 * Deterministically split an integer quantity over schedule rows.
 * Largest-remainder allocation preserves the exact total and prevents every
 * crew member/day from independently receiving the full work-order quantity.
 */
function allocateInteger(total, rows, weightFor = () => 1) {
  const quantity = positiveInteger(total);
  const ordered = [...(rows || [])]
    .filter(row => id(row))
    .sort((a, b) => id(a).localeCompare(id(b)));
  const result = new Map(ordered.map(row => [id(row), 0]));
  if (!quantity || !ordered.length) return result;

  let weights = ordered.map(row => Math.max(0, Number(weightFor(row)) || 0));
  if (!weights.some(Boolean)) weights = ordered.map(() => 1);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const shares = ordered.map((row, index) => {
    const exact = quantity * weights[index] / weightTotal;
    const floor = Math.floor(exact);
    result.set(id(row), floor);
    return { row, floor, remainder: exact - floor };
  });
  let remaining = quantity - shares.reduce((sum, share) => sum + share.floor, 0);
  shares.sort((a, b) => b.remainder - a.remainder || id(a.row).localeCompare(id(b.row)));
  for (let index = 0; index < remaining; index += 1) {
    const key = id(shares[index % shares.length].row);
    result.set(key, result.get(key) + 1);
  }
  return result;
}

function assignmentWeight(row) {
  return positiveInteger(row.targetUnits) || positiveInteger(row.allocatedMinutes) || 1;
}

/**
 * Convert confirmed project execution rows into requirements for one
 * technician/day. Equipment is split across that day's crew and is reusable;
 * consumables/parts are apportioned once across the complete work-order plan.
 */
function buildProjectKitRequirements({ targetAssignments = [], allAssignments = [], workOrders = [] } = {}) {
  const orderMap = new Map(workOrders.map(order => [id(order), order]));
  const assignmentsByOrder = new Map();
  for (const row of allAssignments) {
    const key = id(row.workOrderId);
    if (!key) continue;
    if (!assignmentsByOrder.has(key)) assignmentsByOrder.set(key, []);
    assignmentsByOrder.get(key).push(row);
  }

  const requirements = [];
  for (const target of targetAssignments) {
    const workOrder = orderMap.get(id(target.workOrderId));
    if (!workOrder) continue;
    const scheduleRows = assignmentsByOrder.get(id(workOrder)) || [target];
    const sameDayRows = scheduleRows.filter(row => {
      const a = new Date(row.date); a.setHours(0, 0, 0, 0);
      const b = new Date(target.date); b.setHours(0, 0, 0, 0);
      return a.getTime() === b.getTime();
    });

    for (const resource of workOrder.resourceRequirements || []) {
      if (!resource?.itemName || !["equipment", "consumable", "part"].includes(resource.type)) continue;
      const distribution = resource.type === "equipment"
        ? allocateInteger(resource.quantity, sameDayRows, () => 1)
        : allocateInteger(resource.quantity, scheduleRows, assignmentWeight);
      const quantity = distribution.get(id(target)) || 0;
      if (!quantity) continue;
      requirements.push({
        inventoryId: resource.toolId || null,
        name: resource.itemName,
        kind: resource.type === "part" ? "repair_part" : resource.type,
        quantity,
        unit: resource.unit || "pcs",
        projectId: target.projectId,
        workOrderId: target.workOrderId,
        dailyAssignmentId: target._id,
      });
    }
  }
  return requirements;
}

module.exports = { allocateInteger, buildProjectKitRequirements };
