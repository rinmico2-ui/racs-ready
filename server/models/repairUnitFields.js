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
    decisionMethod: { type: String, enum: ['online', 'on_site'] },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByTechnician: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
  },
  repairVerification: {
    outcome: { type: String, enum: ['resolved', 'follow_up_required'] },
    workPerformed: { type: String, trim: true, maxlength: 1000 },
    testResults: { type: String, trim: true, maxlength: 2000 },
    customerConfirmed: Boolean,
    followUpReason: { type: String, trim: true, maxlength: 500 },
    recordedAt: Date,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
  },
};
const inspectionFields = {
  testsPerformed: { type: String, trim: true, maxlength: 2000 },
  recommendedAction: { type: String, trim: true, maxlength: 2000 },
  technicianConfirmed: Boolean, confirmedAt: Date,
};
const detailFields = {
  inspection: { ...inspectionFields, findings: { type: String, maxlength: 2000 }, completedAt: Date, photos: [String] },
  diagnosis: { summary: { type: String, maxlength: 2000 }, source: { type: String, enum: ['technician', 'ai_reviewed'] }, completedAt: Date },
  quotation: {
    parts: [{ name: String, cost: Number, quantity: Number, toolId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool' } }],
    laborCost: Number, laborCategory: String, totalCost: Number, notes: String,
    laborPricingMode: { type: String, enum: ['company', 'custom'] }, companyLaborCost: Number,
    laborPriceReason: { type: String, maxlength: 500 },
  },
};
module.exports = { trackingFields, detailFields, inspectionFields };
