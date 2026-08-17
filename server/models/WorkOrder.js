const mongoose = require("mongoose");

const WORK_ORDER_STATUSES = [
  "pending",
  "assigned",
  "accepted",
  "en_route",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "rescheduled",
  "declined",
  "on_hold",
  "partially_completed",
  "awaiting_review",
];

const workOrderSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: true,
    index: true,
  },

  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BookingService",
  },

  workOrderNumber: { type: String, trim: true, index: true },
  planningStatus: {
    type: String,
    enum: ["draft", "ready_for_scheduling", "scheduled", "released"],
    default: "draft",
    index: true,
  },

  title: { type: String, trim: true },
  description: { type: String, trim: true },

  section: { type: String, trim: true },
  location: {
    label: { type: String, trim: true },
    address: { type: String, trim: true },
    building: { type: String, trim: true },
    floor: { type: String, trim: true },
    area: { type: String, trim: true },
    lat: Number,
    lng: Number,
  },
  serviceType: { type: String, enum: ["core", "repair"], default: "core", index: true },
  serviceName: { type: String, trim: true },
  workflowType: { type: String, enum: ["core", "repair"], default: "core" },

  units: [{
    unitKey: { type: String, required: true },
    label: String,
    groupIndex: Number,
    serviceId: mongoose.Schema.Types.ObjectId,
    serviceType: { type: String, enum: ["core", "repair"], default: "core" },
    serviceName: String,
    applianceType: String,
    brand: String,
    model: String,
    location: String,
    status: { type: String, enum: ["pending", "in_progress", "completed", "on_hold", "cancelled"], default: "pending" },
    completedAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    notes: String,
  }],

  // ── Appliance Type Tracking ──────────────────────────────────────────────
  // When work orders are split by appliance type, each WO knows which
  // appliance group it covers. Null means the WO covers mixed/all types.
  applianceType: { type: String, trim: true },      // e.g. "split", "refrigerator"
  applianceTypeName: { type: String, trim: true },   // e.g. "Split Type Aircon", "Refrigerator"
  unitGroupId: { type: Number },                     // references unitGroups[].groupIndex
  brand: { type: String, trim: true },
  hp: { type: Number },

  unitCount: { type: Number, required: true },
  completedUnitCount: { type: Number, default: 0 },

  // Completing the tracked units does not close the batch. The team lead
  // reviews the crew's evidence/notes and explicitly submits the work order.
  submittedAt: Date,
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  submissionNotes: { type: String, trim: true },

  estimatedHours: { type: Number, required: true },
  requiredTechnicianCount: { type: Number, min: 1, default: 1 },
  scheduledEndDate: Date,
  scheduleConflicts: [mongoose.Schema.Types.Mixed],

  status: {
    type: String,
    enum: WORK_ORDER_STATUSES,
    default: "pending",
    index: true,
  },

  declinedReason: { type: String, trim: true },

  assignedTechnicians: [{
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    name: String,
    phone: String,
    // Legacy reporting field only. Work-order scope belongs to the team;
    // individual ownership is captured at execution time by unit.completedBy.
    assignedUnits: { type: Number, default: 0 },
  }],
  suggestedTechnicians: [{
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
    name: String,
    phone: String,
    assignedUnits: { type: Number, default: 0 },
  }],
  assignmentProvisional: { type: Boolean, default: true },

  dependencies: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
  resourceRequirements: [{
    planningResourceId: mongoose.Schema.Types.ObjectId,
    toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
    itemName: String,
    type: { type: String, enum: ["equipment", "consumable", "part"] },
    quantity: Number,
    unit: String,
  }],

  scheduledDate: { type: Date },
  startTime: String,
  endTime: String,

  enRouteAt: { type: Date },
  arrivedAt: { type: Date },
  startedAt: { type: Date },
  actualStartDate: { type: Date },
  actualCompletionDate: { type: Date },

  notes: { type: String, trim: true },
  technicianNotes: { type: String, trim: true },

  priority: {
    type: String,
    enum: ["low", "normal", "high", "urgent", "critical"],
    default: "normal",
  },

  sortOrder: { type: Number, default: 0 },

  checklist: [{
    label: { type: String, required: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },
    completedBy: { type: String },
  }],

  cancellationReason: { type: String, trim: true },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledAt: Date,
  activity: [{
    action: String,
    actorId: mongoose.Schema.Types.ObjectId,
    actorName: String,
    reason: String,
    details: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
  }],
  documents: [{ name: String, url: String, uploadedAt: { type: Date, default: Date.now } }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

workOrderSchema.pre("save", function () {
  this.unitCount = this.units?.length || this.unitCount || 0;
  const unitCompleted = (this.units || []).filter(unit => unit.status === "completed").length;
  if (this.units?.length && this.isModified("units")) this.completedUnitCount = unitCompleted;
  if (this.completedUnitCount > 0 && this.completedUnitCount < this.unitCount && this.status !== "cancelled") {
    this.status = "partially_completed";
  }
  if (this.unitCount > 0 && this.completedUnitCount >= this.unitCount && !["completed", "cancelled"].includes(this.status)) {
    this.status = "awaiting_review";
  }
  this.updatedAt = new Date();
});

workOrderSchema.virtual("statusLabel").get(function () {
  const labels = {
    pending: "Pending",
    assigned: "Assigned",
    accepted: "Accepted",
    en_route: "En Route",
    arrived: "Arrived",
    in_progress: "In Progress",
    completed: "Completed",
    cancelled: "Cancelled",
    rescheduled: "Rescheduled",
    declined: "Declined",
    on_hold: "On Hold",
    partially_completed: "Partially Completed",
    awaiting_review: "Awaiting Lead Review",
  };
  return labels[this.status] || this.status;
});

workOrderSchema.virtual("progressPercent").get(function () {
  if (this.unitCount === 0) return 0;
  return Math.round((this.completedUnitCount / this.unitCount) * 100);
});

workOrderSchema.index({ projectId: 1, status: 1 });
workOrderSchema.index({ projectId: 1, workOrderNumber: 1 }, { unique: true, sparse: true });
workOrderSchema.index({ assignedTechnicians: 1, status: 1 });
workOrderSchema.index({ scheduledDate: 1, status: 1 });

// Work orders are team-owned batches. Coverage therefore means that each
// batch has a crew, not that every unit was pre-allocated to one technician.
workOrderSchema.statics.computeCoveredUnits = async function (projectId) {
  const wos = await this.find({ projectId }).lean();
  let covered = 0;
  let total = 0;
  let unassignedWos = 0;
  for (const w of wos) {
    total += w.unitCount || 0;
    const techs = w.assignedTechnicians || [];
    if (techs.length === 0) { unassignedWos++; continue; }
    covered += w.unitCount || 0;
  }
  return { covered, total, unassignedWos, fullyCovered: covered >= total && unassignedWos === 0 };
};

module.exports = mongoose.model("WorkOrder", workOrderSchema);
