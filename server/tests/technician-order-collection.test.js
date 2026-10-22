'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Order = require('../models/Order'), Payment = require('../models/Payment'), Technician = require('../models/Technician');
const routes = require('../routes/orderRoutes');
const route = path => routes.stack.find(layer => layer.route?.path === path).route;
const collect = route('/:id/collect-payment').stack.at(-1).handle;
const summary = route('/:id/collection-summary').stack.at(-1).handle;
const id = '507f1f77bcf86cd799439011', techId = '507f1f77bcf86cd799439012', userId = '507f1f77bcf86cd799439013';
const query = value => ({ select() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function fixture(t, options = {}) {
  const writes = [], published = [], payments = [];
  const order = { _id: id, __v: 4, technicianId: techId, status: 'installing', total: 6000, balanceAmount: 5000,
    paymentMethod: 'cash', paymentStatus: 'partial', orderReference: 'TEST-ORDER', customer: { name: 'Test Customer', email: 'private@example.test' }, ...options.order };
  t.mock.method(Order, 'findById', () => query(options.missing ? null : order));
  t.mock.method(Technician, 'findOne', () => query(options.foreign ? { _id: userId } : { _id: techId, name: 'Test Technician' }));
  t.mock.method(Payment, 'find', filter => { assert.equal(String(filter.orderId), id); return query(options.ledger || []); });
  t.mock.method(Payment.prototype, 'save', async function () {
    if (options.failPayment) throw Error('Payment write failed');
    payments.push(this.toObject()); return this;
  });
  t.mock.method(Order, 'findOneAndUpdate', async (filter, update) => {
    writes.push({ filter, update });
    if (options.conflict) return null;
    return { ...order, ...update.$set, pushStatus() {}, async save() {} };
  });
  t.mock.method(Order, 'updateOne', async (filter, update) => { writes.push({ rollback: true, filter, update }); });
  const request = body => ({ params: { id }, user: { _id: userId, role: 'technician' }, body,
    app: { get: () => ({ to: room => ({ emit: (name, data) => published.push({ room, name, data }) }) }) } });
  const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  return { order, writes, payments, published,
    async collect(body = {}) { const res = response(); await collect(request({ amount: 5000, method: 'cash', cashReceivedConfirmed: true, ...body }), res); return res; },
    async summary() { const res = response(); await summary(request(), res); return res; } };
}

test('cash order collection needs no signature or receipt and records who confirmed receipt for admin remittance', async t => {
  const f = fixture(t), result = await f.collect({ notes: 'Counted with the customer.' });
  assert.equal(result.statusCode, 201); assert.equal(result.body.balanceAmount, 0);
  const payment = f.payments[0];
  assert.equal(payment.amount, 5000); assert.equal(payment.status, 'waiting_for_remittance');
  assert.equal(payment.customerSignature, undefined); assert.equal(payment.proofUrl, undefined);
  assert.equal(String(payment.collectedBy), techId); assert.equal(payment.collectedByName, 'Test Technician');
  assert.equal(payment.events[0].metadata.cashReceivedConfirmed, true); assert.equal(payment.events[0].metadata.amount, 5000);
  assert.equal(String(payment.events[0].actor), userId); assert.equal(payment.events[0].at.getTime(), payment.collectedAt.getTime());
  assert.equal(payment.notes, 'Counted with the customer.'); assert.equal(payment.verifiedAt, undefined);
  assert.equal(f.writes[0].update.$set.paymentStatus, 'waiting_for_remittance');
  assert.ok(f.published.some(event => event.room === 'admin-room' && event.data.paymentCollected === true));
});

test('cash requires a real acknowledgment even when legacy proof or a signature is provided', async t => {
  const f = fixture(t);
  for (const cashReceivedConfirmed of [undefined, false, 'true', 1]) {
    const res = await f.collect({ cashReceivedConfirmed, customerSignature: 'Customer', proofUrl: '/receipt.png' });
    assert.equal(res.statusCode, 400); assert.match(res.body.error, /Confirm that you received/);
  }
  assert.equal(f.payments.length, 0); assert.equal(f.writes.length, 0);
});

test('new collections ignore legacy evidence fields and exclude old transfer references from cash', async t => {
  const f = fixture(t), res = await f.collect({ proofUrl: '/cash-receipt.png', customerSignature: 'Customer', customerPhotoUrl: '/customer.png', reference: 'OLD-TRANSFER' });
  assert.equal(res.statusCode, 201); assert.equal(f.payments[0].proofUrl, undefined);
  assert.equal(f.payments[0].customerSignature, undefined); assert.equal(f.payments[0].customerPhotoUrl, undefined);
  assert.equal(f.payments[0].reference, undefined);
});

for (const method of ['gcash', 'bank']) {
  test(method + ' collects with only a transfer reference and no uploaded evidence', async t => {
    const f = fixture(t);
    for (const body of [{ reference: '' }, { reference: '   ' }, { reference: {} }, { reference: 123 }, { reference: undefined }]) {
      assert.equal((await f.collect({ method, cashReceivedConfirmed: false, ...body })).statusCode, 400);
    }
    assert.equal(f.writes.length, 0);
    assert.equal((await f.collect({ method, cashReceivedConfirmed: false, reference: ' REF-123 ' })).statusCode, 201);
    const payment = f.payments[0];
    assert.equal(payment.reference, 'REF-123'); assert.equal(payment.method, method); assert.equal(payment.customerSignature, undefined);
    assert.equal(payment.proofUrl, undefined); assert.equal(payment.customerPhotoUrl, undefined);
    assert.equal(payment.events[0].metadata.cashReceivedConfirmed, undefined); assert.equal(payment.status, 'waiting_for_remittance');
  });
}

test('partial or excessive collection and unsupported methods cannot claim the order balance', async t => {
  const f = fixture(t);
  for (const body of [{ amount: 100 }, { amount: 6000 }, { amount: 'bad' }, { method: 'other' }]) {
    assert.equal((await f.collect(body)).statusCode, 400);
  }
  assert.equal(f.writes.length, 0); assert.equal(f.payments.length, 0);
});

test('collection is limited to the primary technician at handover, including its balance summary', async t => {
  for (const [options, status] of [[{ missing: true }, 404], [{ foreign: true }, 403],
    [{ order: { status: 'out_for_delivery' } }, 400], [{ order: { status: 'cancelled' } }, 400], [{ order: { isProject: true } }, 409]]) {
    await t.test(JSON.stringify(options), async t => {
      const f = fixture(t, options);
      assert.equal((await f.collect()).statusCode, status); assert.equal((await f.summary()).statusCode, status);
      assert.equal(f.payments.length, 0); assert.equal(f.writes.length, 0);
    });
  }
});

test('the private collection summary reads the ledger and returns only the remaining bill', async t => {
  const f = fixture(t, { ledger: [{ amount: 1000 }] }), res = await f.summary();
  assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.total, 6000); assert.equal(res.body.amountPaid, 2000); assert.equal(res.body.balanceDue, 4000);
  assert.equal(res.body.customerName, 'Test Customer'); assert.equal(res.body.customer, undefined); assert.equal(res.body.paymentId, undefined);
  assert.equal(f.writes.length, 0);
});

test('a recorded final collection cannot collect money again even with a stale positive stored balance', async t => {
  const f = fixture(t, { ledger: [{ amount: 5000 }] });
  assert.equal((await f.summary()).body.balanceDue, 0); assert.equal((await f.collect()).statusCode, 409);
  assert.equal(f.writes.length, 0); assert.equal(f.payments.length, 0);
});

test('a concurrent payment, cancellation or reassignment fails the balance claim without creating a receipt', async t => {
  const f = fixture(t, { conflict: true }), res = await f.collect();
  assert.equal(res.statusCode, 409); assert.equal(f.payments.length, 0);
  const filter = f.writes[0].filter;
  assert.equal(filter.__v, 4); assert.equal(filter.balanceAmount, 5000); assert.equal(String(filter.technicianId), techId); assert.equal(filter.status, 'installing');
});

test('a failed receipt save restores the claimed balance and leaves no success notification', async t => {
  const f = fixture(t, { failPayment: true }), res = await f.collect();
  assert.equal(res.statusCode, 500); assert.equal(f.payments.length, 0); assert.equal(f.published.length, 0);
  assert.equal(f.writes[1].rollback, true); assert.equal(f.writes[1].update.$set.balanceAmount, 5000);
  assert.equal(f.writes[1].update.$set.paymentStatus, 'partial');
});
