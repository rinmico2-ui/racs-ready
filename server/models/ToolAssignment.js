const mongoose = require("mongoose");

/**
 * ToolAssignment — Tracks tools assigned to a technician.
 * Supports checkout/return workflow with condition tracking.
 */
const TOOL_ASSIGNMENT_STATUSES = ["assigned", "returned", "lost"];
const TOOL_CONDITIONS = ["good", "fair", "damaged", "lost"];

const toolAssignmentSchema = new mongoose.Schema(
  {
    // ── References ───────────────────────────────────────────────────────────
    toolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: true,
      index: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },

    // ── Snapshot ─────────────────────────────────────────────────────────────
    toolName: { type: String, trim: true, required: true },
    toolBarcode: { type: String, trim: true, default: "" },
    itemType: {
      type: String,
      enum: ["equipment", "part", "consumable", "tool"],
      default: "equipment",
    },
    quantity: { type: Number, default: 1, min: 1 },

    // ── Status ───────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: TOOL_ASSIGNMENT_STATUSES,
      default: "assigned",
      index: true,
    },

    condition: {
      type: String,
      enum: TOOL_CONDITIONS,
      default: "good",
    },

    // ── Dates ────────────────────────────────────────────────────────────────
    assignedDate: { type: Date, default: Date.now },
    returnedDate: { type: Date, default: null },

    // ── Admin who assigned/returned ──────────────────────────────────────────
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    returnedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Notes ────────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    returnNotes: { type: String, trim: true, maxlength: 500, default: "" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
toolAssignmentSchema.index({ technicianId: 1, status: 1 });
toolAssignmentSchema.index({ toolId: 1, status: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────

/** How long the tool has been assigned (days) */
toolAssignmentSchema.virtual("daysAssigned").get(function () {
  const start = this.assignedDate;
  const end = this.returnedDate || new Date();
  return Math.ceil((end - start) / (1000 * 60 * 60 * 24));
});

/** Human-readable status */
toolAssignmentSchema.virtual("statusLabel").get(function () {
  const labels = {
    assigned: "Assigned",
    returned: "Returned",
    lost: "Lost",
  };
  return labels[this.status] || this.status;
});

/** Human-readable condition */
toolAssignmentSchema.virtual("conditionLabel").get(function () {
  const labels = {
    good: "Good",
    fair: "Fair",
    damaged: "Damaged",
    lost: "Lost",
  };
  return labels[this.condition] || this.condition;
});

module.exports = mongoose.model("ToolAssignment", toolAssignmentSchema);
