'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', required: true, index: true },
  dailyKitId: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyKit' },
  itemId: mongoose.Schema.Types.ObjectId,
  equipmentAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EquipmentAssignment' },
  toolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool', required: true },
  name: { type: String, required: true },
  unit: { type: String, default: 'pcs' },
  category: { type: String, enum: ['equipment', 'consumable', 'repair_part'], required: true },
  condition: { type: String, enum: ['good', 'fair', 'damaged', 'lost'], default: 'good' },
  equipmentUse: { type: String, enum: ['used', 'unused', 'not_recorded'], default: 'not_recorded' },
  unused: { type: Number, min: 0, default: 0 },
  used: { type: Number, min: 0, default: 0 },
  damaged: { type: Number, min: 0, default: 0 },
  missing: { type: Number, min: 0, default: 0 },
  notes: { type: String, maxlength: 500, default: '' },
  bookingIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BookingService' }],
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  status: { type: String, enum: ['pending', 'received', 'rejected'], default: 'pending', index: true },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedAt: Date,
  receiptNotes: { type: String, maxlength: 500, default: '' },
  reportedQuantities: { unused: Number, used: Number, damaged: Number, missing: Number },
  reportedCondition: String,
}, { timestamps: true });
schema.index({ equipmentAssignmentId: 1 }, { unique: true, partialFilterExpression: { status: 'pending', category: 'equipment' } });
schema.index({ dailyKitId: 1, itemId: 1 }, { unique: true, partialFilterExpression: { status: 'pending', category: { $in: ['consumable', 'repair_part'] } } });
schema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('KitReturn', schema);
