const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  slug: { type: String, index: true },
  category: { type: String, index: true }, // 'service' | 'repair'
  description: { type: String },
  icon: { type: String },
  duration: { type: Number }, // minutes (legacy `duration` used by seeds)
  durationMinutes: { type: Number },
  basePrice: { type: Number },
  price: { type: Number },
  priceRange: {
    min: { type: Number },
    max: { type: Number }
  },
  images: [String],
  tags: [String],
  active: { type: Boolean, default: true },
  meta: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

serviceSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('Service', serviceSchema);
