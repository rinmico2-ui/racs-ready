const mongoose = require("mongoose");
const audit = require("./audit");
const BookingService = require("../models/BookingService");
const Inventory = require("../models/Inventory");
const Tool = require("../models/Tool");
const ServiceToolUsage = require("../models/ServiceToolUsage");

function parseDateBound(v, endOfDay = false) {
  if (!v) return null;
  const d = new Date(String(v) + (endOfDay ? "T23:59:59" : "T00:00:00"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildToolUsageFilter(query = {}) {
  const q = query || {};
  const filter = {};

  if (q.bookingId && mongoose.Types.ObjectId.isValid(q.bookingId)) {
    filter.bookingId = q.bookingId;
  }
  if (q.technicianId && mongoose.Types.ObjectId.isValid(q.technicianId)) {
    filter.technicianId = q.technicianId;
  }
  if (q.toolItemId && mongoose.Types.ObjectId.isValid(q.toolItemId)) {
    filter.toolItemId = q.toolItemId;
  }
  // Support legacy inventoryItemId query parameter
  if (q.inventoryItemId && mongoose.Types.ObjectId.isValid(q.inventoryItemId)) {
    filter.inventoryItemId = q.inventoryItemId;
  }

  if (q.start || q.end) {
    const usedAt = {};
    const start = parseDateBound(q.start, false);
    const end = parseDateBound(q.end, true);
    if (start) usedAt.$gte = start;
    if (end) usedAt.$lte = end;
    if (usedAt.$gte || usedAt.$lte) filter.usedAt = usedAt;
  }

  const minFuel = toNumberOrNull(q.minFuel);
  const maxFuel = toNumberOrNull(q.maxFuel);
  if (minFuel !== null || maxFuel !== null) {
    filter.fuelUsed = {};
    if (minFuel !== null) filter.fuelUsed.$gte = minFuel;
    if (maxFuel !== null) filter.fuelUsed.$lte = maxFuel;
  }

  const minToolCost = toNumberOrNull(q.minToolCost);
  const maxToolCost = toNumberOrNull(q.maxToolCost);
  if (minToolCost !== null || maxToolCost !== null) {
    filter.toolCost = {};
    if (minToolCost !== null) filter.toolCost.$gte = minToolCost;
    if (maxToolCost !== null) filter.toolCost.$lte = maxToolCost;
  }

  return filter;
}

async function listToolUsage(query = {}, limitDefault = 200) {
  const filter = buildToolUsageFilter(query);
  const limit = Math.min(Math.max(1, Number(query.limit) || limitDefault), 1000);

  const items = await ServiceToolUsage.find(filter)
    .sort({ usedAt: -1 })
    .limit(limit)
    .populate("bookingId", "bookingReference bookingDate startTime customerName")
    .populate("technicianId", "name firstName lastName email")
    .lean();

  const totals = items.reduce(
    (acc, x) => {
      acc.quantityUsed += Number(x.quantityUsed) || 0;
      acc.fuelUsed += Number(x.fuelUsed) || 0;
      acc.toolCost += Number(x.toolCost) || 0;
      return acc;
    },
    { quantityUsed: 0, fuelUsed: 0, toolCost: 0 },
  );

  return { items, count: items.length, totals, filter };
}

async function summarizeToolUsage(query = {}) {
  const match = buildToolUsageFilter(query);

  const [totalsRow] = await ServiceToolUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        entries: { $sum: 1 },
        quantityUsed: { $sum: { $ifNull: ["$quantityUsed", 0] } },
        fuelUsed: { $sum: { $ifNull: ["$fuelUsed", 0] } },
        toolCost: { $sum: { $ifNull: ["$toolCost", 0] } },
      },
    },
  ]);

  const byTechnician = await ServiceToolUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$technicianId",
        entries: { $sum: 1 },
        quantityUsed: { $sum: { $ifNull: ["$quantityUsed", 0] } },
        fuelUsed: { $sum: { $ifNull: ["$fuelUsed", 0] } },
        toolCost: { $sum: { $ifNull: ["$toolCost", 0] } },
      },
    },
    { $sort: { toolCost: -1 } },
    { $limit: 20 },
  ]);

  const byDay = await ServiceToolUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$usedAt",
            timezone: "Asia/Manila",
          },
        },
        entries: { $sum: 1 },
        quantityUsed: { $sum: { $ifNull: ["$quantityUsed", 0] } },
        fuelUsed: { $sum: { $ifNull: ["$fuelUsed", 0] } },
        toolCost: { $sum: { $ifNull: ["$toolCost", 0] } },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 31 },
  ]);

  const totals = {
    entries: Number(totalsRow?.entries || 0),
    quantityUsed: Number(totalsRow?.quantityUsed || 0),
    fuelUsed: Number(totalsRow?.fuelUsed || 0),
    toolCost: Number(totalsRow?.toolCost || 0),
  };

  return { totals, byTechnician, byDay, filter: match };
}

