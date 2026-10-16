'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const policy = require('../public/js/booking-edit-policy');
const guard = require('../utils/customerBookingEditPolicy');
const Payment = require('../models/Payment'), Booking = require('../models/BookingService');
const router = require('../routes/bookingRoutesNew');
const { mutationPolicy } = require('../utils/bookingServiceItems');
const { presentCustomerBooking } = require('../utils/customerBookingPresentation');
const id = '507f1f77bcf86cd799439011';

test('verified deposits, full payments and historical verification lock edits even after status changes', () => {
  for (const signal of [{ paymentVerifiedAt: new Date() }, { paymentVerifiedBy: id }, { status: 'payment_verified' },
    { paymentStatus: 'partial' }, { paymentStatus: 'paid' }, { payments: [{ status: 'verified' }] }, { payments: [{ status: 'pending', verifiedAt: new Date() }] }]) {
    const booking = { status: 'pending', ...signal };
    assert.equal(policy.state(booking).canEdit, false); assert.equal(mutationPolicy(booking).direct, false);
    assert.equal(mutationPolicy(booking).mode, 'locked');
    assert.equal(presentCustomerBooking(booking).bookingEditPolicy.paymentVerified, true);
  }
  assert.equal(policy.state({ status: 'pending', paymentStatus: 'pending', payments: [{ status: 'pending' }] }).canEdit, true);
  assert.equal(mutationPolicy({ status: 'pending' }).direct, true);
});

test('a verified ledger locks an older booking whose payment summary was not updated', async t => {
  let filter; t.mock.method(Payment, 'exists', async input => { filter = input; return { _id: id }; });
  await assert.rejects(guard.assertPaymentNotVerified({ _id: id, status: 'pending' }), error => error.status === 409 && error.code === 'BOOKING_PAYMENT_VERIFIED');
  assert.equal(filter.bookingId, id); assert.ok(filter.$or.some(row => row.verifiedAt));
});

test('the customer change endpoint rejects verified payments before validating or writing proposed changes', async t => {
  let saved = false;
  t.mock.method(Booking, 'findById', async () => ({ _id: id, customerId: id, status: 'pending', paymentVerifiedAt: new Date(), save() { saved = true; } }));
  const handler = router.stack.find(layer => layer.route?.path === '/:id/service-change-requests').route.stack.at(-1).handle;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { id }, user: { _id: id, role: 'customer' }, body: { services: [] } }, res);
  assert.equal(res.code, 409); assert.equal(res.body.code, 'BOOKING_PAYMENT_VERIFIED'); assert.equal(saved, false);
});

test('the save guard is included in Mongoose updates to reject concurrent verification', async t => {
  const booking = Booking.hydrate({ _id: id, status: 'pending', paymentStatus: 'pending', services: [], __v: 0 });
  booking.specialInstructions = 'Changed by the customer'; guard.guardCustomerSave(booking);
  let filter;
  t.mock.method(Booking.collection, 'updateOne', async input => { filter = input; return { matchedCount: 0 }; });
  await assert.rejects(booking.save({ validateBeforeSave: false }), error => ['DocumentNotFoundError', 'VersionError'].includes(error.name));
  assert.equal(filter.paymentVerifiedAt, null); assert.equal(filter.paymentVerifiedBy, null);
  assert.ok(filter.paymentStatus.$nin.includes('partial')); assert.equal(filter.status.$ne, 'payment_verified');
});

test('history renders Edit Booking disabled with an explanation while retaining a schedule-change request', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/book-history.js'), 'utf8');
  const start = script.indexOf('    const bookingActionsHtml = (() => {');
  const code = script.slice(start, script.indexOf('    })();', start) + '    })();'.length) + '\nbookingActionsHtml;';
  const render = b => vm.runInNewContext(code, { b, status: b.status, window: { BookingEditPolicy: policy },
    CUSTOMER_RESCHEDULE_STATUSES: new Set(['pending', 'awaiting_assignment']), escapeHtml: String,
    section: (title, icon, body, footer) => footer });
  const locked = render({ status: 'awaiting_assignment', paymentVerifiedAt: new Date() });
  assert.match(locked, /data-booking-action="edit-services" disabled aria-disabled="true"/);
  assert.match(locked, /Payment has been verified/);
  assert.match(locked, /data-booking-action="reschedule" >|data-booking-action="reschedule"\s*>/);
  assert.doesNotMatch(render({ status: 'pending', paymentStatus: 'pending' }), /data-booking-action="edit-services" disabled/);
});
