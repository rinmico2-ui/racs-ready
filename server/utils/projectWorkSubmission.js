function parseArrayField(value, fieldName) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      throw Object.assign(new Error(`${fieldName} must be valid JSON.`), { status: 400 });
    }
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error(`${fieldName} must be an array.`), { status: 400 });
  }
  return parsed;
}

function normalizeProjectWorkSubmission(body = {}) {
  const rawWorkOrders = parseArrayField(body.workOrders, "workOrders");
  if (!rawWorkOrders.length || rawWorkOrders.length > 50) {
    throw Object.assign(new Error("Submit between 1 and 50 work-order lines."), { status: 400 });
  }

  const workOrderIds = new Set();
  const workOrders = rawWorkOrders.map((row) => {
    const workOrderId = String(row?.workOrderId || "").trim();
    const completedUnits = Number(row?.completedUnits);
    if (!workOrderId) throw Object.assign(new Error("Every work-order line needs an id."), { status: 400 });
    if (workOrderIds.has(workOrderId)) throw Object.assign(new Error("A work order can only appear once per submission."), { status: 400 });
    if (!Number.isInteger(completedUnits) || completedUnits < 1) {
      throw Object.assign(new Error("Completed units must be whole numbers greater than zero."), { status: 400 });
    }
    workOrderIds.add(workOrderId);
    return { workOrderId, completedUnits };
  });

  const rawConsumables = body.consumables == null || body.consumables === ""
    ? []
    : parseArrayField(body.consumables, "consumables");
  if (rawConsumables.length > 100) {
    throw Object.assign(new Error("A submission cannot contain more than 100 consumable lines."), { status: 400 });
  }

  const assignmentIds = new Set();
  const consumables = rawConsumables.map((row) => {
    const assignmentId = String(row?.assignmentId || "").trim();
    const quantityUsed = Number(row?.quantityUsed);
    if (!assignmentId) throw Object.assign(new Error("Every consumable line needs an assignment id."), { status: 400 });
    if (assignmentIds.has(assignmentId)) throw Object.assign(new Error("A consumable can only appear once per submission."), { status: 400 });
    if (!Number.isFinite(quantityUsed) || quantityUsed <= 0 || quantityUsed > 1000000) {
      throw Object.assign(new Error("Consumable quantities must be greater than zero."), { status: 400 });
    }
    assignmentIds.add(assignmentId);
    return { assignmentId, quantityUsed: Math.round(quantityUsed * 1000) / 1000 };
  });

  const consumablesDeclaredNone = body.consumablesDeclaredNone === true || body.consumablesDeclaredNone === "true";
  if (!consumables.length && !consumablesDeclaredNone) {
    throw Object.assign(new Error("List the consumables used or explicitly confirm that none were used."), { status: 400 });
  }

  const clientSubmissionId = String(body.clientSubmissionId || "").trim();
  if (!clientSubmissionId || clientSubmissionId.length > 100) {
    throw Object.assign(new Error("A valid client submission id is required."), { status: 400 });
  }

  return {
    workOrders,
    consumables,
    consumablesDeclaredNone,
    clientSubmissionId,
    notes: String(body.notes || "").trim().slice(0, 1000),
  };
}

module.exports = { normalizeProjectWorkSubmission, parseArrayField };
