const mongoose = require("mongoose");

const equipmentUsageLogSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },
    equipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: function () { return !['personal', 'borrowed'].includes(this.source); },
    },
    recordKind: { type: String, enum: ['daily_note', 'extra'], default: 'daily_note', index: true },
    source: { type: String, enum: ['company', 'personal', 'borrowed'], default: 'company' },
    companyMode: { type: String, enum: ['held', 'stock'] },
    equipmentAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EquipmentAssignment' },
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingService' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    workType: { type: String, enum: ['booking', 'order'] },
    workReference: { type: String, maxlength: 160 },
    owner: { type: String, trim: true, maxlength: 160 },
    quantity: { type: Number, min: 1, max: 10000, default: 1, validate: Number.isInteger },
    clientSubmissionId: { type: String, maxlength: 80 },
    submissionDigest: { type: String, maxlength: 64 },
    equipmentName: { type: String, required: true, trim: true },
    equipmentCode: { type: String, default: "" },
    date: { type: Date, required: true, index: true },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

equipmentUsageLogSchema.index({ technicianId: 1, date: -1 });
equipmentUsageLogSchema.index({ technicianId: 1, clientSubmissionId: 1 }, {
  unique: true, partialFilterExpression: { recordKind: 'extra', clientSubmissionId: { $type: 'string' } },
});

module.exports = mongoose.model("EquipmentUsageLog", equipmentUsageLogSchema);
