const mongoose = require("mongoose");

const STATUSES = [
  "requested", "under_review", "awaiting_return", "received", "inspected",
  "refund_pending", "refund_approved", "refund_processing", "replacement_pending",
  "repair_pending", "completed", "rejected", "cancelled",
];
const REASONS = [
  "defective", "delivery_damage", "wrong_item", "wrong_specification",
  "missing_parts", "warranty", "dead_on_arrival", "manufacturing_defect",
  "wrong_quantity", "other",
];

const productReturnSchema = new mongoose.Schema({
  rmaNumber: { type: String, required: true, unique: true, index: true },
  sourceType: { type: String, enum: ["order", "walk_in"], required: true, index: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sourceReference: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  customerName: { type: String, trim: true, maxlength: 150, default: "" },
  customerPhone: { type: String, trim: true, maxlength: 40, default: "" },
  itemIndex: { type: Number, required: true, min: 0 },
  productId: { type: mongoose.Schema.Types.ObjectId, default: null },
  productName: { type: String, required: true, trim: true },
  sku: { type: String, trim: true, default: "" },
  serialNumbers: { type: [String], default: [] },
  quantity: { type: Number, required: true, min: 1 },
  originalQuantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  maxRefundable: { type: Number, required: true, min: 0 },
  purchaseDate: { type: Date, required: true },
  eligibleUntil: { type: Date, default: null },
  coverageType: { type: String, enum: ["return_period", "seller_warranty", "manufacturer_warranty", "manual_review"], required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService", default: null },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
  reason: { type: String, enum: REASONS, required: true },
  description: { type: String, trim: true, minlength: 10, maxlength: 3000, required: true },
  evidenceUrls: { type: [String], default: [] },
  requestedResolution: { type: String, enum: ["refund", "replacement", "repair"], required: true },
  priority: { type: String, enum: ["normal", "high"], default: "normal", index: true },
  status: { type: String, enum: STATUSES, default: "requested", index: true },
  reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewerName: { type: String, trim: true, maxlength: 150, default: "" },
  receivedAt: { type: Date, default: null },
  inventoryDisposition: { type: String, enum: ["customer_held", "quarantined", "defective", "restocked"], default: "customer_held" },
  inspection: {
    result: { type: String, enum: ["", "defect_confirmed", "not_confirmed", "customer_damage", "misuse", "missing_components", "wrong_item", "warranty_covered", "warranty_not_covered", "further_diagnosis"], default: "" },
    condition: { type: String, trim: true, maxlength: 500, default: "" },
    serialVerified: { type: Boolean, default: false },
    accessoriesComplete: { type: Boolean, default: false },
    signsOfMisuse: { type: Boolean, default: false },
    resellable: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 3000, default: "" },
    evidenceUrls: { type: [String], default: [] },
    inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    inspectedAt: { type: Date, default: null },
  },
  resolution: {
    type: { type: String, enum: ["", "refund", "replacement", "repair"], default: "" },
    reason: { type: String, trim: true, maxlength: 2000, default: "" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    refundAmount: { type: Number, min: 0, default: 0 },
    replacementProductId: { type: mongoose.Schema.Types.ObjectId, default: null },
    replacementSerialNumbers: { type: [String], default: [] },
    refundTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductRefund", default: null },
    completedAt: { type: Date, default: null },
  },
  history: [{
    action: { type: String, required: true },
    from: { type: String, default: "" },
    to: { type: String, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: "system" },
    note: { type: String, trim: true, maxlength: 2000, default: "" },
    at: { type: Date, default: Date.now },
  }],
}, { timestamps: true, optimisticConcurrency: true });

productReturnSchema.index({ sourceType: 1, sourceId: 1, itemIndex: 1, status: 1 });
productReturnSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("ProductReturn", productReturnSchema);
module.exports.STATUSES = STATUSES;
module.exports.REASONS = REASONS;
