const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  clientRequestId: { type:String, trim:true, maxlength:100 },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requestType: { type: String, enum: ['core', 'repair'], default: 'core' },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoreService', required: function () { return this.requestType !== 'repair'; } },
  existingBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingService', default: null },
  existingBookingReference: String,
  serviceName: { type: String, required: true },
  applianceKind: { type: String, enum: ['aircon', 'refrigerator', 'freezer', 'other'], default: 'aircon' },
  repair: { unitType: { type: String, maxlength: 80 }, unitCategory: { type: String, maxlength: 80 }, inspectionFee: Number, problemDescription: { type: String, maxlength: 500 } },
  model: { type: String, trim: true, maxlength: 50, default: '' },
  photos: [{ fileId: { type: mongoose.Schema.Types.ObjectId, required: true }, contentType: String, length: Number }],
  brand: { type: String, trim: true, maxlength: 80, default: '' },
  airconType: { type: String, trim: true, maxlength: 40, default: '' },
  hp: { type: Number, default: null },
  quantity: { type: Number, required: true, min: 1, max: 40 },
  relocation: {
    scope: { type: String, enum: ['same_property'] },
    fromPosition: { type: String, trim: true, maxlength: 500 },
    toPosition: { type: String, trim: true, maxlength: 500 },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerAsset', default: null },
    model: { type: String, trim: true, maxlength: 80 },
    serialNumber: { type: String, trim: true, maxlength: 100 },
  },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  status: { type: String, enum: ['pending', 'quoted', 'accepted', 'declined', 'converted', 'resolved'], default: 'pending', index: true },
  quote: {
    applianceKind: { type: String, enum: ['aircon', 'refrigerator', 'freezer', 'other'] },
    unitType: String,
    unitCategory: String,
    brand: String,
    airconType: String,
    airconTypeName: String,
    hp: Number,
    unitPrice: Number,
    durationMinutes: Number,
    notes: { type: String, maxlength: 1000 },
    verificationMethod: { type: String, enum: ['customer_contact', 'model_label', 'site_visit'] },
    quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    quotedAt: Date,
    expiresAt: Date,
  },
  acceptedAt: Date,
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingService', default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: Date,
  resolutionNotes: String,
  events: [{
    action: { type: String, enum: ['requested', 'quoted', 'accepted', 'declined', 'converted', 'resolved'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    unitPrice: Number,
    notes: String,
  }],
}, { timestamps: true });

schema.index({ customerId: 1, createdAt: -1 });
schema.index({ customerId:1, clientRequestId:1 }, { unique:true, partialFilterExpression:{ clientRequestId:{ $type:'string' } } });
schema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('UnitAssistanceRequest', schema);
