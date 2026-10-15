"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: { type: String, maxlength: 160 },
  count: { type: Number, default: 0, min: 0 },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("SecurityRateBucket", schema);
