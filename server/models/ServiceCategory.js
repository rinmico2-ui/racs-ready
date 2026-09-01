const mongoose = require('mongoose');
const { warrantyPolicySchema } = require('../utils/serviceWarrantyPolicy');

const unitTypeSchema = new mongoose.Schema({
  value: { type: String, required: true },
  label: { type: String, required: true },
  icon: { type: String, default: 'bi-circle' }
}, { _id: true });

const serviceCategorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  icon: { type: String, default: 'bi-grid' },
  iconColor: { type: String, default: 'blue' },
  unitTypes: [unitTypeSchema],
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  isCustom: { type: Boolean, default: false },
  // Repair requests are created from these category/unit-type records rather
  // than from the priced RepairService catalog. Keep the prospective warranty
  // policy on the owning record so Aftercare does not become a second source
  // of truth. Existing categories stay unconfigured until an admin saves one.
  warrantyPolicy: { type: warrantyPolicySchema(mongoose), default: undefined },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
}, { timestamps: true });

serviceCategorySchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
