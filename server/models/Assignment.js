const mongoose = require("mongoose");

/**
 * Assignment — Unified job assignment tracking for technicians.
 * References BookingService but tracks the full lifecycle:
 *   pending_acceptance → accepted → en_route → on_site → in_progress → completed
 * Also supports: declined, cancelled, no_show
 */
const ASSIGNMENT_STATUSES = [
  "pending_acceptance",
  "accepted",
  "declined",
  "expired",
  "en_route",
  "on_site",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
];

const PRIORITY_LEVELS = ["low", "normal", "high", "urgent"];

const assignmentSchema = new mongoose.Schema(
  {
    // ── References ───────────────────────────────────────────────────────────
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      required: true,
      index: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },

    // ── Snapshots (denormalized for fast reads) ──────────────────────────────
    customerName: { type: String, trim: true, default: "" },
    customerPhone: { type: String, trim: true, default: "" },
    customerEmail: { type: String, trim: true, default: "" },
    serviceType: { type: String, trim: true, default: "" },
    serviceName: { type: String, trim: true, default: "" },
    servicePrice: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, default: 1, min: 1 },
    bookingDate: { type: Date, index: true },
    startTime: { type: String, default: "" },
    endTime: { type: String, default: "" },
    address: { type: String, trim: true, default: "" },
    coordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },

    // ── Assignment Pipeline ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: ASSIGNMENT_STATUSES,
      default: "pending_acceptance",
      index: true,
    },

    priority: {
      type: String,
      enum: PRIORITY_LEVELS,
      default: "normal",
      index: true,
    },

    // ── Timestamps per stage ─────────────────────────────────────────────────
    assignedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date },
    declinedAt: { type: Date },
    declineReason: { type: String, trim: true, maxlength: 500 },
    enRouteAt: { type: Date },
    arrivedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    expiredAt: { type: Date },
    expiredReason: { type: String, trim: true, maxlength: 500 },

    // ── Equipment lifecycle ──────────────────────────────────────────────────
    equipmentCheckedOut: { type: Boolean, default: false },
    equipmentCheckedOutAt: { type: Date },
    equipmentReturned: { type: Boolean, default: false },
    equipmentReturnedAt: { type: Date },

    // ── Acceptance deadline ──────────────────────────────────────────────────
    acceptanceDeadline: { type: Date, index: true },

    // ── SLA Tracking ─────────────────────────────────────────────────────────
    slaDeadline: { type: Date, index: true },
    slaBreached: { type: Boolean, default: false },

    // ── Notes / Activity Log ─────────────────────────────────────────────────
    notes: [
      {
        text: { type: String, trim: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        byName: { type: String, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // ── Estimated fee from booking ──────────────────────────────────────────
    estimatedFee: { type: Number, default: 0, min: 0 },
    travelFare: { type: Number, default: 0, min: 0 },
    travelTime: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
assignmentSchema.index({ technicianId: 1, status: 1 });
assignmentSchema.index({ technicianId: 1, bookingDate: -1 });
assignmentSchema.index({ status: 1, assignedAt: -1 });
assignmentSchema.index({ acceptanceDeadline: 1, status: 1 });
assignmentSchema.index({ slaDeadline: 1, status: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────

/** Human-readable status label */
assignmentSchema.virtual("statusLabel").get(function () {
  const labels = {
    pending_acceptance: "Pending Acceptance",
    accepted: "Accepted",
    declined: "Declined",
    expired: "Assignment Expired",
    en_route: "En Route",
    on_site: "On Site",
    in_progress: "In Progress",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No Show",
  };
  return labels[this.status] || this.status;
});

/** Whether the assignment is in an active/transitional state */
assignmentSchema.virtual("isActive").get(function () {
  return ["accepted", "en_route", "on_site", "in_progress"].includes(
    this.status
  );
});

/** Elapsed time since accepted (minutes) */
assignmentSchema.virtual("elapsedMinutes").get(function () {
  if (!this.acceptedAt) return 0;
  const end = this.completedAt || new Date();
  return Math.round((end - this.acceptedAt) / 60000);
});

// ── Static Helpers ───────────────────────────────────────────────────────────

/**
 * Get dashboard summary counts for a technician.
 * @param {ObjectId} technicianId
 * @returns {Promise<Object>}
 */
assignmentSchema.statics.getDashboardCounts = async function (technicianId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const pipeline = [
    { $match: { technicianId: new mongoose.Types.ObjectId(technicianId) } },
    {
      $facet: {
        pendingAcceptance: [
          { $match: { status: "pending_acceptance" } },
          { $count: "count" },
        ],
        active: [
          {
            $match: {
              status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
            },
          },
          { $count: "count" },
        ],
        todayJobs: [
          { $match: { bookingDate: { $gte: today, $lt: tomorrow } } },
          { $count: "count" },
        ],
        completedToday: [
          {
            $match: {
              status: "completed",
              completedAt: { $gte: today, $lt: tomorrow },
            },
          },
          { $count: "count" },
        ],
        completedTotal: [
          { $match: { status: "completed" } },
          { $count: "count" },
        ],
        upcoming: [
          {
            $match: {
              status: { $in: ["accepted", "pending_acceptance"] },
              bookingDate: { $gte: today },
            },
          },
          { $count: "count" },
        ],
        slaBreached: [
          { $match: { slaDeadline: { $lt: new Date() }, status: { $nin: ["completed", "cancelled", "declined"] } } },
          { $count: "count" },
        ],
      },
    },
  ];

  const [result] = await this.aggregate(pipeline);
  return {
    pendingAcceptance: result.pendingAcceptance[0]?.count || 0,
    active: result.active[0]?.count || 0,
    todayJobs: result.todayJobs[0]?.count || 0,
    completedToday: result.completedToday[0]?.count || 0,
    completedTotal: result.completedTotal[0]?.count || 0,
    upcoming: result.upcoming[0]?.count || 0,
    slaBreached: result.slaBreached[0]?.count || 0,
  };
};

module.exports = mongoose.model("Assignment", assignmentSchema);
