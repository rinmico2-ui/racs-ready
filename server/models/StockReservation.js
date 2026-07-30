const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// StockReservation — Reserves inventory for approved quotations
// ─────────────────────────────────────────────────────────────────────────────
// When a customer approves a quotation, stock is reserved (soft deducted)
// from Tool inventory. On repair completion, reservations convert to
// ServiceToolUsage records (fulfilled). On cancel, stock is released.
// ─────────────────────────────────────────────────────────────────────────────

const RESERVATION_STATUSES = ["reserved", "fulfilled", "cancelled"];

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
  bookingId, parts, reservedBy,
}) {
  const Tool = mongoose.model("Tool");
  const reservations = [];
  const insufficientStock = [];

  for (const part of parts) {
    if (!part.toolId) continue; // Skip custom (non-inventory) parts

    const qty = parseInt(part.quantity) || 1;

    // Use findOneAndUpdate with $inc for atomic stock deduction
    const tool = await Tool.findOneAndUpdate(
      {
        _id: part.toolId,
        active: true,
        quantity: { $gte: qty },
      },
      {
        $inc: { quantity: -qty },
      },
      {
        new: true,
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
      quantity: qty,
      status: "reserved",
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

  const reservations = await this.find({
    bookingId,
    status: "reserved",
  }).lean();

  for (const res of reservations) {
    // Create ServiceToolUsage record
    await ServiceToolUsage.create({
      bookingId,
      technicianId,
      toolItemId: res.toolId,
      inventoryItemId: res.toolId,
      itemName: res.itemName,
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
    // Restore stock
    await Tool.findByIdAndUpdate(res.toolId, {
      $inc: { quantity: res.quantity },
    });

    // Mark reservation as cancelled
    await this.findByIdAndUpdate(res._id, {
      status: "cancelled",
      cancelledAt: new Date(),
    });
  }

  return reservations;
};

module.exports = mongoose.model("StockReservation", stockReservationSchema);
