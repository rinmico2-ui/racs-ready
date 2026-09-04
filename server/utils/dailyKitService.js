const mongoose = require("mongoose");
const Assignment = require("../models/Assignment");
const BookingService = require("../models/BookingService");
const DailyAssignment = require("../models/DailyAssignment");
const DailyKit = require("../models/DailyKit");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Order = require("../models/Order");
const ServiceToolUsage = require("../models/ServiceToolUsage");
const StockReservation = require("../models/StockReservation");
const Tool = require("../models/Tool");
const WorkOrder = require("../models/WorkOrder");
const { buildServicePreparation } = require("./servicePreparation");
const { buildProjectKitRequirements } = require("./projectDailyKitPlanning");
const {
  ACTIVE_INSTALLATION_ORDER_STATUSES,
  buildOrderInstallationPreparation,
  orderInstallationReadiness,
  orderUnitCount,
} = require("./orderPreparation");

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

function mergeRequirement(map, rec, context = {}) {
  if (!rec || !rec.name || !["equipment", "consumable", "repair_part"].includes(rec.kind)) return;
  const key = rec.inventoryId ? `${rec.kind}:id:${rec.inventoryId}` : `${rec.kind}:name:${String(rec.name).trim().toLowerCase()}`;
  const quantity = Math.max(1, Number(rec.quantity || 1)) * Math.max(1, Number(context.multiplier || 1));
  const current = map.get(key) || {
    name: rec.name,
    quantity: 0,
    unit: rec.unit || "pcs",
    category: rec.kind,
    source: rec.kind === "repair_part" ? "quotation" : "job_specific",
    toolId: rec.inventoryId || null,
    assignmentIds: [],
    bookingIds: [],
    orderIds: [],
    orderAllocations: [],
    projectIds: [],
    workOrderIds: [],
    dailyAssignmentIds: [],
    projectAllocations: [],
  };
  // Reusable equipment is carried once. Consumables/parts cover total daily demand.
  current.quantity = rec.kind === "equipment" ? Math.max(1, current.quantity, quantity) : current.quantity + quantity;
  if (context.assignmentId) current.assignmentIds.push(context.assignmentId);
  if (context.bookingId) current.bookingIds.push(context.bookingId);
  if (context.orderId) {
    current.orderIds.push(context.orderId);
    const allocation = current.orderAllocations.find(row => String(row.orderId) === String(context.orderId));
    if (allocation) {
      allocation.quantity = rec.kind === "equipment"
        ? Math.max(allocation.quantity, quantity)
        : allocation.quantity + quantity;
    } else {
      current.orderAllocations.push({ orderId: context.orderId, quantity });
    }
  }
  if (context.projectId) current.projectIds.push(context.projectId);
  if (context.workOrderId) current.workOrderIds.push(context.workOrderId);
  if (context.dailyAssignmentId) current.dailyAssignmentIds.push(context.dailyAssignmentId);
  if (context.projectId) {
    current.projectAllocations.push({
      projectId: context.projectId,
      workOrderId: context.workOrderId || null,
      dailyAssignmentId: context.dailyAssignmentId || null,
      quantity,
    });
  }
  map.set(key, current);
}

const REPAIR_PART_STATUSES = ["repair_scheduled", "repair_in_progress"];

/**
 * Resolve a quotation part to its inventory Tool, matching by toolId first,
 * then falling back to name-matching against active inventory.
 */
