const mongoose = require("mongoose");
const Assignment = require("../models/Assignment");
const BookingService = require("../models/BookingService");
const DailyKit = require("../models/DailyKit");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Tool = require("../models/Tool");
const { buildServicePreparation } = require("./servicePreparation");

const ACTIVE_ASSIGNMENT_STATUSES = ["accepted", "en_route", "on_site", "in_progress"];

function dayBounds(value = new Date()) {
  const start = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(start.getTime())) throw Object.assign(new Error("Invalid work date"), { status: 400 });
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean).map(String))].map(id => new mongoose.Types.ObjectId(id));
}

function mergeRequirement(map, rec, assignment, booking) {
  if (!rec || !rec.name || !["equipment", "consumable"].includes(rec.kind)) return;
  const key = rec.inventoryId ? `${rec.kind}:id:${rec.inventoryId}` : `${rec.kind}:name:${String(rec.name).trim().toLowerCase()}`;
  const quantity = Math.max(1, Number(rec.quantity || 1)) * Math.max(1, Number(assignment.quantity || 1));
  const current = map.get(key) || {
    name: rec.name,
    quantity: 0,
    unit: rec.unit || "pcs",
    category: rec.kind,
    source: "job_specific",
    toolId: rec.inventoryId || null,
    assignmentIds: [],
    bookingIds: [],
  };
  // Reusable equipment is carried once. Consumables cover total daily demand.
  current.quantity = rec.kind === "equipment" ? Math.max(1, current.quantity, quantity) : current.quantity + quantity;
  current.assignmentIds.push(assignment._id);
  current.bookingIds.push(booking._id);
  map.set(key, current);
}

async function requirementsFor(assignments, bookings) {
  const bookingMap = new Map(bookings.map(booking => [String(booking._id), booking]));
  const requirements = new Map();
  for (const assignment of assignments) {
    const booking = bookingMap.get(String(assignment.bookingId));
    if (!booking) continue;
    const prep = await buildServicePreparation(booking);
    for (const rec of prep.recommendations || []) mergeRequirement(requirements, rec, assignment, booking);
  }
  return [...requirements.values()].map(item => ({
    ...item,
    assignmentIds: uniqueIds(item.assignmentIds),
    bookingIds: uniqueIds(item.bookingIds),
  }));
}

async function hydrateAvailability(items, technicianId, start, end) {
  const toolIds = uniqueIds(items.map(item => item.toolId));
  const [tools, otherCheckouts] = await Promise.all([
    Tool.find({ _id: { $in: toolIds } }).lean(),
    EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      technicianId: { $ne: technicianId },
      status: { $in: ["reserved", "checked_out", "in_use"] },
      workDate: { $gte: start, $lt: end },
      consumable: { $ne: true },
    }).populate("technicianId", "name").lean(),
  ]);
  const toolMap = new Map(tools.map(tool => [String(tool._id), tool]));
  const conflictMap = new Map(otherCheckouts.map(row => [String(row.equipmentId), row]));

  return items.map(item => {
    const tool = toolMap.get(String(item.toolId));
    const standardQty = tool?.standardTechnicianKit ? Number(tool.standardKitQuantity || 1) : 0;
    if (standardQty >= item.quantity) return { ...item, checkoutStatus: "standard_kit", conflict: { isUnavailable: false } };
    const needed = Math.max(0, item.quantity - standardQty);
    const available = Math.max(0, Number(tool?.quantity || 0) - Number(tool?.reservedQuantity || 0));
    const conflict = item.category === "equipment" ? conflictMap.get(String(item.toolId)) : null;
    const unusable = !tool || tool.active === false || (item.category === "equipment" && (
      Tool.effectiveInventoryClass(tool) !== "operational_asset" || tool.assignable === false ||
      ["under_maintenance", "damaged", "retired"].includes(tool.assetStatus)
    ));
    const unavailable = unusable || available < needed || Boolean(conflict && available < needed);
    return {
      ...item,
      quantity: needed || item.quantity,
      toolCode: tool?.assetCode || tool?.barcode || null,
      checkoutStatus: unavailable ? "unavailable" : "pending",
      conflict: unavailable ? {
        isUnavailable: true,
        checkedOutTo: conflict?.technicianId?.name || null,
        message: !tool
          ? `${item.name} is required but is missing or misclassified in the inventory catalog`
          : conflict?.technicianId?.name
          ? `${item.name} is checked out to ${conflict.technicianId.name}`
          : `${item.name} requires ${needed}, but only ${available} is available`,
      } : { isUnavailable: false },
    };
  });
}

