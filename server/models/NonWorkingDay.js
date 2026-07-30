const mongoose = require('mongoose');

const nonWorkingDaySchema = new mongoose.Schema({
  // date-only (normalized to startOfDay)
  date: { type: Date, required: true, index: true },
  // optional service scope; when absent it's a global day-off
  service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', index: true, required: false },
  note: { type: String },
  // optional reason (controller expects `reason` in some places)
  reason: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// unique per (date, service) — sparse so multiple services can create separate entries
nonWorkingDaySchema.index({ date: 1, service: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('NonWorkingDay', nonWorkingDaySchema);
