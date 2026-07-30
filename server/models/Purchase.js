const mongoose = require("mongoose");

/**
 * Purchase
 * Records a single transaction where a customer purchased one or more products.
 * This is intentionally lightweight; product details are denormalized so that
 * the record stays valid even if the product itself is later modified/removed.
 */
const lineItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const purchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  items: { type: [lineItemSchema], default: [] },
  subtotal: { type: Number, default: 0, min: 0 },
  tax: { type: Number, default: 0, min: 0 },
  shipping: { type: Number, default: 0, min: 0 },
  total: { type: Number, default: 0, min: 0 },
  purchaseDate: { type: Date, default: Date.now, index: true },
  status: {
    type: String,
    enum: ["pending", "paid", "shipped", "completed", "cancelled"],
    default: "pending",
  },
});

// compound index to quickly look up user purchases by date
purchaseSchema.index({ userId: 1, purchaseDate: -1 });

module.exports = mongoose.model("Purchase", purchaseSchema);
