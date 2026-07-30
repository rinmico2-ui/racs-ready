const mongoose = require('mongoose');

/**
 * Secretary
 * Lightweight profile that references a User with role='secretary'.
 * Use this for secretary-specific metadata (extension, shift, notes).
 */
const secretarySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  extension: { type: String },
  shift: { type: String }, // e.g. "08:00-17:00"
  phone: { type: String },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Secretary', secretarySchema);
