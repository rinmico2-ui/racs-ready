const mongoose = require('mongoose');

const failedLoginSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, index: true },
  ip: { type: String },
  count: { type: Number, default: 0 },
  lastAttemptAt: { type: Date },
  lockedUntil: { type: Date }
});

failedLoginSchema.methods.increment = function (windowMs, maxAttempts) {
  const now = new Date();
  this.count = (this.count || 0) + 1;
  this.lastAttemptAt = now;
  if (this.count >= maxAttempts) {
    this.lockedUntil = new Date(Date.now() + windowMs);
  }
  return this.save();
};

module.exports = mongoose.model('FailedLoginAttempt', failedLoginSchema);
