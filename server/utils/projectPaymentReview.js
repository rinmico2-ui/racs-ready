"use strict";

const { summarizeBookingPayments } = require('./paymentSummary');

const money = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const fail = (message, status = 409, code) => Object.assign(new Error(message), { status, code });
const paymentFilter = project => ({ $or: [
  { projectId: project._id },
  ...(project.bookingId ? [{ bookingId: project.bookingId }] : []),
] });

function projectPaymentSnapshot(booking) {
  return {
    amountPaid: money(booking.amountPaid),
    balanceAmount: money(booking.balanceAmount),
    totalAmount: money(booking.totalPrice || booking.estimatedFee),
    paymentMethod: booking.paymentChannel || booking.paymentMethod || '',
    paymentStatus: booking.paymentStatus || 'unpaid',
  };
}

function projectPaymentSummary(project, booking, payments = []) {
  const ledger = summarizeBookingPayments(booking, payments);
  const recorded = project.payment || {};
  const total = money(project.quotationReview?.status === 'approved' && project.quotationReview.totalAmount)
    ? money(project.quotationReview.totalAmount) + money(booking?.travelFare)
    : money(booking?.totalPrice || recorded.totalAmount || booking?.estimatedFee);
  // Pending submissions are separate from money actually received. When a
  // ledger exists it is authoritative, including refunds and failed receipts.
  const amountPaid = payments.length ? ledger.amountPaid : money(booking?.amountPaid ?? recorded.amountPaid);
  const pending = payments.filter(row => row.status === 'pending' && money(row.amount) > 0);
  const submittedDownpayment = pending.filter(row => row.type === 'downpayment')
    .reduce((sum, row) => sum + money(row.amount), 0);
  const status = ledger.submittedAmount > 0 ? 'pending'
    : amountPaid > 0 ? (total > 0 && amountPaid >= total ? 'paid' : 'partial')
    : (booking?.paymentStatus || recorded.paymentStatus || 'unpaid');
  return {
    total, amountPaid, submittedAmount: ledger.submittedAmount, submittedDownpayment,
    balance: Math.max(0, total - amountPaid),
    balanceAfterReview: Math.max(0, total - amountPaid - ledger.submittedAmount),
    status, requiresVerification: pending.length > 0,
    downpaymentRequired: money(booking?.downpaymentAmount),
    pendingPayments: pending.map(row => ({ id: row._id, amount: money(row.amount),
      type: row.type, method: row.method, reference: row.reference || '' })),
  };
}

function syncProjectPayment(project, booking, summary) {
  project.payment = {
    ...(project.payment?.toObject?.() || project.payment || {}),
    ...(booking ? projectPaymentSnapshot(booking) : {}),
    amountPaid: summary.amountPaid, balanceAmount: summary.balance, totalAmount: summary.total,
    paymentStatus: summary.status,
  };
}

// Keep the ledger, source booking and project snapshot in one transaction.
// A repeated confirmation of this same payment never records money twice.
async function verifyProjectPayment({ mongoose, Project, BookingService, Payment, projectId, paymentId, actor }) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const project = await Project.findById(projectId).session(session);
      if (!project) throw fail('Project not found', 404);
      if (['cancelled', 'closed', 'completed', 'archived'].includes(project.status)) {
        throw fail('Payment cannot be reviewed for a finished or cancelled project.');
      }
      const booking = project.bookingId ? await BookingService.findById(project.bookingId).session(session) : null;
      if (project.bookingId && !booking) throw fail('The source booking could not be found.', 404);
      if (booking && ['cancelled', 'closed', 'completed', 'rejected', 'expired'].includes(booking.status)) {
        throw fail('Payment cannot be reviewed for a finished or cancelled booking.');
      }
      const payment = await Payment.findOne({ _id: paymentId, ...paymentFilter(project) }).session(session);
      if (!payment) throw fail('This payment does not belong to the project.', 404);
      if (payment.projectId && String(payment.projectId) !== String(project._id)) {
        throw fail('This payment is already linked to another project.');
      }
      if (payment.status !== 'pending') {
        if (!payment.verifiedAt || !['paid', 'partial', 'verified'].includes(payment.status)) {
          throw fail('This payment is no longer waiting for review.');
        }
        const payments = await Payment.find(paymentFilter(project)).session(session).lean();
        result = { alreadyVerified: true, paymentSummary: projectPaymentSummary(project, booking, payments) };
        return;
      }
      if (!money(payment.amount)) throw fail('The submitted payment has no valid amount.', 400);
      if (!payment.reference && !payment.proofUrl && !booking?.paymentProofFileId && !booking?.paymentProof) {
        throw fail('A receipt or transaction reference is needed before confirming payment.', 400);
      }
      const now = new Date();
      payment.status = 'verified';
      payment.verifiedAt = now;
      payment.verifiedBy = actor._id;
      payment.projectId = project._id;
      payment.events = payment.events || [];
      payment.events.push({ status: 'verified', actor: actor._id, actorName: actor.name || actor.email || 'Operations staff',
        actorRole: actor.role, note: 'Receipt checked and payment received; reviewed from the project page.', at: now });
      await payment.save({ session });
      const payments = await Payment.find(paymentFilter(project)).session(session).lean();
      const summary = projectPaymentSummary(project, booking, payments);
      if (booking) {
        booking.amountPaid = summary.amountPaid;
        booking.balanceAmount = summary.balance;
        booking.paymentStatus = summary.amountPaid >= summary.total && summary.total > 0 ? 'paid' : 'partial';
        booking.paymentVerifiedAt = now;
        booking.paymentVerifiedBy = actor._id;
        await booking.save({ session });
      }
      syncProjectPayment(project, booking, summary);
      project.payment.recordedAt = now;
      project.payment.recordedBy = actor._id;
      await project.save({ session });
      result = { alreadyVerified: false, paymentSummary: summary, paymentId: payment._id, amount: payment.amount };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function projectCanUsePlanning(project, booking, schedulingEngine) {
  const units = Number(project.requestedUnitCount || booking?.quantity || project.totalUnits);
  if (!Number.isInteger(units) || units < 1 || units > schedulingEngine.MAX_BOOKING_UNITS) return false;
  // Original server-recorded workload survives a later reduction of repair
  // scope. A project with declined units must not lose its approval flow.
  return schedulingEngine.isLargeProject({ totalUnits: units,
    totalEstimatedMinutes: Number(booking?.serviceDurationMinutes || project.estimatedTotalHours * 60) || 0 });
}

module.exports = { paymentFilter, projectPaymentSnapshot, projectPaymentSummary, syncProjectPayment,
  verifyProjectPayment, projectCanUsePlanning };
