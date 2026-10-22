'use strict';
const OPEN = new Set(['pending', 'under_review']);
const PRE_START = new Set(['pending', 'payment_verified', 'awaiting_assignment', 'pending_reassignment', 'confirmed', 'scheduled', 'assigned', 're-scheduled', 'reschedule-required', 'repair_requested', 'pending_inspection', 'inspection_scheduled', 'ready_for_repair', 'repair_scheduled', 'pending_project_scheduling']);
const RECEIVED = new Set(['verified', 'paid', 'partial', 'remitted', 'payment_collected', 'waiting_for_remittance', 'refunded']);
const INACTIVE_ASSIGNMENTS = ['cancelled', 'completed', 'declined', 'expired', 'no_show'];
const REASONS = Object.freeze({ no_technician: 'No technician assigned', payment_delay: 'Payment verification delayed', schedule_passed: 'Scheduled visit did not happen', plans_changed: 'I no longer need the service', other: 'Another reason' });
const key = value => String(value?._id || value || '');
const open = booking => OPEN.has(booking?.customerCancellation?.status);
function eligible(booking) {
  return Boolean(booking && !booking.archivedAt && !booking.sourceOrderId && !booking.isProject && !booking.maintenance?.isMaintenance && PRE_START.has(booking.status)
    && !booking.inspection?.completedAt
    && !(booking.services || []).some(row => ['en_route', 'arrived', 'in_progress', 'inspection_in_progress', 'repair_in_progress', 'completed', 'inspection_completed', 'diagnosis_completed', 'parts_check', 'awaiting_quotation', 'awaiting_customer_decision', 'payment_pending'].includes(row.status)));
}
function money(booking, payments = []) {
  const received = payments.filter(row => RECEIVED.has(row.status) && Number(row.amount) > 0);
  const pending = payments.filter(row => row.status === 'pending' && Number(row.amount) > 0);
  const receivedAmount = received.reduce((sum, row) => sum + Number(row.amount), 0);
  const refunded = received.reduce((sum, row) => sum + Math.max(0, Number(row.refundAmount) || 0), 0);
  const evidence = Boolean(booking.paymentProof || booking.paymentProofFileId || booking.paymentReference);
  const savedReceived = Math.max(0, Number(booking.amountPaid) || 0);
  const missingLedger = RECEIVED.has(booking.paymentStatus) && received.length === 0;
  return { receivedAmount, refundableAmount: Math.max(0, receivedAmount - refunded), submittedAmount: pending.reduce((sum, row) => sum + Number(row.amount), 0),
    requiresVerification: pending.length > 0 || (!payments.length && evidence && !RECEIVED.has(booking.paymentStatus)),
    hasMoney: received.length > 0 || pending.length > 0 || savedReceived > 0 || missingLedger || (!payments.length && evidence),
    ledgerMismatch: savedReceived > receivedAmount + 0.01 || missingLedger, received };
}
function publicRequest(value) {
  if (!value?.requestId) return null;
  return { requestId: key(value.requestId), revision: value.revision, status: value.status, reasonCode: value.reasonCode, reason: value.reason,
    requestedAt: value.requestedAt, reviewStartedAt: value.reviewStartedAt, decisionNote: value.decisionNote, decidedAt: value.decidedAt,
    history: (value.history || []).map(row => ({ type: row.type, at: row.at, note: row.note })) };
}
function summary(booking, payments = [], assigned = false) {
  const request = publicRequest(booking.customerCancellation), bill = money(booking, payments);
  const canRequest = eligible(booking) && !open(booking);
  const direct = canRequest && !booking.isProject && !booking.technicianId && !booking.assignmentId && !assigned && !bill.hasMoney;
  return { request, hold: open(booking), canRequest, canAppeal: canRequest && request?.status === 'declined', mode: direct ? 'cancel' : 'request',
    payment: { receivedAmount: bill.receivedAmount, submittedAmount: bill.submittedAmount, requiresVerification: bill.requiresVerification, refundableAmount: bill.refundableAmount },
    refund: { status: booking.refundStatus || 'none', amount: Number(booking.refundAmount) || 0, method: booking.refundMethod || '' } };
}
function assertNoHold(booking) {
  if (open(booking)) throw Object.assign(new Error('The customer requested cancellation. Review that request in the Resolution Center before assigning or changing this visit.'), { status: 409, code: 'CUSTOMER_CANCELLATION_PENDING' });
}
function refundProgress(payments) {
  const rows = payments.filter(row => Number(row.refundAmount) > 0 && row.refundStatus !== 'none');
  const amount = rows.reduce((sum, row) => sum + Number(row.refundAmount), 0);
  const completed = rows.filter(row => row.refundStatus === 'completed').reduce((sum, row) => sum + Number(row.refundAmount), 0);
  const received = payments.filter(row => RECEIVED.has(row.status)).reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
  return { refundAmount: amount, refundStatus: !amount ? 'none' : completed >= amount ? 'completed' : completed > 0 || rows.some(row => row.refundStatus === 'processing') ? 'processing' : 'pending',
    ...(amount > 0 && completed >= received && received > 0 ? { paymentStatus: 'refunded' } : {}) };
}
function fields(mongoose) {
  return { customerCancellation: { type: new mongoose.Schema({
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true }, revision: { type: Number, min: 1, default: 1 },
    status: { type: String, enum: ['pending', 'under_review', 'approved', 'declined'], required: true },
    reasonCode: { type: String, enum: Object.keys(REASONS), required: true }, reason: { type: String, required: true, minlength: 10, maxlength: 500 },
    requestedAt: { type: Date, required: true }, reviewStartedAt: Date, reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date, decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, decisionNote: { type: String, maxlength: 1000 },
    history: [{ type: { type: String, enum: ['submitted', 'appealed', 'review_started', 'approved', 'declined'], required: true },
      at: { type: Date, required: true }, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: { type: String, maxlength: 1000 } }],
  }, { _id: false }), default: undefined } };
}
function installHoldGuards(schema) {
  const assigns = update => {
    const set = update?.$set || update || {};
    if (set.status === 'cancelled') return false;
    return ['bookingDate', 'startTime', 'endTime'].some(field => set[field] != null)
      || ['technicianId', 'assignmentId', 'technicianTeam'].some(field => set[field] != null && (!Array.isArray(set[field]) || set[field].length))
      || ['assigned', 'confirmed', 'scheduled', 'inspection_scheduled', 'repair_scheduled', 'on-the-way', 'arrived', 'in-progress', 'repair_in_progress'].includes(set.status);
  };
  schema.pre('save', async function () {
    if (this.isNew) return;
    const update = Object.fromEntries(['bookingDate', 'startTime', 'endTime', 'technicianId', 'assignmentId', 'technicianTeam', 'status']
      .filter(field => this.isModified(field) && (field !== 'technicianTeam' || !this.isDirectModified || this.isDirectModified(field)))
      .map(field => [field, this[field]]));
    if (!assigns(update)) return;
    assertNoHold(this);
    const saved = await this.constructor.findById(this._id).select('customerCancellation').session(this.$session()).lean();
    assertNoHold(saved);
    this.$where = { ...(this.$where || {}), 'customerCancellation.status': { $nin: [...OPEN] } };
  });
  schema.pre(['findOneAndUpdate', 'updateOne'], async function () {
    if (!assigns(this.getUpdate())) return;
    const saved = await this.model.findOne(this.getFilter()).select('customerCancellation').session(this.getOptions().session || null).lean();
    assertNoHold(saved);
    this.setQuery({ $and: [this.getFilter(), { 'customerCancellation.status': { $nin: [...OPEN] } }] });
  });
}
module.exports = { OPEN, PRE_START, RECEIVED, INACTIVE_ASSIGNMENTS, REASONS, key, open, eligible, money, publicRequest, summary, assertNoHold, refundProgress, fields, installHoldGuards };