async function resolvePartTool(part) {
  if (part.toolId) {
    const tool = await Tool.findById(part.toolId).select("quantity active itemName assetCode barcode").lean();
    if (tool) return tool;
  }
  const escaped = String(part.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return null;
  const regex = new RegExp(escaped.replace(/\\s+/g, ".*"), "i");
  const candidates = await Tool.find({ itemName: regex, active: true })
    .select("quantity active itemName assetCode barcode").sort({ quantity: -1 }).lean();
  const qty = Math.max(1, Number(part.quantity) || 1);
  return candidates.find(t => (t.quantity || 0) >= qty) || candidates[0] || null;
}

/**
 * Build repair-part requirements for Phase 2 (scheduled repair visit) jobs.
 * Parts are known exactly from the approved quotation at this point.
 */
async function partRequirementsFor(assignments, bookings, requirements) {
  const bookingMap = new Map(bookings.map(booking => [String(booking._id), booking]));
  for (const assignment of assignments) {
    const booking = bookingMap.get(String(assignment.bookingId));
    if (!booking) continue;
    const isRepairVisit = booking.serviceType === "repair" && REPAIR_PART_STATUSES.includes(booking.status);
    if (!isRepairVisit) continue;
    const parts = Array.isArray(booking.quotation?.parts) ? booking.quotation.parts : [];
    for (const part of parts) {
      if (!part?.name) continue;
      const tool = await resolvePartTool(part);
      mergeRequirement(requirements, {
        name: part.name,
        kind: "repair_part",
        quantity: Math.max(1, Number(part.quantity) || 1),
        inventoryId: tool?._id || null,
        unit: "pcs",
      }, { assignmentId: assignment._id, bookingId: booking._id, multiplier: assignment.quantity });
    }
  }
}

async function requirementsFor(assignments, bookings, orders, projectRequirements, preferToolIds) {
  const bookingMap = new Map(bookings.map(booking => [String(booking._id), booking]));
  const linkedOrderBookingIds = new Set(
    orders.map(order => order.bookingId).filter(Boolean).map(String),
  );
  const requirements = new Map();
  for (const assignment of assignments) {
    const booking = bookingMap.get(String(assignment.bookingId));
    // A linked order booking is a calendar/history projection. The Order is
    // the sole inventory-demand source for delivery + installation. Matching
    // bookingId also protects legacy rows before the optional backfill runs.
    if (!booking || booking.sourceOrderId || linkedOrderBookingIds.has(String(booking._id))) continue;
    const prep = await buildServicePreparation(booking, { preferToolIds });
    for (const rec of prep.recommendations || []) {
      mergeRequirement(requirements, rec, {
        assignmentId: assignment._id,
        bookingId: booking._id,
        multiplier: assignment.quantity,
      });
    }
  }
  for (const order of orders) {
    const prep = await buildOrderInstallationPreparation(order, { preferToolIds });
    for (const rec of prep.recommendations || []) {
      mergeRequirement(requirements, rec, {
        orderId: order._id,
        multiplier: orderUnitCount(order),
      });
    }
  }
  for (const rec of projectRequirements || []) {
    mergeRequirement(requirements, rec, {
      projectId: rec.projectId,
      workOrderId: rec.workOrderId,
      dailyAssignmentId: rec.dailyAssignmentId,
    });
  }
  // Phase 2 repair visits: parts are now known exactly from the approved quotation.
  await partRequirementsFor(assignments, bookings, requirements);
  return [...requirements.values()].map(item => ({
    ...item,
    assignmentIds: uniqueIds(item.assignmentIds),
    bookingIds: uniqueIds(item.bookingIds),
    orderIds: uniqueIds(item.orderIds),
    orderAllocations: item.orderAllocations || [],
    projectIds: uniqueIds(item.projectIds || []),
    workOrderIds: uniqueIds(item.workOrderIds || []),
    dailyAssignmentIds: uniqueIds(item.dailyAssignmentIds || []),
    projectAllocations: item.projectAllocations || [],
  }));
}

function mergeOrderAllocations(existing = [], incoming = []) {
  const allocations = new Map(existing.map(row => [String(row.orderId), {
    orderId: row.orderId,
    quantity: Number(row.quantity || 0),
  }]));
  for (const row of incoming || []) {
    if (!row?.orderId) continue;
    const key = String(row.orderId);
    const prior = allocations.get(key);
    // Incoming rows describe the order's full requirement. A confirmed-kit
    // delta only describes the incremental warehouse quantity, so summing the
    // allocation would double count an order whose quantity increased.
    allocations.set(key, {
      orderId: row.orderId,
      quantity: Math.max(Number(prior?.quantity || 0), Number(row.quantity || 0)),
    });
  }
  return [...allocations.values()];
}

function mergeProjectAllocations(existing = [], incoming = []) {
  const allocations = new Map();
  for (const row of [...(existing || []), ...(incoming || [])]) {
    if (!row?.projectId) continue;
    const key = `${row.projectId}|${row.workOrderId || ""}|${row.dailyAssignmentId || ""}`;
    const prior = allocations.get(key);
    allocations.set(key, {
      projectId: row.projectId,
      workOrderId: row.workOrderId || null,
      dailyAssignmentId: row.dailyAssignmentId || null,
      quantity: Math.max(Number(prior?.quantity || 0), Number(row.quantity || 0)),
    });
  }
  return [...allocations.values()];
}

function copyRequirementLinks(target, requirement) {
  target.assignmentIds = uniqueIds(requirement.assignmentIds || []);
  target.bookingIds = uniqueIds(requirement.bookingIds || []);
  target.orderIds = uniqueIds(requirement.orderIds || []);
  target.orderAllocations = requirement.orderAllocations || [];
  target.projectIds = uniqueIds(requirement.projectIds || []);
  target.workOrderIds = uniqueIds(requirement.workOrderIds || []);
  target.dailyAssignmentIds = uniqueIds(requirement.dailyAssignmentIds || []);
  target.projectAllocations = requirement.projectAllocations || [];
}

async function hydrateAvailability(items, technicianId, start, end) {
  const toolIds = uniqueIds(items.map(item => item.toolId));
  const repairPartItems = items.filter(item => item.category === "repair_part" && item.toolId);
  const repairPartBookingIds = uniqueIds(repairPartItems.flatMap(item => item.bookingIds || []));
  const [tools, otherCheckouts, ownCheckouts, stockReservations] = await Promise.all([
    Tool.find({ _id: { $in: toolIds } }).lean(),
    EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      technicianId: { $ne: technicianId },
      status: { $in: ["reserved", "checked_out", "in_use"] },
      workDate: { $gte: start, $lt: end },
      consumable: { $ne: true },
    }).populate("technicianId", "name").lean(),
    EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      technicianId,
      status: { $in: ["checked_out", "in_use"] },
      workDate: { $gte: start, $lt: end },
      consumable: { $ne: true },
    }).select("_id equipmentId quantity").lean(),
    repairPartItems.length
      ? StockReservation.find({
          toolId: { $in: toolIds },
          bookingId: { $in: repairPartBookingIds },
          status: { $in: ["reserved", "checked_out"] },
        }).lean()
      : Promise.resolve([]),
  ]);
  const toolMap = new Map(tools.map(tool => [String(tool._id), tool]));
  const conflictMap = new Map(otherCheckouts.map(row => [String(row.equipmentId), row]));
  const ownCustodyByTool = ownCheckouts.reduce((map, row) => {
    const key = String(row.equipmentId);
    const current = map.get(key) || { quantity: 0, assignmentIds: [] };
    current.quantity += Number(row.quantity || 1);
    current.assignmentIds.push(row._id);
    map.set(key, current);
    return map;
  }, new Map());
  const reservedPartQtyByTool = stockReservations.reduce((map, r) => {
    const key = String(r.toolId);
    map.set(key, (map.get(key) || 0) + (Number(r.quantity) || 0));
    return map;
  }, new Map());

  return items.map(item => {
    const tool = toolMap.get(String(item.toolId));

    // Repair parts: already soft-reserved from inventory when the quotation
    // was approved/scheduled. If a reservation covers the needed quantity,
    // the part is ready to bring — no further availability check needed.
    if (item.category === "repair_part") {
      const reservedQty = reservedPartQtyByTool.get(String(item.toolId)) || 0;
      if (reservedQty >= item.quantity) {
        return {
          ...item,
          toolCode: tool?.assetCode || tool?.barcode || null,
          checkoutStatus: "reserved",
          conflict: { isUnavailable: false },
        };
      }
      const available = Math.max(0, Number(tool?.quantity || 0));
      const unavailable = !tool || tool.active === false || available < item.quantity;
      return {
        ...item,
        toolCode: tool?.assetCode || tool?.barcode || null,
        checkoutStatus: unavailable ? "unavailable" : "pending",
        conflict: unavailable ? {
          isUnavailable: true,
          checkedOutTo: null,
          message: !tool
            ? `${item.name} is not linked to inventory`
            : `${item.name} requires ${item.quantity}, but only ${available} is available`,
        } : { isUnavailable: false },
      };
    }

    const ownCustody = item.category === "equipment" ? ownCustodyByTool.get(String(item.toolId)) : null;
    if (ownCustody && ownCustody.quantity >= item.quantity) {
      return {
        ...item,
        toolCode: tool?.assetCode || tool?.barcode || null,
        checkoutStatus: "in_custody",
        custodyAssignmentIds: ownCustody.assignmentIds,
        conflict: { isUnavailable: false },
      };
    }

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
          ? `${item.name} is not linked to inventory`
          : conflict?.technicianId?.name
          ? `${item.name} is checked out to ${conflict.technicianId.name}`
          : `${item.name} requires ${needed}, but only ${available} is available`,
      } : { isUnavailable: false },
    };
  });
}

