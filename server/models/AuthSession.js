const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ip: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now },
  revoked: { type: Boolean, default: false }
});

module.exports = mongoose.model('AuthSession', authSessionSchema);
