const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  returnId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductReturn", required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceType: { type: String, enum: ["order", "walk_in"], required: true },
  type: { type: String, enum: ["quarantine", "mark_defective", "restock", "replacement_out", "return_to_customer"], required: true },
  quantity: { type: Number, required: true, min: 1 },
  serialNumbers: { type: [String], default: [] },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  note: { type: String, trim: true, maxlength: 1000, default: "" },
}, { timestamps: true });

schema.index({ returnId: 1, type: 1 }, { unique: true });
module.exports = mongoose.model("ProductReturnMovement", schema);
