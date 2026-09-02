const test = require("node:test");
const assert = require("node:assert/strict");
const Payment = require("../models/Payment");
const Notification = require("../models/Notification");
const {
  assertAdminTransition,
  assertResolution,
  assertTechnicianSubmission,
  normalizeLocation,
  queueState,
} = require("../utils/remittancePolicy");

const PAYMENT_ID = "68b7db813490043cadf01001";
const PROOF = `/uploads/remittance-proofs/remittance-${PAYMENT_ID}-123.png`;

test("technician can correct a rejected remittance with stored evidence", () => {
  const submission = assertTechnicianSubmission({ _id: PAYMENT_ID, status: "rejected" }, {
    remittanceMethod: "cash_handover",
    notes: "Handed to cashier Ana at the main office.",
    proofUrl: PROOF,
  });
  assert.equal(submission.method, "cash_handover");
  assert.equal(submission.proofUrl, PROOF);
  assert.throws(() => assertTechnicianSubmission({ _id: "68b7db813490043cadf01002", status: "rejected" }, {
    remittanceMethod: "cash_handover",
    notes: "Handed to cashier Ana at the main office.",
    proofUrl: PROOF,
  }), error => error.code === "REMITTANCE_PROOF_REQUIRED");
});

test("technician remittance rejects base64 evidence and missing transfer references", () => {
  assert.throws(() => assertTechnicianSubmission({ status: "waiting_for_remittance" }, {
    remittanceMethod: "cash_handover",
    notes: "Handed to the office cashier.",
    proofUrl: "data:image/png;base64,AAAA",
  }), error => error.code === "REMITTANCE_PROOF_REQUIRED");
  assert.throws(() => assertTechnicianSubmission({ status: "waiting_for_remittance" }, {
    remittanceMethod: "gcash_transfer",
    notes: "Transferred to the company GCash account.",
    proofUrl: PROOF,
  }), error => error.code === "REMITTANCE_REFERENCE_REQUIRED");
});

test("admin transitions follow one explicit custody state machine", () => {
  assert.equal(assertAdminTransition({ status: "remitted", remittanceProofUrl: PROOF }, "verify").action, "verify");
  assert.equal(assertAdminTransition({ status: "remitted", remittanceProofUrl: PROOF }, "reject", { reason: "The uploaded amount is not readable." }).action, "reject");
  assert.equal(assertAdminTransition({ status: "rejected" }, "override", { notes: "Cash was received by Ana at the cashier desk." }).action, "override");
  assert.throws(() => assertAdminTransition({ status: "waiting_for_remittance" }, "verify"), error => error.status === 409);
  assert.throws(() => assertAdminTransition({ status: "remitted", remittanceProofUrl: "data:image/png;base64,AAAA" }, "verify"), error => error.code === "REMITTANCE_EVIDENCE_MISSING");
});

test("exception resolution requires notes and a future recovery deadline", () => {
  const now = new Date("2026-09-02T08:00:00+08:00");
  const result = assertResolution({ status: "unaccounted" }, {
    resolutionType: "recovery",
    notes: "Technician will return the cash to the office.",
    followUpDate: "2026-09-04T00:00:00+08:00",
  }, now);
  assert.equal(result.resolutionType, "recovery");
  assert.throws(() => assertResolution({ status: "unaccounted" }, {
    resolutionType: "recovery",
    notes: "Technician will return the cash to the office.",
    followUpDate: "2026-09-01T00:00:00+08:00",
  }, now), error => error.code === "REMITTANCE_FOLLOW_UP_INVALID");
});

test("queue ownership distinguishes correction, verification, and resolved exceptions", () => {
  assert.deepEqual(queueState({ status: "rejected" }), { owner: "technician", stage: "correction_required", terminal: false });
  assert.deepEqual(queueState({ status: "remitted" }), { owner: "admin", stage: "verification_required", terminal: false });
  assert.deepEqual(queueState({ status: "unaccounted", resolvedAt: new Date() }), { owner: "none", stage: "exception_resolved", terminal: true });
});

test("remittance location accepts only finite geographic coordinates", () => {
  assert.deepEqual(normalizeLocation({ lat: 14.67, lng: 121.04, accuracy: 18 }), { lat: 14.67, lng: 121.04, accuracy: 18 });
  assert.equal(normalizeLocation({ lat: 999, lng: 121 }), undefined);
});

test("payment schema stores remittance custody and resolution fields", () => {
  assert.ok(Payment.schema.path("remittanceMethod"));
  assert.ok(Payment.schema.path("remittanceReference"));
  assert.ok(Payment.schema.path("resolutionType"));
  assert.ok(Payment.schema.path("recoveryFollowUpDate"));
  assert.ok(Payment.schema.path("violationUserId"));
  const notificationTypes = Notification.schema.path("type").enumValues;
  assert.ok(notificationTypes.includes("payment_remitted"));
  assert.ok(notificationTypes.includes("remittance_recovery"));
});
