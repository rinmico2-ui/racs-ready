const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  toolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool', required: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, enum: ['equipment', 'consumable'], required: true },
  unit: { type: String, default: 'pcs' },
  quantity: { type: Number, required: true, min: 1, max: 10000 },
  quantityBasis: { type: String, enum: ['per_visit', 'per_unit'], required: true },
}, { _id: false });
const snapshotSchema = new mongoose.Schema({
  revision: Number, mode: String, items: [itemSchema], inspectionItems: [itemSchema], repairItems: [itemSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, updatedAt: Date,
}, { _id: false });
const schema = new mongoose.Schema({
  serviceModel: { type: String, enum: ['CoreService', 'RepairService', 'ServiceCategory'], required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'serviceModel', required: true },
  mode: { type: String, enum: ['custom', 'defaults'], default: 'custom' },
  items: [itemSchema], inspectionItems: [itemSchema], repairItems: [itemSchema],
  revision: { type: Number, min: 1, default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedAt: { type: Date, default: Date.now },
  history: [snapshotSchema],
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ serviceModel: 1, serviceId: 1 }, { unique: true });
module.exports = mongoose.model('ServiceKitRule', schema);
