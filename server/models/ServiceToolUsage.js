const mongoose = require("mongoose");

const serviceToolUsageSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      required: false,
      index: true,
      set: (v) => (v === "" || v === null ? undefined : v),
      // null means the usage is not tied to a specific appointment
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: false,
      index: true,
      set: (v) => (v === "" || v === null ? undefined : v),
    },
    // Primary reference — points to the Tool collection
    toolItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: false,
      index: true,
      set: (v) => (v === "" || v === null ? undefined : v),
    },
    // @deprecated — use toolItemId instead. Kept for backward compatibility.
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: false,
      index: true,
      set: (v) => (v === "" || v === null ? undefined : v),
    },

    // Snapshots preserve historical accuracy even if inventory changes later.
    itemName: { type: String, required: true, trim: true },
    unit: { type: String, default: "pcs", trim: true },

    quantityUsed: {
      type: Number,
      required: true,
      min: 0.0001,
    },

    unitPrice: {
      type: Number,
      default: 0,
      min: 0,
      // snapshot price per unit at time of usage
    },

    deductedFromInventory: {
      type: Boolean,
      default: false,
      // true only when stock was decremented from Inventory for this usage entry
    },

    // additional fields for cost tracking
    fuelUsed: {
      type: Number,
      default: 0,
      min: 0,
      // interpreted as liters or appropriate unit; not required
    },
    toolCost: {
      type: Number,
      default: 0,
      min: 0,
      // price paid for the quantity of tools used; useful for revenue/expense calculation
    },

    notes: { type: String, trim: true, maxlength: 500 },
    usedAt: { type: Date, default: Date.now, index: true },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

serviceToolUsageSchema.index({ bookingId: 1, usedAt: -1 });
serviceToolUsageSchema.index({ technicianId: 1, usedAt: -1 });

module.exports = mongoose.model("ServiceToolUsage", serviceToolUsageSchema);
