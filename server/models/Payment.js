const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  // reference to the booking/service this payment belongs to
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService" },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },
  clientSubmissionId: { type: String, trim: true, maxlength: 100 },

  // amount paid (may be downpayment or full amount)
  amount: { type: Number, required: true },

  // method used by customer (gcash, cod, bank, paymongo, etc.)
  method: {
    type: String,
    enum: ["gcash", "cod", "cash", "bank", "paymongo", "other"],
    required: true,
  },

  // if this is a partial/initial payment rather than final
  type: {
    type: String,
    enum: ["downpayment", "final", "adjustment", "inspection"],
    default: "final",
  },

  // gateway-specific fields (for PayMongo integration)
  gateway: {
    type: String,
    enum: ["gcash", "cod", "bank", "paymongo", "other"],
    default: "cod",
  },
  gatewayId: String,       // resource ID returned by gateway
  gatewayType: String,     // e.g. payment_intent, source
  gatewayStatus: String,   // raw status from provider
  webhookEvents: { type: Array }, // store raw webhook payloads

  reference: String, // e.g. GCash transaction code or notes
  proofUrl: String, // base64 data url or stored upload path

  status: {
    type: String,
    enum: ["pending", "payment_collected", "waiting_for_remittance", "remitted", "verified", "rejected", "refunded", "paid", "failed", "partial", "unaccounted"],
    default: "pending",
  },

  collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  collectedByName: String,
  collectedAt: Date,
  collectionLocation: { address: String, lat: Number, lng: Number, accuracy: Number },
  customerSignature: String,
  customerPhotoUrl: String,
  remittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  remittedByTechnician: { type: mongoose.Schema.Types.ObjectId, ref: "Technician" },
  remittedAt: Date,
  remittanceMethod: {
    type: String,
    enum: ["cash_handover", "gcash_transfer", "bank_deposit"],
  },
  remittanceReference: { type: String, trim: true, maxlength: 120 },
  remittanceNotes: String,
  remittanceProofUrl: { type: String, trim: true, maxlength: 300 },
  remittanceLocation: { address: String, lat: Number, lng: Number, accuracy: Number },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  rejectedAt: Date,
  rejectionReason: String,

  // Admin override fields (when admin manually confirms remittance)
  overrideBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  overrideAt: Date,
  overrideNotes: String,

  // Flag / violation fields (when admin flags payment as unaccounted)
  flaggedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  flaggedAt: Date,
  flagReason: String,
  violationUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // Resolution fields (when admin resolves an unaccounted payment)
  resolutionType: { type: String, enum: ["write_off", "deduct_from_payroll", "recovery"], default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  resolvedAt: Date,
  resolutionNotes: String,
  payrollDeductionId: { type: mongoose.Schema.Types.ObjectId, ref: "Payroll" },
  recoveryFollowUpDate: { type: Date },
  refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  refundedAt: Date,
  refundReason: String,
  refundAmount: { type: Number, default: 0 },
  refundMethod: { type: String, enum: ["original", "gcash", "bank", "cash", "other"] },
  refundProofUrl: { type: String },
  refundNotes: { type: String },
  refundStatus: {
    type: String,
    enum: ["none", "pending", "processing", "completed", "partial"],
    default: "none",
  },
  events: [{
    status: { type: String, required: true }, actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorName: String, actorRole: String, note: String,
    at: { type: Date, default: Date.now }, metadata: mongoose.Schema.Types.Mixed,
  }],

  submittedAt: { type: Date, default: Date.now },
  verifiedAt: { type: Date },
  completedAt: { type: Date },

  notes: String, // admin notes or reconciliation comments
}, { optimisticConcurrency: true });

paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ orderId: 1 });
paymentSchema.index({ projectId: 1 });
paymentSchema.index(
  { projectId: 1, clientSubmissionId: 1 },
  { unique: true, partialFilterExpression: { clientSubmissionId: { $type: "string" } } },
);
paymentSchema.index({ status: 1, collectedAt: -1 });
paymentSchema.index({ status: 1, submittedAt: -1 });
paymentSchema.index({ status: 1, verifiedAt: -1 });
paymentSchema.index({ status: 1, completedAt: -1 });
paymentSchema.index({ status: 1, refundedAt: -1 });
paymentSchema.index({ collectedBy: 1, status: 1, collectedAt: -1 });
paymentSchema.index({ status: 1, resolvedAt: 1, recoveryFollowUpDate: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
