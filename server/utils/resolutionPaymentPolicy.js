'use strict';

const VERIFIED = new Set(['paid', 'partial', 'verified', 'remitted']);
const CLOSED = new Set(['cancelled', 'completed', 'closed', 'repair_completed', 'rejected']);
const normalize = value => String(value || '').trim().toLowerCase();
const amountDue = (record, source) => Math.max(0, Number(source === 'order' ? record.total : record.totalPrice ?? record.estimatedFee ?? record.estimatedTotal) || 0);

function state(record, source = 'booking') {
  if (!record || CLOSED.has(normalize(record.status))) return { required: false };
  const method = normalize(record.paymentMethod);
  const cash = source === 'booking' && method === 'cash_after_service'
    || source === 'order' && method === 'cash_onsite';
  if (VERIFIED.has(normalize(record.paymentStatus))) return { required: false };
  if (source === 'booking' && require('./customerBookingPresentation').isUnpaidAftercareMaintenance(record)) return { required: false };
  if (cash && !(Number(record.amountPaid) > 0)) {
    const saved = record.cashPaymentConfirmation;
    const confirmed = saved?.confirmedAt && Number.isFinite(Number(new Date(saved.confirmedAt))) && saved?.confirmedBy && saved.method === method
      && Number(saved.amountDue) === amountDue(record, source);
    return confirmed ? { required: false } : { required: true, kind: 'cash', actionLabel: 'Confirm cash arrangement',
      reason: 'Confirm the booking and cash-payment arrangement before resolving this case. No advance payment is required.' };
  }
  return { required: true, kind: 'payment', actionLabel: 'Review payment',
    reason: 'Verify the submitted payment before resolving, rescheduling or reassigning this case.' };
}

function assertReady(record, source = 'booking') {
  if (source === 'booking') require('./customerCancellationPolicy').assertNoHold(record);
  const review = state(record, source);
  if (review.required) throw Object.assign(new Error(review.reason), { status: 409, code: 'RESOLUTION_PAYMENT_REVIEW_REQUIRED', paymentReview: review });
}

function allowedActions(record, source, actions) {
  const review = state(record, source);
  if (source === 'booking' && require('./customerCancellationPolicy').open(record)) return ['view', ...actions.filter(action => action === 'call'), 'review_cancellation'];
  return review.required ? [...actions.filter(action => ['view', 'call'].includes(action)), review.kind === 'cash' ? 'confirm_cash' : 'verify_payment'] : actions;
}

function fields(mongoose) {
  return { cashPaymentConfirmation: { type: new mongoose.Schema({
    method: { type: String, enum: ['cash_after_service', 'cash_onsite'], required: true },
    amountDue: { type: Number, min: 0, required: true }, confirmedAt: { type: Date, required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  }, { _id: false }), default: undefined } };
}

function cashSummary(record, source = 'booking') {
  const review = state(record, source);
  return review.required && review.kind === 'cash' ? { method: record.paymentMethod,
    amountDue: amountDue(record, source), expectedUpdatedAt: record.updatedAt } : null;
}

function createService(overrides = {}) {
  const deps = { model: source => require(source === 'order' ? '../models/Order' : '../models/BookingService'),
    now: () => new Date(), ...overrides };
  async function confirm(source, id, input, actor) {
    if (!['booking', 'order'].includes(source) || !require('mongoose').isValidObjectId(id)) throw Object.assign(new Error('Invalid record reference.'), { status: 400 });
    if (input?.confirmed !== true) throw Object.assign(new Error('Confirm the customer and cash-payment arrangement first.'), { status: 400 });
    const Model = deps.model(source), record = await Model.findById(id).lean();
    if (!record) throw Object.assign(new Error('Record not found.'), { status: 404 });
    if (CLOSED.has(normalize(record.status)) || normalize(record.paymentMethod) !== (source === 'order' ? 'cash_onsite' : 'cash_after_service')) {
      throw Object.assign(new Error('This record is not available for cash-arrangement confirmation.'), { status: 409 });
    }
    const review = state(record, source);
    if (!review.required) return { duplicate: true, confirmation: record.cashPaymentConfirmation };
    if (review.kind !== 'cash') throw Object.assign(new Error('This record requires payment verification.'), { status: 409 });
    if (!input.expectedUpdatedAt || !record.updatedAt || Number(new Date(input.expectedUpdatedAt)) !== Number(new Date(record.updatedAt))
      || input.amountDue == null || Number(input.amountDue) !== amountDue(record, source)) {
      throw Object.assign(new Error('The booking or payment terms changed. Reload the review before confirming.'), { status: 409 });
    }
    const confirmation = { method: record.paymentMethod, amountDue: amountDue(record, source), confirmedAt: deps.now(), confirmedBy: actor._id };
    const saved = await Model.findOneAndUpdate({ _id: record._id, updatedAt: record.updatedAt,
      status: record.status, paymentMethod: record.paymentMethod, paymentStatus: record.paymentStatus },
    { $set: { cashPaymentConfirmation: confirmation } }, { returnDocument: 'after', runValidators: true });
    if (!saved) throw Object.assign(new Error('This record changed. Reload the review before confirming.'), { status: 409 });
    return { duplicate: false, confirmation };
  }
  return { confirm };
}

module.exports = { state, assertReady, allowedActions, fields, amountDue, cashSummary, createService };
