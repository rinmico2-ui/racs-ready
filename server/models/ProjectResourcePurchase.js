const mongoose = require("mongoose");

const projectResourcePurchaseSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true, index: true },
  resourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", required: true, index: true },
  itemName: { type: String, required: true, trim: true },
  resourceType: { type: String, enum: ["equipment", "consumable", "part"], required: true },
  orderedQuantity: { type: Number, min: 1, required: true },
  receivedQuantity: { type: Number, min: 0, default: 0 },
  supplier: { type: String, required: true, trim: true },
  unitPurchaseCost: { type: Number, min: 0, default: 0 },
  expectedDelivery: { type: Date, required: true },
  acquisitionMode: { type: String, enum: ["purchase", "rent", "acquire"], default: "purchase" },
  status: { type: String, enum: ["ordered", "partially_received", "received", "cancelled"], default: "ordered", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  receipts: [{ quantity: Number, receivedAt: { type: Date, default: Date.now }, receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, stockAdjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: "StockAdjustment" } }],
}, { timestamps: true });

projectResourcePurchaseSchema.index({ projectId: 1, resourceId: 1, status: 1 });

module.exports = mongoose.model("ProjectResourcePurchase", projectResourcePurchaseSchema);
