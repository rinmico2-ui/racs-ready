const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 80 },
  kind: { type: String, enum: ['allowance', 'deduction'], required: true },
  amount: { type: Number, required: true, min: 0, max: 10000000 },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ kind: 1, name: 1 }, { unique: true, partialFilterExpression: { active: true } });
module.exports = mongoose.model('PayrollTemplate', schema);
