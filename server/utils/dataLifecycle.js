const DATA_RETENTION_POLICY = Object.freeze({
  version: "1.0",
  automaticHardDelete: false,
  operationalRecords: "retained",
  financialRecords: "retained",
  auditRecords: "retained",
  catalogueRecords: "soft_archived",
  schedulingExceptions: "soft_archived",
  correctionMode: "void_cancel_or_reverse",
  reasonMinLength: 10,
  reasonMaxLength: 500,
});

function lifecycleFields(mongoose) {
  return {
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, maxlength: 500, default: "" },
    lifecycleHistory: {
      type: [{
        action: { type: String, enum: ["archived", "restored"], required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        reason: { type: String, trim: true, maxlength: 500, default: "" },
      }],
      default: [],
    },
  };
}

function normalizeLifecycleReason(value, action = "Archive", options = {}) {
  const reason = String(value || options.fallback || "").trim().replace(/\s+/g, " ");
  const min = options.minLength ?? DATA_RETENTION_POLICY.reasonMinLength;
  if (reason.length < min || reason.length > DATA_RETENTION_POLICY.reasonMaxLength) {
    const error = new Error(`${action} reason must be between ${min} and ${DATA_RETENTION_POLICY.reasonMaxLength} characters.`);
    error.status = 400;
    error.statusCode = 400;
    error.code = "INVALID_LIFECYCLE_REASON";
    throw error;
  }
  return reason;
}

function archiveRecord(record, actorId, reason, at = new Date()) {
  // Treat repeated requests as idempotent, but still allow legacy inactive
  // rows without archive metadata to be brought under the lifecycle policy.
  if (record.active === false && record.archivedAt) return record;
  record.active = false;
  record.archivedAt = at;
  record.archivedBy = actorId;
  record.archiveReason = reason;
  if (Array.isArray(record.lifecycleHistory)) {
    record.lifecycleHistory.push({ action: "archived", at, by: actorId, reason });
  }
  return record;
}

function restoreRecord(record, actorId, reason, at = new Date()) {
  if (record.active !== false && !record.archivedAt) return record;
  record.active = true;
  record.archivedAt = null;
  record.archivedBy = null;
  record.archiveReason = "";
  if (Array.isArray(record.lifecycleHistory)) {
    record.lifecycleHistory.push({ action: "restored", at, by: actorId, reason });
  }
  return record;
}

module.exports = {
  DATA_RETENTION_POLICY,
  lifecycleFields,
  normalizeLifecycleReason,
  archiveRecord,
  restoreRecord,
};
