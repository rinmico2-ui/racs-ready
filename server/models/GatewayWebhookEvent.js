"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: { type: String, maxlength: 160 },
  processedAt: { type: Date, required: true },
}, { versionKey: false });
module.exports = mongoose.model("GatewayWebhookEvent", schema);
