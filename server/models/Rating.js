const mongoose = require("mongoose");

const ratingSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  targetType: {
    type: String,
    enum: ["inventory", "technician", "booking", "order"],
    required: true,
    index: true,
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  score: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  comment: { type: String, default: null },
  moderationStatus: {
    type: String,
    enum: ["visible", "flagged", "hidden"],
    default: "visible",
    index: true,
  },
  moderatedAt: { type: Date, default: null },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  moderationReason: { type: String, trim: true, maxlength: 500, default: "" },
  moderationHistory: {
    type: [{
      status: { type: String, enum: ["visible", "flagged", "hidden"], required: true },
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      reason: { type: String, trim: true, maxlength: 500, default: "" },
    }],
    default: [],
  },
}, { timestamps: true });

// Performance indexes
ratingSchema.index({ targetType: 1, targetId: 1 });
ratingSchema.index({ targetType: 1, createdAt: -1 });

module.exports = mongoose.model("Rating", ratingSchema);
