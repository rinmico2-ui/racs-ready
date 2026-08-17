const mongoose = require('mongoose');

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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
}, { timestamps: true });

serviceCategorySchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
