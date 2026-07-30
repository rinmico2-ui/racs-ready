const mongoose = require('mongoose');

// HP-based pricing schema for aircon repair services
const hpPricingSchema = new mongoose.Schema({
  hp: { type: Number, required: true }, // Horsepower (e.g., 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0)
  price: { type: Number, required: true }, // Price for this HP
  laborPerHour: { type: Number }, // Optional labor rate override for this HP
  estimatedDurationMinutes: { type: Number }, // Optional duration override for this HP
  description: { type: String } // Optional description for this HP tier
}, { _id: false });

const partSchema = new mongoose.Schema({
  name: { type: String, required: true },
  partNumber: { type: String },
  price: { type: Number },
  quantity: { type: Number, default: 1 },
  required: { type: Boolean, default: false }
}, { _id: false });

const repairServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  icon: { type: String },
  applianceType: { type: String, index: true },
  commonFaults: [String],
  parts: [partSchema],
  
  // Pricing structure - INITIAL PRICING (before technician diagnosis)
  initialPrice: { type: Number }, // Initial diagnostic/service call fee
  basePrice: { type: Number }, // Base price for non-aircon services (legacy support)
  laborPerHour: { type: Number },
  
  // Pricing note to display to customers
  pricingNote: { 
    type: String, 
    default: 'This is an initial service fee. Final pricing will be determined by the technician after diagnosis.' 
  },
  
  // HP-based pricing for aircon repair services
  isAirconService: { type: Boolean, default: false }, // Flag to identify aircon repair services
  hpPricing: [hpPricingSchema], // Array of HP-based prices for aircon repairs
  
  // Aircon types with HP pricing (same structure as CoreService)
  airconTypes: [{
    type: { 
      type: String, 
      required: true,
      enum: ['split', 'window', 'floor_mounted', 'split_suspended', 'cassette', 'central']
    },
    name: { type: String, required: true },
    description: { type: String },
    hpPricing: [hpPricingSchema],
    supportedHpRange: {
      min: { type: Number },
      max: { type: Number }
    }
  }],
  defaultAirconType: { type: String },
  
  // Duration
  estimatedDurationMinutes: { type: Number }, // Default duration for non-aircon services
  durationRange: {
    min: { type: Number },
    max: { type: Number }
  },
  
  // Common HP ranges for aircon repair services
  supportedHpRange: {
    min: { type: Number }, // Minimum HP supported
    max: { type: Number }  // Maximum HP supported
  },
  
  // Technician final pricing (set after diagnosis)
  allowTechnicianPricing: { type: Boolean, default: true }, // Allow technician to set final price
  
  warrantyDays: { type: Number, default: 0 },
  availabilityLocations: [String],
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

// use modern (sync/async) middleware signature — do not accept `next`
repairServiceSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('RepairService', repairServiceSchema);
