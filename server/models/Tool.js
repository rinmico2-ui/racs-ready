const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Tool Schema — Service Tools & Materials Catalog
// ─────────────────────────────────────────────────────────────────────────────
// Each document represents a single tool or consumable material item used by
// technicians during service jobs (e.g. copper pipe, refrigerant gas, wrench).
// Referenced by ServiceToolUsage for deducting stock per job.
// ─────────────────────────────────────────────────────────────────────────────

/** Tool/material stock statuses */
const TOOL_STATUSES = [
  "in_stock",      // available
  "low_stock",     // below minStockLevel threshold
  "out_of_stock",  // quantity === 0
  "discontinued",  // no longer used
];

// ─── Main Tool Schema ────────────────────────────────────────────────────────

const toolSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    itemName: {
      type: String,
      required: [true, "Item name is required"],
      trim: true,
      index: true,
    },

    unit: {
      type: String,
      default: "pcs",
      trim: true,
    },

    // ── Stock Management ──────────────────────────────────────────────────────
    quantity: {
      type: Number,
      default: 0,
      min: [0, "Quantity cannot be negative"],
    },

    minStockLevel: {
      type: Number,
      default: 3,
      min: [0, "Min stock level cannot be negative"],
    },

    status: {
      type: String,
      enum: {
        values: TOOL_STATUSES,
        message: "Status must be one of: " + TOOL_STATUSES.join(", "),
      },
      default: "out_of_stock",
      index: true,
    },

    // ── Pricing (PHP) ─────────────────────────────────────────────────────────
    costPrice: {
      type: Number,
      default: 0,
      min: [0, "Cost price cannot be negative"],
    },

    sellingPrice: {
      type: Number,
      default: 0,
      min: [0, "Selling price cannot be negative"],
    },

    // ── Details ───────────────────────────────────────────────────────────────
    category: {
      type: String,
      trim: true,
      default: "General",
      index: true,
    },

    specification: {
      type: String,
      trim: true,
      default: null,
    },

    description: {
      type: String,
      trim: true,
      default: null,
    },

    supplier: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Identification ────────────────────────────────────────────────────────
    serialNumber: {
      type: String,
      trim: true,
      default: null,
    },

    barcode: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    // ── Flags ─────────────────────────────────────────────────────────────────
    isStockItem: {
      type: Boolean,
      default: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    // ── Reservation ledger ────────────────────────────────────────────────────
    // Quantity currently committed to active project reservations. The admin
    // "Reserve Project Resources" flow reserves catalog stock so it cannot be
    // double-booked on other jobs. available = quantity - reservedQuantity.
    reservedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

toolSchema.index({ active: 1, status: 1 });
toolSchema.index({ itemName: "text" });

// ─── Pre-save Middleware ─────────────────────────────────────────────────────

toolSchema.pre("save", async function () {
  // ── Auto-generate serial number if missing ────────────────────────────
  if (!this.serialNumber) {
    const count = await mongoose.models.Tool.countDocuments();
    this.serialNumber = `SN-${String(count + 1).padStart(6, "0")}`;
  }

  // ── Auto-generate barcode if missing ───────────────────────────────────
  if (!this.barcode) {
    const base = `TOOL${this._id.toString().slice(-8).toUpperCase()}`;
    let candidate = base;
    let suffix = 0;
    while (await mongoose.models.Tool.findOne({ barcode: candidate })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.barcode = candidate;
  }

  // ── Auto-compute stock status ──────────────────────────────────────────
  if (this.status !== "discontinued") {
    if (this.quantity <= 0) {
      this.status = "out_of_stock";
    } else if (this.quantity <= this.minStockLevel) {
      this.status = "low_stock";
    } else {
      this.status = "in_stock";
    }
  }
});

// ─── Static Methods ──────────────────────────────────────────────────────────

/**
 * Find active tool items for dropdowns (tool-usage selection).
 * @param {number} [limit=600]
 */
toolSchema.statics.findForDropdown = function (limit = 600) {
  return this.find({ active: true, isStockItem: true })
    .sort({ itemName: 1 })
    .limit(limit)
    .select("_id itemName unit quantity costPrice barcode");
};

/**
 * Find items that are low on stock or out of stock.
 * @param {number} [limit=50]
 */
toolSchema.statics.findLowStock = function (limit = 50) {
  return this.find({
    active: true,
    isStockItem: true,
    $or: [
      { status: "low_stock" },
      { status: "out_of_stock" },
      { $expr: { $lte: ["$quantity", "$minStockLevel"] } },
    ],
  })
    .sort({ quantity: 1 })
    .limit(limit);
};

/**
 * Available (unreserved) units of a tool, accounting for active project
 * reservations. reservedQuantity is the canonical ledger; this is a derived
 * helper used by the reservation UI and the POST /materials guard.
 */
toolSchema.virtual("availableQuantity").get(function () {
  return Math.max(0, (this.quantity || 0) - (this.reservedQuantity || 0));
});

/**
 * Recompute reservedQuantity for a tool from all active project-material
 * reservations (status reserved/fulfilled). Keeps the ledger consistent
 * after edits/cancellations. Pass null to recompute every tool.
 */
toolSchema.statics.recomputeReserved = async function (toolId) {
  const ProjectMaterial = mongoose.models.ProjectMaterial;
  if (!ProjectMaterial) return;
  const match = { source: "inventory", sourceId: { $exists: true, $ne: null }, status: { $in: ["reserved", "fulfilled"] } };
  if (toolId) match.sourceId = new mongoose.Types.ObjectId(toolId);
  const pipeline = [
    { $match: match },
    { $group: { _id: "$sourceId", total: { $sum: "$quantity" } } },
  ];
  const rows = await ProjectMaterial.aggregate(pipeline);
  const byId = new Map(rows.map((r) => [r._id.toString(), r.total]));
  if (toolId) {
    await this.updateOne({ _id: toolId }, { $set: { reservedQuantity: byId.get(toolId.toString()) || 0 } });
    return;
  }
  const ids = [...byId.keys()];
  await this.updateMany({ _id: { $in: ids } }, { $set: { reservedQuantity: 0 } });
  for (const [id, total] of byId) {
    await this.updateOne({ _id: id }, { $set: { reservedQuantity: total } });
  }
};

// ─── Export ──────────────────────────────────────────────────────────────────

module.exports = mongoose.model("Tool", toolSchema);
