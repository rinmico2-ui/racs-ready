const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhotos } = require('../public/js/resolution-evidence');
const { bookingPhotos, orderPhotos } = require('../utils/operationsDetail');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const routes = require('../routes/orderRoutes');
const id = '507f1f77bcf86cd799439011';

test('photo previews accept receipt images and protected URLs, deduplicate them, and reject executable sources', () => {
  const photos = normalizePhotos([
    { src: '/api/orders/order/payment-proof', label: 'Payment receipt' },
    { src: 'https://res.cloudinary.com/account/image/upload/receipt.jpg', label: '<unsafe label>' },
    { src: 'data:image/png;base64,aGVsbG8=', label: 'Receipt' },
    { src: '/api/orders/order/payment-proof', label: 'Duplicate' },
    { src: 'javascript:alert(1)' }, { src: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { src: 'https://username:password@example.test/photo.jpg' }, null, { src: {} },
  ], 'http://localhost:5000/admin/operations/resolution-center');
  assert.equal(photos.length, 3);
  assert.equal(photos[1].label, '<unsafe label>'); // Rendered with textContent, never HTML.
  assert.deepEqual(normalizePhotos(null, 'http://localhost:5000'), []);
});

test('booking evidence includes stored receipts, arrival and no-show proofs, and payment-ledger photos', () => {
  const photos = bookingPhotos({ _id: id, paymentProofFileId: 'file-id', noShowReport: { arrivalProofUrl: '/arrival.jpg' } },
    { arrivalProofUrl: '/arrival.jpg' }, [{ proofUrl: `/api/appointments/${id}/payment-proof`, refundProofUrl: '/refund.jpg' }]);
  assert.deepEqual(photos, [
    { src: `/api/appointments/${id}/payment-proof`, label: 'Customer Payment Proof' },
    { src: '/arrival.jpg', label: 'Arrival Proof' }, { src: '/refund.jpg', label: 'Refund Proof' },
  ]);
});

test('order evidence uses its protected stored receipt and includes legacy and collected-payment receipts once', () => {
  assert.deepEqual(orderPhotos({ _id: id, gcashProofFileId: 'file-id', gcashProofUrl: '/obsolete-path.jpg' }, [
    { proofUrl: `/api/orders/${id}/payment-proof` }, { proofUrl: '/collected-receipt.jpg' },
  ]), [
    { src: `/api/orders/${id}/payment-proof`, label: 'Payment receipt' },
    { src: '/collected-receipt.jpg', label: 'Payment receipt' },
  ]);
});

test('the protected order photo endpoint loads stored and ledger receipts without exposing payment metadata', async t => {
  let query, selection;
  const chain = value => ({ select(fields) { selection = fields; return this; }, maxTimeMS() { return this; }, lean: async () => value });
  t.mock.method(Order, 'findById', () => chain({ _id: id, gcashProofFileId: 'stored-file' }));
  t.mock.method(Payment, 'find', filter => { query = filter; return chain([{ proofUrl: '/receipt.jpg', reference: 'Private financial metadata', amount: 1000 }]); });
  const route = routes.stack.find(layer => layer.route?.path === '/:id/photos').route;
  const res = { code: 200, headers: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; } };
  await route.stack.at(-1).handle({ params: { id }, user: { role: 'admin' } }, res);
  assert.equal(res.code, 200); assert.deepEqual(query, { orderId: id });
  assert.equal(selection, 'proofUrl remittanceProofUrl refundProofUrl');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.photos.length, 2);
  assert.ok(!JSON.stringify(res.body).includes('Private financial metadata'));
  for (const role of ['admin', 'secretary', 'customer', 'technician']) {
    let allowed = false;
    route.stack[1].handle({ user: { role } }, res, () => { allowed = true; });
    assert.equal(allowed, ['admin', 'secretary'].includes(role));
  }
});