async function syncOrderPreparationSummaries(kit, orderIds) {
  const ids = uniqueIds(orderIds || []);
  if (!ids.length) return;
  const orders = await Order.find({ _id: { $in: ids } });
  const now = new Date();
  await Promise.all(orders.map(async (order) => {
    if (order.fulfillmentType !== "delivery_installation") return;
    const readiness = orderInstallationReadiness(order, kit);
    order.preparation = order.preparation || {};
    order.preparation.installation = {
      ...(order.preparation.installation?.toObject?.() || order.preparation.installation || {}),
      status: order.status === "cancelled" ? "cancelled"
        : order.status === "completed" ? "completed"
        : readiness.status,
      dailyKitId: readiness.dailyKitId,
      requiredItems: readiness.requiredItems,
      blockers: readiness.blockers,
      lastSyncedAt: now,
      confirmedAt: readiness.confirmedAt,
    };
    await order.save();
  }));
}

async function syncDailyKit(technicianId, date) {
  const { start, end } = dayBounds(date);
  const [assignments, orders, projectAssignments] = await Promise.all([
    Assignment.find({
      technicianId,
      status: { $in: ACTIVE_ASSIGNMENT_STATUSES },
      bookingDate: { $gte: start, $lt: end },
    }).sort({ startTime: 1 }).lean(),
    Order.find({
      technicianId,
      fulfillmentType: "delivery_installation",
      status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES },
      "delivery.preferredDate": { $gte: start, $lt: end },
    }).sort({ timeSlot: 1, createdAt: 1 }).lean(),
    DailyAssignment.find({
      technicianId,
      planningOnly: { $ne: true },
      status: { $in: ["pending", "in_progress"] },
      date: { $gte: start, $lt: end },
    }).sort({ startTime: 1 }).lean(),
  ]);
  const bookingIds = uniqueIds(assignments.map(row => row.bookingId));
  const bookings = await BookingService.find({ _id: { $in: bookingIds } }).lean();
  const orderIds = uniqueIds(orders.map(row => row._id));
  const workOrderIds = uniqueIds(projectAssignments.map(row => row.workOrderId));
  const projectIds = uniqueIds(projectAssignments.map(row => row.projectId));
  const dailyAssignmentIds = uniqueIds(projectAssignments.map(row => row._id));
  const [workOrders, projectScheduleRows] = await Promise.all([
    WorkOrder.find({ _id: { $in: workOrderIds }, status: { $ne: "cancelled" } })
      .select("projectId workOrderNumber title resourceRequirements")
      .lean(),
    workOrderIds.length
      ? DailyAssignment.find({
          workOrderId: { $in: workOrderIds },
          planningOnly: { $ne: true },
          status: { $ne: "skipped" },
        }).select("projectId workOrderId technicianId date allocatedMinutes targetUnits status").lean()
      : Promise.resolve([]),
  ]);
  const projectRequirements = buildProjectKitRequirements({
    targetAssignments: projectAssignments,
    allAssignments: projectScheduleRows,
    workOrders,
  });
  const itemKey = item => item.toolId ? `${item.category}:id:${item.toolId}` : `${item.category}:name:${String(item.name).trim().toLowerCase()}`;
  let kit = await DailyKit.findOne({ technicianId, workDate: start });
  const previouslyLinkedOrderIds = kit ? uniqueIds(kit.orderIds || []) : [];
  // Sticky resolution: prefer inventory items already in today's kit so
  // requirement → item mapping stays stable across re-syncs (availability
  // changes must not manufacture phantom new requirements).
  const preferToolIds = new Set();
  if (kit) {
    for (const src of [...(kit.items || []), ...(Array.isArray(kit.deltaItems) ? kit.deltaItems : [])]) {
      if (src?.toolId && !["returned"].includes(src.checkoutStatus)) preferToolIds.add(String(src.toolId));
    }
  }
  const required = await hydrateAvailability(
    await requirementsFor(assignments, bookings, orders, projectRequirements, preferToolIds),
    technicianId,
    start,
    end,
  );

  if (!kit) {
    kit = await DailyKit.create({
      technicianId,
      workDate: start,
      items: required,
      assignmentIds: assignments.map(a => a._id),
      bookingIds,
      orderIds,
      projectIds,
      workOrderIds,
      dailyAssignmentIds,
    });
    await syncOrderPreparationSummaries(kit, orderIds);
    return kit;
  }

  if (!["confirmed", "in_progress"].includes(kit.status)) {
    // Preserve technician resolutions from previous items before overwriting
    const resolutionMap = new Map();
    for (const oldItem of kit.items) {
      if (oldItem.resolution && oldItem.resolution.status) {
        const key = itemKey(oldItem);
        resolutionMap.set(key, oldItem.resolution);
      }
    }
    // Carry over resolutions to new items
    for (const newItem of required) {
      const key = itemKey(newItem);
      const savedResolution = resolutionMap.get(key);
      if (savedResolution) {
        newItem.resolution = savedResolution;
        // If previously resolved as confirmed_available, keep the exception status
        if (savedResolution.status === "confirmed_available") {
          newItem.checkoutStatus = "exception";
        }
      }
    }
    // Manually-added contingency items are explicit technician decisions and
    // must survive an automatic re-sync. If the generated plan now includes
    // the same item, keep the larger reusable quantity and one canonical row.
    for (const oldItem of kit.items.filter(item => item.source === "manual")) {
      const existingRequired = required.find(item => itemKey(item) === itemKey(oldItem));
      if (!existingRequired) required.push(oldItem.toObject ? oldItem.toObject() : oldItem);
      else existingRequired.quantity = Math.max(existingRequired.quantity, oldItem.quantity);
    }
    kit.items = required;
    kit.assignmentIds = assignments.map(a => a._id);
    kit.bookingIds = bookingIds;
    kit.orderIds = orderIds;
    kit.projectIds = projectIds;
    kit.workOrderIds = workOrderIds;
    kit.dailyAssignmentIds = dailyAssignmentIds;
    kit.hasDelta = false;
    kit.deltaItems = [];
    await kit.save();
    await syncOrderPreparationSummaries(kit, uniqueIds([...previouslyLinkedOrderIds, ...orderIds]));
    return kit;
  }

  const existing = new Map(kit.items.map(item => [itemKey(item), item]));
  // A confirmed kit is also a physical custody record, so removed demand does
  // not delete checked-out rows. Clear their job links first, then rebuild the
  // links from current work; cancelled/rescheduled/reassigned jobs cannot keep
  // appearing as covered by an obsolete kit.
  for (const item of kit.items) {
    if (item.source === "manual") continue;
    item.assignmentIds = [];
    item.bookingIds = [];
    item.orderIds = [];
    item.orderAllocations = [];
    item.projectIds = [];
    item.workOrderIds = [];
    item.dailyAssignmentIds = [];
    item.projectAllocations = [];
  }
  // Same catalog entry resolved under a different inventory id (or vice versa)
  // must not appear twice — match by category + normalized name as fallback.
  const existingByName = new Map();
  for (const item of kit.items) {
    const k = `${item.category}:${String(item.name).trim().toLowerCase()}`;
    if (!existingByName.has(k)) existingByName.set(k, item);
  }
  // Preserve technician decisions (not_required / alternative / admin_notified)
  // made on previously synced delta items so they survive recomputation.
  const priorResolutionMap = new Map();
  for (const source of [...kit.items, ...(Array.isArray(kit.deltaItems) ? kit.deltaItems : [])]) {
    if (source?.resolution?.status && source.resolution.status !== "admin_notified") {
      const key = itemKey(source);
      if (!priorResolutionMap.has(key)) priorResolutionMap.set(key, source.resolution);
    }
  }
  const additions = [];
  for (const requirement of required) {
    const old = existing.get(itemKey(requirement));
    const priorResolution = priorResolutionMap.get(itemKey(requirement));
    if (priorResolution) requirement.resolution = priorResolution;
    if (!old) {
      const nameMatch = existingByName.get(`${requirement.category}:${String(requirement.name).trim().toLowerCase()}`);
      if (nameMatch) {
        // Same consumable/equipment under a different inventory id — merge
        // into the kit's existing row instead of emitting a phantom delta.
        copyRequirementLinks(nameMatch, requirement);
        if (requirement.quantity > nameMatch.quantity && ["confirmed", "in_progress"].includes(kit.status)) {
          additions.push({ ...requirement, quantity: requirement.quantity - nameMatch.quantity });
        }
        continue;
      }
      additions.push(requirement);
      continue;
    }
    copyRequirementLinks(old, requirement);
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
  kit.orderIds = orderIds;
  kit.projectIds = projectIds;
  kit.workOrderIds = workOrderIds;
  kit.dailyAssignmentIds = dailyAssignmentIds;
  kit.deltaItems = additions;
  kit.hasDelta = additions.length > 0;
  if (!["confirmed", "in_progress"].includes(kit.status)) kit.items = [...existing.values(), ...additions];
  await kit.save();
  await syncOrderPreparationSummaries(kit, uniqueIds([...previouslyLinkedOrderIds, ...orderIds]));
  return kit;
}

