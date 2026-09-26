const mongoose = require("mongoose");

const productRefundSchema = new mongoose.Schema({
  returnId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductReturn", required: true, unique: true },
  sourceType: { type: String, enum: ["order", "walk_in"], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  itemIndex: { type: Number, required: true, min: 0 },
  originalPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
  amount: { type: Number, required: true, min: 0.01 },
  status: { type: String, enum: ["approved", "processing", "completed"], default: "approved" },
  method: { type: String, enum: ["gcash", "maya", "bank", "cash", "card", "other"], default: null },
  reference: { type: String, trim: true, maxlength: 120, default: "" },
  proofUrl: { type: String, trim: true, maxlength: 500, default: "" },
  notes: { type: String, trim: true, maxlength: 2000, default: "" },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  processedAt: { type: Date, default: null },
}, { timestamps: true });

productRefundSchema.index({ sourceType: 1, sourceId: 1, status: 1 });
module.exports = mongoose.model("ProductRefund", productRefundSchema);
