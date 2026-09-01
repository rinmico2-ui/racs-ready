const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// StockReservation — Reserves inventory for approved quotations
// ─────────────────────────────────────────────────────────────────────────────
// When a customer approves a quotation, stock is reserved (soft deducted)
// from Tool inventory. On repair completion, reservations convert to
// ServiceToolUsage records (fulfilled). On cancel, stock is released.
// ─────────────────────────────────────────────────────────────────────────────

const RESERVATION_STATUSES = ["reserved", "checked_out", "fulfilled", "cancelled"];

const stockReservationSchema = new mongoose.Schema(
  {
    toolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: true,
      index: true,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      required: true,
      index: true,
    },
    serviceItemId: { type: mongoose.Schema.Types.ObjectId, index: true },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      enum: RESERVATION_STATUSES,
      default: "reserved",
      index: true,
    },

    // Quotation reservations historically deduct physical stock immediately;
    // technician AI reservations hold stock until checkout.
    stockTreatment: {
      type: String,
      enum: ["deducted", "soft_hold"],
      default: "deducted",
      index: true,
    },

    reservedAt: {
      type: Date,
      default: Date.now,
    },

    fulfilledAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    // Snapshot of item info at reservation time (for historical accuracy)
    itemName: {
      type: String,
      trim: true,
    },

    unitPrice: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

stockReservationSchema.index({ bookingId: 1, status: 1 });
stockReservationSchema.index({ bookingId: 1, serviceItemId: 1, status: 1 });
stockReservationSchema.index({ toolId: 1, status: 1 });

// ─── Static Helpers ──────────────────────────────────────────────────────────

/**
 * Reserve stock for a booking's quotation parts.
 * @param {Object} params
 * @param {ObjectId} params.bookingId
 * @param {Array} params.parts - [{ name, cost, quantity, toolId? }]
 * @param {ObjectId} params.reservedBy - User who approved
 * @returns {Object} { reservations, insufficientStock: [...] }
 */
