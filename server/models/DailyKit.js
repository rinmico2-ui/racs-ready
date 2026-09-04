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
 * Repair parts are included ONLY for scheduled Phase 2 repair visits, where
 * the customer has approved a quotation and the exact parts are known. AI-
 * suggested parts during Phase 1 inspection remain outside this model and
 * stay in the existing inspection/quotation/parts-reservation workflow.
 */

const KIT_STATUSES = ["draft", "prepared", "confirmed", "in_progress", "completed", "cancelled"];

const orderAllocationSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const projectAllocationSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
  dailyAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DailyAssignment", default: null },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const dailyKitItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  unit: { type: String, default: "pcs" },

  // Daily preparation contains operational equipment, consumables, and — for
  // scheduled Phase 2 repair visits where the quotation is approved — the
  // exact repair parts to bring.
  category: {
    type: String,
    enum: ["equipment", "consumable", "repair_part"],
    required: true,
  },

  // Source: standard (always bring), job_specific (from today's jobs), ai_recommended, manual, quotation (Phase 2 repair parts)
  source: {
    type: String,
    enum: ["standard", "job_specific", "ai_recommended", "manual", "quotation"],
    default: "job_specific",
  },

  // Reference to inventory item (Tool model)
  toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
  toolCode: { type: String, default: null },

  // For equipment: checkout/return tracking
  checkoutStatus: {
    type: String,
    enum: ["pending", "reserved", "checked_out", "issued", "standard_kit", "in_custody", "returned", "damaged", "unavailable", "exception"],
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
  // Product delivery + installation orders participate directly in the
  // technician-day kit. The linked calendar booking is deliberately not the
  // inventory source, which prevents one installation from being counted
  // twice when order and booking workflows are both visible.
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
  // Per-order demand remains explicit even when identical requirements are
  // consolidated into one technician-day inventory row.
  orderAllocations: [orderAllocationSchema],
  // Confirmed project schedule rows participate in the same technician/day
  // kit as service bookings and installation orders. These links keep one
  // physical checkout auditable from every originating workflow.
  projectIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Project" }],
  workOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
  dailyAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "DailyAssignment" }],
  projectAllocations: [projectAllocationSchema],
  // Legacy project equipment may already be in this technician's custody.
  // Referencing it prevents the consolidated kit from deducting it again.
  custodyAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EquipmentAssignment" }],

  // Conflict info (if equipment unavailable)
  conflict: {
    isUnavailable: { type: Boolean, default: false },
    checkedOutTo: { type: String, default: null }, // technician name
    message: { type: String, default: null },
  },

  // Technician/admin resolution for unavailable items
  resolution: {
    status: {
      type: String,
      enum: [null, "confirmed_available", "not_required", "admin_notified",
             "assigned_from_stock", "procured", "rescheduled"],
      default: null,
    },
    source: { type: String, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, default: null },
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
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
  projectIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Project" }],
  workOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
  dailyAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "DailyAssignment" }],

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
