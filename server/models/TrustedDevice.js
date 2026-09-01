const mongoose = require("mongoose");

const trustedDeviceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  tokenHash: { type: String, required: true, unique: true, select: false },
  label: { type: String, trim: true, maxlength: 160 },
  userAgent: { type: String, maxlength: 512 },
  createdIp: { type: String, maxlength: 128 },
  lastUsedIp: { type: String, maxlength: 128 },
  passwordChangedAt: Date,
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
});

trustedDeviceSchema.index({ userId: 1, revokedAt: 1, lastUsedAt: -1 });
trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("TrustedDevice", trustedDeviceSchema);