stockReservationSchema.statics.reserveForBooking = async function ({
  bookingId, serviceItemId = null, parts, reservedBy,
}) {
  const Tool = mongoose.model("Tool");
  const reservations = [];
  const insufficientStock = [];

  for (const part of parts) {
    if (!part.toolId) continue; // Skip custom (non-inventory) parts

    const inv = await Tool.findById(part.toolId).select('type inventoryClass').lean();
    if (!inv || Tool.effectiveInventoryClass(inv) !== 'merchandise') continue;
    const itemType = inv ? (inv.type === 'tool' ? 'equipment' : (inv.type || 'part')) : 'part';
    if (itemType === 'equipment') continue; // equipment is not consumed from stock

    const qty = parseInt(part.quantity) || 1;

    // Use findOneAndUpdate with $inc for atomic stock deduction
    const tool = await Tool.findOneAndUpdate(
      {
        _id: part.toolId,
        active: true,
        $and: [Tool.merchandiseFilter()],
        quantity: { $gte: qty },
      },
      {
        $inc: { quantity: -qty },
      },
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    if (!tool) {
      // Either tool not found, inactive, or insufficient stock
      const toolDoc = await Tool.findById(part.toolId).lean();
      if (toolDoc) {
        insufficientStock.push({
          toolId: toolDoc._id,
          itemName: toolDoc.itemName,
          requested: qty,
          available: toolDoc.quantity || 0,
        });
      }
      continue;
    }

    // Create reservation
    const reservation = await this.create({
      toolId: tool._id,
      bookingId,
      serviceItemId,
      quantity: qty,
      status: "reserved",
      stockTreatment: "deducted",
      itemName: tool.itemName,
      unitPrice: Number(part.cost) || Number(tool.costPrice) || 0,
    });

    reservations.push(reservation);
  }

  return { reservations, insufficientStock };
};

/**
 * Fulfill reservations for a completed repair (convert to ServiceToolUsage).
 * @param {ObjectId} bookingId
 * @param {ObjectId} technicianId
 * @param {ObjectId} recordedBy - User who completed the repair
 */
stockReservationSchema.statics.fulfillForBooking = async function ({
  bookingId, technicianId, recordedBy,
}) {
  const ServiceToolUsage = mongoose.model("ServiceToolUsage");
  const Tool = mongoose.model("Tool");

  const reservations = await this.find({
    bookingId,
    status: "reserved",
  }).lean();

  for (const res of reservations) {
    const inv = res.toolId ? await Tool.findById(res.toolId).select('type').lean() : null;
    const itemType = inv ? (inv.type === 'tool' ? 'equipment' : (inv.type || 'part')) : 'part';
    // Create ServiceToolUsage record
    await ServiceToolUsage.create({
      bookingId,
      technicianId,
      toolItemId: res.toolId,
      inventoryItemId: res.toolId,
      itemName: res.itemName,
      itemType,
      quantityUsed: res.quantity,
      unitPrice: res.unitPrice,
      deductedFromInventory: true, // Already deducted at reservation
      toolCost: res.unitPrice * res.quantity,
      recordedBy,
      usedAt: new Date(),
    });

    // Mark reservation as fulfilled
    await this.findByIdAndUpdate(res._id, {
      status: "fulfilled",
      fulfilledAt: new Date(),
    });
  }

  return reservations;
};

/**
 * Release (cancel) reservations and restore stock.
 * @param {ObjectId} bookingId
 */
stockReservationSchema.statics.releaseForBooking = async function (bookingId) {
  const Tool = mongoose.model("Tool");

  const reservations = await this.find({
    bookingId,
    status: "reserved",
  }).lean();

  for (const res of reservations) {
    if (res.stockTreatment === "soft_hold") {
      const tool = await Tool.findById(res.toolId);
      if (tool) {
        tool.reservedQuantity = Math.max(0, (Number(tool.reservedQuantity) || 0) - res.quantity);
        await tool.save();
      }
    } else {
      // Legacy quotation reservations deducted physical stock at reservation.
      await Tool.findByIdAndUpdate(res.toolId, { $inc: { quantity: res.quantity } });
    }

    // Mark reservation as cancelled
    await this.findByIdAndUpdate(res._id, {
      status: "cancelled",
      cancelledAt: new Date(),
    });
  }

  return reservations;
};

/**
 * Release active reservations whose booking has been deleted.
 *
 * Technician AI reservations use a soft hold until checkout. Only those
 * explicit holds are safe to release automatically; deducted quotation stock
 * remains subject to the normal booking cancellation/release workflow.
 */
stockReservationSchema.statics.releaseOrphanedForTool = async function (toolId) {
  if (!toolId) return { released: 0, softReleased: 0, hardReleased: 0 };

  const Tool = mongoose.model("Tool");
  const BookingService = mongoose.model("BookingService");
  const reservations = await this.find({ toolId, status: "reserved", stockTreatment: "soft_hold" })
    .select("_id bookingId quantity")
    .lean();
  if (!reservations.length) return { released: 0, softReleased: 0, hardReleased: 0 };

  const bookingIds = [...new Set(reservations.map((row) => String(row.bookingId || "")).filter(Boolean))];
  const existingBookings = await BookingService.find({ _id: { $in: bookingIds } }).select("_id").lean();
  const existingIds = new Set(existingBookings.map((row) => String(row._id)));
  const orphaned = reservations.filter((row) => !row.bookingId || !existingIds.has(String(row.bookingId)));
  if (!orphaned.length) return { released: 0, softReleased: 0, hardReleased: 0 };

  const orphanedQty = orphaned.reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0);
  const tool = await Tool.findById(toolId);
  let softReleased = 0;
  const hardReleased = 0;
  if (tool) {
    softReleased = Math.min(Math.max(0, Number(tool.reservedQuantity) || 0), orphanedQty);
    tool.reservedQuantity = Math.max(0, (Number(tool.reservedQuantity) || 0) - softReleased);
    await tool.save();
  }

  await this.updateMany(
    { _id: { $in: orphaned.map((row) => row._id) }, status: "reserved" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
  );

  return { released: orphaned.length, softReleased, hardReleased };
};

module.exports = mongoose.model("StockReservation", stockReservationSchema);
