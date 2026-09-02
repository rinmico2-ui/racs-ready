const REMITTANCE_STATUSES = Object.freeze([
  "waiting_for_remittance",
  "remitted",
  "verified",
  "rejected",
  "unaccounted",
]);

const REMITTANCE_METHODS = Object.freeze([
  "cash_handover",
  "gcash_transfer",
  "bank_deposit",
]);

class RemittancePolicyError extends Error {
  constructor(message, status = 400, code = "REMITTANCE_INVALID") {
    super(message);
    this.name = "RemittancePolicyError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function isStoredProofUrl(value) {
  return /^\/uploads\/remittance-proofs\/[A-Za-z0-9._-]+$/.test(String(value || ""));
}

function isProofForPayment(value, paymentId) {
  if (!isStoredProofUrl(value)) return false;
  if (!paymentId) return true;
  const escapedId = String(paymentId).replace(/[^A-Za-z0-9_-]/g, "");
  return String(value).startsWith(`/uploads/remittance-proofs/remittance-${escapedId}-`);
}

function normalizeLocation(value) {
  if (!value || typeof value !== "object") return undefined;
  const lat = Number(value.lat), lng = Number(value.lng), accuracy = Number(value.accuracy);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return undefined;
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100000 ? { accuracy } : {}),
    ...(cleanText(value.address, 300) ? { address: cleanText(value.address, 300) } : {}),
  };
}

function assertTechnicianSubmission(payment, body = {}) {
  const status = String(payment?.status || "");
  if (!["waiting_for_remittance", "rejected", "paid"].includes(status)) {
    throw new RemittancePolicyError(
      `This collection is already ${status.replace(/_/g, " ") || "processed"}. Refresh the queue before trying again.`,
      409,
      "REMITTANCE_STATE_CONFLICT",
    );
  }

  const method = cleanText(body.remittanceMethod, 40);
  const notes = cleanText(body.notes, 1000);
  const reference = cleanText(body.remittanceReference, 120);
  const proofUrl = cleanText(body.proofUrl, 300);
  if (!REMITTANCE_METHODS.includes(method)) {
    throw new RemittancePolicyError("Choose how the funds were handed over.", 400, "REMITTANCE_METHOD_REQUIRED");
  }
  if (notes.length < 10) {
    throw new RemittancePolicyError("Add at least 10 characters describing who received the funds and where.", 400, "REMITTANCE_NOTES_REQUIRED");
  }
  if (!isProofForPayment(proofUrl, payment?._id)) {
    throw new RemittancePolicyError("Upload a JPG, PNG, or WEBP handover proof before submitting.", 400, "REMITTANCE_PROOF_REQUIRED");
  }
  if (method !== "cash_handover" && reference.length < 4) {
    throw new RemittancePolicyError("Enter the bank or e-wallet transaction reference.", 400, "REMITTANCE_REFERENCE_REQUIRED");
  }

  return { method, notes, reference, proofUrl };
}

function assertAdminTransition(payment, action, body = {}) {
  const current = String(payment?.status || "");
  const normalizedAction = cleanText(action, 30).toLowerCase();
  const allowedFrom = {
    verify: ["remitted"],
    reject: ["remitted"],
    override: ["waiting_for_remittance", "rejected"],
    flag: ["waiting_for_remittance", "remitted", "rejected"],
    refund: ["verified"],
  };
  if (!allowedFrom[normalizedAction]) {
    throw new RemittancePolicyError("Unsupported remittance action.", 400, "REMITTANCE_ACTION_INVALID");
  }
  if (!allowedFrom[normalizedAction].includes(current)) {
    throw new RemittancePolicyError(
      `Cannot ${normalizedAction} a remittance that is ${current.replace(/_/g, " ")}. Refresh the queue and review its latest state.`,
      409,
      "REMITTANCE_STATE_CONFLICT",
    );
  }
  if (normalizedAction === "verify" && !isStoredProofUrl(payment?.remittanceProofUrl)) {
    throw new RemittancePolicyError("A stored handover proof is required before verification. Request a corrected submission instead.", 409, "REMITTANCE_EVIDENCE_MISSING");
  }
  const reason = cleanText(body.reason, 1000);
  const notes = cleanText(body.notes, 1000);
  if (["reject", "flag", "refund"].includes(normalizedAction) && reason.length < 10) {
    throw new RemittancePolicyError("Enter a specific reason of at least 10 characters.", 400, "REMITTANCE_REASON_REQUIRED");
  }
  if (normalizedAction === "override" && notes.length < 10) {
    throw new RemittancePolicyError("Document the in-person handover with at least 10 characters.", 400, "REMITTANCE_OVERRIDE_NOTES_REQUIRED");
  }
  return { action: normalizedAction, reason, notes };
}

function assertResolution(payment, body = {}, now = new Date()) {
  if (payment?.status !== "unaccounted" || payment?.resolvedAt) {
    throw new RemittancePolicyError("Only an unresolved unaccounted payment can be resolved.", 409, "REMITTANCE_RESOLUTION_CONFLICT");
  }
  const resolutionType = cleanText(body.resolutionType, 40).toLowerCase();
  if (!["write_off", "deduct_from_payroll", "recovery"].includes(resolutionType)) {
    throw new RemittancePolicyError("Choose recovery, payroll deduction, or write-off.", 400, "REMITTANCE_RESOLUTION_REQUIRED");
  }
  const notes = cleanText(body.notes, 1000);
  if (notes.length < 10) {
    throw new RemittancePolicyError("Document the resolution decision with at least 10 characters.", 400, "REMITTANCE_RESOLUTION_NOTES_REQUIRED");
  }
  let followUpDate = null;
  if (resolutionType === "recovery") {
    followUpDate = new Date(body.followUpDate);
    if (Number.isNaN(followUpDate.getTime()) || followUpDate <= now) {
      throw new RemittancePolicyError("Choose a recovery follow-up date in the future.", 400, "REMITTANCE_FOLLOW_UP_INVALID");
    }
  }
  return { resolutionType, notes, followUpDate };
}

function queueState(payment) {
  const status = String(payment?.status || "");
  if (status === "waiting_for_remittance") return { owner: "technician", stage: "handover_required", terminal: false };
  if (status === "rejected") return { owner: "technician", stage: "correction_required", terminal: false };
  if (status === "remitted") return { owner: "admin", stage: "verification_required", terminal: false };
  if (status === "unaccounted" && !payment?.resolvedAt) return { owner: "admin", stage: "exception_resolution", terminal: false };
  if (status === "unaccounted") return { owner: "none", stage: "exception_resolved", terminal: true };
  return { owner: "none", stage: status || "unknown", terminal: ["verified", "refunded"].includes(status) };
}

module.exports = {
  REMITTANCE_METHODS,
  REMITTANCE_STATUSES,
  RemittancePolicyError,
  assertAdminTransition,
  assertResolution,
  assertTechnicianSubmission,
  isProofForPayment,
  isStoredProofUrl,
  normalizeLocation,
  queueState,
};
