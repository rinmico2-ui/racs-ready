'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const policy = require('../utils/resolutionPaymentPolicy');
const id = '507f1f77bcf86cd799439011', actorId = '507f1f77bcf86cd799439012';
const revision = '2030-01-01T08:00:00.000Z';
const booking = () => ({ _id: id, status: 'pending', updatedAt: revision, paymentStatus: 'pending', paymentMethod: 'cash_after_service',
  totalPrice: 1500, amountPaid: 0, balanceAmount: 1500 });

test('unverified, missing and failed payments block case outcomes regardless of an advanced booking or order status', () => {
  for (const source of ['booking', 'order']) for (const status of ['pending', 'unpaid', 'failed', 'rejected', 'refunded', undefined]) {
    const record = { status: source === 'booking' ? 'awaiting_assignment' : 'preparing_unit', paymentStatus: status, paymentMethod: 'gcash' };
    assert.equal(policy.state(record, source).required, true);
    assert.throws(() => policy.assertReady(record, source), error => error.status === 409 && error.code === 'RESOLUTION_PAYMENT_REVIEW_REQUIRED');
    assert.deepEqual(policy.allowedActions(record, source, ['view', 'reschedule', 'reassign', 'recover', 'close', 'cancel', 'call']), ['view', 'call', 'verify_payment']);
  }
});

test('a verified full payment or deposit unlocks resolution without demanding the remaining balance', () => {
  for (const paymentStatus of ['paid', 'partial', 'verified', 'remitted']) {
    const record = { status: 'pending', paymentStatus };
    assert.equal(policy.state(record).required, false);
    assert.doesNotThrow(() => policy.assertReady(record));
  }
  for (const status of ['cancelled', 'completed', 'closed', 'repair_completed', 'rejected']) assert.equal(policy.state({ status }).required, false);
});

test('cash needs an explicit approval tied to the current method and total, with no payment verification timestamp', () => {
  const record = booking();
  assert.equal(policy.state(record).kind, 'cash');
  record.cashPaymentConfirmation = { method: record.paymentMethod, amountDue: 1500, confirmedAt: revision, confirmedBy: actorId };
  assert.equal(policy.state(record).required, false);
  record.totalPrice = 1800; assert.equal(policy.state(record).required, true);
  record.totalPrice = 1500; record.cashPaymentConfirmation.confirmedAt = 'invalid'; assert.equal(policy.state(record).required, true);
  delete record.cashPaymentConfirmation; record.amountPaid = 200; assert.equal(policy.state(record).kind, 'payment');
  assert.equal(policy.state({ ...booking(), paymentMethod: 'cash_onsite', total: 1500 }, 'order').kind, 'cash');
});

function fixture(source = 'booking', failWrite = false) {
  const record = source === 'booking' ? booking() : { ...booking(), paymentMethod: 'cash_onsite', total: 1500, status: 'ready_for_pickup' };
  const writes = [];
  const Model = { findById: () => ({ lean: async () => structuredClone(record) }),
    async findOneAndUpdate(filter, update, options) {
      writes.push({ filter, update, options });
      if (failWrite) return null;
      record.cashPaymentConfirmation = update.$set.cashPaymentConfirmation;
      return structuredClone(record);
    } };
  const service = policy.createService({ model: () => Model, now: () => new Date(revision) });
  return { record, writes, service, input: () => ({ confirmed: true, amountDue: 1500, expectedUpdatedAt: revision }) };
}

test('cash approval changes only its confirmation record, preserves all money/status fields and is idempotent', async () => {
  for (const source of ['booking', 'order']) {
    const f = fixture(source), before = structuredClone(f.record);
    const result = await f.service.confirm(source, id, f.input(), { _id: actorId });
    assert.equal(result.duplicate, false); assert.equal(f.writes.length, 1);
    assert.deepEqual(Object.keys(f.writes[0].update.$set), ['cashPaymentConfirmation']);
    assert.equal(f.writes[0].filter.updatedAt, revision); assert.equal(f.writes[0].options.runValidators, true);
    const { cashPaymentConfirmation, ...unchanged } = f.record;
    assert.deepEqual(unchanged, before);
    assert.equal(cashPaymentConfirmation.confirmedBy, actorId);
    assert.equal(policy.state(f.record, source).required, false);
    assert.equal((await f.service.confirm(source, id, f.input(), { _id: actorId })).duplicate, true);
    assert.equal(f.writes.length, 1);
  }
});

test('missing confirmation, changed terms, closed work and concurrent changes cannot record a cash approval', async () => {
  const f = fixture();
  for (const input of [{ ...f.input(), confirmed: false }, { ...f.input(), amountDue: 100 }, { ...f.input(), expectedUpdatedAt: '2029-01-01' }]) {
    await assert.rejects(f.service.confirm('booking', id, input, { _id: actorId }), error => [400, 409].includes(error.status));
  }
  assert.equal(f.writes.length, 0);
  f.record.status = 'cancelled'; await assert.rejects(f.service.confirm('booking', id, f.input(), { _id: actorId }), /not available/);
  const concurrent = fixture('order', true);
  await assert.rejects(concurrent.service.confirm('order', id, concurrent.input(), { _id: actorId }), /changed/);
});

test('cash controllers audit the approval without creating a payment or changing financial fields', async t => {
  const audit = require('../utils/audit'), Payment = require('../models/Payment');
  const events = [];
  t.mock.method(audit, 'logEvent', async value => { events.push(value); });
  t.mock.method(Payment, 'create', () => assert.fail('Cash confirmation must not create a payment'));
  for (const source of ['booking', 'order']) {
    const Model = require(source === 'order' ? '../models/Order' : '../models/BookingService'), f = fixture(source);
    t.mock.method(Model, 'findById', () => ({ lean: async () => f.record }));
    t.mock.method(Model, 'findOneAndUpdate', async (_filter, update) => { Object.assign(f.record, update.$set); return f.record; });
    const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await require('../controllers/resolutionCashController')[source]({ params: { id }, body: f.input(), user: { _id: actorId } }, res, error => { throw error; });
    assert.equal(res.body.success, true); assert.equal(f.record.paymentStatus, 'pending'); assert.equal(f.record.amountPaid, 0);
    assert.equal(events.at(-1).action, 'resolution.cash_arrangement_confirmed'); assert.equal(events.at(-1).details.amountReceived, 0);
  }
  assert.equal(events.length, 2);
});
