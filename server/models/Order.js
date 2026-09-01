const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Order Schema — Aircon Product Orders
// ─────────────────────────────────────────────────────────────────────────────
// Each document represents a single customer order for one or more aircon units.
// Connects Inventory, Technician scheduling, and delivery tracking.
// ─────────────────────────────────────────────────────────────────────────────

const ORDER_STATUSES = [
  "pending_payment",
  "preparing_unit",
  "ready_for_pickup",
  "technician_assigned",
  "technician_accepted",
  "technician_declined",
  "out_for_delivery",
  "arrived",
  "installing",
  "completed",
  "cancelled",
];

const FULFILLMENT_TYPES = [
  "delivery_only",
  "delivery_installation",
  "customer_pickup",
];

const SALES_CHANNELS = ["online", "walk_in", "phone", "admin"];

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const orderItemSchema = new mongoose.Schema(
  {
    inventoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Inventory",
      required: true,
    },
    modelLine: { type: String, trim: true },
    brand: { type: String, trim: true },
    capacity: { type: String, trim: true },       // e.g. "1.5"
    capacityUnit: { type: String, default: "HP" },
    quantity: { type: Number, default: 1, min: 1 },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    imageUrl: { type: String, trim: true },
    isHvac: { type: Boolean, default: false },
    parentHvacId: { type: mongoose.Schema.Types.ObjectId, default: null },
    manufacturerWarranty: { type: String, trim: true, maxlength: 1000, default: "" },
    serialNumbers: { type: [String], default: [] },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUSES },
    timestamp: { type: Date, default: Date.now },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const deliverySchema = new mongoose.Schema(
  {
    address: { type: String, trim: true },
    coordinates: {
      type: { type: String, default: "Point" },
      coordinates: [Number], // [lng, lat]
    },
    contactNumber: { type: String, trim: true },
    preferredDate: { type: Date },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const preparationItemSnapshotSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  category: { type: String, enum: ["equipment", "consumable", "repair_part"] },
  quantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, default: "pcs" },
  status: { type: String, trim: true },
}, { _id: false });

const orderPreparationSchema = new mongoose.Schema({
  dispatch: {
    status: { type: String, enum: ["pending", "ready", "blocked", "not_required"], default: "pending", index: true },
    readyAt: { type: Date, default: null },
    readyBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true, maxlength: 500, default: "" },
  },
  installation: {
    status: { type: String, enum: ["not_required", "pending", "blocked", "confirmed", "completed", "cancelled"], default: "not_required", index: true },
    dailyKitId: { type: mongoose.Schema.Types.ObjectId, ref: "DailyKit", default: null },
    requirementVersion: { type: Number, default: 1, min: 1 },
    requiredItems: { type: [preparationItemSnapshotSchema], default: [] },
    blockers: { type: [String], default: [] },
    lastSyncedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
  },
}, { _id: false });

