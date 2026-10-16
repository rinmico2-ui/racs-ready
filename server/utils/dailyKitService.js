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
const Technician = require("../models/Technician");
const Project = require("../models/Project");
const { manilaDateKey, strictManilaDateKey } = require("./bookingDateTime");
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
  if (typeof value === 'string' && !strictManilaDateKey(value)) throw Object.assign(new Error('Invalid work date'), { status: 400 });
  const key = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? strictManilaDateKey(value) : manilaDateKey(value);
  if (!key) throw Object.assign(new Error("Invalid work date"), { status: 400 });
  const start = new Date(`${key}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

function checkoutError(message, status = 409) {
  return Object.assign(new Error(message), { status, code: 'DAILY_KIT_REQUIRED' });
}

function assertWorkDate(date) {
  if (manilaDateKey(dayBounds(date).start) !== manilaDateKey(new Date())) {
    throw checkoutError('Daily Preparation can only be confirmed on the scheduled work date.');
  }
}

async function technicianScope(technicianId, session) {
  const tech = await Technician.findById(technicianId).session(session).select('user').lean();
  return uniqueIds([technicianId, tech?.user]);
}

async function kitReads(tasks, session) {
  if (!session) return Promise.all(tasks.map(task => task()));
  const results = [];
  for (const task of tasks) results.push(await task());
  return results;
}

async function kitTransaction(work, attempt = 0) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    result?.$session?.(null);
    return result;
  } catch (error) {
    if (error.code === 11000 && attempt === 0) return kitTransaction(work, 1);
    if (error.code === 11000) throw checkoutError('Another request updated your kit. Refresh Daily Preparation.');
    if (error.name === 'VersionError') throw checkoutError('Your kit changed. Refresh Daily Preparation and try again.');
    if (/Transaction numbers are only allowed|does not support retryable writes/i.test(error.message)) {
      throw checkoutError('Equipment checkout is unavailable. Ask admin to check the database setup.', 503);
    }
    throw error;
  } finally { await session.endSession(); }
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean).map(String))].map(id => new mongoose.Types.ObjectId(id));
}

function checklistItems(kit) {
  if (kit.status === "draft") return kit.items || [];
  if (["confirmed", "in_progress"].includes(kit.status) && kit.hasDelta) return kit.deltaItems || [];
  return [];
}

function needsChecklistCheck(item) {
  return !["not_required", "rescheduled"].includes(item.resolution?.status);
}

function retainChecklistState(previous, next) {
  if (!previous) return;
  // Keep a stable item ID across automatic kit refreshes so the checkbox
  // endpoint still targets the same requirement.
  next._id = previous._id;
  const unchanged = Number(previous.quantity) === Number(next.quantity)
    && previous.checkoutStatus !== 'standard_kit'
    && Number(previous.quantityToCheckout ?? previous.quantity) === Number(next.quantityToCheckout ?? next.quantity)
    && previous.checkoutStatus !== "unavailable"
    && next.checkoutStatus !== "unavailable"
    && (previous.resolution?.status || null) === (next.resolution?.status || null)
    && (previous.resolution?.source || null) === (next.resolution?.source || null);
  next.preparedChecked = unchanged && Boolean(previous.preparedChecked);
  next.preparedCheckedAt = next.preparedChecked ? previous.preparedCheckedAt : null;
  next.preparedCheckedBy = next.preparedChecked ? previous.preparedCheckedBy : null;
}

function mergeRequirement(map, rec, context = {}) {
  if (!rec || !rec.name || !["equipment", "consumable", "repair_part"].includes(rec.kind)) return;
  const key = rec.inventoryId ? `${rec.kind}:id:${rec.inventoryId}` : `${rec.kind}:name:${String(rec.name).trim().toLowerCase()}`;
  const quantity = Math.max(1, Number(rec.quantity || 1)) * (rec.quantityApplied || rec.quantityBasis === 'per_visit' ? 1 : Math.max(1, Number(context.multiplier || 1)));
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
  current.catalogLocked = Boolean(current.catalogLocked || rec.ruleRevision || rec.catalogLocked);
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

function hasScheduledRepairWork(booking) {
  if (!booking) return false;
  if (REPAIR_PART_STATUSES.includes(booking.status)) {
    return booking.serviceType === "repair" || booking.serviceType === "mixed";
  }
  // Mixed bookings retain an aggregate booking status while their Core and
  // Repair items advance independently.
  return booking.serviceType === "mixed" && (booking.services || []).some(item =>
    item?.type === "repair" && REPAIR_PART_STATUSES.includes(item.status)
  );
}

/**
 * Resolve a quotation part to its inventory Tool, matching by toolId first,
 * then falling back to name-matching against active inventory.
 */
async function resolvePartTool(part) {
  if (part.toolId) {
    const tool = await Tool.findById(part.toolId).select("quantity active itemName assetCode barcode").lean();
    if (tool && tool.active !== false) return tool;
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
    if (assignment.crewRole === 'support') continue;
    const booking = bookingMap.get(String(assignment.bookingId));
    if (!booking) continue;
    const isRepairVisit = hasScheduledRepairWork(booking);
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

async function requirementsFor(assignments, bookings, orders, projectRequirements, preferToolIds, technicianId) {
  const bookingMap = new Map(bookings.map(booking => [String(booking._id), booking]));
  const linkedOrderBookingIds = new Set(
    orders.map(order => order.bookingId).filter(Boolean).map(String),
  );
  const requirements = new Map();
  const noItemsOrderIds = [];
  for (const assignment of assignments) {
    if (assignment.crewRole === 'support') continue;
    const booking = bookingMap.get(String(assignment.bookingId));
    // A linked order booking is a calendar/history projection. The Order is
    // the sole inventory-demand source for delivery + installation. Matching
    // bookingId also protects legacy rows before the optional backfill runs.
    if (!booking || booking.sourceOrderId || linkedOrderBookingIds.has(String(booking._id))) continue;
    const prep = await buildServicePreparation(booking, { preferToolIds, serviceItemId: assignment.serviceItemId, quantity: assignment.quantity });
    for (const rec of prep.recommendations || []) {
      mergeRequirement(requirements, rec, {
        assignmentId: assignment._id,
        bookingId: booking._id,
        multiplier: assignment.quantity,
      });
    }
  }
  for (const order of orders) {
    if (technicianId && !require('./standardJobTeam').isPrimary(order, technicianId)) continue;
    const prep = await buildOrderInstallationPreparation(order, { preferToolIds });
    if (prep.ruleControlled && !prep.recommendations?.length) noItemsOrderIds.push(order._id);
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
  const rows = [...requirements.values()].map(item => ({
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
  rows.noItemsOrderIds = noItemsOrderIds;
  return rows;
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
  target.catalogLocked = Boolean(requirement.catalogLocked);
  target.assignmentIds = uniqueIds(requirement.assignmentIds || []);
  target.bookingIds = uniqueIds(requirement.bookingIds || []);
  target.orderIds = uniqueIds(requirement.orderIds || []);
  target.orderAllocations = requirement.orderAllocations || [];
  target.projectIds = uniqueIds(requirement.projectIds || []);
  target.workOrderIds = uniqueIds(requirement.workOrderIds || []);
  target.dailyAssignmentIds = uniqueIds(requirement.dailyAssignmentIds || []);
  target.projectAllocations = requirement.projectAllocations || [];
}

async function hydrateAvailability(items, technicianId, start, end, session = null) {
  const holderIds = await technicianScope(technicianId, session);
  const toolIds = uniqueIds(items.map(item => item.toolId));
  const repairPartItems = items.filter(item => item.category === "repair_part" && item.toolId);
  const repairPartBookingIds = uniqueIds(repairPartItems.flatMap(item => item.bookingIds || []));
  const [tools, otherCheckouts, ownCheckouts, stockReservations, ownReservations] = await kitReads([
    () => Tool.find({ _id: { $in: toolIds } }).session(session).lean(),
    () => EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      technicianId: { $ne: technicianId },
      status: { $in: ["reserved", "checked_out", "in_use"] },
      workDate: { $gte: start, $lt: end },
      consumable: { $ne: true },
    }).session(session).populate("technicianId", "name").lean(),
    () => EquipmentAssignment.find({
      equipmentId: { $in: toolIds },
      technicianId: { $in: holderIds },
      status: { $in: ["checked_out", "in_use"] },
      workDate: { $lt: end },
      consumable: { $ne: true },
      returnPending: { $ne: true },
    }).session(session).select("_id equipmentId quantity").lean(),
    () => repairPartItems.length
      ? StockReservation.find({
          toolId: { $in: toolIds },
          bookingId: { $in: repairPartBookingIds },
          status: { $in: ["reserved", "checked_out"] },
        }).session(session).lean()
      : Promise.resolve([]),
    () => EquipmentAssignment.find({ equipmentId: { $in: toolIds }, technicianId: { $in: holderIds },
      status: 'reserved', workDate: { $gte: start, $lt: end },
      $or: [{ bookingId: { $in: uniqueIds(items.flatMap(item => item.bookingIds || [])) } },
        { workOrderId: { $in: uniqueIds(items.flatMap(item => item.workOrderIds || [])) } }],
    }).session(session).lean(),
  ], session);
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

    const usable = tool && tool.active !== false && (item.category !== 'equipment' ||
      (Tool.effectiveInventoryClass(tool) === 'operational_asset' && tool.assignable !== false &&
        !['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)));
    const held = ownReservations.filter(row => String(row.equipmentId) === String(item.toolId));
    const ownHeld = held.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const ownCustody = usable && item.category === "equipment" ? ownCustodyByTool.get(String(item.toolId)) : null;
    if (ownCustody && ownCustody.quantity >= item.quantity && !ownHeld) {
      return {
        ...item,
        toolCode: tool?.assetCode || tool?.barcode || null,
        checkoutStatus: "in_custody",
        quantityToCheckout: 0,
        custodyAssignmentIds: ownCustody.assignmentIds,
        conflict: { isUnavailable: false },
      };
    }

    // A catalog flag cannot establish this technician's physical custody.
    const requiredQuantity = Math.max(item.quantity, Number(ownCustody?.quantity || 0) + ownHeld);
    const needed = Math.max(0, requiredQuantity - Number(ownCustody?.quantity || 0));
    const available = Math.max(0, Number(tool?.quantity || 0) - Number(tool?.reservedQuantity || 0) + ownHeld);
    const conflict = item.category === "equipment" ? conflictMap.get(String(item.toolId)) : null;
    const unusable = !tool || tool.active === false || (item.category === "equipment" && (
      Tool.effectiveInventoryClass(tool) !== "operational_asset" || tool.assignable === false ||
      ["under_maintenance", "damaged", "retired"].includes(tool.assetStatus)
    ));
    const unavailable = unusable || available < needed || Boolean(conflict && available < needed);
    return {
      ...item,
      quantity: requiredQuantity,
      quantityToCheckout: needed,
      custodyAssignmentIds: ownCustody?.assignmentIds || [],
      reservedAssignmentIds: held.map(row => row._id),
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

async function syncOrderPreparationSummaries(kit, orderIds, { session = null, events = [] } = {}) {
  const ids = uniqueIds(orderIds || []);
  if (!ids.length) return;
  const query = Order.find({ _id: { $in: ids } });
  const orders = await (session ? query.session(session) : query);
  const now = new Date();
  for (const order of orders) {
    if (order.fulfillmentType !== "delivery_installation") continue;
    if (kit.technicianId && String(order.technicianId) !== String(kit.technicianId)) continue;
    const previousReadiness = order.preparation?.installation?.status;
    const readiness = orderInstallationReadiness(order, kit);
    const installation = {
      ...(order.preparation?.installation?.toObject?.() || order.preparation?.installation || {}),
      status: order.status === "cancelled" ? "cancelled"
        : order.status === "completed" ? "completed"
        : readiness.status,
      dailyKitId: readiness.dailyKitId,
      requiredItems: readiness.requiredItems,
      blockers: readiness.blockers,
      lastSyncedAt: now,
      confirmedAt: readiness.confirmedAt,
    };
    // A staff member may prepare the aircon while this kit is being confirmed.
    // Saving the preparation parent would replace their newer dispatch record.
    const updated = await Order.findOneAndUpdate({
      _id: order._id, status: order.status, technicianId: order.technicianId,
      "delivery.preferredDate": order.delivery?.preferredDate,
    }, { $set: { "preparation.installation": installation } }, { new: true, runValidators: true, ...(session ? { session } : {}) });
    if (!updated) continue; // Schedule/assignment changed; its next kit sync will recalculate.
    if (previousReadiness !== installation.status) {
      const update = { orderId: updated._id, status: updated.status, preparationUpdated: true, timestamp: Date.now() };
      if (session) events.push({ update, technicianId: updated.technicianId });
      else if (global.io) {
        global.io.to("admin-room").emit("order:status-change", update);
        if (updated.technicianId) global.io.to(`tech:${updated.technicianId}`).emit("order:status-change", update);
      }
    }
  }
}

function publishKitEvents(events) {
  if (!global.io) return;
  for (const { update, technicianId } of events) {
    try {
      global.io.to('admin-room').emit('order:status-change', update);
      if (technicianId) global.io.to(`tech:${technicianId}`).emit('order:status-change', update);
    } catch (error) { console.warn('[daily-kit] Live update could not be sent:', error.message); }
  }
}

async function syncDailyKit(technicianId, date, { session = null, automatic = false } = {}) {
  if (!session) {
    const events = [];
    const kit = await kitTransaction(async tx => {
      events.length = 0;
      const kit = await syncDailyKit(technicianId, date, { session: tx, automatic });
      if (kit) await syncOrderPreparationSummaries(kit, kit.$locals.resolutionOrderIds || kit.orderIds || [], { session: tx, events });
      return kit;
    });
    publishKitEvents(events);
    return kit;
  }
  const { start, end } = dayBounds(date);
  let [assignments, orders, projectAssignments] = await kitReads([
    () => Assignment.find({
      technicianId,
      'continuation.status': { $ne: 'pending' },
      status: { $in: ACTIVE_ASSIGNMENT_STATUSES },
      bookingDate: { $gte: start, $lt: end },
    }).session(session).sort({ startTime: 1 }).lean(),
    () => Order.find({
      isProject: { $ne: true },
      'continuation.status': { $ne: 'pending' },
      ...require('./standardJobTeam').scope(technicianId),
      fulfillmentType: "delivery_installation",
      status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES },
      "delivery.preferredDate": { $gte: start, $lt: end },
    }).session(session).sort({ timeSlot: 1, createdAt: 1 }).lean(),
    () => DailyAssignment.find({
      technicianId,
      planningOnly: { $ne: true },
      status: { $in: ["pending", "in_progress"] },
      date: { $gte: start, $lt: end },
    }).session(session).sort({ startTime: 1 }).lean(),
  ], session);
  let bookingIds = uniqueIds(assignments.map(row => row.bookingId));
  const bookings = await BookingService.find({ _id: { $in: bookingIds }, status: { $nin: ['cancelled', 'completed', 'closed', 'repair_declined', 'repair_completed'] } }).session(session).lean();
  const validBookings = new Set(bookings.map(row => String(row._id)));
  assignments = assignments.filter(row => {
    if (!validBookings.has(String(row.bookingId))) return false;
    const booking = bookings.find(booking => String(booking._id) === String(row.bookingId));
    return require('./technicianWorkSync').assignmentWorkDecision(row, booking).current;
  });
  bookingIds = uniqueIds(assignments.map(row => row.bookingId));
  const orderIds = uniqueIds(orders.map(row => row._id));
  let workOrderIds = uniqueIds(projectAssignments.map(row => row.workOrderId));
  let projectIds = uniqueIds(projectAssignments.map(row => row.projectId));
  let dailyAssignmentIds = uniqueIds(projectAssignments.map(row => row._id));
  const [workOrders, projectScheduleRows] = await kitReads([
    () => WorkOrder.find({ _id: { $in: workOrderIds }, status: { $nin: ['cancelled', 'completed', 'declined', 'rescheduled'] } })
      .session(session)
      .select("projectId workOrderNumber title resourceRequirements")
      .lean(),
    () => workOrderIds.length
      ? DailyAssignment.find({
          workOrderId: { $in: workOrderIds },
          planningOnly: { $ne: true },
          status: { $ne: "skipped" },
        }).session(session).select("projectId workOrderId technicianId date allocatedMinutes targetUnits status").lean()
      : Promise.resolve([]),
  ], session);
  const projects = await Project.find({ _id: { $in: projectIds }, status: { $nin: ['cancelled', 'completed', 'closed'] } }).session(session).select('_id').lean();
  const openProjects = new Set(projects.map(row => String(row._id)));
  const openWorkOrders = new Set(workOrders.map(row => String(row._id)));
  projectAssignments = projectAssignments.filter(row => openProjects.has(String(row.projectId)) && openWorkOrders.has(String(row.workOrderId)));
  workOrderIds = uniqueIds(projectAssignments.map(row => row.workOrderId));
  projectIds = uniqueIds(projectAssignments.map(row => row.projectId));
  dailyAssignmentIds = uniqueIds(projectAssignments.map(row => row._id));
  const projectRequirements = buildProjectKitRequirements({
    targetAssignments: projectAssignments,
    allAssignments: projectScheduleRows,
    workOrders,
  });
  const itemKey = item => item.toolId ? `${item.category}:id:${item.toolId}` : `${item.category}:name:${String(item.name).trim().toLowerCase()}`;
  let kit = await DailyKit.findOne({ technicianId, workDate: { $gte: start, $lt: end } }).session(session).sort({ workDate: 1 });
  // Discovery can race with a cancellation or a draft project schedule.
  // Revalidate the work before automatically creating an empty kit.
  if (automatic && !kit && !assignments.length && !orders.length && !projectAssignments.length) return null;
  if (kit && automatic) kit.automaticSyncedAt = new Date();
  if (kit && ['confirmed', 'in_progress'].includes(kit.status)) {
    for (const item of [...(kit.items || []), ...(kit.deltaItems || [])]) {
      if (Number(item.quantityIssued || 0) > 0 || ['checked_out', 'in_custody'].includes(item.checkoutStatus)) {
        item.issuedBookingIds = uniqueIds([...(item.issuedBookingIds || []), ...(item.bookingIds || [])]);
        item.issuedOrderIds = uniqueIds([...(item.issuedOrderIds || []), ...(item.orderIds || [])]);
      }
    }
    kit.returnedItems = kit.returnedItems || [];
    for (const item of kit.items.filter(item => ['returned', 'damaged'].includes(item.checkoutStatus))) {
      if (!kit.returnedItems.some(row => String(row._id) === String(item._id))) kit.returnedItems.push(item.toObject ? item.toObject() : { ...item });
    }
    kit.items = kit.items.filter(item => !['standard_kit', 'returned', 'damaged'].includes(item.checkoutStatus));
  }
  const previouslyLinkedAssignmentIds = new Set((kit?.assignmentIds || []).map(String));
  const previouslyLinkedOrderIds = kit ? uniqueIds(kit.orderIds || []) : [];
  const previouslyLinkedOrderIdSet = new Set(previouslyLinkedOrderIds.map(String));
  const previouslyLinkedDailyAssignmentIds = new Set((kit?.dailyAssignmentIds || []).map(String));
  const pendingCoverageReview = Boolean(kit?.hasDelta && !(kit.deltaItems || []).length);
  // Sticky resolution: prefer inventory items already in today's kit so
  // requirement → item mapping stays stable across re-syncs (availability
  // changes must not manufacture phantom new requirements).
  const preferToolIds = new Set();
  if (kit) {
    for (const src of [...(kit.items || []), ...(Array.isArray(kit.deltaItems) ? kit.deltaItems : [])]) {
      if (src?.toolId && !["returned"].includes(src.checkoutStatus)) preferToolIds.add(String(src.toolId));
    }
  }
  const requirements = await requirementsFor(assignments, bookings, orders, projectRequirements, preferToolIds, technicianId);
  if (kit) kit.noItemsOrderIds = requirements.noItemsOrderIds || [];
  const holderIds = await technicianScope(technicianId, session);
  const reservations = await EquipmentAssignment.find({ technicianId: { $in: holderIds }, status: 'reserved', workDate: { $gte: start, $lt: end },
    $or: [{ bookingId: { $in: bookingIds } }, { workOrderId: { $in: workOrderIds } }],
  }).session(session).lean();
  for (const held of reservations) {
    const category = held.consumable ? 'consumable' : 'equipment';
    let item = requirements.find(row => String(row.toolId) === String(held.equipmentId) && row.category === category);
    if (!item) {
      item = { name: held.equipmentName, quantity: held.quantity, category, unit: 'pcs', source: 'job_specific', toolId: held.equipmentId,
        bookingIds: held.bookingId ? [held.bookingId] : [], assignmentIds: assignments.filter(row => String(row.bookingId) === String(held.bookingId)).map(row => row._id),
        orderIds: [], projectIds: held.projectId ? [held.projectId] : [], workOrderIds: held.workOrderId ? [held.workOrderId] : [], dailyAssignmentIds: held.dailyAssignmentIds || [] };
      requirements.push(item);
    }
  }
  // Rehydrate manual extras with current stock, rather than appending a stale
  // availability snapshot after hydration. Store requested totals separately
  // when the same catalog item is also required by a job.
  for (const item of requirements) item.requiredQuantity = item.quantity;
  for (const source of (kit?.items || []).filter(item => item.source === 'manual' || Number(item.manualQuantity) > 0)) {
    const old = source.toObject ? source.toObject() : { ...source };
    const hasLegacyLinks = ['assignmentIds', 'bookingIds', 'orderIds', 'projectIds', 'dailyAssignmentIds'].some(field => (old[field] || []).length);
    const intersects = (values, current) => (values || []).some(id => current.some(value => String(id) === String(value)));
    const linked = old.manualJobType === 'booking' ? assignments.some(row => String(row._id) === String(old.manualJobId))
      : old.manualJobType === 'order' ? orderIds.some(id => String(id) === String(old.manualJobId))
      : old.manualJobType === 'project' ? dailyAssignmentIds.some(id => String(id) === String(old.manualJobId))
      : hasLegacyLinks ? intersects(old.assignmentIds, assignments.map(row => row._id)) || intersects(old.bookingIds, bookingIds)
        || intersects(old.orderIds, orderIds) || intersects(old.dailyAssignmentIds, dailyAssignmentIds) || intersects(old.projectIds, projectIds)
      : assignments.length + orders.length + projectAssignments.length > 0;
    if (!linked) continue;
    const manualQuantity = Number(old.manualQuantity) || Number(old.quantity) || 1;
    const existing = requirements.find(item => itemKey(item) === itemKey(old));
    const row = existing || { ...old, quantity: manualQuantity, requiredQuantity: 0, source: 'manual' };
    row.quantity = Math.max(row.quantity, manualQuantity);
    for (const field of ['manualJobType', 'manualJobId', 'manualNote', 'manualAddedBy', 'manualAddedAt']) row[field] = old[field];
    row.manualQuantity = manualQuantity;
    let links = {
      assignmentIds: (old.assignmentIds || []).filter(id => assignments.some(row => String(row._id) === String(id))),
      bookingIds: (old.bookingIds || []).filter(id => bookingIds.some(value => String(value) === String(id))),
      orderIds: (old.orderIds || []).filter(id => orderIds.some(value => String(value) === String(id))),
      projectIds: (old.projectIds || []).filter(id => projectIds.some(value => String(value) === String(id))),
      workOrderIds: (old.workOrderIds || []).filter(id => workOrderIds.some(value => String(value) === String(id))),
      dailyAssignmentIds: (old.dailyAssignmentIds || []).filter(id => dailyAssignmentIds.some(value => String(value) === String(id))),
      orderAllocations: (old.orderAllocations || []).filter(row => orderIds.some(id => String(id) === String(row.orderId))),
      projectAllocations: (old.projectAllocations || []).filter(row => dailyAssignmentIds.some(id => String(id) === String(row.dailyAssignmentId))),
    };
    if (old.manualJobType === 'booking') {
      const assignment = assignments.find(job => String(job._id) === String(old.manualJobId));
      links = { assignmentIds: [assignment._id], bookingIds: [assignment.bookingId] };
    } else if (old.manualJobType === 'order') {
      links = { orderIds: [old.manualJobId], orderAllocations: [{ orderId: old.manualJobId, quantity: manualQuantity }] };
    } else if (old.manualJobType === 'project') {
      const daily = projectAssignments.find(job => String(job._id) === String(old.manualJobId));
      links = { projectIds: [daily.projectId], workOrderIds: [daily.workOrderId], dailyAssignmentIds: [daily._id],
        projectAllocations: [{ projectId: daily.projectId, workOrderId: daily.workOrderId, dailyAssignmentId: daily._id, quantity: manualQuantity }] };
    }
    // Keep extra consumables usable by the explicitly selected job.
    for (const field of ['assignmentIds', 'bookingIds', 'orderIds', 'projectIds', 'workOrderIds', 'dailyAssignmentIds']) {
      row[field] = uniqueIds([...(existing ? row[field] || [] : []), ...(links[field] || [])]);
    }
    row.orderAllocations = mergeOrderAllocations(existing ? row.orderAllocations : [], links.orderAllocations);
    row.projectAllocations = mergeProjectAllocations(existing ? row.projectAllocations : [], links.projectAllocations);
    if (!existing) requirements.push(row);
  }
  const required = await hydrateAvailability(
    requirements,
    technicianId,
    start,
    end,
    session,
  );

  if (!kit) {
    [kit] = await DailyKit.create([{
      technicianId,
      workDate: start,
      ...(automatic ? { automaticSyncedAt: new Date() } : {}),
      items: required,
      noItemsOrderIds: requirements.noItemsOrderIds || [],
      assignmentIds: assignments.map(a => a._id),
      bookingIds,
      orderIds,
      projectIds,
      workOrderIds,
      dailyAssignmentIds,
    }], { session });
    return kit;
  }
  kit.$locals.resolutionOrderIds = uniqueIds([...previouslyLinkedOrderIds, ...orderIds]);

  if (!["confirmed", "in_progress"].includes(kit.status)) {
    // Preserve technician resolutions from previous items before overwriting
    const resolutionMap = new Map();
    const priorItems = new Map(kit.items.map(item => [itemKey(item), item]));
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
    for (const item of required) retainChecklistState(priorItems.get(itemKey(item)), item);
    kit.items = required;
    kit.assignmentIds = assignments.map(a => a._id);
    kit.bookingIds = bookingIds;
    kit.orderIds = orderIds;
    kit.projectIds = projectIds;
    kit.workOrderIds = workOrderIds;
    kit.dailyAssignmentIds = dailyAssignmentIds;
    kit.hasDelta = false;
    kit.deltaItems = [];
    await kit.save({ session });
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
    if (source?.resolution?.status) {
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
      if (nameMatch && !requirement.catalogLocked && !nameMatch.catalogLocked) {
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
    // Pending receipt is still physical custody. Do not replace or remove
    // that row just because it is excluded from reusable available custody.
    if (old.category === 'equipment' && Number(old.returnPendingQuantity || 0) > 0) continue;
    if (Number(requirement.quantityToCheckout) > 0 && ['checked_out', 'in_custody'].includes(old.checkoutStatus)) {
      const remaining = Number(requirement.quantityToCheckout);
      additions.push({ ...requirement, quantity: remaining, quantityToCheckout: remaining });
      const carried = requirement.quantity - remaining;
      if (carried > 0) old.quantity = carried;
      else kit.items = kit.items.filter(item => String(item._id) !== String(old._id));
    } else if (requirement.quantity > old.quantity && ["confirmed", "in_progress"].includes(kit.status)) {
      additions.push({ ...requirement, quantity: requirement.quantity - old.quantity });
    } else if (!["confirmed", "in_progress"].includes(kit.status)) {
      old.quantity = requirement.quantity;
      old.checkoutStatus = requirement.checkoutStatus;
      old.conflict = requirement.conflict;
    }
  }
  // A newly covered job requires an explicit Daily Preparation update even
  // when all of its physical requirements are already present in the shared
  // kit. Otherwise a late Repair/Mixed booking could silently inherit an old
  // confirmed kit and depart without ever being reviewed.
  const coverageChanged = assignments.some(row => !previouslyLinkedAssignmentIds.has(String(row._id)))
    || orders.some(row => !previouslyLinkedOrderIdSet.has(String(row._id)))
    || projectAssignments.some(row => !previouslyLinkedDailyAssignmentIds.has(String(row._id)));

  kit.assignmentIds = uniqueIds(assignments.map(a => a._id));
  kit.bookingIds = bookingIds;
  kit.orderIds = orderIds;
  kit.projectIds = projectIds;
  kit.workOrderIds = workOrderIds;
  kit.dailyAssignmentIds = dailyAssignmentIds;
  const priorDelta = new Map((kit.deltaItems || []).map(item => [itemKey(item), item]));
  for (const item of additions) retainChecklistState(priorDelta.get(itemKey(item)), item);
  kit.deltaItems = additions;
  kit.hasDelta = additions.length > 0 || coverageChanged || pendingCoverageReview;
  if (!["confirmed", "in_progress"].includes(kit.status)) kit.items = [...existing.values(), ...additions];
  await kit.save({ session });
  return kit;
}

function kitEditError(message, status = 409) { return Object.assign(new Error(message), { status }); }
function assertEditableKit(kit) {
  if (kit.status !== 'draft') throw kitEditError('This kit is already confirmed. Return issued equipment from My Tools; it cannot be removed here.');
  if (!(kit.assignmentIds || []).length && !(kit.orderIds || []).length && !(kit.dailyAssignmentIds || []).length) {
    throw kitEditError('Accept a scheduled job before changing the kit.');
  }
}
function assertUnissuedItem(item) {
  if (['checked_out', 'issued', 'in_custody', 'returned', 'damaged', 'reserved'].includes(item.checkoutStatus)
      || item.equipmentAssignmentId || (item.custodyAssignmentIds || []).length || (item.reservedAssignmentIds || []).length
      || Number(item.quantityIssued) > 0) throw kitEditError('This item has a stock or custody record. Use the return process instead of removing it.');
}

async function addDailyKitItem({ technicianId, userId, date, inventoryItemId, quantity, jobType, jobId, note }) {
  assertWorkDate(date);
  const requested = Number(quantity), reason = String(note || '').trim();
  if (!mongoose.isValidObjectId(inventoryItemId) || !mongoose.isValidObjectId(jobId)
      || !['booking', 'order', 'project'].includes(jobType) || !Number.isFinite(requested) || requested < 1 || requested > 10000
      || reason.length < 3 || reason.length > 300) throw kitEditError('Choose a catalog item, job, quantity from 1 to 10,000, and a short reason (3 to 300 characters).', 400);
  return kitTransaction(async session => {
    let kit = await syncDailyKit(technicianId, date, { session });
    assertEditableKit(kit);
    const tool = await Tool.findById(inventoryItemId).session(session).lean();
    if (!tool || tool.active === false || tool.archivedAt || tool.status === 'discontinued') throw kitEditError('This catalog item is no longer active.', 404);
    const category = tool.type === 'consumable' ? 'consumable' : ['tool', 'equipment'].includes(tool.type) ? 'equipment' : null;
    if (!category) throw kitEditError('Repair parts must come from the approved repair quotation. Choose equipment or a consumable.', 400);
    if (category === 'equipment' && (!Number.isInteger(requested) || Tool.effectiveInventoryClass(tool) !== 'operational_asset'
      || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus))) {
      throw kitEditError('Choose usable company equipment and a whole-number quantity.', 400);
    }
    const ids = jobType === 'booking' ? kit.assignmentIds : jobType === 'order' ? kit.orderIds : kit.dailyAssignmentIds;
    if (!(ids || []).some(id => String(id) === String(jobId))) throw kitEditError('This job is not covered by your kit. Refresh Daily Preparation.', 403);
    let item = kit.items.find(row => String(row.toolId) === String(tool._id) && row.category === category);
    if (item) {
      assertUnissuedItem(item);
      if (requested < Number(item.requiredQuantity)) throw kitEditError(`The covered jobs need at least ${item.requiredQuantity} ${tool.unit || 'pcs'}. Removing an extra cannot reduce that requirement.`, 400);
    }
    else {
      kit.items.push({ name: tool.itemName, toolId: tool._id, category, unit: tool.unit || 'pcs', source: 'manual', quantity: requested });
      item = kit.items[kit.items.length - 1];
    }
    item.manualQuantity = requested;
    item.manualJobType = jobType; item.manualJobId = jobId; item.manualNote = reason;
    item.manualAddedBy = userId; item.manualAddedAt = new Date();
    item.resolution = { status: null }; item.exception = { approved: false };
    item.preparedChecked = false; item.preparedCheckedAt = null; item.preparedCheckedBy = null;
    // Clear older manual links only for a standalone extra. Generated job
    // demand will rebuild its own links during the next sync.
    if (item.source === 'manual') for (const field of ['assignmentIds', 'bookingIds', 'orderIds', 'orderAllocations', 'projectIds', 'workOrderIds', 'dailyAssignmentIds', 'projectAllocations']) item[field] = [];
    if (jobType === 'booking') {
      const assignment = await Assignment.findById(jobId).session(session).lean();
      item.assignmentIds = uniqueIds([...(item.assignmentIds || []), assignment._id]);
      item.bookingIds = uniqueIds([...(item.bookingIds || []), assignment.bookingId]);
    } else if (jobType === 'order') {
      item.orderIds = uniqueIds([...(item.orderIds || []), jobId]);
      item.orderAllocations = mergeOrderAllocations(item.orderAllocations, [{ orderId: jobId, quantity: requested }]);
    } else {
      const daily = await DailyAssignment.findById(jobId).session(session).lean();
      item.projectIds = uniqueIds([...(item.projectIds || []), daily.projectId]);
      item.workOrderIds = uniqueIds([...(item.workOrderIds || []), daily.workOrderId]);
      item.dailyAssignmentIds = uniqueIds([...(item.dailyAssignmentIds || []), jobId]);
      item.projectAllocations = mergeProjectAllocations(item.projectAllocations, [{ projectId: daily.projectId, workOrderId: daily.workOrderId, dailyAssignmentId: jobId, quantity: requested }]);
    }
    kit.notes = [kit.notes, `[${new Date().toISOString()}] Extra ${tool.itemName}: requested total ${requested}; ${jobType} ${jobId}; by ${userId}; ${reason}`].filter(Boolean).join('\n');
    await kit.save({ session });
    kit = await syncDailyKit(technicianId, date, { session });
    return kit;
  });
}

async function removeDailyKitItem({ technicianId, userId, date, itemId, itemName, note }) {
  assertWorkDate(date);
  const reason = String(note || '').trim();
  if ((!mongoose.isValidObjectId(itemId) && !String(itemName || '').trim()) || reason.length < 3 || reason.length > 300) {
    throw kitEditError('Choose the extra item and give a short reason (3 to 300 characters).', 400);
  }
  return kitTransaction(async session => {
    let kit = await syncDailyKit(technicianId, date, { session });
    assertEditableKit(kit);
    const matches = kit.items.filter(row => itemId ? String(row._id) === String(itemId) : row.name === itemName);
    if (matches.length !== 1) throw kitEditError('This item changed. Refresh the kit and try again.');
    const item = matches[0];
    assertUnissuedItem(item);
    if (!(Number(item.manualQuantity) > 0) && item.source !== 'manual') throw kitEditError('This item is required by a job. Use Not needed and give a reason instead.');
    kit.notes = [kit.notes, `[${new Date().toISOString()}] Removed extra ${item.name}: ${item.manualQuantity || item.quantity}; by ${userId}; ${reason}`].filter(Boolean).join('\n');
    if (Number(item.requiredQuantity) > 0) {
      item.manualQuantity = 0; item.manualJobType = null; item.manualJobId = null; item.manualNote = '';
      item.manualAddedBy = null; item.manualAddedAt = null;
      item.quantity = item.requiredQuantity; item.source = 'job_specific';
      item.preparedChecked = false; item.preparedCheckedAt = null; item.preparedCheckedBy = null;
    } else kit.items = kit.items.filter(row => String(row._id) !== String(item._id));
    await kit.save({ session });
    kit = await syncDailyKit(technicianId, date, { session });
    return kit;
  });
}

async function setDailyKitItemChecked({ technicianId, userId, date, itemId, checked }) {
  const { start } = dayBounds(date);
  assertWorkDate(date);
  if (!mongoose.isValidObjectId(itemId) || typeof checked !== "boolean") {
    throw Object.assign(new Error("Choose a valid kit item and check state."), { status: 400 });
  }
  return kitTransaction(async session => {
    const kit = await syncDailyKit(technicianId, start, { session });
    const item = checklistItems(kit).find(row => String(row._id) === String(itemId));
    if (!item) throw Object.assign(new Error("This kit item changed. Refresh the kit and try again."), { status: 409 });
    if (!needsChecklistCheck(item)) {
      throw Object.assign(new Error("This item was marked not required and does not need a checkmark."), { status: 409 });
    }
    if (item.checkoutStatus === "unavailable" && !item.exception?.approved) {
      throw Object.assign(new Error("Resolve this unavailable item before checking it off."), { status: 409 });
    }
    item.preparedChecked = checked;
    item.preparedCheckedAt = checked ? new Date() : null;
    item.preparedCheckedBy = checked ? userId : null;
    await kit.save({ session });
    return kit;
  });
}

async function confirmDailyKit({ technicianId, userId, date, expectedAssignmentIds = [], equipmentAssignmentId = null }) {
  const { start } = dayBounds(date);
  assertWorkDate(date);
  const events = [];
  const kit = await kitTransaction(async session => {
    events.length = 0;
    const kit = await syncDailyKit(technicianId, start, { session });
    if (expectedAssignmentIds.some(id => !(kit.assignmentIds || []).some(value => String(value) === String(id)))) {
      throw checkoutError('Accept this job and review Daily Preparation before checking out equipment.');
    }
    if (equipmentAssignmentId) {
      const row = await EquipmentAssignment.findById(equipmentAssignmentId).session(session);
      if (!row || ![String(technicianId), String(userId)].includes(String(row.technicianId))) {
        throw checkoutError('This equipment is not assigned to you.', 403);
      }
      assertWorkDate(row.workDate);
      const covered = (row.bookingId && (kit.bookingIds || []).some(id => String(id) === String(row.bookingId)))
        || (row.workOrderId && (kit.workOrderIds || []).some(id => String(id) === String(row.workOrderId)));
      if (!covered || ![...(kit.items || []), ...(kit.deltaItems || [])].some(item => String(item.toolId) === String(row.equipmentId))) {
        throw checkoutError('Review this equipment in Daily Preparation before checkout.');
      }
    }
    if (['confirmed', 'in_progress'].includes(kit.status) && !kit.hasDelta) return kit;
    if (!["draft", "confirmed", "in_progress"].includes(kit.status) ||
        (kit.status !== "draft" && !kit.hasDelta)) {
      throw Object.assign(new Error("This Daily Kit is already confirmed."), { status: 409 });
    }
    if (!(kit.assignmentIds?.length || kit.orderIds?.length || kit.dailyAssignmentIds?.length)) {
      throw Object.assign(new Error("There are no accepted jobs to prepare for this date."), { status: 409 });
    }
    const items = checklistItems(kit);
    // Block if there are truly unresolved unavailable items
    // admin_notified still blocks (admin hasn't resolved yet)
    // Only confirmed_available, not_required, assigned_from_stock, procured are truly resolved
    const unresolved = items.filter(item =>
      item.checkoutStatus === "unavailable" &&
      !item.exception?.approved &&
      needsChecklistCheck(item)
    );
    if (unresolved.length) throw Object.assign(new Error("Resolve unavailable equipment before confirming the Daily Kit."), { status: 409, unavailable: unresolved });

    const unchecked = items.filter(item => needsChecklistCheck(item) && !item.preparedChecked);
    if (unchecked.length) {
      throw Object.assign(new Error(`Check ${unchecked.length} required kit item(s) before confirming.`), {
        status: 409,
        unchecked: unchecked.map(item => ({ id: String(item._id), name: item.name, quantity: item.quantity })),
      });
    }

    for (const item of items) {
      if (Number(item.returnPendingQuantity || 0) > 0 && (item.category === 'equipment' || require('./kitMaterialBalance').available(item) <= 0)) throw checkoutError(`${item.name} has a return awaiting admin review. Resolve it before preparing this kit.`);
      item.issuedBookingIds = uniqueIds([...(item.issuedBookingIds || []), ...(item.bookingIds || [])]);
      item.issuedOrderIds = uniqueIds([...(item.issuedOrderIds || []), ...(item.orderIds || [])]);
      // Only verified custody, recorded issuance, and explicit exceptions skip checkout.
      if (item.checkoutStatus === 'in_custody') {
        const custody = item.custodyAssignmentIds || [];
        const claimed = await EquipmentAssignment.updateMany({ _id: { $in: custody },
          technicianId: { $in: uniqueIds([technicianId, userId]) }, status: { $in: ['checked_out', 'in_use'] },
          returnPending: { $ne: true },
        }, { $set: { updatedAt: new Date() } }, { session });
        const usable = await Tool.updateOne({ _id: item.toolId, active: { $ne: false }, assignable: { $ne: false },
          assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
        }, { $set: { updatedAt: new Date() } }, { session });
        if (!custody.length || claimed.matchedCount !== custody.length || usable.matchedCount !== 1) {
          throw checkoutError(`${item.name} is no longer available in your custody. Refresh Daily Preparation.`);
        }
      }
      if (["in_custody", "exception", "checked_out", "issued"].includes(item.checkoutStatus)) continue;
      // Technician field decision: item explicitly marked not needed — never deduct.
      if (item.resolution?.status === "not_required") {
        item.checkoutStatus = "exception";
        item.exception = { approved: true, reason: `Not required — technician confirmed (${item.resolution.reasonCode || "field decision"})`, approvedBy: item.resolution.resolvedBy };
        continue;
      }
      const held = await EquipmentAssignment.find({ _id: { $in: item.reservedAssignmentIds || [] },
        technicianId: { $in: uniqueIds([technicianId, userId]) }, equipmentId: item.toolId, status: 'reserved', workDate: { $gte: start, $lt: dayBounds(date).end },
      }).session(session);
      const parts = item.category === 'repair_part' ? await StockReservation.find({
        toolId: item.toolId, bookingId: { $in: item.bookingIds || [] }, status: { $in: ['reserved', 'checked_out'] },
      }).session(session) : [];
      const alreadyDeducted = parts.filter(row => row.stockTreatment !== 'soft_hold' || row.status === 'checked_out')
        .reduce((sum, row) => sum + Number(row.quantity), 0);
      const quantity = Math.max(0, Number(item.quantityToCheckout ?? item.quantity) - alreadyDeducted);
      const heldQuantity = held.reduce((sum, row) => sum + Number(row.quantity), 0)
        + parts.filter(row => row.stockTreatment === 'soft_hold' && row.status === 'reserved').reduce((sum, row) => sum + Number(row.quantity), 0);
      if (heldQuantity > quantity) throw checkoutError(`${item.name} has conflicting reserved quantities. Ask admin to review its reservation.`);
      if (quantity) {
        const updated = await Tool.findOneAndUpdate({
          _id: item.toolId,
          active: { $ne: false },
          quantity: { $gte: quantity },
          ...(heldQuantity ? { reservedQuantity: { $gte: heldQuantity } } : {}),
          $expr: { $gte: [{ $subtract: ['$quantity', { $ifNull: ['$reservedQuantity', 0] }] }, quantity - heldQuantity] },
          ...(item.category === "equipment" ? { assignable: { $ne: false }, assetStatus: { $nin: ["under_maintenance", "damaged", "retired"] } } : {}),
        }, {
          $inc: item.category === "equipment"
            ? { quantity: -quantity, checkedOutQuantity: quantity, reservedQuantity: -heldQuantity }
            : { quantity: -quantity, reservedQuantity: -heldQuantity },
          ...(item.category === "equipment" ? { $set: { assetStatus: "checked_out" } } : {}),
        }, { returnDocument: "after", session });
        if (!updated) throw Object.assign(new Error(`${item.name} became unavailable. Refresh the kit and resolve the conflict.`), { status: 409 });
      }
      for (const reservation of parts) {
        if (reservation.status === 'checked_out') continue;
        const claimed = await StockReservation.updateOne({ _id: reservation._id, status: 'reserved' },
          { $set: { status: 'checked_out', fulfilledAt: new Date() } }, { session });
        if (!claimed.modifiedCount) throw checkoutError('This parts reservation changed. Refresh Daily Preparation.');
      }
      for (const reservation of held) {
        reservation.status = reservation.consumable ? 'consumed' : 'checked_out';
        reservation.dailyKitId = kit._id;
        reservation.checkedOutAt = new Date(); reservation.checkedOutBy = userId;
        await reservation.save({ session });
        if (!item.equipmentAssignmentId) item.equipmentAssignmentId = reservation._id;
        item.custodyAssignmentIds = uniqueIds([...(item.custodyAssignmentIds || []), reservation._id]);
      }

      if (item.category === "equipment") {
        if (quantity > heldQuantity) {
        const [ledger] = await EquipmentAssignment.create([{
          dailyKitId: kit._id, bookingId: item.bookingIds[0] || null, technicianId, workDate: start,
          orderIds: item.orderIds || [],
          projectId: item.projectIds?.[0] || null,
          projectIds: item.projectIds || [],
          workOrderId: item.workOrderIds?.[0] || null,
          workOrderIds: item.workOrderIds || [],
          dailyAssignmentIds: item.dailyAssignmentIds || [],
          equipmentId: item.toolId, equipmentName: item.name, equipmentCode: item.toolCode || "",
          quantity: quantity - heldQuantity, consumable: false, status: "checked_out", checkedOutAt: new Date(), checkedOutBy: userId,
          notes: `Daily Kit; bookings: ${item.bookingIds.join(", ") || "none"}; orders: ${(item.orderIds || []).join(", ") || "none"}; projects: ${(item.projectIds || []).join(", ") || "none"}`,
        }], { session });
        item.equipmentAssignmentId = ledger._id;
        item.custodyAssignmentIds = uniqueIds([...(item.custodyAssignmentIds || []), ledger._id]);
        }
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
            const [ledger] = await EquipmentAssignment.create([{
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
            }], { session });
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
          if (['consumable', 'repair_part'].includes(delta.category)) existing.quantityIssued = (existing.quantityIssued || 0) + (delta.quantityIssued || 0);
          existing.issuedBookingIds = uniqueIds([...(existing.issuedBookingIds || []), ...(delta.issuedBookingIds || [])]);
          existing.issuedOrderIds = uniqueIds([...(existing.issuedOrderIds || []), ...(delta.issuedOrderIds || [])]);
          existing.assignmentIds = uniqueIds([...existing.assignmentIds, ...delta.assignmentIds]);
          existing.bookingIds = uniqueIds([...existing.bookingIds, ...delta.bookingIds]);
          existing.orderIds = uniqueIds([...(existing.orderIds || []), ...(delta.orderIds || [])]);
          existing.orderAllocations = mergeOrderAllocations(existing.orderAllocations, delta.orderAllocations);
          existing.projectIds = uniqueIds([...(existing.projectIds || []), ...(delta.projectIds || [])]);
          existing.workOrderIds = uniqueIds([...(existing.workOrderIds || []), ...(delta.workOrderIds || [])]);
          existing.dailyAssignmentIds = uniqueIds([...(existing.dailyAssignmentIds || []), ...(delta.dailyAssignmentIds || [])]);
          existing.custodyAssignmentIds = uniqueIds([...(existing.custodyAssignmentIds || []), ...(delta.custodyAssignmentIds || [])]);
          existing.reservedAssignmentIds = uniqueIds([...(existing.reservedAssignmentIds || []), ...(delta.reservedAssignmentIds || [])]);
          existing.projectAllocations = mergeProjectAllocations(existing.projectAllocations, delta.projectAllocations);
          if (delta.resolution?.status) existing.resolution = delta.resolution;
        } else kit.items.push(delta.toObject ? delta.toObject() : delta);
      }
    }
    kit.status = "confirmed";
    kit.confirmedAt = new Date();
    kit.hasDelta = false;
    kit.deltaItems = [];
    await kit.save({ session });

    await Assignment.updateMany({ _id: { $in: kit.assignmentIds } }, {
      $set: { equipmentCheckedOut: true, equipmentCheckedOutAt: new Date(), preparationStatus: "checked_out", preparationIssue: "" },
    }, { session });
    await BookingService.updateMany({ _id: { $in: kit.bookingIds } }, {
      $set: { "servicePreparation.confirmed": true, "servicePreparation.confirmedAt": new Date(), "servicePreparation.confirmedBy": technicianId },
    }, { session });
    // These writes also prevent cancellation/reassignment from racing checkout.
    await Order.updateMany({ _id: { $in: kit.orderIds || [] }, technicianId,
      status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES } },
      { $set: { 'preparation.installation.lastSyncedAt': new Date() } }, { session });
    await DailyAssignment.updateMany({ _id: { $in: kit.dailyAssignmentIds || [] }, technicianId },
      { $set: { updatedAt: new Date() } }, { session });
    await WorkOrder.updateMany({ _id: { $in: kit.workOrderIds || [] } }, { $set: { updatedAt: new Date() } }, { session });
    await Project.updateMany({ _id: { $in: kit.projectIds || [] } }, { $set: { updatedAt: new Date() } }, { session });
    await syncOrderPreparationSummaries(kit, kit.$locals.resolutionOrderIds || kit.orderIds || [], { session, events });
    return kit;
  });
  publishKitEvents(events);
  return kit;
}

/**
 * Re-sync and verify the canonical technician/day preparation before travel.
 * Core, Repair, and Mixed routes all use this contract so a specialized
 * workflow cannot bypass Daily Kit readiness.
 */
async function dailyKitDepartureReadiness({ technicianId, assignment }) {
  if (!assignment?._id) {
    return {
      ready: false,
      code: "DAILY_KIT_JOB_NOT_INCLUDED",
      error: "Accept the assignment before preparing the Daily Kit.",
    };
  }

  const kit = await syncDailyKit(technicianId, assignment.bookingDate || new Date());
  const assignmentCovered = (kit.assignmentIds || []).some(id => String(id) === String(assignment._id));
  if (!assignmentCovered) {
    return {
      ready: false,
      code: "DAILY_KIT_JOB_NOT_INCLUDED",
      error: "This job is not included in the Daily Kit. Accept it and review Daily Preparation before going En Route.",
      kit,
    };
  }

  return dailyKitReadiness(kit);
}

/** Shared preparation, delta and return gates for bookings and project crews. */
function dailyKitReadiness(kit) {
  if (!kit) return { ready: false, code: "DAILY_KIT_REQUIRED", error: "Review and confirm your Daily Preparation before departure.", kit: null };
  if (!["confirmed", "in_progress"].includes(kit.status)) {
    return {
      ready: false,
      code: "DAILY_KIT_REQUIRED",
      error: "Complete your Daily Preparation before going En Route.",
      kit,
    };
  }

  if ([...(kit.items || []), ...(kit.deltaItems || [])].some(item => Number(item.returnPendingQuantity || 0) > 0 && (item.category === 'equipment' || require('./kitMaterialBalance').available(item) <= 0))) {
    return { ready: false, code: 'DAILY_KIT_RETURN_PENDING', error: 'This Daily Kit has items awaiting admin receipt. Resolve the return before starting another job with those items.', kit };
  }

  // A delta is not prepared merely because each row has a field decision.
  // Prepare Additional Items completes checkout/issuance and custody logging.
  if (kit.hasDelta && Array.isArray(kit.deltaItems) && kit.deltaItems.length) {
    const itemNames = kit.deltaItems.map(item => item.name).filter(Boolean);
    return {
      ready: false,
      code: "DAILY_KIT_DELTA_REQUIRED",
      error: itemNames.length
        ? `New items were added to your Daily Kit (${itemNames.join(", ")}). Prepare the additional items before going En Route.`
        : "A new job was added after your Daily Kit was confirmed. Review and confirm the Daily Preparation update before going En Route.",
      items: kit.deltaItems.map(item => ({
        name: item.name,
        category: item.category,
        quantity: item.quantity,
        resolution: item.resolution?.status || null,
      })),
      kit,
    };
  }

  if (kit.hasDelta) {
    return {
      ready: false,
      code: "DAILY_KIT_DELTA_REQUIRED",
      error: "A new job was added after your Daily Kit was confirmed. Review and confirm the Daily Preparation update before going En Route.",
      items: [],
      kit,
    };
  }

  return { ready: true, kit };
}

/** Attribute already-issued Daily Kit consumables to a specific installation. */
async function recordOrderConsumableUsage({ technicianId, userId, orderId, date, usages = [], session = null }) {
  if (!session) return kitTransaction(tx => recordOrderConsumableUsage({ technicianId, userId, orderId, date, usages, session: tx }));
  if (!mongoose.isValidObjectId(orderId)) {
    throw Object.assign(new Error("Invalid order id"), { status: 400 });
  }
  const { start } = dayBounds(date);
  const kit = await DailyKit.findOne({ technicianId, workDate: start }).session(session);
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
    const remaining = require('./kitMaterialBalance').available(item);
    if (usage.quantity > remaining) {
      throw Object.assign(new Error(`${usage.name} usage exceeds the ${remaining} ${item.unit || "pcs"} still available.`), { status: 409 });
    }
  }

  for (const usage of normalized.values()) {
    const item = covered.find((candidate) => candidate.name.toLowerCase() === usage.name.toLowerCase());
    item.quantityUsed = Number(item.quantityUsed || 0) + usage.quantity;
    const tool = item.toolId ? await Tool.findById(item.toolId).select("costPrice").session(session).lean() : null;
    await ServiceToolUsage.create([{
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
    }], { session });
  }
  await kit.save({ session });
  return { kit, recorded: [...normalized.values()] };
}

/**
 * Atomically attribute issued consumables to a booking completion. Passing the
 * assignment id makes retries idempotent instead of decrementing the same kit
 * twice after an interrupted response.
 */
async function recordBookingConsumableUsage({ technicianId, userId, assignmentId, bookingId, date, usages = [], session }) {
  if (!mongoose.isValidObjectId(assignmentId) || !mongoose.isValidObjectId(bookingId)) {
    throw Object.assign(new Error("Invalid assignment or booking id"), { status: 400 });
  }

  const normalized = new Map();
  for (const row of usages || []) {
    const name = String(row?.itemName || row?.name || "").trim();
    const quantity = Number(row?.quantityUsed ?? row?.quantity ?? 0);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) {
      throw Object.assign(new Error("Consumable usage must contain a valid item name and positive quantity."), { status: 400 });
    }
    const key = name.toLowerCase();
    const existing = normalized.get(key);
    normalized.set(key, { name, quantity: quantity + Number(existing?.quantity || 0) });
  }
  const existingQuery = ServiceToolUsage.find({ assignmentId, lifecycleStatus: { $ne: "voided" } }).lean();
  if (session) existingQuery.session(session);
  const existingRows = await existingQuery;
  if (existingRows.length) {
    const recorded = new Map(existingRows.map(row => [String(row.itemName).trim().toLowerCase(), Number(row.quantityUsed || 0)]));
    const sameUsage = recorded.size === normalized.size
      && [...normalized].every(([key, row]) => recorded.get(key) === row.quantity);
    if (!sameUsage) {
      throw Object.assign(new Error("Consumable usage was already recorded for this completion. Refresh the assignment before retrying."), { status: 409 });
    }
    return { recorded: [...normalized.values()], alreadyRecorded: true };
  }

  const { start } = dayBounds(date);
  const kitQuery = DailyKit.findOne({ technicianId, workDate: start });
  if (session) kitQuery.session(session);
  const kit = await kitQuery;
  if (!kit && !normalized.size) return { recorded: [] };
  if (!kit) throw Object.assign(new Error("No Daily Kit was found for this service date."), { status: 409 });

  const covered = (kit.items || []).filter(item =>
    item.category === "consumable"
    && (item.bookingIds || []).some(id => String(id) === String(bookingId))
  );
  const missing = covered.filter(item => !normalized.has(item.name.toLowerCase()));
  if (missing.length) {
    throw Object.assign(new Error(`Record consumable usage for: ${missing.map(item => item.name).join(", ")}.`), { status: 400 });
  }
  if (!normalized.size) return { kit, recorded: [] };
  const usageRows = [];
  for (const usage of normalized.values()) {
    const item = covered.find(candidate => candidate.name.toLowerCase() === usage.name.toLowerCase());
    if (!item) throw Object.assign(new Error(`${usage.name} is not assigned to this booking's Daily Kit.`), { status: 403 });
    const remaining = require('./kitMaterialBalance').available(item);
    if (usage.quantity > remaining) {
      throw Object.assign(new Error(`${usage.name} usage exceeds the ${remaining} ${item.unit || "pcs"} still available.`), { status: 409 });
    }
    const toolQuery = item.toolId ? Tool.findById(item.toolId).select("costPrice").lean() : null;
    if (session && toolQuery) toolQuery.session(session);
    const tool = toolQuery ? await toolQuery : null;
    item.quantityUsed = Number(item.quantityUsed || 0) + usage.quantity;
    usageRows.push({
      assignmentId,
      bookingId,
      technicianId,
      toolItemId: item.toolId || undefined,
      inventoryItemId: item.toolId || undefined,
      itemName: item.name,
      itemType: "consumable",
      unit: item.unit || "pcs",
      quantityUsed: usage.quantity,
      unitPrice: Number(tool?.costPrice || 0),
      deductedFromInventory: true,
      notes: "Actual service usage committed with proof of completion",
      recordedBy: userId,
    });
  }

  await kit.save({ session });
  await ServiceToolUsage.insertMany(usageRows, { session });
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
        const nextQuantity = Math.max(existingDelta.quantity, requestedQuantity - Number(existingMain?.quantity || 0));
        if (nextQuantity !== existingDelta.quantity) {
          existingDelta.preparedChecked = false;
          existingDelta.preparedCheckedAt = null;
          existingDelta.preparedCheckedBy = null;
        }
        existingDelta.quantity = nextQuantity;
      } else if (isConfirmedKit && requestedQuantity > existingMain.quantity) {
        target.push({ ...hydrated, quantity: requestedQuantity - existingMain.quantity });
      } else if (!isConfirmedKit) {
        const nextQuantity = Math.max(existing.quantity, requestedQuantity);
        if (nextQuantity !== existing.quantity) {
          existing.preparedChecked = false;
          existing.preparedCheckedAt = null;
          existing.preparedCheckedBy = null;
        }
        existing.quantity = nextQuantity;
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

module.exports = {
  ACTIVE_ASSIGNMENT_STATUSES,
  dayBounds,
  syncDailyKit,
  checklistItems,
  needsChecklistCheck,
  retainChecklistState,
  setDailyKitItemChecked,
  addDailyKitItem,
  removeDailyKitItem,
  confirmDailyKit,
  dailyKitDepartureReadiness,
  dailyKitReadiness,
  recordBookingConsumableUsage,
  recordOrderConsumableUsage,
  addProjectItemsToDailyKit,
};
