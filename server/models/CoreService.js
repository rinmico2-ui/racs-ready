const mongoose = require('mongoose');

// HP-based pricing schema for aircon services
const hpPricingSchema = new mongoose.Schema({
  hp: { type: Number, required: true }, // Horsepower (e.g., 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0)
  price: { type: Number, required: true }, // Price for this HP
  durationMinutes: { type: Number }, // Optional duration override for this HP
  description: { type: String } // Optional description for this HP tier
}, { _id: false });

// Aircon type schema with HP pricing
const airconTypeSchema = new mongoose.Schema({
  type: { 
    type: String, 
    required: true,
    enum: ['split', 'window', 'floor_standing', 'cassette', 'floor_mounted', 'split_suspended', 'central']
  },
  name: { type: String, required: true }, // Display name e.g. "Split Type"
  description: { type: String },
  hpPricing: [hpPricingSchema], // HP-based prices for this type
  supportedHpRange: {
    min: { type: Number },
    max: { type: Number }
  }
}, { _id: false });

const coreServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  category: { type: String, required: true, index: true },
  description: { type: String },
  features: [String],
  includedItems: [String],
  exclusions: [String],
  images: [String],
  
  // Pricing structure
  basePrice: { type: Number }, // Base price for non-aircon services
  priceRange: {
    min: { type: Number },
    max: { type: Number }
  },
  
  // HP-based pricing for aircon services (legacy support)
  isAirconService: { type: Boolean, default: false },
  hpPricing: [hpPricingSchema],
  
  // Aircon types with HP pricing (new structure)
  airconTypes: [airconTypeSchema],
  defaultAirconType: { type: String }, // Default type if not specified

  // Catalog of aircon appliance types this service supports (display + enum key).
  // Drives the customer-side "Appliance Type" selector.
  applianceTypes: [{
    type: { type: String, enum: ['split', 'window', 'cassette', 'floor_standing'] },
    name: { type: String } // e.g. "Split Type"
  }],

  // Catalog of supported aircon brands for this service (free-form select on UI).
  brands: [String],
  
  // Duration
  durationMinutes: { type: Number },
  durationRange: {
    min: { type: Number },
    max: { type: Number }
  },
  
  // Common HP ranges for aircon services
  supportedHpRange: {
    min: { type: Number },
    max: { type: Number }
  },
  
  tags: [String],
  active: { type: Boolean, default: true },
  meta: {
    title: { type: String },
    description: { type: String }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

// use modern (sync/async) middleware signature — don't accept `next` and call it
coreServiceSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('CoreService', coreServiceSchema);