// ─── Main Order Schema ──────────────────────────────────────────────────────

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // snapshot of customer info at time of order
    customer: {
      name: String,
      email: String,
      phone: String,
    },

    items: { type: [orderItemSchema], default: [], validate: v => v.length > 0 },

    fulfillmentType: {
      type: String,
      enum: { values: FULFILLMENT_TYPES, message: "Invalid fulfillment type" },
      required: true,
    },

    delivery: { type: deliverySchema, default: null },

    // pickup info (only for customer_pickup)
    pickupDate: { type: Date, default: null },
    pickupLocation: { type: String, default: "CALIDRO RACS Store", trim: true },

    // technician assignment (for delivery/installation)
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      default: null,
      index: true,
    },
    technician: {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
      name: String,
      phone: String,
      email: String,
    },

    // technician acceptance tracking
    technicianAcceptance: {
      status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
      respondedAt: { type: Date },
      declineReason: { type: String },
    },

    // optional booking reference when delivery_installation creates a service booking
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingService",
      default: null,
    },

    // order status
    status: {
      type: String,
      enum: { values: ORDER_STATUSES, message: "Invalid order status" },
      default: "pending_payment",
      index: true,
    },

    // when an order is cancelled, record the reason
    cancellationReason: { type: String },
    // reschedule request from customer
    rescheduleRequest: {
      requested: { type: Boolean, default: false },
      requestedDate: { type: String },
      requestedTime: { type: String },
      reason: { type: String },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      requestedAt: { type: Date },
      status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
      processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      processedAt: { type: Date },
      rejectionReason: { type: String }
    },

    timeSlot: { type: String, default: null }, // e.g., "09:00", "13:00"

    statusHistory: { type: [statusHistorySchema], default: [] },

    // Two independent readiness contracts: the sellable unit/cargo is owned
    // by dispatch, while installation tools and consumables are covered by
    // the technician's consolidated Daily Kit.
    preparation: { type: orderPreparationSchema, default: () => ({}) },

    // Field execution evidence mirrors the technician Core Service lifecycle.
    enRouteAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    arrivalProofUrl: { type: String, default: null },
    arrivalProofCapturedAt: { type: Date, default: null },
    startProofUrl: { type: String, default: null },
    startProofNotes: { type: String, trim: true, maxlength: 500, default: "" },
    startProofCapturedAt: { type: Date, default: null },
    proofPhoto: { type: String, default: null },

    // Authoritative lifecycle date used by warranty and aftercare schedules.
    completedAt: { type: Date, default: null },

    // human-readable order reference
    orderReference: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    // financials
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    deliveryFee: { type: Number, default: 0, min: 0 },
    installationFee: { type: Number, default: 0, min: 0 },
    transportationFee: { type: Number, default: 0, min: 0 },
    routeDistanceKm: { type: Number, default: 0, min: 0 },
    routeDurationMin: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },

    // rating
    customerRating: {
      type: Number,
      min: 1,
      max: 5,
    },
    customerRatingComment: {
      type: String,
      trim: true,
    },

    // payment
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: ["cod", "gcash", "paymongo", "other", "cash_onsite", "gcash_full", "gcash_downpayment", "cash", "downpayment"],
      default: "cod",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "payment_collected", "waiting_for_remittance", "remitted", "verified", "rejected", "refunded", "paid", "failed", "partial"],
      default: "pending",
    },

    salesChannel: {
      type: String,
      enum: SALES_CHANNELS,
      default: "online",
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    refundStatus: {
      type: String,
      enum: ["none", "pending", "processing", "completed", "partial"],
      default: "none",
      index: true,
    },

    // Client-generated replay key. Combined with userId this makes checkout
    // retries idempotent without allowing one customer to collide with another.
    checkoutRequestId: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    refundAmount: { type: Number, min: 0, default: 0 },
    refundReason: { type: String, trim: true, maxlength: 1000, default: "" },
    refundRequestedAt: { type: Date, default: null },
    // Snapshot the policy used when the order was placed. This must not
    // change when an admin updates the global percentage later.
    downpaymentPercentage: { type: Number, min: 1, max: 100, default: null },
    downpaymentAmount: { type: Number, min: 0, default: 0 },
    balanceAmount: { type: Number, min: 0, default: 0 },
    gcashNumber: { type: String, trim: true, default: null },
    gcashProofUrl: { type: String, trim: true, default: null },

    // warranty (set when order is completed with installation)
    warranty: {
      days: { type: Number, default: 0 },
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
      status: { type: String, enum: ["active", "claimed", "expired"], default: null },
      claimIssue: { type: String, default: null },
      claimedAt: { type: Date, default: null },
      coverages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────

orderSchema.index({ createdAt: -1 });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index(
  { userId: 1, checkoutRequestId: 1 },
  { unique: true, partialFilterExpression: { checkoutRequestId: { $type: "string" } } },
);
orderSchema.index({ technicianId: 1, status: 1 });
orderSchema.index({ status: 1, updatedAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ status: 1, completedAt: -1 });
orderSchema.index({ status: 1, "statusHistory.timestamp": -1 });
orderSchema.index({ paymentStatus: 1, createdAt: -1 });
orderSchema.index({ fulfillmentType: 1, createdAt: -1 });
orderSchema.index({ "preparation.dispatch.status": 1, "preparation.installation.status": 1, createdAt: -1 });
orderSchema.index({ paymentMethod: 1, createdAt: -1 });
orderSchema.index({ technicianId: 1, createdAt: -1 });
orderSchema.index({ "items.brand": 1, createdAt: -1 });

// ─── Pre-save Middleware ────────────────────────────────────────────────────

orderSchema.pre("save", async function () {
  // Auto-generate order reference
  if (!this.orderReference) {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const base = `ORD-${datePart}-${rand}`;

    let candidate = base;
    let suffix = 0;
    while (await mongoose.models.Order.findOne({ orderReference: candidate })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.orderReference = candidate;
  }

  // Push initial status to history if empty
  if (this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      note: "Order created",
    });
  }

  // Snapshot customer info if we have userId
  if (this.userId && (!this.customer || !this.customer.name)) {
    try {
      const User = mongoose.model("User");
      const u = await User.findById(this.userId).lean();
      if (u) {
        this.customer = {
          name: u.name || ((u.firstName || "") + " " + (u.lastName || "")).trim(),
          email: u.email || "",
          phone: u.phone || "",
        };
      }
    } catch (e) { /* ignore */ }
  }

  // Snapshot technician info
  if (this.technicianId && (!this.technician || !this.technician._id)) {
    try {
      const Technician = mongoose.model("Technician");
      const t = await Technician.findById(this.technicianId).lean();
      if (t) {
        this.technician = {
          _id: t._id,
          name: t.name || "",
          phone: t.phone || "",
          email: t.userEmail || "",
        };
      }
    } catch (e) { /* ignore */ }
  }

  // Recalculate total
  this.subtotal = this.items.reduce((sum, it) => sum + (it.totalPrice || 0), 0);
  this.total = Math.max(0, this.subtotal - (this.discount || 0))
    + (this.deliveryFee || 0)
    + (this.installationFee || 0)
    + (this.transportationFee || 0);
});

// ─── Instance Methods ───────────────────────────────────────────────────────

orderSchema.methods.pushStatus = function (newStatus, note, opts) {
  this.status = newStatus;
  const timestamp = new Date();
  this.statusHistory.push({
    status: newStatus,
    timestamp,
    note: note || "",
  });

  // ── Enterprise: mirror every order status change to the global audit log ──
  try {
    const { logEvent } = require("../utils/audit");
    logEvent({
      actor: opts && opts.actor ? opts.actor : null,
      action: "order.status_change",
      module: "Order",
      details: {
        toStatus: newStatus,
        note: note || "",
        orderReference: this.orderReference,
        orderId: this._id ? this._id.toString() : null,
        actorRole: (opts && opts.actorRole) || "System",
        actorName: (opts && opts.actorName) || "System",
      },
      entityId: this._id || null,
      entityType: "Order",
      category: "order",
      actionType: "status_change",
    });
  } catch (_) { /* non-fatal */ }
};

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("Order", orderSchema);
