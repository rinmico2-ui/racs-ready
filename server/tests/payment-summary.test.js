const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeBookingPayments, reconcileBookingPayments } = require("../utils/paymentSummary");

test("pending payment is reported as submitted but not refundable", () => {
  const result = summarizeBookingPayments(
    { paymentStatus: "pending", paymentMethod: "cod" },
    [{ _id: "pending-1", amount: 205, method: "cod", type: "downpayment", status: "pending" }]
  );

  assert.equal(result.amountPaid, 0);
  assert.equal(result.submittedAmount, 205);
  assert.equal(result.requiresVerification, true);
  assert.equal(result.pendingPaymentId, "pending-1");
});

test("verified COD downpayment is refundable", () => {
  const result = summarizeBookingPayments(
    { paymentStatus: "partial", paymentMethod: "cod" },
    [{ _id: "paid-1", amount: 205, method: "cod", type: "downpayment", status: "partial" }]
  );

  assert.equal(result.amountPaid, 205);
  assert.equal(result.submittedAmount, 0);
  assert.equal(result.requiresVerification, false);
  assert.equal(result.paymentId, "paid-1");
});

test("completed refunds remain in the ledger and reduce refundable value", () => {
  const result = summarizeBookingPayments(
    { paymentStatus: "refunded", paymentMethod: "gcash" },
    [{ _id: "refund-1", amount: 500, refundAmount: 500, method: "gcash", status: "refunded" }]
  );

  assert.equal(result.amountPaid, 0);
  assert.equal(result.alreadyRefunded, 500);
  assert.equal(result.recordsFound, 1);
});

test("partial refund exposes only the remaining refundable amount", () => {
  const result = summarizeBookingPayments(
    {},
    [{ _id: "paid-2", amount: 1000, refundAmount: 250, method: "bank", status: "paid" }]
  );

  assert.equal(result.amountPaid, 750);
  assert.equal(result.alreadyRefunded, 250);
});

test("flags a settled booking whose remittance ledger does not cover the service total", () => {
  const result = reconcileBookingPayments(
    { totalPrice: 950, amountPaid: 150, balanceAmount: 0, balanceCollected: true, paymentStatus: "waiting_for_remittance" },
    [{ amount: 150, type: "final", method: "cash", status: "waiting_for_remittance" }],
  );

  assert.equal(result.ledgerCollected, 150);
  assert.equal(result.outstandingFromLedger, 800);
  assert.equal(result.hasLedgerMismatch, true);
});

test("accepts a complete downpayment and final-payment ledger", () => {
  const result = reconcileBookingPayments(
    { totalPrice: 950, amountPaid: 950, balanceAmount: 0, balanceCollected: true, paymentStatus: "waiting_for_remittance" },
    [
      { amount: 150, type: "downpayment", method: "gcash", status: "verified" },
      { amount: 800, type: "final", method: "cash", status: "waiting_for_remittance" },
    ],
  );

  assert.equal(result.ledgerCollected, 950);
  assert.equal(result.outstandingFromLedger, 0);
  assert.equal(result.hasLedgerMismatch, false);
});
