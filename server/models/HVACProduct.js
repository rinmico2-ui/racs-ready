const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// HVAC Product Schema — Professional Air Conditioner Catalog
// ─────────────────────────────────────────────────────────────────────────────
// Each document represents a complete aircon model line with multiple HP variants.
// Designed for professional HVAC inventory management.
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
 * HP Variant sub-document for different capacity options.
 * Each variant represents one HP option with its specific pricing and stock.
 */
const hpVariantSchema = new mongoose.Schema(
  {
    capacity: {
      type: String,
      required: [true, "Capacity (HP) is required"],
      trim: true,
      // e.g. "0.5", "0.75", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "5.0"
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

    sellingPrice: {
      type: Number,
      required: [true, "Selling price is required"],
      min: [0, "Selling price cannot be negative"],
    },

    costPrice: {
      type: Number,
      default: 0,
      min: [0, "Cost price cannot be negative"],
    },

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
    },

    sku: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },

    barcode: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    // Variant-specific specifications
    specifications: {
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
      coverageArea: {
        type: String,
        trim: true,
        default: null, // e.g. "15-20 sqm"
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
    },

    active: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true }
);

/**
 * Specifications sub-document for general product details.
 */
const specificationsSchema = new mongoose.Schema(
  {
    voltage: {
      type: String,
      trim: true,
      default: "220-240V / 60Hz",
    },
    features: {
      type: [String],
      default: [],
    },
    installationRequirements: {
      type: String,
      trim: true,
      default: null,
    },
    warranty: {
      type: String,
      trim: true,
      default: "1 Year Compressor, 1 Year Parts",
    },
  },
  { _id: false }
);

// ─── Main HVAC Product Schema ──────────────────────────────────────────────────

const hvacProductSchema = new mongoose.Schema(
  {
    // ── Product Identity ────────────────────────────────────────────────────
    modelLine: {
      type: String,
      required: [true, "Model line is required"],
      trim: true,
      index: true,
      // e.g. "AUX QCDI Inverter", "Carrier Nexus Inverter"
    },

    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: [true, "Brand is required"],
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

    inverter: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── HP Variants Array ────────────────────────────────────────────────────
    variants: {
      type: [hpVariantSchema],
      required: [true, "At least one HP variant is required"],
      validate: {
        validator: function(variants) {
          return variants && variants.length > 0;
        },
        message: "Product must have at least one HP variant"
      }
    },

    // ── Product Details ─────────────────────────────────────────────────────
    description: {
      type: String,
      trim: true,
      default: null,
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

    // ── Overall Product Status ─────────────────────────────────────────────
    status: {
      type: String,
      enum: {
        values: PRODUCT_STATUSES,
        message: "Status must be one of: " + PRODUCT_STATUSES.join(", "),
      },
      default: "out_of_stock",
      index: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    // ── Metadata ───────────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "hvac_products"
  }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Compound indexes for efficient queries
hvacProductSchema.index({ modelLine: 1, brand: 1 });
hvacProductSchema.index({ brand: 1, type: 1 });
hvacProductSchema.index({ "variants.capacity": 1 });
hvacProductSchema.index({ "variants.status": 1 });
hvacProductSchema.index({ active: 1, status: 1 });

// ─── Virtual Fields ─────────────────────────────────────────────────────────

// Get price range across all variants
hvacProductSchema.virtual("priceRange").get(function() {
  if (!this.variants || this.variants.length === 0) return { min: 0, max: 0 };
  
  const prices = this.variants
    .filter(v => v.active && v.sellingPrice)
    .map(v => v.sellingPrice);
  
  if (prices.length === 0) return { min: 0, max: 0 };
  
  return {
    min: Math.min(...prices),
    max: Math.max(...prices)
  };
});

// Get available HP options
hvacProductSchema.virtual("availableHPs").get(function() {
  if (!this.variants || this.variants.length === 0) return [];
  
  return this.variants
    .filter(v => v.active && v.status === 'in_stock')
    .map(v => v.capacity)
    .sort((a, b) => parseFloat(a) - parseFloat(b));
});

// Get total stock across all variants
hvacProductSchema.virtual("totalStock").get(function() {
  if (!this.variants || this.variants.length === 0) return 0;
  
  return this.variants
    .filter(v => v.active)
    .reduce((total, v) => total + (v.quantity || 0), 0);
});

// Check if any variant is in stock
hvacProductSchema.virtual("hasStock").get(function() {
  if (!this.variants || this.variants.length === 0) return false;
  
  return this.variants.some(v => 
    v.active && v.status === 'in_stock' && v.quantity > 0
  );
});

// ─── Instance Methods ───────────────────────────────────────────────────────

// Find variant by capacity
hvacProductSchema.methods.findVariant = function(capacity) {
  if (!this.variants) return null;
  return this.variants.find(v => v.capacity === capacity);
};

// Get variant by SKU
hvacProductSchema.methods.findVariantBySKU = function(sku) {
  if (!this.variants) return null;
  return this.variants.find(v => v.sku === sku);
};

// Update overall status based on variants
hvacProductSchema.methods.updateOverallStatus = function() {
  if (!this.variants || this.variants.length === 0) {
    this.status = "out_of_stock";
    return this.status;
  }

  const activeVariants = this.variants.filter(v => v.active);
  
  if (activeVariants.length === 0) {
    this.status = "discontinued";
  } else if (activeVariants.some(v => v.status === "out_of_stock")) {
    if (activeVariants.every(v => v.status === "out_of_stock")) {
      this.status = "out_of_stock";
    } else {
      this.status = "low_stock";
    }
  } else if (activeVariants.some(v => v.status === "low_stock")) {
    this.status = "low_stock";
  } else {
    this.status = "in_stock";
  }

  return this.status;
};

// ─── Static Methods ───────────────────────────────────────────────────────

// Find products by brand and type
hvacProductSchema.statics.findByBrandAndType = function(brandId, type) {
  return this.find({
    brand: brandId,
    type: type,
    active: true
  }).populate('brand', 'name').populate('category', 'name');
};

// Find products with specific HP capacity
hvacProductSchema.statics.findByCapacity = function(capacity) {
  return this.find({
    "variants.capacity": capacity,
    "variants.active": true,
    active: true
  }).populate('brand', 'name').populate('category', 'name');
};

// Search products by model line
hvacProductSchema.statics.searchByModel = function(searchTerm) {
  const regex = new RegExp(searchTerm, 'i');
  return this.find({
    modelLine: regex,
    active: true
  }).populate('brand', 'name').populate('category', 'name');
};

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("HVACProduct", hvacProductSchema);
