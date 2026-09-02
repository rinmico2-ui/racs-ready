const RECEIVED_PAYMENT_STATUSES = new Set([
  "verified",
  "paid",
  "remitted",
  "payment_collected",
  "partial",
  "waiting_for_remittance",
  // These are treasury/custody exceptions, not customer-payment reversals.
  // The customer has still paid even when the technician's handover evidence
  // is rejected or the collected funds are escalated as unaccounted.
  "rejected",
  "unaccounted",
  "refunded",
]);

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function summarizeBookingPayments(booking, payments = []) {
  const records = Array.isArray(payments) ? payments : [];
  const received = records.filter((payment) => RECEIVED_PAYMENT_STATUSES.has(payment.status));
  const pending = records.filter((payment) => payment.status === "pending");

  const totalPaid = received.reduce((sum, payment) => sum + money(payment.amount), 0);
  const totalRefunded = received.reduce(
    (sum, payment) => sum + Math.min(money(payment.amount), money(payment.refundAmount)),
    0
  );
  const submittedAmount = pending.reduce((sum, payment) => sum + money(payment.amount), 0);
  const latestReceived = received[0] || null;
  const latestPending = pending[0] || null;

  return {
    amountPaid: Math.max(0, totalPaid - totalRefunded),
    submittedAmount,
    alreadyRefunded: totalRefunded,
    paymentId: latestReceived?._id || null,
    pendingPaymentId: latestPending?._id || null,
    method: latestReceived?.method || latestPending?.method || booking?.paymentMethod || "",
    paymentType: latestReceived?.type || latestPending?.type || "",
    paymentStatus: latestReceived?.status || latestPending?.status || booking?.paymentStatus || "pending",
    recordsFound: received.length,
    pendingRecordsFound: pending.length,
    requiresVerification: received.length === 0 && submittedAmount > 0,
  };
}

function reconcileBookingPayments(booking, payments = []) {
  const summary = summarizeBookingPayments(booking, payments);
  const total = money(booking?.totalPrice || booking?.estimatedFee || booking?.servicePrice);
  const ledgerCollected = summary.amountPaid;
  const snapshotAmountPaid = money(booking?.amountPaid);
  const outstandingFromLedger = Math.max(0, total - ledgerCollected);
  const snapshotSaysSettled = Boolean(booking?.balanceCollected)
    || (total > 0 && money(booking?.balanceAmount) === 0 && ["paid", "verified", "waiting_for_remittance", "remitted"].includes(booking?.paymentStatus));
  const hasLedgerMismatch = total > 0
    && snapshotSaysSettled
    && outstandingFromLedger > 0.01;

  return {
    ...summary,
    total,
    ledgerCollected,
    snapshotAmountPaid,
    outstandingFromLedger,
    snapshotSaysSettled,
    hasLedgerMismatch,
  };
}

module.exports = {
  RECEIVED_PAYMENT_STATUSES,
  summarizeBookingPayments,
  reconcileBookingPayments,
};
