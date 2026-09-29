"use strict";

const mongoose = require("mongoose");

const emailOutboxSchema = new mongoose.Schema({
  payloadCiphertext: { type: String, required: true, select: false },
  payloadIv: { type: String, required: true, select: false },
  payloadTag: { type: String, required: true, select: false },
  recipientHash: { type: String, required: true, index: true },
  source: { type: String, maxlength: 80, default: "application" },
  status: {
    type: String,
    enum: ["pending", "processing", "sent", "failed"],
    default: "pending",
    index: true,
  },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lockedAt: { type: Date, default: null },
  lastError: { type: String, maxlength: 500, default: "" },
  sentAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

emailOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
emailOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("EmailOutbox", emailOutboxSchema);