async function createToolUsageEntry({
  body = {},
  actorId,
  req,
  moduleName = "admin",
  allowFuelAndToolCostInput = true,
}) {
  const bookingId = String(body.bookingId || "").trim();
  // allow empty to indicate "all" or general usage
  const inventoryItemId = String(body.inventoryItemId || "").trim();
  const manualItemName = String(body.itemName || "").trim();
  const manualUnit = String(body.unit || "pcs").trim() || "pcs";
  const manualUnitPriceRaw =
    body.unitPrice == null || body.unitPrice === "" ? null : Number(body.unitPrice);
  const quantityUsed = Number(body.quantityUsed);
  const technicianIdRaw = String(body.technicianId || "").trim();
  const notes = String(body.notes || "").trim().slice(0, 500);
  const fuelUsed = body.fuelUsed == null || body.fuelUsed === "" ? null : Number(body.fuelUsed);
  const toolCostInput = body.toolCost == null || body.toolCost === "" ? null : Number(body.toolCost);

  if (bookingId && !mongoose.Types.ObjectId.isValid(bookingId)) {
    const e = new Error("Invalid booking id");
    e.status = 400;
    throw e;
  }
  if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
    const e = new Error("Quantity used must be greater than zero");
    e.status = 400;
    throw e;
  }
  const hasInventorySelection = mongoose.Types.ObjectId.isValid(inventoryItemId);
  if (!hasInventorySelection && !manualItemName) {
    const e = new Error("Select inventory item or provide material name");
    e.status = 400;
    throw e;
  }
  if (!hasInventorySelection) {
    if (!Number.isFinite(manualUnitPriceRaw) || manualUnitPriceRaw < 0) {
      const e = new Error("unitPrice is required for manual material entry");
      e.status = 400;
      throw e;
    }
  }
  if (!allowFuelAndToolCostInput && fuelUsed !== null) {
    const e = new Error("Fuel cost can only be encoded by technician");
    e.status = 403;
    throw e;
  }
  if (!allowFuelAndToolCostInput && toolCostInput !== null) {
    const e = new Error("Tool cost is computed automatically for this role");
    e.status = 403;
    throw e;
  }
  if (fuelUsed !== null && (!Number.isFinite(fuelUsed) || fuelUsed < 0)) {
    const e = new Error("Fuel used must be a non-negative number");
    e.status = 400;
    throw e;
  }
  if (toolCostInput !== null && (!Number.isFinite(toolCostInput) || toolCostInput < 0)) {
    const e = new Error("Tool cost must be a non-negative number");
    e.status = 400;
    throw e;
  }

  let booking = null;
  if (bookingId) {
    booking = await BookingService.findById(bookingId).lean();
    if (!booking) {
      const e = new Error("Appointment/booking not found");
      e.status = 404;
      throw e;
    }
  }

  let technicianId =
    mongoose.Types.ObjectId.isValid(technicianIdRaw)
      ? technicianIdRaw
      : booking && mongoose.Types.ObjectId.isValid(String(booking.technicianId || ""))
        ? booking.technicianId
        : null;
  // if no technician identifiable, tools are "general" and technicianId may remain null

  if (bookingId && (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId))) {
    const e = new Error("Valid technician id is required when booking is specified");
    e.status = 400;
    throw e;
  }

  let updatedItem = null;
  let catalogItem = null;
  let itemType = 'part';
  if (hasInventorySelection) {
    const inv = await Tool.findById(inventoryItemId).select('itemName unit type').lean();
    itemType = inv ? (inv.type === 'tool' ? 'equipment' : (inv.type || 'part')) : 'part';
    if (itemType === 'equipment') {
      // Equipment is not consumed; do not deduct stock.
      catalogItem = inv;
    } else {
      updatedItem = await Tool.findOneAndUpdate(
        {
          _id: inventoryItemId,
          active: true,
          isStockItem: true,
          quantity: { $gte: quantityUsed },
        },
        { $inc: { quantity: -quantityUsed } },
        { returnDocument: "after" },
      ).lean();

      if (!updatedItem) {
        const e = new Error("Insufficient stock or invalid tool item");
        e.status = 409;
        throw e;
      }
      catalogItem = updatedItem;
    }
  }

  if (!hasInventorySelection) {
    const Category = require("../models/Category");
    const toolsCategory = await Category.findOneAndUpdate(
      { name: "Tools & Equipment" },
      { $setOnInsert: { name: "Tools & Equipment" } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();

    const unitPrice = Number(manualUnitPriceRaw || 0);
    const existing = await Tool.findOne({
      active: true,
      itemName: manualItemName,
      unit: manualUnit,
      isStockItem: true,
    });

    if (existing) {
      if (!Number.isFinite(existing.costPrice) || Number(existing.costPrice) <= 0) {
        existing.costPrice = unitPrice;
      }
      if (!Number.isFinite(existing.sellingPrice) || Number(existing.sellingPrice) <= 0) {
        existing.sellingPrice = unitPrice;
      }
      await existing.save();
      catalogItem = existing.toObject();
    } else {
      const created = await Tool.create({
        itemName: manualItemName,
        unit: manualUnit,
        quantity: 0,
        minStockLevel: 0,
        costPrice: unitPrice,
        sellingPrice: unitPrice,
        isStockItem: true,
        active: true,
      });
      catalogItem = created.toObject();
    }
  }

  const usagePayload = {
    bookingId: mongoose.Types.ObjectId.isValid(bookingId) ? bookingId : undefined,
    technicianId: mongoose.Types.ObjectId.isValid(String(technicianId || ""))
      ? technicianId
      : undefined,
    toolItemId: updatedItem ? updatedItem._id : catalogItem ? catalogItem._id : undefined,
    inventoryItemId: updatedItem ? updatedItem._id : catalogItem ? catalogItem._id : undefined,
    itemName: catalogItem ? catalogItem.itemName : manualItemName,
    itemType: catalogItem ? (catalogItem.type === 'tool' ? 'equipment' : (catalogItem.type || 'part')) : 'part',
    unit: catalogItem ? catalogItem.unit || "pcs" : manualUnit,
    quantityUsed,
    unitPrice: catalogItem ? Number(catalogItem.costPrice) || 0 : Number(manualUnitPriceRaw || 0),
    deductedFromInventory: Boolean(updatedItem),
    notes,
    recordedBy: actorId,
  };

  if (allowFuelAndToolCostInput) {
    if (fuelUsed !== null) usagePayload.fuelUsed = fuelUsed;
    if (toolCostInput !== null) usagePayload.toolCost = toolCostInput;
  }
  if (!allowFuelAndToolCostInput || toolCostInput === null) {
    usagePayload.toolCost = (usagePayload.unitPrice || 0) * quantityUsed;
  }

  if (body.usedAt) {
    const d = new Date(body.usedAt);
    if (!Number.isNaN(d.getTime())) usagePayload.usedAt = d;
  }

  const usage = await ServiceToolUsage.create(usagePayload);

  await audit.logEvent({
    actor: actorId,
    target: usage.bookingId || usage._id,
    action: "tool.usage.create",
    module: moduleName,
    req,
    details: {
      usageId: usage._id,
      bookingId: usage.bookingId || null,
      technicianId: usage.technicianId || null,
      inventoryItemId: updatedItem ? inventoryItemId : null,
      quantityUsed,
      fuelUsed: usage.fuelUsed || 0,
      toolCost: usage.toolCost || 0,
      remainingQty: updatedItem ? updatedItem.quantity : null,
    },
  });

  return { usage, inventory: updatedItem || catalogItem || null };
}

async function updateToolUsageEntry({
  usageId,
  body = {},
  actorId,
  req,
  moduleName = "admin",
  allowFuelAndToolCostPatch = true,
}) {
  if (!mongoose.Types.ObjectId.isValid(usageId)) {
    const e = new Error("Invalid usage id");
    e.status = 400;
    throw e;
  }

  const usage = await ServiceToolUsage.findById(usageId);
  if (!usage) {
    const e = new Error("Tool usage record not found");
    e.status = 404;
    throw e;
  }

  const patch = {};

  if (body.notes !== undefined) patch.notes = String(body.notes || "").trim().slice(0, 500);

  if (!allowFuelAndToolCostPatch && body.fuelUsed !== undefined) {
    const e = new Error("Fuel cost can only be updated by technician");
    e.status = 403;
    throw e;
  }
  if (!allowFuelAndToolCostPatch && body.toolCost !== undefined) {
    const e = new Error("Tool cost cannot be edited for this role");
    e.status = 403;
    throw e;
  }

  if (body.fuelUsed !== undefined) {
    const v = Number(body.fuelUsed);
    if (!Number.isFinite(v) || v < 0) {
      const e = new Error("Fuel used must be a non-negative number");
      e.status = 400;
      throw e;
    }
    patch.fuelUsed = v;
  }

  if (body.toolCost !== undefined) {
    const v = Number(body.toolCost);
    if (!Number.isFinite(v) || v < 0) {
      const e = new Error("Tool cost must be a non-negative number");
      e.status = 400;
      throw e;
    }
    patch.toolCost = v;
  }

  if (body.usedAt !== undefined) {
    const d = new Date(body.usedAt);
    if (Number.isNaN(d.getTime())) {
      const e = new Error("Invalid usedAt date");
      e.status = 400;
      throw e;
    }
    patch.usedAt = d;
  }

  if (body.quantityUsed !== undefined) {
    const newQty = Number(body.quantityUsed);
    if (!Number.isFinite(newQty) || newQty <= 0) {
      const e = new Error("Quantity used must be greater than zero");
      e.status = 400;
      throw e;
    }

    const oldQty = Number(usage.quantityUsed) || 0;
    const delta = newQty - oldQty;

    if (usage.inventoryItemId && usage.deductedFromInventory) {
      if (delta > 0) {
        const inv = await Tool.findOneAndUpdate(
          { _id: usage.inventoryItemId, quantity: { $gte: delta } },
          { $inc: { quantity: -delta } },
          { returnDocument: "after" },
        );
        if (!inv) {
          const e = new Error("Insufficient stock for quantity increase");
          e.status = 409;
          throw e;
        }
      } else if (delta < 0) {
        await Tool.findByIdAndUpdate(usage.inventoryItemId, { $inc: { quantity: Math.abs(delta) } });
      }
    }

    patch.quantityUsed = newQty;
    if (body.toolCost === undefined && Number.isFinite(Number(usage.unitPrice))) {
      patch.toolCost = Number(usage.unitPrice) * newQty;
    }
  }

  Object.assign(usage, patch);
  await usage.save();

  await audit.logEvent({
    actor: actorId,
    target: usage.bookingId,
    action: "tool.usage.update",
    module: moduleName,
    req,
    details: {
      usageId: usage._id,
      patch,
    },
  });

  return usage;
}

async function deleteToolUsageEntry({ usageId, actorId, req, moduleName = "admin" }) {
  if (!mongoose.Types.ObjectId.isValid(usageId)) {
    const e = new Error("Invalid usage id");
    e.status = 400;
    throw e;
  }

  const usage = await ServiceToolUsage.findById(usageId);
  if (!usage) {
    const e = new Error("Tool usage record not found");
    e.status = 404;
    throw e;
  }

  if (usage.inventoryItemId && usage.deductedFromInventory) {
    await Tool.findByIdAndUpdate(usage.inventoryItemId, {
      $inc: { quantity: Number(usage.quantityUsed) || 0 },
    });
  }

  await usage.deleteOne();

  await audit.logEvent({
    actor: actorId,
    target: usage.bookingId,
    action: "tool.usage.delete",
    module: moduleName,
    req,
    details: {
      usageId: usage._id,
      inventoryItemId: usage.inventoryItemId,
      restoredQty: Number(usage.quantityUsed) || 0,
    },
  });

  return { deleted: true, usageId: String(usage._id) };
}

module.exports = {
  buildToolUsageFilter,
  listToolUsage,
  summarizeToolUsage,
  createToolUsageEntry,
  updateToolUsageEntry,
  deleteToolUsageEntry,
};
