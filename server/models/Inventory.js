const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Aircon Inventory Schema — Air Conditioner Product Catalog
// ─────────────────────────────────────────────────────────────────────────────
// Each document represents a single aircon SKU (one model line × one capacity).
// For service tools & materials, use the Tool model instead.
// Designed for RACS (Refrigeration & Air Conditioning Services).
// ─────────────────────────────────────────────────────────────────────────────

/** Valid aircon unit types */
const AIRCON_TYPES = [
  "split",                // Split Type
  "split_ceiling",        // Split Type - Ceiling Suspended
  "window_inverter",      // Window Type - Inverter
  "window_non_inverter",  // Window Type - Non Inverter
  "floor_mounted",        // Floor Mounted
];

/** Product lifecycle statuses */
const PRODUCT_STATUSES = [
  "in_stock",       // available for purchase
  "low_stock",      // below minStockLevel threshold
  "out_of_stock",   // quantity === 0
  "coming_soon",    // listed but not yet available
  "discontinued",   // no longer sold
];

/** Sales channel options */
const SALES_CHANNELS = ["web", "shop", "both"];

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

/**
 * Specifications sub-document for technical details.
 * Keeps the main schema clean while allowing rich product data.
 */
const specificationsSchema = new mongoose.Schema(
  {
    refrigerantType: {
      type: String,
      trim: true,
      default: "R32",
    },
    energyRating: {
      type: String,
      trim: true,
      default: null, // e.g. "5-Star", "EER 12.5"
    },
    noiseLevel: {
      type: String,
      trim: true,
      default: null, // e.g. "26 dB(A)"
    },
    voltage: {
      type: String,
      trim: true,
      default: "220-240V / 60Hz",
    },
    dimensions: {
      type: String,
      trim: true,
      default: null, // e.g. "Indoor: 800x275x200mm"
    },
    weight: {
      type: String,
      trim: true,
      default: null, // e.g. "Indoor: 9kg, Outdoor: 28kg"
    },
    coverageArea: {
      type: String,
      trim: true,
      default: null, // e.g. "15-20 sqm"
    },
  },
  { _id: false },
);

// ─── Main Inventory Schema ──────────────────────────────────────────────────

