const mongoose = require("mongoose");

const DAILY_STATUSES = ["pending", "in_progress", "completed", "skipped"];

const dailyAssignmentSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true, index: true },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true, index: true },
  technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", required: true, index: true },

  // The working day this assignment targets.
  date: { type: Date, required: true },

  // Units expected to be completed this day (admin-editable).
  targetUnits: { type: Number, default: 0, min: 0 },
  // Units the technician actually completed this day.
  completedUnits: { type: Number, default: 0, min: 0 },

  // ── Appliance Type Tracking ──────────────────────────────────────────────
  // When work orders are split by appliance type, daily assignments inherit
  // the type from their parent work order. Null means mixed/unspecified.
  applianceType: { type: String, trim: true },
  applianceTypeName: { type: String, trim: true },
  unitGroupId: { type: Number },

  status: { type: String, enum: DAILY_STATUSES, default: "pending" },
  generatedBy: { type: String, enum: ["system", "admin"], default: "system" },

  notes: { type: String, trim: true },
  completedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

dailyAssignmentSchema.pre("save", function () {
  this.updatedAt = new Date();
  if (this.completedUnits > 0 && this.status !== "skipped") this.status = "completed";
  else if (this.targetUnits > 0 && this.status === "pending") this.status = "in_progress";
});

dailyAssignmentSchema.index({ workOrderId: 1, date: 1, technicianId: 1 }, { unique: true });

module.exports = mongoose.model("DailyAssignment", dailyAssignmentSchema);
