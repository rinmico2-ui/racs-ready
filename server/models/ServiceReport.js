const mongoose = require("mongoose");

/**
 * ServiceReport — Structured completion report for each service job.
 * Created by technician after completing a job, reviewed by admin.
 */
const REPORT_STATUSES = ["draft", "submitted", "approved", "revision_requested"];

const serviceReportSchema = new mongoose.Schema(
  {
    // ── References ───────────────────────────────────────────────────────────
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      required: true,
      index: true,
    },
    serviceItemId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      default: null,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },

    // ── Snapshots ────────────────────────────────────────────────────────────
    customerName: { type: String, trim: true, default: "" },
    serviceName: { type: String, trim: true, default: "" },
    serviceType: { type: String, trim: true, default: "" },
    bookingDate: { type: Date },

    // ── Report Content ───────────────────────────────────────────────────────
    findings: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    recommendations: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    actionsTaken: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    // ── Parts & Materials ────────────────────────────────────────────────────
    partsReplaced: [
      {
        name: { type: String, trim: true },
        quantity: { type: Number, default: 1, min: 0 },
        unit: { type: String, default: "pcs", trim: true },
        cost: { type: Number, default: 0, min: 0 },
      },
    ],

    // ── Labor ────────────────────────────────────────────────────────────────
    laborHours: { type: Number, default: 0, min: 0 },

    // ── Photos ───────────────────────────────────────────────────────────────
    photos: [{ type: String }],

    // ── Signatures ───────────────────────────────────────────────────────────
    technicianSignature: { type: String, default: null },
    customerSignature: { type: String, default: null },
    customerNameSigned: { type: String, trim: true, default: "" },

    // ── Cost Summary ─────────────────────────────────────────────────────────
    partsCost: { type: Number, default: 0, min: 0 },
    laborCost: { type: Number, default: 0, min: 0 },
    // Internal direct labor expense allocated to this job. The legacy
    // `laborCost` field is customer-facing and is not a profitability cost.
    actualLaborCost: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },

    // ── Status / Workflow ────────────────────────────────────────────────────
    status: {
      type: String,
      enum: REPORT_STATUSES,
      default: "draft",
      index: true,
    },

    submittedAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    revisionNotes: { type: String, trim: true, maxlength: 1000, default: "" },

    // ── Follow-up ────────────────────────────────────────────────────────────
    followUpRequired: { type: Boolean, default: false },
    followUpNotes: { type: String, trim: true, maxlength: 500, default: "" },
    followUpDate: { type: Date, default: null },

    // ── Customer Satisfaction ─────────────────────────────────────────────────
    customerRating: { type: Number, min: 1, max: 5, default: null },
    customerFeedback: { type: String, trim: true, maxlength: 500, default: "" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
serviceReportSchema.index({ technicianId: 1, status: 1 });
serviceReportSchema.index({ technicianId: 1, createdAt: -1 });
serviceReportSchema.index(
  { bookingId: 1, serviceItemId: 1 },
  { unique: true, partialFilterExpression: { serviceItemId: { $type: "objectId" } }, name: "booking_service_item_unique" },
);

// ── Virtuals ─────────────────────────────────────────────────────────────────

/** Human-readable status label */
serviceReportSchema.virtual("statusLabel").get(function () {
  const labels = {
    draft: "Draft",
    submitted: "Submitted",
    approved: "Approved",
    revision_requested: "Revision Requested",
  };
  return labels[this.status] || this.status;
});

/** Bootstrap badge class for status */
serviceReportSchema.virtual("badgeClass").get(function () {
  const classes = {
    draft: "bg-secondary",
    submitted: "bg-warning text-dark",
    approved: "bg-success",
    revision_requested: "bg-danger",
  };
  return classes[this.status] || "bg-secondary";
});

module.exports = mongoose.model("ServiceReport", serviceReportSchema);
