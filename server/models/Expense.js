const mongoose = require("mongoose");

/**
 * Expense — Fuel records, material costs, and general expenses logged by technicians.
 * Supports admin approval workflow.
 */
const EXPENSE_TYPES = ["fuel", "parking", "toll", "external_parts", "meal", "other", "material", "transport"];
const EXPENSE_STATUSES = ["pending", "approved", "rejected"];

const expenseSchema = new mongoose.Schema(
  {
    // ── Technician ───────────────────────────────────────────────────────────
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },

    technicianName: { type: String, trim: true, default: "" },

    // ── Expense Details ──────────────────────────────────────────────────────
    type: {
      type: String,
      enum: EXPENSE_TYPES,
      required: [true, "Expense type is required"],
      index: true,
    },

    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0.01, "Amount must be greater than zero"],
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      required: [true, "Description is required"],
    },

    // ── Optional link to an appointment ──────────────────────────────────────
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      default: null,
      index: true,
    },

    // ── Optional link to a large-scale project / work order ───────────────────
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },

    workOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      default: null,
      index: true,
    },

    // ── Fuel-specific fields ─────────────────────────────────────────────────
    fuelLiters: { type: Number, default: 0, min: 0 },
    pricePerLiter: { type: Number, default: 0, min: 0 },
    odometerReading: { type: Number, default: 0, min: 0 },
    gasStation: { type: String, trim: true, default: "" },

    // ── Receipt / Proof ──────────────────────────────────────────────────────
    receiptImage: { type: String, default: null },

    // ── Date of expense ──────────────────────────────────────────────────────
    expenseDate: { type: Date, default: Date.now, index: true },

    // ── Approval Workflow ────────────────────────────────────────────────────
    status: {
      type: String,
      enum: EXPENSE_STATUSES,
      default: "pending",
      index: true,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedAt: { type: Date, default: null },

    rejectionReason: { type: String, trim: true, maxlength: 500, default: "" },

    // ── Timestamps ───────────────────────────────────────────────────────────
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
expenseSchema.index({ technicianId: 1, expenseDate: -1 });
expenseSchema.index({ technicianId: 1, status: 1 });
expenseSchema.index({ type: 1, expenseDate: -1 });
expenseSchema.index({ technicianId: 1, bookingId: 1 });
expenseSchema.index({ status: 1, expenseDate: -1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────

/** Human-readable type label */
expenseSchema.virtual("typeLabel").get(function () {
  const labels = {
    fuel: "Fuel",
    parking: "Parking",
    toll: "Toll",
    external_parts: "External Parts",
    material: "Materials",
    transport: "Transport",
    meal: "Meal",
    other: "Other",
  };
  return labels[this.type] || this.type;
});

// ── Static Helpers ───────────────────────────────────────────────────────────

/**
 * Get monthly expense summary for a technician.
 * @param {ObjectId} technicianId
 * @param {number} year
 * @param {number} month (0-indexed)
 * @returns {Promise<Object>}
 */
expenseSchema.statics.getMonthlySummary = async function (
  technicianId,
  year,
  month
) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

  const pipeline = [
    {
      $match: {
        technicianId: new mongoose.Types.ObjectId(technicianId),
        expenseDate: { $gte: start, $lte: end },
      },
    },
    {
      $facet: {
        totalApproved: [
          { $match: { status: "approved" } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ],
        totalPending: [
          { $match: { status: "pending" } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ],
        byType: [
          { $match: { status: "approved" } },
          { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ],
        fuelTotal: [
          { $match: { status: "approved", type: "fuel" } },
          { $group: { _id: null, total: { $sum: "$amount" }, liters: { $sum: "$fuelLiters" } } },
        ],
      },
    },
  ];

  const [result] = await this.aggregate(pipeline);
  return {
    approvedTotal: result.totalApproved[0]?.total || 0,
    approvedCount: result.totalApproved[0]?.count || 0,
    pendingTotal: result.totalPending[0]?.total || 0,
    pendingCount: result.totalPending[0]?.count || 0,
    byType: result.byType || [],
    fuelTotal: result.fuelTotal[0]?.total || 0,
    fuelLiters: result.fuelTotal[0]?.liters || 0,
  };
};

module.exports = mongoose.model("Expense", expenseSchema);
