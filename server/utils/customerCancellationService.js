'use strict';
const policy = require('./customerCancellationPolicy');
const fail = (message, status = 409, code) => Object.assign(new Error(message), { status, code });
function text(value, label, min = 10, max = 1000) {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (result.length < min || result.length > max) throw fail(`${label} must contain ${min} to ${max.toLocaleString('en-US')} characters.`, 400);
  return result;
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Payment: require('../models/Payment'), Assignment: require('../models/Assignment'),
    lock: require('./operationLock').withOperationLock, now: () => new Date(),
    reopen: (...args) => require('./maintenanceLifecycle').reopenScheduleAfterBookingCancellation(...args), ...overrides };
  function valid(id) { if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid booking reference.', 400); }
  async function load(id, actor, session) {
    valid(id);
    const booking = await deps.Booking.findById(id).select('+paymentProofFileId').session(session || null);
    if (!booking || actor.role === 'customer' && policy.key(booking.customerId) !== policy.key(actor._id)) throw fail('Booking not found.', 404);
    if (!['customer', 'admin', 'secretary'].includes(actor.role)) throw fail('Access denied.', 403);
    return booking;
  }
  async function payments(booking, session) { return deps.Payment.find({ bookingId: booking._id }).session(session || null); }
  async function assertNotStarted(booking, session) {
    const started = await deps.Assignment.exists({ bookingId: booking._id,
      status: { $in: ['en_route', 'on_site', 'in_progress', 'waiting_for_customer', 'no_show_reported'] } }).session(session || null);
    if (started) throw fail('The technician has already started this visit. Contact staff for help with this booking.');
  }
  async function read(id, actor) {
    const booking = await load(id, actor);
    const rows = await payments(booking);
    const assigned = await deps.Assignment.exists({ bookingId: booking._id, status: { $nin: policy.INACTIVE_ASSIGNMENTS } });
    const result = { bookingId: policy.key(booking), reference: booking.bookingReference || '', bookingStatus: booking.status, ...policy.summary(booking, rows, Boolean(assigned)) };
    if (actor.role !== 'customer') result.evidence = rows.map(row => ({ id: policy.key(row), amount: row.amount, status: row.status, method: row.method, reference: row.reference,
      proofUrl: row.proofUrl || (booking.paymentProofFileId ? `/api/appointments/${booking._id}/payment-proof` : booking.paymentProof) || null, submittedAt: row.submittedAt }));
    return result;
  }
  async function transact(id, actor, work) {
    const initial = await load(id, actor);
    const date = initial.bookingDate || initial.preferredDate;
    const lockKey = date ? require('./operationLock').bookingCapacityLockKey(date) : `booking-cancellation:${id}`;
    return deps.lock(lockKey, async () => {
      const session = await deps.mongoose.startSession(); let result;
      try {
        await session.withTransaction(async () => {
          const booking = await load(id, actor, session);
          if (date && String(require('./bookingDateTime').manilaDateKey(booking.bookingDate || booking.preferredDate)) !== require('./bookingDateTime').manilaDateKey(date)) throw fail('The appointment changed. Refresh before submitting.');
          result = await work(booking, session);
        }, { timeoutMS: 15000 });
        return result;
      } finally { await session.endSession(); }
    });
  }
  async function submit(id, actor, input = {}) {
    if (actor.role !== 'customer') throw fail('Only the booking customer can submit this request.', 403);
    if (!Object.hasOwn(policy.REASONS, input.reasonCode)) throw fail('Choose a cancellation reason.', 400);
    const reason = text(input.reason, 'Your reason', 10, 500);
    return transact(id, actor, async (booking, session) => {
      if (booking.status === 'cancelled') return { booking, cancelled: true, duplicate: true };
      if (policy.open(booking)) return { booking, cancelled: false, duplicate: true };
      if (!policy.eligible(booking)) throw fail('This visit has started or closed. Contact staff for help with this booking.');
      await assertNotStarted(booking, session);
      const prior = booking.customerCancellation;
      if (prior?.status === 'declined' && (input.appeal !== true || String(input.requestId) !== policy.key(prior.requestId) || Number(input.revision) !== prior.revision)) throw fail('Open the latest decision and choose Ask for Review.');
      const ledger = await payments(booking, session);
      const assigned = await deps.Assignment.exists({ bookingId: booking._id, status: { $nin: policy.INACTIVE_ASSIGNMENTS } }).session(session);
      const state = policy.summary(booking, ledger, Boolean(assigned));
      const now = deps.now(), appeal = prior?.status === 'declined';
      const history = [...(prior?.history || []).map(row => row.toObject?.() || row)];
      if (history.length >= 50) throw fail('This case has a long review history. Contact staff using your booking reference.');
      history.push({ type: appeal ? 'appealed' : 'submitted', at: now, actor: actor._id, note: reason });
      booking.customerCancellation = { requestId: prior?.requestId || new deps.mongoose.Types.ObjectId(), revision: Number(prior?.revision || 0) + 1,
        status: state.mode === 'cancel' ? 'approved' : 'pending', reasonCode: input.reasonCode, reason, requestedAt: now, history };
      let cancelled = false;
      if (state.mode === 'cancel') {
        const note = 'Cancelled before technician assignment. No payment was submitted or received.';
        Object.assign(booking.customerCancellation, { decidedAt: now, decidedBy: actor._id, decisionNote: note });
        booking.customerCancellation.history.push({ type: 'approved', at: now, actor: actor._id, note });
        require('./bookingLifecycle').cancelBookingRecord(booking, { actorId: actor._id, actorName: actor.name || 'Customer', reason, at: now });
        await deps.reopen(booking, { session, actorId: actor._id, actorName: 'Customer' });
        cancelled = true;
      }
      await booking.save({ session });
      return { booking, cancelled, duplicate: false };
    });
  }
  async function decide(id, actor, input = {}) {
    if (!['admin', 'secretary'].includes(actor.role)) throw fail('Staff access required.', 403);
    if (!['review', 'decline', 'approve'].includes(input.action)) throw fail('Choose a review action.', 400);
    const note = input.action === 'review' ? '' : text(input.note, 'The customer-facing decision');
    return transact(id, actor, async (booking, session) => {
      const request = booking.customerCancellation;
      if (!request || policy.key(request.requestId) !== String(input.requestId) || request.revision !== Number(input.revision)) throw fail('This request changed. Reload the latest customer request.');
      if (!policy.open(booking)) {
        if (request.status === (input.action === 'approve' ? 'approved' : input.action === 'decline' ? 'declined' : 'under_review')) return { booking, duplicate: true };
        throw fail('This request has already been decided.');
      }
      if (input.action === 'review' && request.status === 'under_review') return { booking, duplicate: true };
      if (!policy.eligible(booking)) throw fail('This booking changed or work has started. Refresh and review the current visit.');
      await assertNotStarted(booking, session);
      const now = deps.now();
      if (input.action === 'review') {
        request.status = 'under_review'; request.reviewStartedAt = now; request.reviewedBy = actor._id;
        request.history.push({ type: 'review_started', at: now, actor: actor._id, note: 'Staff started reviewing your request.' });
      } else {
        if (input.action === 'approve') {
          const ledger = await payments(booking, session), bill = policy.money(booking, ledger);
          if (bill.requiresVerification) throw fail('Review the submitted payment before approving cancellation or a refund.', 409, 'CANCELLATION_PAYMENT_REVIEW_REQUIRED');
          if (bill.ledgerMismatch) throw fail('The saved paid amount does not match the payment ledger. Reconcile the payment before approving cancellation.');
          if (!['full', 'partial', 'none'].includes(input.refundDecision)) throw fail('Choose a refund decision.', 400);
          if (!['original', 'cash', 'gcash', 'bank', undefined].includes(input.refundMethod)) throw fail('Choose a valid refund method.', 400);
          let remaining = input.refundDecision === 'full' ? bill.refundableAmount : input.refundDecision === 'partial' ? Number(input.refundAmount) : 0;
          if (input.refundDecision !== 'none' && (!Number.isFinite(remaining) || remaining <= 0 || remaining > bill.refundableAmount || Math.abs(remaining * 100 - Math.round(remaining * 100)) > 0.00001)) throw fail('Enter a refund amount within the received payment balance, using at most two decimal places.', 400);
          const requestedRefund = remaining;
          for (const payment of bill.received) {
            if (remaining <= 0) break;
            const available = Math.max(0, Number(payment.amount) - (Number(payment.refundAmount) || 0));
            const amount = Math.min(available, remaining);
            if (amount <= 0) continue;
            if (payment.refundStatus && payment.refundStatus !== 'none' && Number(payment.refundAmount) > 0) throw fail('A refund is already being handled on this payment. Review its current refund first.');
            payment.refundAmount = amount; payment.refundStatus = 'pending'; payment.refundMethod = input.refundMethod || 'original'; payment.refundReason = note;
            payment.events ||= []; payment.events.push({ status: 'refund_pending', actor: actor._id, actorName: actor.name || 'Staff', actorRole: actor.role, at: now, note });
            await payment.save({ session }); remaining = Math.round((remaining - amount) * 100) / 100;
          }
          if (requestedRefund > 0) { booking.refundStatus = 'pending'; booking.refundAmount = requestedRefund; booking.refundMethod = input.refundMethod || 'original'; booking.refundNotes = note; }
          require('./bookingLifecycle').cancelBookingRecord(booking, { actorId: actor._id, actorName: actor.name || 'Staff', reason: request.reason, at: now });
          await deps.Assignment.updateMany({ bookingId: booking._id, status: { $nin: policy.INACTIVE_ASSIGNMENTS } }, { $set: { status: 'cancelled', cancelledAt: now } }, { session });
          booking.technicianId = null; booking.technician = undefined; booking.assignmentId = null;
          await deps.reopen(booking, { session, actorId: actor._id, actorName: actor.name || 'Staff' });
        }
        request.status = input.action === 'approve' ? 'approved' : 'declined';
        request.decisionNote = note; request.decidedAt = now; request.decidedBy = actor._id;
        request.history.push({ type: request.status, at: now, actor: actor._id, note });
      }
      await booking.save({ session });
      return { booking, duplicate: false, cancelled: input.action === 'approve' };
    });
  }
  return { read, submit, decide };
}
async function attachSummaries(bookings, overrides = {}) {
  const candidates = bookings.filter(booking => policy.eligible(booking) || booking.customerCancellation);
  if (!candidates.length) return bookings;
  const Payment = overrides.Payment || require('../models/Payment');
  const Assignment = overrides.Assignment || require('../models/Assignment');
  const ids = candidates.map(booking => booking._id);
  const [payments, assigned] = await Promise.all([
    Payment.find({ bookingId: { $in: ids } }).select('bookingId amount status refundAmount refundStatus').lean(),
    Assignment.distinct('bookingId', { bookingId: { $in: ids }, status: { $nin: policy.INACTIVE_ASSIGNMENTS } }),
  ]);
  const assignedIds = new Set(assigned.map(policy.key));
  return bookings.map(booking => ({ ...booking, cancellation: policy.summary(booking,
    payments.filter(row => policy.key(row.bookingId) === policy.key(booking)), assignedIds.has(policy.key(booking))) }));
}
module.exports = { createService, text, attachSummaries };
