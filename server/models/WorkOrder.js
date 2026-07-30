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

  title: { type: String, trim: true },
  description: { type: String, trim: true },

  section: { type: String, trim: true },

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

  estimatedHours: { type: Number, required: true },

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
    // Units of this work order this technician is responsible for.
    // Used to confirm the whole project's quantity is covered by the team
    // before planning can be marked ready.
    assignedUnits: { type: Number, default: 0 },
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
    enum: ["low", "normal", "high", "urgent"],
    default: "normal",
  },

  sortOrder: { type: Number, default: 0 },

  checklist: [{
    label: { type: String, required: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },
    completedBy: { type: String },
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

workOrderSchema.pre("save", function () {
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
  };
  return labels[this.status] || this.status;
});

workOrderSchema.virtual("progressPercent").get(function () {
  if (this.unitCount === 0) return 0;
  return Math.round((this.completedUnitCount / this.unitCount) * 100);
});

workOrderSchema.index({ projectId: 1, status: 1 });
workOrderSchema.index({ assignedTechnicians: 1, status: 1 });
workOrderSchema.index({ scheduledDate: 1, status: 1 });

// Total units covered by technician assignments across a project's work orders.
// A work order's `unitCount` is considered covered only when at least one
// technician is assigned with `assignedUnits > 0`; the covered total is the sum
// of every assigned technician's `assignedUnits`.
workOrderSchema.statics.computeCoveredUnits = async function (projectId) {
  const wos = await this.find({ projectId }).lean();
  let covered = 0;
  let total = 0;
  let unassignedWos = 0;
  for (const w of wos) {
    total += w.unitCount || 0;
    const techs = w.assignedTechnicians || [];
    if (techs.length === 0) { unassignedWos++; continue; }
    const woCovered = techs.reduce((s, t) => s + (t.assignedUnits || 0), 0);
    // If nothing explicitly allocated, fall back to the work order's full unit count
    // (a single assigned tech implicitly owns the whole order).
    covered += woCovered > 0 ? woCovered : (w.unitCount || 0);
  }
  return { covered, total, unassignedWos, fullyCovered: covered >= total && unassignedWos === 0 };
};

module.exports = mongoose.model("WorkOrder", workOrderSchema);
