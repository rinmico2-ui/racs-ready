const mongoose = require("mongoose");

const CLAIM_STATUSES = [
  "submitted",
  "triage",
  "inspection_scheduled",
  "inspection_en_route",
  "inspection_arrived",
  "inspection_in_progress",
  "inspection_completed",
  "approved",
  "partially_approved",
  "denied",
  "remedy_in_progress",
  "resolved",
  "closed",
  "withdrawn",
];

const historySchema = new mongoose.Schema({
  status: { type: String, enum: CLAIM_STATUSES, required: true },
  at: { type: Date, default: Date.now },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  actorRole: { type: String, trim: true, default: "system" },
  actorName: { type: String, trim: true, maxlength: 150, default: "System" },
  note: { type: String, trim: true, maxlength: 2000, default: "" },
}, { _id: false });

const warrantyClaimSchema = new mongoose.Schema({
  claimReference: { type: String, required: true, unique: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  sourceType: { type: String, enum: ["booking", "order"], required: true, index: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sourceReference: { type: String, trim: true, maxlength: 100, required: true },
  serviceAddress: { type: String, trim: true, maxlength: 1000, default: "" },
  coverageId: { type: String, trim: true, maxlength: 120, default: "legacy" },
  coverageSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  claimType: {
    type: String,
    enum: ["product_defect", "installation_workmanship", "repair_workmanship", "replacement_part", "diagnostic_accuracy", "safety_defect"],
    required: true,
    index: true,
  },
  affectedItem: {
    itemKey: { type: String, trim: true, maxlength: 120, default: "" },
    name: { type: String, trim: true, maxlength: 300, required: true },
    serialNumber: { type: String, trim: true, maxlength: 120, default: "" },
  },
  description: { type: String, trim: true, minlength: 10, maxlength: 3000, required: true },
  discoveredAt: { type: Date, required: true },
  safetyRisk: { type: Boolean, default: false, index: true },
  requestedRemedy: { type: String, enum: ["inspection", "repair", "replacement", "refund", "manufacturer_referral"], default: "inspection" },
  claimantEvidenceUrls: { type: [String], default: [] },
  status: { type: String, enum: CLAIM_STATUSES, default: "submitted", index: true },
  active: { type: Boolean, default: true, index: true },
  priority: { type: String, enum: ["normal", "high", "critical"], default: "normal", index: true },
  submittedAt: { type: Date, default: Date.now },
  acknowledgedAt: { type: Date, default: null },
  assignedTechnicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", default: null, index: true },
  inspection: {
    scheduledDate: { type: Date, default: null },
    timeSlot: { type: String, trim: true, maxlength: 100, default: "" },
    enRouteAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    diagnosis: { type: String, trim: true, maxlength: 3000, default: "" },
    rootCause: { type: String, enum: ["product_defect", "workmanship", "replacement_part", "customer_damage", "maintenance", "third_party", "inconclusive", ""], default: "" },
    evidenceUrls: { type: [String], default: [] },
  },
  decision: {
    outcome: { type: String, enum: ["approved", "partially_approved", "denied", ""], default: "" },
    reason: { type: String, trim: true, maxlength: 3000, default: "" },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  remedy: {
    type: { type: String, enum: ["repair", "replacement", "refund", "manufacturer_referral", "reinspection", "none"], default: "none" },
    status: { type: String, enum: ["not_started", "in_progress", "completed", "cancelled"], default: "not_started" },
    oldSerialNumber: { type: String, trim: true, maxlength: 120, default: "" },
    newSerialNumber: { type: String, trim: true, maxlength: 120, default: "" },
    amount: { type: Number, min: 0, default: 0 },
    notes: { type: String, trim: true, maxlength: 3000, default: "" },
    completedAt: { type: Date, default: null },
  },
  customerConfirmedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  history: { type: [historySchema], default: [] },
}, { timestamps: true });

warrantyClaimSchema.index({ sourceType: 1, sourceId: 1, createdAt: -1 });
warrantyClaimSchema.index({ customerId: 1, createdAt: -1 });
warrantyClaimSchema.index({ status: 1, priority: 1, submittedAt: 1 });
warrantyClaimSchema.index(
  { customerId: 1, sourceType: 1, sourceId: 1, coverageId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
warrantyClaimSchema.index(
  { customerId: 1, sourceType: 1, sourceId: 1, "affectedItem.itemKey": 1, claimType: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

module.exports = mongoose.model("WarrantyClaim", warrantyClaimSchema);
module.exports.CLAIM_STATUSES = CLAIM_STATUSES;
