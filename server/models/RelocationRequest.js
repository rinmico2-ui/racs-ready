const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  address: { type: String, required: true, trim: true, maxlength: 300 },
  details: { type: String, trim: true, maxlength: 500, default: '' },
}, { _id: false });

const relocationRequestSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoreService', required: true },
  assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerAsset', default: null },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingService', default: null },
  scope: { type: String, enum: ['same_property', 'custom_quote'], required: true },
  from: { type: locationSchema, required: true },
  to: { type: locationSchema, required: true },
  unit: {
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    airconType: { type: String, trim: true, maxlength: 40, default: '' },
    hp: { type: Number, default: null },
    model: { type: String, trim: true, maxlength: 80, default: '' },
    serialNumber: { type: String, trim: true, maxlength: 100, default: '' },
  },
  preferredDate: { type: Date, required: true },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  status: {
    type: String,
    enum: ['pending_review', 'assessment_needed', 'quoted', 'accepted', 'declined', 'converted', 'completed', 'cancelled'],
    default: 'pending_review', index: true,
  },
  assessmentNotes: { type: String, trim: true, maxlength: 1000, default: '' },
  quote: {
    lines: [{ label: { type: String, trim: true, maxlength: 100 }, amount: { type: Number, min: 0 } }],
    total: { type: Number, min: 0 },
    durationMinutes: { type: Number, min: 60, max: 1440 },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    version: { type: Number, default: 0 },
    quotedAt: Date,
    expiresAt: Date,
    quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  acceptedAt: Date,
  events: [{ action: String, actorId: mongoose.Schema.Types.ObjectId, at: { type: Date, default: Date.now }, note: String }],
}, { timestamps: true });

relocationRequestSchema.index({ customerId: 1, createdAt: -1 });
relocationRequestSchema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('RelocationRequest', relocationRequestSchema);
