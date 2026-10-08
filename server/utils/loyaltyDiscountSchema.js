const mongoose = require('mongoose');
module.exports = new mongoose.Schema({
  ruleId: String, ruleName: String, policyRevision: String, metric: String,
  threshold: Number, completedCount: Number, discountPercent: { type: Number, min: 0, max: 50 },
  eligibleBase: { type: Number, min: 0 }, amount: { type: Number, min: 0 }, channel: String,
  appliedAt: Date,
  eligibleItemIds: [String],
}, { _id: false });