const inventorySchema = new mongoose.Schema(
  {
    // ── Product Identity ────────────────────────────────────────────────────
    modelLine: {
      type: String,
      required: [true, "Model line is required"],
      trim: true,
      index: true,
    },

    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
      index: true,
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: [true, "Category is required"],
      index: true,
    },

    type: {
      type: String,
      enum: {
        values: AIRCON_TYPES,
        message: "Type must be one of: " + AIRCON_TYPES.join(", "),
      },
      default: "split",
      index: true,
    },

    // ── Capacity & Performance ──────────────────────────────────────────────
    capacity: {
      type: String,
      required: [true, "Capacity (HP) is required"],
      trim: true,
      index: true, // e.g. "1.0", "1.5", "2.0", "2.5", "3.0"
    },

    capacityUnit: {
      type: String,
      default: "HP",
      trim: true,
    },

    btu: {
      type: Number,
      default: 0,
      min: [0, "BTU cannot be negative"],
    },

    inverter: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── SKU / Barcode ───────────────────────────────────────────────────────
    sku: {
      type: String,
      trim: true,
      uppercase: true,
      index: true,
      unique: true,
      sparse: true,
    },

    barcode: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    // ── Pricing (PHP) ───────────────────────────────────────────────────────
    sellingPrice: {
      type: Number,
      default: 0,
      min: [0, "Selling price cannot be negative"],
    },

    costPrice: {
      type: Number,
      default: 0,
      min: [0, "Cost price cannot be negative"],
    },

    // ── Stock Management ────────────────────────────────────────────────────
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
        values: PRODUCT_STATUSES,
        message: "Status must be one of: " + PRODUCT_STATUSES.join(", "),
      },
      default: "out_of_stock",
      index: true,
    },


    // ── Product Details ─────────────────────────────────────────────────────
    description: {
      type: String,
      trim: true,
      default: null,
    },

    features: {
      type: [String],
      default: [],
    },

    warranty: {
      type: String,
      trim: true,
      default: "1 Year Compressor, 1 Year Parts",
    },

    imageUrl: {
      type: String,
      trim: true,
      default: "/images/products/default.png",
    },

    // ── Technical Specifications ────────────────────────────────────────────
    specifications: {
      type: specificationsSchema,
      default: () => ({}),
    },

    // ── Business Logic ──────────────────────────────────────────────────────
    salesChannel: {
      type: String,
      enum: {
        values: SALES_CHANNELS,
        message: "Sales channel must be one of: " + SALES_CHANNELS.join(", "),
      },
      default: "both",
      index: true,
    },

    supplier: {
      type: String,
      trim: true,
      default: null,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },


    // ── Display Name (derived from modelLine + capacity) ─────────────────────
    // Stored for fast lookup/search without needing virtuals.
    displayLabel: {
      type: String,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Indexes ────────────────────────────────────────────────────────────────

// Ensure one SKU per model-line + capacity combination
inventorySchema.index(
  { brand: 1, modelLine: 1, capacity: 1 },
  { unique: true, name: "brand_model_capacity_unique" },
);

// Compound index for common product listing queries
inventorySchema.index({ active: 1, salesChannel: 1, status: 1 });

// ─── Virtuals ───────────────────────────────────────────────────────────────

/** Human-friendly display name: "AUX QCDI Inverter 1.5 HP" */
inventorySchema.virtual("displayName").get(function () {
  return `${this.modelLine} ${this.capacity} ${this.capacityUnit || "HP"}`;
});

/** Formatted price string: "₱25,500" */
inventorySchema.virtual("formattedPrice").get(function () {
  if (!this.sellingPrice) return "Price TBA";
  return `₱${this.sellingPrice.toLocaleString("en-PH")}`;
});

// ─── Pre-save Middleware ────────────────────────────────────────────────────

inventorySchema.pre("validate", function () {
  // Auto-populate displayLabel from modelLine + capacity
  if (this.modelLine) {
    this.displayLabel = `${this.modelLine} ${this.capacity || ''} ${this.capacityUnit || 'HP'}`.trim();
  }
});

inventorySchema.pre("save", async function () {
  // ── Auto-generate SKU ──────────────────────────────────────────────────
  if (!this.sku && this.modelLine) {
    // Build SKU from brand abbreviation + model + capacity
    // e.g. "CAR-NEXUS-INV-1.5HP"
    const abbrev = (this.modelLine || "")
      .replace(/[^A-Za-z0-9 ]/g, "")
      .split(/\s+/)
      .slice(0, 3)
      .map((w) => w.substring(0, 4).toUpperCase())
      .join("-");
    const cap = (this.capacity || "").replace(/\./g, "");
    const base = `${abbrev}-${cap}HP`;

    let candidate = base;
    let suffix = 0;
    while (await mongoose.models.Inventory.findOne({ sku: candidate })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.sku = candidate;
  }

  // ── Auto-generate barcode if missing ───────────────────────────────────
  if (!this.barcode) {
    const base = `INV${this._id.toString().slice(-8).toUpperCase()}`;
    let candidate = base;
    let suffix = 0;
    while (await mongoose.models.Inventory.findOne({ barcode: candidate })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    this.barcode = candidate;
  }

  // ── Auto-compute stock status ──────────────────────────────────────────
  // Only update status when it's not manually set to a lifecycle status
  if (this.status !== "coming_soon" && this.status !== "discontinued") {
    if (this.quantity <= 0) {
      this.status = "out_of_stock";
    } else if (this.quantity <= this.minStockLevel) {
      this.status = "low_stock";
    } else {
      this.status = "in_stock";
    }
  }
});

// ─── Static Methods ─────────────────────────────────────────────────────────

/**
 * Find all products visible on the web storefront.
 * @returns {Query} Mongoose query (call .exec() or await)
 */
inventorySchema.statics.findWebProducts = function () {
  return this.find({
    active: true,
    salesChannel: { $in: ["web", "both"] },
    status: { $ne: "discontinued" },
  })
    .populate("brand", "name")
    .populate("category", "name")
    .sort({ modelLine: 1, capacity: 1 });
};

/**
 * Find items that are low on stock or out of stock.
 * @param {number} [limit=50]
 * @returns {Query}
 */
inventorySchema.statics.findLowStock = function (limit = 50) {
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

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("Inventory", inventorySchema);
