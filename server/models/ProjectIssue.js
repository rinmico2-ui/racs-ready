const mongoose = require("mongoose");

/**
 * ProjectIssue — Issues raised by technicians during a large-scale project
 * (damaged wiring, missing parts, locked room, access, safety, etc.).
 * Surfaced instantly to admins and the lead technician.
 */
const ISSUE_CATEGORIES = [
  "electrical",
  "inventory",
  "customer",
  "safety",
  "access",
  "other",
];

const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"];

const projectIssueSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },

    workOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      default: null,
      index: true,
    },

    reportedBy: {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
    },

    category: {
      type: String,
      enum: ISSUE_CATEGORIES,
      default: "other",
      index: true,
    },

    title: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },

    photos: [{ type: String }],
    voiceNote: { type: String, default: null },

    status: {
      type: String,
      enum: ISSUE_STATUSES,
      default: "open",
      index: true,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, default: "" },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

projectIssueSchema.virtual("categoryLabel").get(function () {
  const labels = {
    electrical: "Electrical",
    inventory: "Inventory",
    customer: "Customer",
    safety: "Safety",
    access: "Access",
    other: "Other",
  };
  return labels[this.category] || this.category;
});

projectIssueSchema.virtual("statusLabel").get(function () {
  const labels = {
    open: "Open",
    in_progress: "In Progress",
    resolved: "Resolved",
    closed: "Closed",
  };
  return labels[this.status] || this.status;
});

projectIssueSchema.index({ projectId: 1, status: 1 });

module.exports = mongoose.model("ProjectIssue", projectIssueSchema);
