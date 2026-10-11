const ACTIVE = ["checked_out", "in_use"];
const CLOSED_BOOKINGS = ["completed", "repair_completed", "cancelled", "repair_declined"];
const id = value => String(value?._id || value || "");
const ids = values => [...new Set(values.filter(Boolean).map(id))];
const fail = (status, message) => Object.assign(new Error(message), { status });

function usageDay(value, now = new Date()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(400, "Choose a valid date.");
  const start = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || new Date(start.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== value) throw fail(400, "Choose a valid date.");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (value > today) throw fail(400, "Choose today or an earlier date.");
  return { start, end: new Date(start.getTime() + 86400000) };
}

function createService(overrides = {}) {
  const defaults = () => ({
    mongoose: require("mongoose"),
    ...Object.fromEntries(["EquipmentAssignment", "ToolAssignment", "Tool", "DailyKit", "Assignment", "BookingService", "Order", "DailyAssignment", "WorkOrder", "Project", "EquipmentUsageLog", "Notification"].map(name => [name, require(`../models/${name}`)])),
  });
  const m = { ...defaults(), ...overrides };
  const scope = technicianIds => ({ technicianId: { $in: technicianIds } });

  async function usageOptions(technicianIds, date) {
    const { start, end } = usageDay(date);
    const [equipment, legacy] = await Promise.all([
      m.EquipmentAssignment.find({ ...scope(technicianIds), consumable: { $ne: true }, status: { $in: [...ACTIVE, "returned", "damaged", "lost"] }, $and: [{ $or: [{ checkedOutAt: { $lt: end } }, { checkedOutAt: null, issuedAt: { $lt: end } }, { checkedOutAt: null, issuedAt: null, workDate: { $lt: end } }] }, { $or: [{ returnedAt: { $exists: false } }, { returnedAt: null }, { returnedAt: { $gte: start } }] }] }).select("equipmentId equipmentName equipmentCode").lean(),
      m.ToolAssignment.find({ ...scope(technicianIds), itemType: { $in: ["equipment", "tool"] }, assignedDate: { $lt: end }, $or: [{ returnedDate: null }, { returnedDate: { $gte: start } }] }).select("toolId toolName toolBarcode").lean(),
    ]);
    const options = new Map();
    for (const row of equipment) options.set(id(row.equipmentId), { _id: id(row.equipmentId), name: row.equipmentName, code: row.equipmentCode || "" });
    for (const row of legacy) if (!options.has(id(row.toolId))) options.set(id(row.toolId), { _id: id(row.toolId), name: row.toolName, code: row.toolBarcode || "" });
    return [...options.values()].filter(row => row._id).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function logUsage({ technicianId, technicianIds, userId, equipmentId, date, notes }) {
    if (!m.mongoose.isValidObjectId(equipmentId)) throw fail(400, "Choose an equipment item.");
    const { start } = usageDay(date);
    if (typeof notes !== "undefined" && typeof notes !== "string") throw fail(400, "Enter valid notes.");
    if ((notes || "").trim().length > 500) throw fail(400, "Keep notes within 500 characters.");
    const options = await usageOptions(technicianIds, date);
    if (!options.some(row => row._id === id(equipmentId))) throw fail(403, "You can only log equipment issued to you on this date.");
    const tool = await m.Tool.findById(equipmentId).lean();
    if (!tool) throw fail(404, "This equipment is no longer in the inventory.");
    return m.EquipmentUsageLog.create({ technicianId, equipmentId, equipmentName: tool.itemName, equipmentCode: tool.assetCode || tool.barcode || "", date: start, notes: (notes || "").trim(), createdBy: userId });
  }

  async function assertWorkFinished(assignment, rows, session) {
    const links = (key, singular) => ids([...(assignment[key] || []), ...(singular ? [assignment[singular]] : []), ...rows.flatMap(row => row[key] || [])]);
    const checks = [
      [m.BookingService, links("bookingIds", "bookingId"), CLOSED_BOOKINGS],
      [m.Order, links("orderIds"), ["completed", "cancelled"]],
      [m.DailyAssignment, links("dailyAssignmentIds"), ["completed", "skipped"]],
    ];
    // A completed day's project work can release equipment while the project continues.
    if (!links("dailyAssignmentIds").length) {
      const workOrders = links("workOrderIds", "workOrderId");
      checks.push(workOrders.length ? [m.WorkOrder, workOrders, ["completed", "cancelled", "declined", "rescheduled"]] : [m.Project, links("projectIds", "projectId"), ["completed", "cancelled"]]);
    }
    for (const [Model, linkedIds, closed] of checks) {
      if (!linkedIds.length) continue;
      const open = await Model.exists({ _id: { $in: linkedIds }, status: { $nin: closed } }).session(session);
      if (open) throw fail(409, "This equipment is still needed for unfinished work. Finish the work before returning it, or report damage if it cannot be used.");
    }
  }

  async function returnEquipment({ assignmentIds, technicianIds, userId, condition = "good", damageDescription = "" }) {
    if (!["good", "fair", "damaged", "lost"].includes(condition)) throw fail(400, "Choose the equipment condition.");
    if (typeof damageDescription !== "string" || damageDescription.trim().length > 500) throw fail(400, "Keep notes within 500 characters.");
    const note = damageDescription.trim();
    if (["damaged", "lost"].includes(condition) && !note) throw fail(400, "Add a short note about the damage or missing equipment.");
    if (!assignmentIds?.length || assignmentIds.some(value => !m.mongoose.isValidObjectId(value))) throw fail(400, "Choose a valid equipment record.");
    const session = await m.mongoose.startSession();
    let results;
    try {
      await session.withTransaction(async () => {
        results = [];
        for (const assignmentId of ids(assignmentIds)) {
          const assignment = await m.EquipmentAssignment.findById(assignmentId).session(session).lean();
          if (!assignment) throw fail(404, "Equipment record not found.");
          if (!technicianIds.map(id).includes(id(assignment.technicianId))) throw fail(403, "This equipment was not issued to you.");
          if (assignment.consumable || !ACTIVE.includes(assignment.status) || ["processing", "resolved"].includes(assignment.resolutionState)) throw fail(409, "This equipment was already returned or is being processed.");
          const relatedKits = await m.DailyKit.find({ technicianId: { $in: technicianIds }, $or: [{ _id: assignment.dailyKitId || null }, { "items.equipmentAssignmentId": assignmentId }, { "deltaItems.equipmentAssignmentId": assignmentId }, { "items.custodyAssignmentIds": assignmentId }, { "deltaItems.custodyAssignmentIds": assignmentId }] }).session(session).lean();
          if (assignment.dailyKitId && !relatedKits.some(kit => id(kit._id) === id(assignment.dailyKitId))) throw fail(409, "The linked Daily Kit could not be found. Ask admin to check this record.");
          const rows = relatedKits.flatMap(kit => [...(kit.items || []), ...(kit.deltaItems || [])].filter(row => id(row.equipmentAssignmentId) === id(assignmentId) || (row.custodyAssignmentIds || []).some(value => id(value) === id(assignmentId)) || (id(kit._id) === id(assignment.dailyKitId) && row.category === "equipment" && id(row.toolId) === id(assignment.equipmentId))));
          if (["good", "fair"].includes(condition)) await assertWorkFinished(assignment, rows, session);
          const now = new Date();
          const status = ["good", "fair"].includes(condition) ? "returned" : condition;
          const claimed = await m.EquipmentAssignment.findOneAndUpdate({ _id: assignmentId, status: { $in: ACTIVE }, $or: [{ resolutionState: "open" }, { resolutionState: null }, { resolutionState: { $exists: false } }] }, { $set: { status, condition, damageDescription: note, returnedAt: now, returnedTo: id(userId), resolvedBy: userId, resolutionNotes: note, resolutionState: "resolved" } }, { session, returnDocument: "after", runValidators: true }).lean();
          if (!claimed) throw fail(409, "This equipment was already returned or is being processed.");
          const quantity = Number(assignment.quantity);
          if (!Number.isFinite(quantity) || quantity <= 0) throw fail(409, "The issued quantity needs an admin check.");
          const checkedOut = { $max: [0, { $subtract: [{ $ifNull: ["$checkedOutQuantity", 0] }, quantity] }] };
          const updates = { checkedOutQuantity: checkedOut, assetCondition: condition === "lost" ? "damaged" : condition, assetStatus: status === "returned" ? { $cond: [{ $gt: [checkedOut, 0] }, "checked_out", "available"] } : condition === "lost" ? "retired" : "damaged" };
          if (status === "returned") {
            const unavailable = { $in: ["$assetStatus", ["under_maintenance", "damaged", "retired"]] };
            updates.assetStatus = { $cond: [unavailable, "$assetStatus", updates.assetStatus] };
            updates.assetCondition = { $cond: [unavailable, "$assetCondition", condition] };
            updates.quantity = { $add: [{ $ifNull: ["$quantity", 0] }, quantity] };
            updates.status = { $cond: [{ $lte: [updates.quantity, 0] }, "out_of_stock", { $cond: [{ $lte: [updates.quantity, { $ifNull: ["$minStockLevel", 0] }] }, "low_stock", "in_stock"] }] };
          } else updates.assignable = false;
          const inventory = await m.Tool.updateOne({ _id: assignment.equipmentId }, [{ $set: updates }], { session, updatePipeline: true });
          if (!inventory.matchedCount) throw fail(409, "The linked inventory item is missing. Ask admin to check it.");
          // Update every affected row, including extra items and existing project custody.
          for (const related of relatedKits) {
            const custody = ids([...(related.items || []), ...(related.deltaItems || [])].filter(row => id(row.toolId) === id(assignment.equipmentId)).flatMap(row => [...(row.custodyAssignmentIds || []), row.equipmentAssignmentId]));
            const remaining = await m.EquipmentAssignment.exists({ equipmentId: assignment.equipmentId, status: { $in: ACTIVE }, $or: [{ dailyKitId: related._id }, { _id: { $in: custody } }] }).session(session);
            const sets = {};
            for (const key of ["items", "deltaItems"]) (related[key] || []).forEach((row, index) => {
              if (!rows.some(value => id(value._id) === id(row._id)) && id(row.equipmentAssignmentId) !== id(assignmentId) && !(row.custodyAssignmentIds || []).some(value => id(value) === id(assignmentId))) return;
              if (remaining && status === "returned") return;
              sets[`${key}.${index}.checkoutStatus`] = status === "returned" ? "returned" : "damaged";
              sets[`${key}.${index}.returnedAt`] = now;
            });
            if (Object.keys(sets).length) await m.DailyKit.updateOne({ _id: related._id }, { $set: sets }, { session });
          }
          const bookingIds = ids([assignment.bookingId, ...rows.flatMap(row => row.bookingIds || []), ...relatedKits.flatMap(kit => kit.bookingIds || [])]);
          const custodyIds = ids(relatedKits.flatMap(kit => [...(kit.items || []), ...(kit.deltaItems || [])].flatMap(row => [...(row.custodyAssignmentIds || []), row.equipmentAssignmentId])));
          for (const bookingId of bookingIds) {
            const remaining = await m.EquipmentAssignment.exists({ technicianId: { $in: technicianIds }, consumable: { $ne: true }, status: { $in: ACTIVE }, $or: [{ bookingId }, { dailyKitId: { $in: relatedKits.map(kit => kit._id) } }, { _id: { $in: custodyIds } }] }).session(session);
            if (!remaining) await m.Assignment.updateMany({ bookingId, technicianId: { $in: technicianIds } }, { $set: { equipmentReturned: true, equipmentReturnedAt: now } }, { session });
          }
          await m.Notification.updateMany({ referenceModel: "EquipmentAssignment", referenceId: assignmentId, type: "equipment_return_overdue", read: false }, { $set: { read: true, readAt: now } }, { session });
          results.push(claimed);
        }
      });
      return results;
    } catch (error) {
      if (/Transaction numbers are only allowed|does not support retryable writes/i.test(error.message)) throw fail(503, "Equipment returns are temporarily unavailable. Ask admin to check the database setup.");
      throw error;
    } finally { await session.endSession(); }
  }
  return { usageOptions, logUsage, returnEquipment };
}

module.exports = { createService, usageDay, ACTIVE };
