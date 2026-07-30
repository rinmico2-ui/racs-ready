const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// WalkInSale Schema — POS Transaction for Walk-In Parts/Tools Sales
// ─────────────────────────────────────────────────────────────────────────────
// Records over-the-counter sales of repair parts and tools to walk-in
// customers. Each sale deducts stock from the Tool catalog and generates
// an invoice receipt for the customer.
// ─────────────────────────────────────────────────────────────────────────────

const WALKIN_STATUSES = [
  "pending",       // checkout in progress
  "completed",     // payment received, stock deducted
  "voided",        // cancelled/refunded
];

const PAYMENT_METHODS = [
  "cash",
  "gcash",
  "maya",
  "card",
  "bank_transfer",
];

const walkInSaleItemSchema = new mongoose.Schema(
  {
    toolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: true,
    },
    // snapshot at time of sale
    itemName: { type: String, required: true },
    category: { type: String, default: "" },
    unit: { type: String, default: "pcs" },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },  // selling price
    costPrice: { type: Number, default: 0, min: 0 },      // for profit calc
    totalPrice: { type: Number, required: true, min: 0 },  // qty × unitPrice
    serialNumber: { type: String, trim: true, default: null },
  },
  { _id: true }
);

const walkInSaleSchema = new mongoose.Schema(
  {
    // ── Invoice ────────────────────────────────────────────────────────────
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ── Customer Info ──────────────────────────────────────────────────────
    customerName: { type: String, trim: true, default: "Walk-In Customer" },
    customerPhone: { type: String, trim: true, default: null },
    customerTin: { type: String, trim: true, default: null },
    customerAddress: { type: String, trim: true, default: null },

    // ── Items ──────────────────────────────────────────────────────────────
    items: {
      type: [walkInSaleItemSchema],
      default: [],
      validate: (v) => v.length > 0,
    },

    // ── Totals ─────────────────────────────────────────────────────────────
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    // ── Profit ─────────────────────────────────────────────────────────────
    totalCost: { type: Number, default: 0, min: 0 },     // sum of costPrice × qty
    totalProfit: { type: Number, default: 0 },             // subtotal - totalCost

    // ── Payment ────────────────────────────────────────────────────────────
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHODS,
      default: "cash",
    },
    amountPaid: { type: Number, required: true, min: 0 },
    change: { type: Number, default: 0, min: 0 },

    // ── Status ─────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: WALKIN_STATUSES,
      default: "pending",
      index: true,
    },

    // ── Processing ─────────────────────────────────────────────────────────
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    processedByName: { type: String, default: "" },
    notes: { type: String, trim: true, default: null },

    // ── Timestamps ─────────────────────────────────────────────────────────
    completedAt: { type: Date },
    voidedAt: { type: Date },
    voidReason: { type: String, trim: true, default: null },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
walkInSaleSchema.index({ status: 1, createdAt: -1 });
walkInSaleSchema.index({ invoiceNumber: 1 });

// ─── Auto-generate Invoice Number ───────────────────────────────────────────
walkInSaleSchema.pre("save", async function () {
  if (this.invoiceNumber) return;

  const date = new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const prefix = `WIS-${yy}${mm}${dd}`;

  const lastSale = await mongoose
    .model("WalkInSale")
    .findOne({ invoiceNumber: { $regex: `^${prefix}` } })
    .sort({ invoiceNumber: -1 })
    .lean();

  let seq = 1;
  if (lastSale && lastSale.invoiceNumber) {
    const lastSeq = parseInt(lastSale.invoiceNumber.split("-").pop(), 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  this.invoiceNumber = `${prefix}-${String(seq).padStart(4, "0")}`;
});

module.exports = mongoose.model("WalkInSale", walkInSaleSchema);
