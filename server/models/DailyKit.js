const mongoose = require("mongoose");

/**
 * DailyKit — Daily dispatch preparation for technicians.
 * One kit per technician per day. Contains:
 *   - Standard kit (always bring)
 *   - Job-specific equipment (generated from today's assignments)
 *   - Consumables (tracked by usage)
 *
 * Equipment is reusable (checked out → returned).
 * Consumables are tracked by actual usage.
 * Repair parts are deliberately outside this model and stay in the existing
 * inspection, quotation and parts-reservation workflow.
 */

const KIT_STATUSES = ["draft", "prepared", "confirmed", "in_progress", "completed", "cancelled"];

const dailyKitItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  unit: { type: String, default: "pcs" },

  // Daily preparation contains operational equipment and consumables only.
  category: {
    type: String,
    enum: ["equipment", "consumable"],
    required: true,
  },

  // Source: standard (always bring), job_specific (from today's jobs), ai_recommended, manual
  source: {
    type: String,
    enum: ["standard", "job_specific", "ai_recommended", "manual"],
    default: "job_specific",
  },

  // Reference to inventory item (Tool model)
  toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
  toolCode: { type: String, default: null },

  // For equipment: checkout/return tracking
  checkoutStatus: {
    type: String,
    enum: ["pending", "reserved", "checked_out", "issued", "standard_kit", "returned", "unavailable", "exception"],
    default: "pending",
  },
  checkedOutAt: { type: Date },
  returnedAt: { type: Date },
  equipmentAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "EquipmentAssignment", default: null },

  // For consumables: actual usage tracking
  quantityIssued: { type: Number, default: 0 },
  quantityUsed: { type: Number, default: 0 },
  quantityReturned: { type: Number, default: 0 },

  // Which job(s) need this item
  assignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }],
  bookingIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "BookingService" }],

  // Conflict info (if equipment unavailable)
  conflict: {
    isUnavailable: { type: Boolean, default: false },
    checkedOutTo: { type: String, default: null }, // technician name
    message: { type: String, default: null },
  },

  notes: { type: String, trim: true },
  exception: {
    approved: { type: Boolean, default: false },
    reason: { type: String, trim: true, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
});

const dailyKitSchema = new mongoose.Schema({
  technicianId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Technician",
    required: true,
    index: true,
  },
  workDate: {
    type: Date,
    required: true,
    index: true,
  },

  status: {
    type: String,
    enum: KIT_STATUSES,
    default: "draft",
    index: true,
  },

  // Items in the kit
  items: [dailyKitItemSchema],

  // Summary counts
  totalEquipment: { type: Number, default: 0 },
  totalConsumables: { type: Number, default: 0 },
  totalRepairParts: { type: Number, default: 0 },

  // Job assignments included in this kit
  assignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }],
  bookingIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "BookingService" }],

  // Tracking
  generatedAt: { type: Date, default: Date.now },
  preparedAt: { type: Date },
  confirmedAt: { type: Date },
  completedAt: { type: Date },

  // When new jobs are added after confirmation, track delta
  hasDelta: { type: Boolean, default: false },
  deltaItems: [dailyKitItemSchema],

  notes: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

dailyKitSchema.pre("save", function () {
  this.updatedAt = new Date();
  // Recalculate summary counts
  this.totalEquipment = this.items.filter(i => i.category === "equipment").length;
  this.totalConsumables = this.items.filter(i => i.category === "consumable").length;
  this.totalRepairParts = this.items.filter(i => i.category === "repair_part").length;
});

// Unique index: one kit per technician per day
dailyKitSchema.index({ technicianId: 1, workDate: 1 }, { unique: true });

module.exports = mongoose.model("DailyKit", dailyKitSchema);
