"use strict";

const mongoose = require("mongoose");

const emailDeliveryLogSchema = new mongoose.Schema({
  provider: { type: String, enum: ["smtp", "brevo"], required: true, index: true },
  recipient: { type: String, required: true, maxlength: 500, index: true },
  subject: { type: String, required: true, maxlength: 300 },
  status: { type: String, enum: ["accepted", "failed"], required: true, index: true },
  messageId: { type: String, maxlength: 300, default: "" },
  error: { type: String, maxlength: 500, default: "" },
  source: { type: String, maxlength: 80, default: "application" },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

emailDeliveryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
emailDeliveryLogSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("EmailDeliveryLog", emailDeliveryLogSchema);
