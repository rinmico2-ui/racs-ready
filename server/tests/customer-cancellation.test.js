'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const mongoose = require('mongoose');
const policy = require('../utils/customerCancellationPolicy');
const { fixture, id } = require('./helpers/customer-cancellation-fixture');
const received = amount => ({ _id: id(10), bookingId: id(3), amount, status: 'paid', method: 'gcash', events: [] });
function setup(t, options) { const f = fixture(options); t.after(f.dispose); return f; }

test('unpaid, unassigned booking cancels immediately, retains service history and is idempotent', async t => {
  const f = setup(t), result = await f.submit();
  assert.equal(result.cancelled, true); assert.equal(f.store.booking.status, 'cancelled');
  assert.equal(f.store.booking.services[0].status, 'cancelled'); assert.equal(f.store.booking.customerCancellation.status, 'approved');
  assert.equal(f.store.reopened, 1); assert.equal(f.store.booking.amountPaid, 0);
  assert.equal((await f.submit()).duplicate, true); assert.equal(f.store.reopened, 1);
});
test('a submitted unverified payment opens a held request without pretending money was received', async t => {
  const f = setup(t, { payments: [{ ...received(250), status: 'pending', reference: 'SAVED-RECEIPT' }] });
  const result = await f.submit(); assert.equal(result.cancelled, false); assert.equal(f.store.booking.status, 'pending');
  const summary = await f.service.read(f.bookingId, f.customer);
  assert.equal(summary.hold, true); assert.equal(summary.payment.receivedAmount, 0); assert.equal(summary.payment.submittedAmount, 250);
  assert.equal(summary.evidence, undefined); assert.equal((await f.submit()).duplicate, true);
  await assert.rejects(f.decide(), error => error.code === 'CANCELLATION_PAYMENT_REVIEW_REQUIRED');
  assert.equal(f.store.payments[0].refundStatus, undefined); assert.equal(f.store.booking.customerCancellation.history.length, 1);
});
test('verified money is reviewed, then refunds across all payments stay pending and duplicate approval is safe', async t => {
  const f = setup(t, { booking: { amountPaid: 1000, paymentStatus: 'paid' }, payments: [received(250), { ...received(750), _id: id(11) }] });
  await f.submit(); await f.decide({ action: 'review' }); assert.equal(f.store.booking.customerCancellation.status, 'under_review');
  await f.decide({ refundDecision: 'full', refundMethod: 'gcash' });
  assert.equal(f.store.booking.status, 'cancelled'); assert.equal(f.store.booking.refundAmount, 1000);
  assert.equal(f.store.booking.refundStatus, 'pending'); assert.equal(f.store.booking.paymentStatus, 'paid');
  assert.deepEqual(f.store.payments.map(row => row.refundAmount), [250, 750]);
  assert.ok(f.store.payments.every(row => row.refundStatus === 'pending' && row.status === 'paid' && !row.refundedAt));
  assert.equal((await f.decide({ refundDecision: 'full' })).duplicate, true);
  assert.ok(f.store.payments.every(row => row.events.length === 1));
});
test('cash-after-service with a team needs staff approval but no fabricated payment verification or refund', async t => {
  const f = setup(t, { booking: { status: 'assigned', technicianId: id(8), assignmentId: id(9) }, assignments: [{ _id: id(9), status: 'accepted' }, { _id: id(12), status: 'pending_acceptance' }] });
  assert.equal((await f.submit()).cancelled, false); await f.decide();
  assert.ok(f.store.assignments.every(row => row.status === 'cancelled'));
  assert.equal(f.store.booking.technicianId, null); assert.equal(f.store.booking.assignmentId, null);
  assert.equal(f.store.booking.amountPaid, 0); assert.equal(f.store.booking.paymentStatus, 'pending'); assert.equal(f.store.payments.length, 0);
});
test('decline is explained to customer; appeal reuses the same case and stale decisions cannot overwrite it', async t => {
  const f = setup(t, { payments: [received(250)] }); await f.submit();
  await assert.rejects(f.decide({ action: 'decline', note: 'No' }), error => error.status === 400);
  await f.decide({ action: 'decline', note: 'Your appointment is still confirmed. Please tell us if a different date would help.' });
  const previous = { ...f.store.booking.customerCancellation };
  assert.equal((await f.service.read(f.bookingId, f.customer)).canAppeal, true);
  await assert.rejects(f.submit(), /Ask for Review/);
  await f.submit({ appeal: true, requestId: previous.requestId, revision: previous.revision, reason: 'I still need cancellation because I will no longer be at the address.' });
  assert.equal(f.store.booking.customerCancellation.requestId, previous.requestId);
  assert.equal(f.store.booking.customerCancellation.revision, 2); assert.equal(f.store.booking.customerCancellation.status, 'pending');
  assert.deepEqual(f.store.booking.customerCancellation.history.map(row => row.type), ['submitted', 'declined', 'appealed']);
  await assert.rejects(f.decide({ requestId: previous.requestId, revision: previous.revision }), /request changed/);
});
test('ownership, roles, invalid reasons, started visits and closed records are enforced server-side', async t => {
  const f = setup(t);
  await assert.rejects(f.service.read(f.bookingId, { ...f.customer, _id: id(99) }), error => error.status === 404);
  await assert.rejects(f.service.submit(f.bookingId, f.admin, f.input), error => error.status === 403);
  await assert.rejects(f.service.decide(f.bookingId, f.customer, {}), error => error.status === 403);
  await assert.rejects(f.submit({ reasonCode: 'fake' }), error => error.status === 400);
  await assert.rejects(f.submit({ reason: 'short' }), error => error.status === 400);
  await assert.rejects(f.submit({ reason: 'x'.repeat(501) }), error => error.status === 400);
  for (const state of ['on-the-way', 'in-progress', 'completed', 'closed']) {
    f.store.booking.status = state; await assert.rejects(f.submit(), /started or closed/);
  }
  f.store.booking.status = 'assigned'; f.store.assignments.push({ status: 'en_route' });
  await assert.rejects(f.submit(), /technician has already started/);
  assert.equal(f.store.booking.customerCancellation, undefined);
  assert.equal(policy.eligible({ status: 'inspection_scheduled', services: [{ type: 'core', status: 'completed' }, { type: 'repair', status: 'inspection_scheduled' }] }), false);
  assert.equal(policy.eligible({ status: 'repair_scheduled', inspection: { completedAt: new Date() } }), false);
});
test('refund amounts are bounded, reconcile against received ledger, and never count expected deposits', async t => {
  const f = setup(t, { booking: { amountPaid: 300 }, payments: [received(300)] }); await f.submit();
  for (const amount of [0, -1, 301, 'bad', 10.001]) await assert.rejects(f.decide({ refundDecision: 'partial', refundAmount: amount }), error => error.status === 400);
  f.store.booking.amountPaid = 500; await assert.rejects(f.decide(), /does not match/); f.store.booking.amountPaid = 300;
  await f.decide({ refundDecision: 'partial', refundAmount: 125.50 }); assert.equal(f.store.payments[0].refundAmount, 125.5);
  assert.equal(policy.money({ downpaymentAmount: 5000, amountPaid: 0 }, []).hasMoney, false);
});
test('midway failure rolls back payment, booking, assignment and history; transient conflicts retry the whole transaction', async t => {
  const f = setup(t, { booking: { amountPaid: 300 }, payments: [received(300)], failWrite: 3 }); await f.submit();
  await assert.rejects(f.decide({ refundDecision: 'full' }), /persistence failure/);
  assert.equal(f.store.payments[0].refundStatus, undefined); assert.equal(f.store.booking.status, 'pending');
  assert.equal(f.store.booking.customerCancellation.status, 'pending'); assert.equal(f.store.reopened, 0);
  const retry = setup(t, { conflict: true }); await retry.submit();
  assert.equal(retry.store.booking.status, 'cancelled'); assert.equal(retry.store.reopened, 1);
  assert.deepEqual(retry.store.booking.customerCancellation.history.map(row => row.type), ['submitted', 'approved']);
  assert.ok(retry.events.includes('abort'));
});
test('a schedule or assignment changed while waiting is reread under the same assignment date lease', async t => {
  const changed = setup(t, { insideLock: store => { store.booking.bookingDate = '2099-01-02'; } });
  await assert.rejects(changed.submit(), /appointment changed/); assert.equal(changed.store.booking.customerCancellation, undefined);
  const assigned = setup(t, { insideLock: store => { store.booking.technicianId = id(8); store.assignments.push({ status: 'accepted' }); } });
  assert.equal((await assigned.submit()).cancelled, false); assert.equal(assigned.store.booking.status, 'pending');
  assert.ok(assigned.events.some(event => event.startsWith('booking-capacity:')));
});
test('refunded and rejected legacy payments do not create a second refund or require an obsolete rejected receipt', () => {
  assert.equal(policy.money({ paymentProof: 'old' }, [{ ...received(100), status: 'rejected' }]).hasMoney, false);
  const bill = policy.money({ amountPaid: 100 }, [{ ...received(100), status: 'refunded', refundAmount: 100, refundStatus: 'completed' }]);
  assert.equal(bill.refundableAmount, 0); assert.equal(bill.ledgerMismatch, false);
});
test('request presentation hides staff actors while exposing decision, history and safe refund progress', async t => {
  const f = setup(t, { payments: [received(300)] }); await f.submit(); await f.decide({ action: 'review' });
  const customer = await f.service.read(f.bookingId, f.customer), staff = await f.service.read(f.bookingId, f.admin);
  assert.ok(staff.evidence.length); assert.equal(customer.evidence, undefined);
  assert.equal(customer.request.reviewedBy, undefined); assert.ok(customer.request.history.every(row => !row.actor));
  const presented = require('../utils/customerBookingPresentation').presentCustomerBooking({ ...f.store.booking, cancellation: customer });
  assert.equal(presented.customerCancellation, undefined); assert.equal(presented.bookingEditPolicy.canEdit, false);
  assert.equal(require('../utils/bookingServiceItems').mutationPolicy(f.store.booking).mode, 'locked');
  const technician = require('../utils/technicianDataPresentation').presentTechnicianBooking(f.store.booking);
  assert.equal(technician.customerCancellationPending, true); assert.equal(technician.customerCancellation, undefined);
});
test('pending requests block assignment and generic resolution but still allow dedicated payment review', () => {
  const booking = { status: 'pending', customerCancellation: { status: 'pending' }, paymentStatus: 'pending', paymentMethod: 'cash_after_service' };
  assert.throws(() => policy.assertNoHold(booking), error => error.code === 'CUSTOMER_CANCELLATION_PENDING');
  const resolution = require('../utils/resolutionPaymentPolicy');
  assert.deepEqual(resolution.allowedActions(booking, 'booking', ['view', 'call', 'reassign', 'close']), ['view', 'call', 'review_cancellation']);
  assert.throws(() => resolution.assertReady(booking), error => error.code === 'CUSTOMER_CANCELLATION_PENDING');
  assert.deepEqual(require('../utils/resolutionCenter').bookingOverviewScheduleResolution(booking), { required: true, issueType: 'customer_cancellation' });
});
test('model guards stop stale document saves and include the hold in the atomic MongoDB predicate', async () => {
  const schema = new mongoose.Schema({}); policy.installHoldGuards(schema);
  const query = value => ({ select() { return this; }, session() { return this; }, lean: async () => value });
  const doc = { _id: id(3), isNew: false, status: 'assigned', isModified: name => name === 'status', $session: () => null,
    constructor: { findById: () => query({ customerCancellation: { status: 'pending' } }) } };
  await assert.rejects(schema.s.hooks.execPre('save', doc, []), /customer requested cancellation/);
  doc.constructor.findById = () => query({}); await schema.s.hooks.execPre('save', doc, []);
  assert.deepEqual(doc.$where['customerCancellation.status'].$nin, ['pending', 'under_review']);
  let filter;
  await schema.s.hooks.execPre('findOneAndUpdate', { getUpdate: () => ({ $set: { technicianId: id(9) } }), getFilter: () => ({ _id: id(3) }), getOptions: () => ({}), model: { findOne: () => query({}) }, setQuery: value => { filter = value; } }, []);
  assert.deepEqual(filter.$and[1]['customerCancellation.status'].$nin, ['pending', 'under_review']);
});
test('completing one payment refund keeps the booking pending until all approved refunds are actually paid', () => {
  const rows = [{ ...received(250), status: 'refunded', refundStatus: 'completed', refundAmount: 250 }, { ...received(750), refundStatus: 'pending', refundAmount: 750 }];
  assert.deepEqual(policy.refundProgress(rows), { refundAmount: 1000, refundStatus: 'processing' });
  rows[1].status = 'refunded'; rows[1].refundStatus = 'completed';
  assert.deepEqual(policy.refundProgress(rows), { refundAmount: 1000, refundStatus: 'completed', paymentStatus: 'refunded' });
});
test('post-commit notification failure cannot roll back a cancellation or skip inventory and audit follow-ups', async () => {
  const trace = [], f = fixture(), booking = { _id: id(3), customerId: id(1), bookingReference: 'DEMO', cancellationReason: 'Customer no longer available.', customerCancellation: { requestId: id(4), revision: 1, status: 'approved', decisionNote: 'Cancelled as requested.' } };
  const source = fs.readFileSync(require.resolve('../controllers/customerCancellationController'), 'utf8');
  const context = { module: { exports: {} }, console: { warn() {}, error() {} }, require(name) {
    if (name.endsWith('customerCancellationPolicy')) return policy;
    if (name.endsWith('customerCancellationService')) return { createService: () => ({ submit: async () => ({ booking, cancelled: true }) }) };
    if (name.endsWith('/notify')) return { createNotification: async () => { trace.push('notification'); throw Error('Notification unavailable'); } };
    if (name.endsWith('equipmentAssignmentLifecycle')) return { releaseReservedEquipment: async () => trace.push('inventory') };
    if (name.endsWith('technicianWorkSync')) return { publishBookingWorkUpdate: async () => trace.push('sync') };
    if (name.endsWith('/audit')) return { logEvent: async () => trace.push('audit') };
    throw Error(name);
  } };
  vm.runInNewContext(source, context);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try { await context.module.exports.submit({ params: { id: id(3) }, user: f.customer, body: {}, app: { get() {} } }, res); }
  finally { await f.dispose(); }
  assert.equal(res.code, 201); assert.equal(res.body.cancelled, true); assert.deepEqual(trace.sort(), ['audit', 'inventory', 'notification', 'sync']);
});
