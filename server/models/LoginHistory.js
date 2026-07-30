const mongoose = require('mongoose');

const loginHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ip: { type: String },
  country: { type: String },
  city: { type: String },
  userAgent: { type: String },
  deviceType: { type: String },
  browser: { type: String },
  os: { type: String },
  isNewDevice: { type: Boolean, default: false },
  isNewIp: { type: Boolean, default: false },
  suspicious: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('LoginHistory', loginHistorySchema);
