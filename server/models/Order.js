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

    // human-readable order reference
    orderReference: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    // financials
    subtotal: { type: Number, default: 0, min: 0 },
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
      enum: ["pending", "paid", "failed", "partial"],
      default: "pending",
    },
    gcashNumber: { type: String, trim: true, default: null },
    gcashProofUrl: { type: String, trim: true, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ technicianId: 1, status: 1 });

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
  this.total = this.subtotal + (this.deliveryFee || 0) + (this.installationFee || 0) + (this.transportationFee || 0);
});

// ─── Instance Methods ───────────────────────────────────────────────────────

orderSchema.methods.pushStatus = function (newStatus, note) {
  this.status = newStatus;
  this.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
    note: note || "",
  });
};

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("Order", orderSchema);
