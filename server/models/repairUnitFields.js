const mongoose = require('mongoose');
const trackingFields = {
  problemDescription: { type: String, trim: true, maxlength: 2000 },
  repairReview: {
    state: { type: String, enum: ['pending', 'staff_review', 'customer_review', 'approved', 'declined', 'completed'], default: 'pending' },
    revision: { type: Number, default: 0 },
    inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, decidedAt: Date,
    decisionNotes: { type: String, maxlength: 1000 },
  },
};
const detailFields = {
  inspection: { findings: { type: String, maxlength: 2000 }, completedAt: Date, photos: [String] },
  diagnosis: { summary: { type: String, maxlength: 2000 }, completedAt: Date },
  quotation: {
    parts: [{ name: String, cost: Number, quantity: Number, toolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool' } }],
    laborCost: Number, laborCategory: String, totalCost: Number, notes: String,
  },
};
module.exports = { trackingFields, detailFields };
