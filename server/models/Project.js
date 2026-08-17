const mongoose = require("mongoose");

const PROJECT_STATUSES = [
  "pending_project_scheduling",
  "accepted",
  "planning",
  "ready",
  "in_progress",
  "completed",
  "closed",
  "cancelled",
  "on_hold",
];

const projectSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BookingService",
    required: true,
    index: true,
  },

  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },

  customer: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: String,
    email: String,
    phone: String,
    address: String,
  },

  service: {
    name: String,
    description: String,
    category: String,
  },

  status: {
    type: String,
    enum: PROJECT_STATUSES,
    default: "pending_project_scheduling",
    index: true,
  },

  // Whether the project qualifies as "large scale" (derived at creation from
  // estimated hours vs the enterprise threshold). Drives the admin verify gate.
  isLargeScale: { type: Boolean, default: false, index: true },

  // Phase within in_progress for large-scale projects:
  //   assessment       – Lead inspects site, submits report + quotation
  //   quotation_review – Admin reviews & approves/rejects the quotation
  //   execution        – Team executes repair work (existing mobilization flow)
  projectPhase: {
    type: String,
    enum: ['assessment', 'quotation_review', 'execution'],
  },

  // Lead-submitted inspection report (Phase 1)
  inspectionReport: {
    submittedAt: Date,
    notes: String,
    photos: [String],
    findings: String,
  },

  // Quotation for admin review & approval before Phase 2 execution
  quotationReview: {
    totalAmount: { type: Number, default: 0 },
    items: [{
      description: String,
      quantity: { type: Number, default: 1 },
      unitPrice: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    }],
    notes: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: String,
  },

  // Admin verification/acceptance of a large-scale project (mirrors the
  // booking payment_verified / order accept pattern).
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  verifiedAt: { type: Date },

  // ── Capacity reservation (used by the scheduling engine) ───────────────
  // How many technicians this project reserves per working day while active.
  // Source of truth: admin-assigned technicians. If none assigned yet, a
  // single-technician safe default is used until planning completes.
  reservedTechnicians: { type: Number, default: 0, min: 0 },
  // Per-day minimum technician requirement for the auto-scheduler
  // ("Required Technicians: 2 of 3"). Defaults to the assigned team size.
  dailyRequiredTechnicians: { type: Number, default: 0, min: 0 },
  // Inclusive calendar span the project occupies (working days only).
  plannedStartDate: { type: Date },
  plannedCompletionDate: { type: Date },
  // Whether the span has been locked by the operations team. Until locked,
  // the engine derives a provisional span from estimatedTotalHours so the
  // calendar still reflects the reservation.
  scheduleLocked: { type: Boolean, default: false },

  estimatedTotalHours: { type: Number, required: true },
  totalUnits: { type: Number, required: true, min: 1, max: 40 },
  // Per-service unit count the customer entered in the booking UI (sum of
  // services[].quantity). Mirrors BookingService.quantity and is the source
  // for totalUnits unless the customer overrides it via scheduling prefs.
  quantity: { type: Number, default: 1, min: 1, max: 40 },
  estimatedDurationPerUnit: { type: Number },

  preferredStartDate: { type: Date },
  preferredWorkingDays: [String],
  preferredWorkingHours: {
    start: String,
    end: String,
  },
  schedulePlan: {
    status: { type: String, enum: ["not_generated", "preview", "ready", "blocked", "confirmed"], default: "not_generated" },
    startDate: Date,
    estimatedEndDate: Date,
    targetEndDate: Date,
    executionEndDate: Date,
    workingDays: [Number],
    workingHours: { start: String, end: String },
    bufferDays: { type: Number, default: 0, min: 0, max: 10 },
    qualityScore: { type: Number, default: 0, min: 0, max: 100 },
    conflicts: [mongoose.Schema.Types.Mixed],
    dailySummary: [mongoose.Schema.Types.Mixed],
    manualOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    generatedAt: Date,
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    confirmedAt: Date,
  },
  preferredCompletionDeadline: { type: Date },

  actualStartDate: { type: Date },
  actualCompletionDate: { type: Date },

  projectManager: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: String,
  },

  notes: { type: String, trim: true },
  adminNotes: { type: String, trim: true },

  // Planning may be prepared before the assigned team accepts. These values
  // are advisory only: they do not reserve inventory or create daily work.
  planningDraft: {
    resources: [{
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", default: null },
      itemName: String,
      // `type` is reserved in Mongoose schema definitions; wrap it so this
      // remains a resource field instead of defining the whole item as String.
      type: { type: String },
      scope: String,
      quantity: Number,
      unit: String,
      reason: String,
      available: Number,
      owned: { type: Number, default: 0 },
      assignedElsewhere: { type: Number, default: 0 },
      shortage: { type: Number, default: 0 },
      readinessStatus: { type: String, default: "optional" },
      source: { type: String, default: "ai" },
      recommendationState: { type: String, default: "recommended" },
      requirementRule: { type: String, default: "fixed" },
      baseQuantity: { type: Number, default: 1 },
      originalQuantity: { type: Number, default: 1 },
      confidence: { type: String, default: "medium" },
      affectedWorkOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
      affectedWorkOrders: [{
        _id: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },
        number: String,
        title: String,
        unitCount: Number,
      }],
      purchaseCost: { type: Number, default: 0 },
      sellingPrice: { type: Number, default: 0 },
      estimatedCost: { type: Number, default: 0 },
      adjustmentReason: String,
      changedAt: Date,
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      procurementRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "PartsRequest", default: null },
      purchaseRecordId: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectResourcePurchase", default: null },
      purchaseStatus: String,
      orderedQuantity: { type: Number, default: 0 },
      receivedQuantity: { type: Number, default: 0 },
      supplier: String,
      expectedDelivery: Date,
      unitPurchaseCost: { type: Number, default: 0 },
    }],
    schedulePreview: [{
      date: Date,
      technicians: [{ _id: mongoose.Schema.Types.ObjectId, name: String }],
      shortfall: Number,
      conflicts: [mongoose.Schema.Types.Mixed],
    }],
    updatedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    readiness: {
      status: { type: String, default: "not_checked" },
      checkedAt: Date,
      total: { type: Number, default: 0 },
      available: { type: Number, default: 0 },
      partial: { type: Number, default: 0 },
      procurement: { type: Number, default: 0 },
      conflicts: { type: Number, default: 0 },
      optional: { type: Number, default: 0 },
      blockers: [String],
      estimatedDirectMaterialCost: { type: Number, default: 0 },
    },
    resourceHistory: [{
      resourceId: mongoose.Schema.Types.ObjectId,
      itemName: String,
      action: String,
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed,
      reason: String,
      changedAt: { type: Date, default: Date.now },
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    }],
    baselineLocked: { type: Boolean, default: false },
    confirmedAt: Date,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },

  assignedTechnicians: [
    {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
      phone: String,
      email: String,
      assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
    },
  ],

  leadTechnicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },

  // Lead acceptance flow (large-scale on-site coordination).
  // leadAcceptedAt set when the lead accepts the project assignment.
  // leadDeclinedReason set when the lead declines (admin is notified).
  // teamStatus tracks each assigned member's acknowledgement:
  //   "notified"     (assignment sent)
  //   "acknowledged" (member clicked "Got it")
  //   "declined"     (member reported a conflict — admin/lead notified)
  leadAcceptedAt: { type: Date },
  leadDeclinedReason: { type: String, trim: true },
  teamStatus: [
    {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
      status: { type: String, enum: ["notified", "acknowledged", "declined"], default: "notified" },
      acknowledgedAt: { type: Date },
      declinedReason: { type: String, trim: true },
    },
  ],

  totalAssignedTechnicians: { type: Number, default: 0 },
  totalWorkOrders: { type: Number, default: 0 },
  completedWorkOrders: { type: Number, default: 0 },
  completedUnits: { type: Number, default: 0 },

  // ── Daily Re-acceptance Flow ────────────────────────────────────────────
  // After end-day, the project enters a daily re-acceptance phase.
  // Lead and members must explicitly accept ("Continue Project") or decline
  // before mobilization can start the next working day.
  dailyAcceptance: {
    required: { type: Boolean, default: false },
    date: { type: Date },                    // the working day this acceptance is for
    leadAccepted: { type: Boolean, default: false },
    leadAcceptedAt: { type: Date },
    membersAccepted: [{
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date },
    }],
    declined: [{
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
      reason: { type: String, trim: true },
      declinedAt: { type: Date },
    }],
  },

  // ── Proof of Payment (commercial / large-scale projects) ───────────────
  payment: {
    amountPaid: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    paymentMethod: { type: String, trim: true },
    paymentStatus: { type: String, enum: ["unpaid", "pending", "payment_collected", "waiting_for_remittance", "remitted", "verified", "rejected", "partial", "paid", "refunded"], default: "unpaid" },
    proofUrl: { type: String, trim: true },
    proofNote: { type: String, trim: true },
    completionProofUrl: { type: String, trim: true },
    paidAt: { type: Date },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    recordedAt: { type: Date },
    // Fee breakdown (editable by lead at payment time, admin defaults via SiteSetting)
    laborRatePerDay: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
    daysWorked: { type: Number, default: 0 },
    crewSize: { type: Number, default: 0 },
    additionalCharges: { type: Number, default: 0 },
  },

  // Flag to avoid re-notifying lead when all units complete
  _allUnitsNotified: { type: Boolean, default: false },

  // ── Repair-Specific Data (snapshot from BookingService at project creation) ──
  repair: {
    serviceType: { type: String, enum: ["core", "repair"], default: "core" },
    unitInfo: {
      unitType: String,
      brand: String,
      model: String,
      problemDescription: String,
      photos: [String],
    },
    inspection: {
      findings: String,
      severity: { type: String, enum: ["", "minor", "major", "critical"] },
      damagedParts: [String],
      recommendedAction: String,
      technicianName: String,
      completedAt: Date,
    },
    diagnosis: {
      summary: String,
      confirmedDiagnoses: [String],
      laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
      laborDuration: String,
      technicianName: String,
    },
    aiAssist: {
      summary: String,
      probableCauses: [String],
      suggestedTools: [String],
      possibleParts: [String],
      repairComplexity: String,
      estimatedDurationMinutes: Number,
      safetyReminders: [String],
    },
    quotation: {
      parts: [{
        name: String,
        cost: Number,
        quantity: Number,
        toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
        itemType: { type: String, default: "part" },
        currentStock: Number,
        stockStatus: String,
      }],
      laborCost: Number,
      laborCategory: { type: String, enum: ["standard", "complex", "major"] },
      totalCost: Number,
      notes: String,
      approvedAt: Date,
    },
    partsUsed: [{
      name: String,
      quantity: Number,
      unitCost: Number,
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
      itemType: { type: String, default: "part" },
      usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      usedAt: Date,
    }],
    warranty: {
      days: { type: Number, default: 30 },
      startDate: Date,
      endDate: Date,
    },
  },

  // ── Unit Groups (per-appliance type tracking) ────────────────────────────
  // When a project involves multiple different appliance types (e.g., 3 aircons
  // + 2 fridges + 1 washer), each group tracks its own inspection, quotation,
  // and per-unit completion. Snapshot from BookingService.getUnitGroups().
  unitGroups: [{
    groupIndex: { type: Number, required: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId },
    serviceName: { type: String },
    serviceType: { type: String },         // 'core' or 'repair'
    unitType: { type: String },            // e.g. "Split Type Aircon", "Refrigerator"
    brand: { type: String },
    model: { type: String },
    applianceType: { type: String },       // 'split', 'window', etc.
    applianceTypeName: { type: String },   // "Split Type", "Window Type"
    hp: { type: Number },
    hpDescription: { type: String },
    problemDescription: { type: String },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    totalPrice: { type: Number, default: 0 },
    repairIssue: { type: String },
    duration: { type: Number },            // minutes per unit

    // Per-group inspection (lead submits during assessment phase)
    inspection: {
      findings: String,
      severity: { type: String, enum: ["", "minor", "major", "critical"] },
      damagedParts: [String],
      recommendedAction: String,
      technicianName: String,
      completedAt: Date,
      photos: [String],
      notes: String,
    },
    // Per-group diagnosis
    diagnosis: {
      summary: String,
      confirmedDiagnoses: [String],
      laborCategory: { type: String, enum: ["standard", "complex", "major"], default: "standard" },
      laborDuration: String,
      technicianName: String,
      completedAt: Date,
    },
    // Per-group quotation (parts + labor for this appliance type)
    quotation: {
      parts: [{
        name: String,
        cost: Number,
        quantity: Number,
        toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
        itemType: { type: String, default: "part" },
        currentStock: Number,
        stockStatus: String,
      }],
      laborCost: Number,
      laborCategory: { type: String, enum: ["standard", "complex", "major"] },
      totalCost: Number,
      notes: String,
    },
    // Per-group parts used
    partsUsed: [{
      name: String,
      quantity: Number,
      unitCost: Number,
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool" },
      itemType: { type: String, default: "part" },
      usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      usedAt: Date,
    }],
    // Per-unit tracking within this group
    units: [{
      unitIndex: { type: Number, required: true },
      label: { type: String },
      status: {
        type: String,
        enum: ["pending", "inspected", "in_progress", "completed", "skipped"],
        default: "pending",
      },
      completedAt: Date,
      completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      completionNotes: String,
    }],
    // Group-level progress
    completedUnits: { type: Number, default: 0 },
    inspectedUnits: { type: Number, default: 0 },
  }],

  location: {
    address: String,
    lat: Number,
    lng: Number,
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

projectSchema.pre("save", function () {
  // Business classification is quantity-based and cannot be overridden by a
  // stale client flag or by duration estimates.
  this.isLargeScale = Number(this.totalUnits || this.quantity || 0) >= 8;
  this.updatedAt = new Date();
});

projectSchema.virtual("progressPercent").get(function () {
  if (this.totalUnits === 0) return 0;
  return Math.round((this.completedUnits / this.totalUnits) * 100);
});

// Virtual: check if project has multiple appliance types
projectSchema.virtual("hasMultipleApplianceTypes").get(function () {
  if (!this.unitGroups || this.unitGroups.length === 0) return false;
  return this.unitGroups.length > 1;
});

// Virtual: get appliance type summary for display
projectSchema.virtual("applianceTypeSummary").get(function () {
  if (!this.unitGroups || this.unitGroups.length === 0) {
    return this.repair?.unitInfo?.unitType || 'Unknown';
  }
  return this.unitGroups.map(g => `${g.quantity}× ${g.unitType}`).join(', ');
});

projectSchema.virtual("statusLabel").get(function () {
  const labels = {
    pending_project_scheduling: "Pending Review",
    accepted: "Pending Review",
    planning: "Project Planning",
    ready: "Project Ready",
    in_progress: "Project Active",
    completed: "Project Completed",
    closed: "Project Closed",
    cancelled: "Cancelled",
    on_hold: "On Hold",
  };
  return labels[this.status] || this.status;
});

/**
 * Compute the inclusive working-day span [start, end] a project occupies.
 *
 * Priority:
 *   1. If the ops team locked an explicit planned span, use it.
 *   2. Otherwise derive a provisional span from estimatedTotalHours so the
 *      calendar can still reserve capacity before planning finishes.
 *
 * Provisional rule: the project consumes `reservedTechnicians` techs per
 * working day; one technician contributes COMPANY_DAILY_HOURS (8h) per
 * working day. So the number of working days ≈ ceil(hours / techs / 8).
 */
projectSchema.statics.computeActiveSpan = function (doc, opts = {}) {
  const DAILY_HOURS = opts.dailyHours || 8;
  const start = doc.plannedStartDate || doc.preferredStartDate;
  const end = doc.plannedCompletionDate || doc.preferredCompletionDeadline;
  if (doc.scheduleLocked && start && end) {
    return { start: new Date(start), end: new Date(end), locked: true };
  }
  // When the customer (or admin) has set an explicit completion window, that
  // span is authoritative — the scheduler expands it into working days
  // instead of re-deriving a shorter span from estimated hours.
  if (start && end) {
    const s = new Date(start);
    const e = new Date(end);
    if (e >= s) return { start: s, end: e, locked: false };
  }
  if (start) {
    const techs = Math.max(1, Number(doc.reservedTechnicians) || 1);
    const hours = Number(doc.estimatedTotalHours) || 0;
    const workingDays = Math.max(1, Math.ceil(hours / (techs * DAILY_HOURS)));
    const spanEnd = new Date(start);
    // Walk forward counting only working weekdays (Mon–Fri) like company ops.
    let added = 0;
    while (added < workingDays) {
      const dow = spanEnd.getDay();
      if (dow !== 0 && dow !== 6) added++;
      if (added < workingDays) spanEnd.setDate(spanEnd.getDate() + 1);
    }
    return { start: new Date(start), end: spanEnd, locked: false };
  }
  return null;
};

/**
 * Returns the number of technicians this project reserves on a given date.
 * 0 when the project is inactive, not yet started, or already completed.
 */
projectSchema.statics.reservedTechniciansOn = function (doc, date, opts = {}) {
  const ACTIVE = ['pending_project_scheduling', 'accepted', 'planning', 'ready', 'in_progress', 'on_hold'];
  if (!ACTIVE.includes(doc.status)) return 0;
  const span = projectSchema.statics.computeActiveSpan(doc, opts);
  if (!span) return 0;
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const s = new Date(span.start); s.setHours(0, 0, 0, 0);
  const e = new Date(span.end); e.setHours(0, 0, 0, 0);
  if (d < s || d > e) return 0;
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return 0; // company non-working day
  return Math.max(1, Number(doc.reservedTechnicians) || 1);
};

projectSchema.statics.getDashboardStats = async function () {
  const now = new Date();
  const currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const previousStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [result, trendsAgg] = await Promise.all([
    this.aggregate([
      {
        $facet: {
          planning: [{ $match: { status: "planning" } }, { $count: "count" }],
          ready: [{ $match: { status: "ready" } }, { $count: "count" }],
          inProgress: [{ $match: { status: "in_progress" } }, { $count: "count" }],
          pendingScheduling: [{ $match: { status: "pending_project_scheduling" } }, { $count: "count" }],
          accepted: [{ $match: { status: "accepted" } }, { $count: "count" }],
          completed: [{ $match: { status: "completed" } }, { $count: "count" }],
          closed: [{ $match: { status: "closed" } }, { $count: "count" }],
          totalUnitsCompleted: [
            { $group: { _id: null, total: { $sum: "$completedUnits" } } },
          ],
        },
      },
    ]),
    this.aggregate([
      {
        $addFields: {
          period: {
            $cond: [
              { $gte: ["$createdAt", currentStart] },
              "current",
              {
                $cond: [
                  { $gte: ["$createdAt", previousStart] },
                  "previous",
                  null,
                ],
              },
            ],
          },
        },
      },
      { $match: { period: { $ne: null } } },
      {
        $group: {
          _id: { status: "$status", period: "$period" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const map = {};
  trendsAgg.forEach((item) => {
    map[item._id.status] = map[item._id.status] || {};
    map[item._id.status][item._id.period] = item.count;
  });

  const statusKeys = {
    pendingScheduling: "pending_project_scheduling",
    planning: "planning",
    inProgress: "in_progress",
    completed: "completed",
    accepted: "accepted",
    ready: "ready",
    closed: "closed",
  };
  const trends = {};
  for (const [key, status] of Object.entries(statusKeys)) {
    const cur = map[status]?.current || 0;
    const prev = map[status]?.previous || 0;
    let percent = 0;
    if (prev === 0 && cur > 0) percent = 100;
    else if (prev > 0) percent = Math.round(((cur - prev) / prev) * 100);
    trends[key] = { current: cur, previous: prev, percent };
  }

  const counts = result[0];
  return {
    planning: counts.planning[0]?.count || 0,
    ready: counts.ready[0]?.count || 0,
    inProgress: counts.inProgress[0]?.count || 0,
    pendingScheduling: counts.pendingScheduling[0]?.count || 0,
    accepted: counts.accepted[0]?.count || 0,
    completed: counts.completed[0]?.count || 0,
    closed: counts.closed[0]?.count || 0,
    totalUnitsCompleted: counts.totalUnitsCompleted[0]?.total || 0,
    trends,
  };
};

projectSchema.index({ "repair.serviceType": 1 });

module.exports = mongoose.model("Project", projectSchema);