async function confirmDailyKit({ technicianId, userId, date }) {
  const { start } = dayBounds(date);
  const kit = await syncDailyKit(technicianId, start);
  const items = kit.status === "confirmed" && kit.hasDelta ? kit.deltaItems : kit.items;
  // Block if there are truly unresolved unavailable items
  // admin_notified still blocks (admin hasn't resolved yet)
  // Only confirmed_available, not_required, assigned_from_stock, procured are truly resolved
  const unresolved = items.filter(item =>
    item.checkoutStatus === "unavailable" &&
    !item.exception?.approved &&
    (!item.resolution?.status || item.resolution?.status === "admin_notified")
  );
  if (unresolved.length) throw Object.assign(new Error("Resolve unavailable equipment before confirming the Daily Kit."), { status: 409, unavailable: unresolved });

  for (const item of items) {
    // Skip items that are unavailable but truly resolved (not admin_notified)
    if (item.checkoutStatus === "unavailable" && item.resolution?.status && item.resolution?.status !== "admin_notified") continue;
    if (["standard_kit", "in_custody", "exception", "checked_out", "issued"].includes(item.checkoutStatus)) continue;
    // Technician field decision: item explicitly marked not needed — never deduct.
    if (item.resolution?.status === "not_required") {
      item.checkoutStatus = "exception";
      item.exception = { approved: true, reason: `Not required — technician confirmed (${item.resolution.reasonCode || "field decision"})`, approvedBy: item.resolution.resolvedBy };
      continue;
    }
    if (item.checkoutStatus === "reserved" && item.category === "repair_part") {
      // Stock was already soft-deducted via StockReservation when the
      // quotation was approved/scheduled — do not deduct again.
      item.quantityIssued = item.quantity;
      item.checkoutStatus = "issued";
      continue;
    }
    const updated = await Tool.findOneAndUpdate({
      _id: item.toolId,
      quantity: { $gte: item.quantity },
      ...(item.category === "equipment" ? { assignable: { $ne: false }, assetStatus: { $nin: ["under_maintenance", "damaged", "retired"] } } : {}),
    }, {
      $inc: item.category === "equipment"
        ? { quantity: -item.quantity, checkedOutQuantity: item.quantity }
        : { quantity: -item.quantity },
      ...(item.category === "equipment" ? { $set: { assetStatus: "checked_out" } } : {}),
    }, { returnDocument: "after" });
    if (!updated) throw Object.assign(new Error(`${item.name} became unavailable. Refresh the kit and resolve the conflict.`), { status: 409 });

    if (item.category === "equipment") {
      const ledger = await EquipmentAssignment.create({
        dailyKitId: kit._id, bookingId: item.bookingIds[0] || null, technicianId, workDate: start,
        orderIds: item.orderIds || [],
        projectId: item.projectIds?.[0] || null,
        projectIds: item.projectIds || [],
        workOrderId: item.workOrderIds?.[0] || null,
        workOrderIds: item.workOrderIds || [],
        dailyAssignmentIds: item.dailyAssignmentIds || [],
        equipmentId: item.toolId, equipmentName: item.name, equipmentCode: item.toolCode || "",
        quantity: item.quantity, consumable: false, status: "checked_out", checkedOutAt: new Date(), checkedOutBy: userId,
        notes: `Daily Kit; bookings: ${item.bookingIds.join(", ") || "none"}; orders: ${(item.orderIds || []).join(", ") || "none"}; projects: ${(item.projectIds || []).join(", ") || "none"}`,
      });
      item.equipmentAssignmentId = ledger._id;
      item.checkoutStatus = "checked_out";
      item.checkedOutAt = new Date();
    } else {
      item.quantityIssued = item.quantity;
      item.checkoutStatus = "issued";
      // Project submissions historically consume against an
      // EquipmentAssignment id. Create an issued-custody ledger linked to the
      // Daily Kit so that workflow can record usage without deducting stock a
      // second time.
      if ((item.projectIds || []).length && item.toolId) {
        const allocations = mergeProjectAllocations([], item.projectAllocations || []);
        const ledgerRows = allocations.length ? allocations : [{
          projectId: item.projectIds[0],
          workOrderId: item.workOrderIds?.[0] || null,
          dailyAssignmentId: item.dailyAssignmentIds?.[0] || null,
          quantity: item.quantity,
        }];
        for (const allocation of ledgerRows) {
          const ledger = await EquipmentAssignment.create({
            dailyKitId: kit._id,
            projectId: allocation.projectId,
            projectIds: [allocation.projectId],
            workOrderId: allocation.workOrderId || null,
            workOrderIds: allocation.workOrderId ? [allocation.workOrderId] : [],
            dailyAssignmentIds: allocation.dailyAssignmentId ? [allocation.dailyAssignmentId] : [],
            technicianId,
            workDate: start,
            equipmentId: item.toolId,
            equipmentName: item.name,
            equipmentCode: item.toolCode || "",
            quantity: allocation.quantity,
            consumable: true,
            status: "in_use",
            checkedOutAt: new Date(),
            checkedOutBy: userId,
            notes: `Issued through shared Daily Kit for project ${allocation.projectId}`,
          });
          if (!item.equipmentAssignmentId) item.equipmentAssignmentId = ledger._id;
        }
      }
    }
  }

  if (kit.hasDelta) {
    for (const delta of kit.deltaItems) {
      const existing = kit.items.find(item => String(item.toolId) === String(delta.toolId) && item.category === delta.category);
      if (existing) {
        existing.quantity += delta.quantity;
        if (delta.category === "consumable") existing.quantityIssued = (existing.quantityIssued || 0) + (delta.quantityIssued || 0);
        existing.assignmentIds = uniqueIds([...existing.assignmentIds, ...delta.assignmentIds]);
        existing.bookingIds = uniqueIds([...existing.bookingIds, ...delta.bookingIds]);
        existing.orderIds = uniqueIds([...(existing.orderIds || []), ...(delta.orderIds || [])]);
        existing.orderAllocations = mergeOrderAllocations(existing.orderAllocations, delta.orderAllocations);
        existing.projectIds = uniqueIds([...(existing.projectIds || []), ...(delta.projectIds || [])]);
        existing.workOrderIds = uniqueIds([...(existing.workOrderIds || []), ...(delta.workOrderIds || [])]);
        existing.dailyAssignmentIds = uniqueIds([...(existing.dailyAssignmentIds || []), ...(delta.dailyAssignmentIds || [])]);
        existing.projectAllocations = mergeProjectAllocations(existing.projectAllocations, delta.projectAllocations);
        if (delta.resolution?.status) existing.resolution = delta.resolution;
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
  await syncOrderPreparationSummaries(kit, kit.orderIds || []);
  return kit;
}

/** Attribute already-issued Daily Kit consumables to a specific installation. */
async function recordOrderConsumableUsage({ technicianId, userId, orderId, date, usages = [] }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw Object.assign(new Error("Invalid order id"), { status: 400 });
  }
  const { start } = dayBounds(date);
  const kit = await DailyKit.findOne({ technicianId, workDate: start });
  if (!kit) throw Object.assign(new Error("No Daily Kit was found for this installation date."), { status: 409 });

  const normalized = new Map();
  for (const row of usages || []) {
    const name = String(row?.itemName || row?.name || "").trim();
    const quantity = Number(row?.quantityUsed ?? row?.quantity ?? 0);
    if (!name || !Number.isFinite(quantity) || quantity < 0) {
      throw Object.assign(new Error("Consumable usage must contain a valid item name and non-negative quantity."), { status: 400 });
    }
    if (quantity > 0) normalized.set(name.toLowerCase(), { name, quantity });
  }

  const covered = (kit.items || []).filter((item) =>
    item.category === "consumable" &&
    (item.orderIds || []).some((id) => String(id) === String(orderId))
  );
  for (const usage of normalized.values()) {
    const item = covered.find((candidate) => candidate.name.toLowerCase() === usage.name.toLowerCase());
    if (!item) throw Object.assign(new Error(`${usage.name} is not assigned to this order's Daily Kit.`), { status: 403 });
    const remaining = Number(item.quantityIssued || 0) - Number(item.quantityUsed || 0) - Number(item.quantityReturned || 0);
    if (usage.quantity > remaining) {
      throw Object.assign(new Error(`${usage.name} usage exceeds the ${remaining} ${item.unit || "pcs"} still available.`), { status: 409 });
    }
  }

  for (const usage of normalized.values()) {
    const item = covered.find((candidate) => candidate.name.toLowerCase() === usage.name.toLowerCase());
    item.quantityUsed = Number(item.quantityUsed || 0) + usage.quantity;
    const tool = item.toolId ? await Tool.findById(item.toolId).select("costPrice").lean() : null;
    await ServiceToolUsage.create({
      orderId,
      technicianId,
      toolItemId: item.toolId || undefined,
      inventoryItemId: item.toolId || undefined,
      itemName: item.name,
      itemType: "consumable",
      unit: item.unit || "pcs",
      quantityUsed: usage.quantity,
      unitPrice: Number(tool?.costPrice || 0),
      deductedFromInventory: true,
      notes: "Actual installation usage from Daily Kit issuance",
      recordedBy: userId,
    });
  }
  await kit.save();
  return { kit, recorded: [...normalized.values()] };
}

/** Add technician-requested project resources to the canonical day kit. */
async function addProjectItemsToDailyKit({ technicianId, projectId, date, items = [] }) {
  const { start, end } = dayBounds(date);
  const projectAssignments = await DailyAssignment.find({
    technicianId,
    projectId,
    planningOnly: { $ne: true },
    status: { $in: ["pending", "in_progress"] },
    date: { $gte: start, $lt: end },
  }).lean();
  if (!projectAssignments.length) {
    throw Object.assign(new Error("No active project work is scheduled for this technician on the selected date."), { status: 409 });
  }

  const kit = await syncDailyKit(technicianId, start);
  const requestedIds = uniqueIds(items.map(item => item.equipmentId || item.toolId));
  const inventory = await Tool.find({ _id: { $in: requestedIds }, active: { $ne: false } }).lean();
  const inventoryMap = new Map(inventory.map(item => [String(item._id), item]));
  const isConfirmedKit = ["confirmed", "in_progress"].includes(kit.status);
  const target = isConfirmedKit ? kit.deltaItems : kit.items;
  const itemKey = item => `${item.category}:${String(item.toolId || item.name).toLowerCase()}`;

  for (const request of items) {
    const tool = inventoryMap.get(String(request.equipmentId || request.toolId));
    if (!tool) throw Object.assign(new Error("Choose an active item from the equipment catalog."), { status: 404 });
    const category = tool.type === "consumable" ? "consumable" : tool.type === "part" ? "repair_part" : "equipment";
    if (category === "equipment" && (Tool.effectiveInventoryClass(tool) !== "operational_asset" || tool.assignable === false)) {
      throw Object.assign(new Error(`${tool.itemName} is not assignable operational equipment.`), { status: 409 });
    }
    const requestedQuantity = Math.max(1, Number(request.quantity) || 1);
    const row = {
      name: tool.itemName,
      quantity: requestedQuantity,
      unit: tool.unit || "pcs",
      category,
      source: "manual",
      toolId: tool._id,
      toolCode: tool.assetCode || tool.barcode || null,
      projectIds: [projectId],
      workOrderIds: uniqueIds(projectAssignments.map(assignment => assignment.workOrderId)),
      dailyAssignmentIds: uniqueIds(projectAssignments.map(assignment => assignment._id)),
      projectAllocations: projectAssignments.slice(0, 1).map(assignment => ({
        projectId,
        workOrderId: assignment.workOrderId,
        dailyAssignmentId: assignment._id,
        quantity: requestedQuantity,
      })),
    };
    const hydrated = (await hydrateAvailability([row], technicianId, start, end))[0];
    const existingMain = kit.items.find(item => itemKey(item) === itemKey(hydrated));
    const existingDelta = kit.deltaItems.find(item => itemKey(item) === itemKey(hydrated));
    const existing = existingDelta || existingMain;
    if (existing) {
      existing.projectIds = uniqueIds([...(existing.projectIds || []), projectId]);
      existing.workOrderIds = uniqueIds([...(existing.workOrderIds || []), ...row.workOrderIds]);
      existing.dailyAssignmentIds = uniqueIds([...(existing.dailyAssignmentIds || []), ...row.dailyAssignmentIds]);
      existing.projectAllocations = mergeProjectAllocations(existing.projectAllocations, row.projectAllocations);
      if (existingDelta) {
        existingDelta.quantity = Math.max(existingDelta.quantity, requestedQuantity - Number(existingMain?.quantity || 0));
      } else if (isConfirmedKit && requestedQuantity > existingMain.quantity) {
        target.push({ ...hydrated, quantity: requestedQuantity - existingMain.quantity });
      } else if (!isConfirmedKit) {
        existing.quantity = Math.max(existing.quantity, requestedQuantity);
      }
      continue;
    }
    target.push(hydrated);
  }
  kit.projectIds = uniqueIds([...(kit.projectIds || []), projectId]);
  kit.workOrderIds = uniqueIds([...(kit.workOrderIds || []), ...projectAssignments.map(row => row.workOrderId)]);
  kit.dailyAssignmentIds = uniqueIds([...(kit.dailyAssignmentIds || []), ...projectAssignments.map(row => row._id)]);
  kit.hasDelta = kit.deltaItems.length > 0;
  await kit.save();
  return kit;
}

module.exports = { dayBounds, syncDailyKit, confirmDailyKit, recordOrderConsumableUsage, addProjectItemsToDailyKit };