async function syncDailyKit(technicianId, date) {
  const { start, end } = dayBounds(date);
  const assignments = await Assignment.find({
    technicianId,
    status: { $in: ACTIVE_ASSIGNMENT_STATUSES },
    bookingDate: { $gte: start, $lt: end },
  }).sort({ startTime: 1 }).lean();
  const bookingIds = uniqueIds(assignments.map(row => row.bookingId));
  const bookings = await BookingService.find({ _id: { $in: bookingIds } }).lean();
  const required = await hydrateAvailability(await requirementsFor(assignments, bookings), technicianId, start, end);
  let kit = await DailyKit.findOne({ technicianId, workDate: start });

  if (!kit) {
    kit = await DailyKit.create({ technicianId, workDate: start, items: required, assignmentIds: assignments.map(a => a._id), bookingIds });
    return kit;
  }

  if (!["confirmed", "in_progress"].includes(kit.status)) {
    kit.items = required;
    kit.assignmentIds = assignments.map(a => a._id);
    kit.bookingIds = bookingIds;
    kit.hasDelta = false;
    kit.deltaItems = [];
    await kit.save();
    return kit;
  }

  const itemKey = item => item.toolId ? `${item.category}:id:${item.toolId}` : `${item.category}:name:${String(item.name).trim().toLowerCase()}`;
  const existing = new Map(kit.items.map(item => [itemKey(item), item]));
  const additions = [];
  for (const requirement of required) {
    const old = existing.get(itemKey(requirement));
    if (!old) { additions.push(requirement); continue; }
    old.assignmentIds = uniqueIds([...old.assignmentIds, ...requirement.assignmentIds]);
    old.bookingIds = uniqueIds([...old.bookingIds, ...requirement.bookingIds]);
    if (requirement.quantity > old.quantity && ["confirmed", "in_progress"].includes(kit.status)) {
      additions.push({ ...requirement, quantity: requirement.quantity - old.quantity });
    } else if (!["confirmed", "in_progress"].includes(kit.status)) {
      old.quantity = requirement.quantity;
      old.checkoutStatus = requirement.checkoutStatus;
      old.conflict = requirement.conflict;
    }
  }
  kit.assignmentIds = uniqueIds(assignments.map(a => a._id));
  kit.bookingIds = bookingIds;
  kit.deltaItems = additions;
  kit.hasDelta = additions.length > 0;
  if (!["confirmed", "in_progress"].includes(kit.status)) kit.items = [...existing.values(), ...additions];
  await kit.save();
  return kit;
}

async function confirmDailyKit({ technicianId, userId, date }) {
  const { start } = dayBounds(date);
  const kit = await syncDailyKit(technicianId, start);
  const items = kit.status === "confirmed" && kit.hasDelta ? kit.deltaItems : kit.items;
  const blocked = items.filter(item => item.checkoutStatus === "unavailable" && !item.exception?.approved);
  if (blocked.length) throw Object.assign(new Error("Resolve unavailable equipment before confirming the Daily Kit."), { status: 409, unavailable: blocked });

  for (const item of items) {
    if (["standard_kit", "exception", "checked_out", "issued"].includes(item.checkoutStatus)) continue;
    const updated = await Tool.findOneAndUpdate({
      _id: item.toolId,
      quantity: { $gte: item.quantity },
      ...(item.category === "equipment" ? { assignable: { $ne: false }, assetStatus: { $nin: ["under_maintenance", "damaged", "retired"] } } : {}),
    }, {
      $inc: item.category === "equipment"
        ? { quantity: -item.quantity, checkedOutQuantity: item.quantity }
        : { quantity: -item.quantity },
      ...(item.category === "equipment" ? { $set: { assetStatus: "checked_out" } } : {}),
    }, { new: true });
    if (!updated) throw Object.assign(new Error(`${item.name} became unavailable. Refresh the kit and resolve the conflict.`), { status: 409 });

    if (item.category === "equipment") {
      const ledger = await EquipmentAssignment.create({
        dailyKitId: kit._id, bookingId: item.bookingIds[0] || null, technicianId, workDate: start,
        equipmentId: item.toolId, equipmentName: item.name, equipmentCode: item.toolCode || "",
        quantity: item.quantity, consumable: false, status: "checked_out", checkedOutAt: new Date(), checkedOutBy: userId,
        notes: `Daily Kit; used for bookings: ${item.bookingIds.join(", ")}`,
      });
      item.equipmentAssignmentId = ledger._id;
      item.checkoutStatus = "checked_out";
      item.checkedOutAt = new Date();
    } else {
      item.quantityIssued = item.quantity;
      item.checkoutStatus = "issued";
    }
  }

  if (kit.hasDelta) {
    for (const delta of kit.deltaItems) {
      const existing = kit.items.find(item => String(item.toolId) === String(delta.toolId) && item.category === delta.category);
      if (existing) {
        existing.quantity += delta.quantity;
        if (delta.category === "consumable") existing.quantityIssued += delta.quantityIssued;
        existing.assignmentIds = uniqueIds([...existing.assignmentIds, ...delta.assignmentIds]);
        existing.bookingIds = uniqueIds([...existing.bookingIds, ...delta.bookingIds]);
      } else kit.items.push(delta.toObject ? delta.toObject() : delta);
    }
  }
  kit.status = "confirmed";
  kit.confirmedAt = new Date();
  kit.hasDelta = false;
  kit.deltaItems = [];
  await kit.save();

  await Assignment.updateMany({ _id: { $in: kit.assignmentIds } }, {
    $set: { equipmentCheckedOut: true, equipmentCheckedOutAt: new Date(), preparationStatus: "checked_out", preparationIssue: "" },
  });
  await BookingService.updateMany({ _id: { $in: kit.bookingIds } }, {
    $set: { "servicePreparation.confirmed": true, "servicePreparation.confirmedAt": new Date(), "servicePreparation.confirmedBy": technicianId },
  });
  return kit;
}

module.exports = { dayBounds, syncDailyKit, confirmDailyKit };
