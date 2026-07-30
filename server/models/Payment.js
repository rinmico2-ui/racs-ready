const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  // reference to the booking/service this payment belongs to
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService" },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },

  // amount paid (may be downpayment or full amount)
  amount: { type: Number, required: true },

  // method used by customer (gcash, cod, bank, paymongo, etc.)
  method: {
    type: String,
    enum: ["gcash", "cod", "bank", "paymongo", "other"],
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
    enum: ["pending", "paid", "failed", "partial"],
    default: "pending",
  },

  submittedAt: { type: Date, default: Date.now },
  verifiedAt: { type: Date },
  completedAt: { type: Date },

  notes: String, // admin notes or reconciliation comments
});

paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ orderId: 1 });
paymentSchema.index({ projectId: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
