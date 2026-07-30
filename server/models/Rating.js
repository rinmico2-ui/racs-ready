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
}, { timestamps: true });

module.exports = mongoose.model("Rating", ratingSchema);
