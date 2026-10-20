'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const mongoose = require('mongoose');
const id = '507f1f77bcf86cd799439011', actor = { _id: '507f1f77bcf86cd799439012', name: 'Admin', role: 'admin' };
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const revision = '2030-01-01T08:00:00Z';

function adminHandler(route, record) {
  const file = path.join(__dirname, '../routes/adminApi.js'), source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async (req, res, next) => {', source.indexOf(`router.post("${route}"`));
  assert.ok(start >= 0, route);
  const end = source.indexOf('\n});', start), actualRequire = createRequire(file);
  let writes = 0;
  const query = { session() { return this; }, then(resolve, reject) { return Promise.resolve(record).then(resolve, reject); } };
  const mutate = () => { writes++; throw Error('Mutation reached before payment review'); };
  const models = { findById: () => query, findByIdAndUpdate: mutate, updateMany: mutate };
  const mockRequire = name => name === '../models/BookingService' || name === '../models/Assignment' ? models
    : name === '../index' ? { io: null }
    : name === '../utils/audit' ? { logEvent: mutate }
    : name === '../utils/mailer' ? {}
    : actualRequire(name);
  const handler = vm.runInNewContext('(' + source.slice(start, end + 2) + ')', { require: mockRequire,
    mongoose: { ...mongoose, startSession: async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }) },
    console, Date, audit: { logEvent: mutate }, cancelBookingRecord: mutate });
  return { handler, get writes() { return writes; } };
}

test('all booking case mutations reject an unverified payment before changing a booking, assignment, refund or notification', async () => {
  const routes = ['/resolution-center/:id/close', '/resolution-center/:id/reassign', '/resolution-center/:id/cancel-with-refund',
    '/review-reschedule/:id/reschedule', '/review-reschedule/:id/cancel', '/no-show-review/:id/confirm', '/no-show-review/:id/reschedule'];
  for (const route of routes) {
    const record = { _id: id, status: 'pending', paymentStatus: 'pending', paymentMethod: 'gcash', save() { throw Error('Unexpected save'); } };
    const f = adminHandler(route, record), res = response();
    await f.handler({ params: { id }, body: { issueType: 'past_date', reason: 'Customer requested another day', refundDecision: 'none' }, user: actor }, res,
      error => { res.code = error.status; res.body = { error: error.message, code: error.code }; });
    assert.equal(res.code, 409, route); assert.equal(res.body.code, 'RESOLUTION_PAYMENT_REVIEW_REQUIRED', route); assert.equal(f.writes, 0, route);
  }
});

test('recovery cannot write a replacement visit or release custody before its payment arrangement is reviewed', async () => {
  for (const source of ['booking', 'order']) {
    let writes = 0;
    const Model = { findById: () => ({ lean: async () => ({ _id: id, status: source === 'booking' ? 'pending_reassignment' : 'technician_declined',
      updatedAt: revision, paymentStatus: 'pending', paymentMethod: source === 'booking' ? 'cash_after_service' : 'gcash', totalPrice: 1500, total: 1500 }) }) };
    const service = require('../utils/visitRecovery').createService({ Booking: Model, Order: Model, mongoose,
      lock: async (_key, fn) => fn(), write: async () => { writes++; }, now: () => new Date(revision) });
    await assert.rejects(service.recover(source, id, { requestId: 'guard-test-001', customerConfirmed: true, decision: 'new_schedule', contactMethod: 'call',
      notes: 'Customer agreed to a replacement visit.', date: '2030-01-02', time: '09:00', expectedUpdatedAt: revision }, actor),
    error => error.code === 'RESOLUTION_PAYMENT_REVIEW_REQUIRED');
    assert.equal(writes, 0);
  }
});

test('cash confirmation endpoints retain staff authorization, and payment management permission is required', () => {
  const router = require('../routes/orderRoutes');
  const route = router.stack.find(layer => layer.route?.path === '/:id/confirm-cash-arrangement').route;
  assert.equal(route.methods.post, true);
  for (const role of ['customer', 'technician']) {
    const res = response(); let next = false;
    route.stack[1].handle({ user: { role } }, res, () => { next = true; });
    assert.equal(res.code, 403); assert.equal(next, false);
  }
  const source = fs.readFileSync(path.join(__dirname, '../routes/adminApi.js'), 'utf8');
  assert.match(source, /payment-summary\|verify-pending-payment\|confirm-cash-arrangement\|cancel-with-refund/);
});

test('direct order schedule and approval requests reject pending payments before saving or acquiring capacity', async t => {
  const Order = require('../models/Order'), router = require('../routes/orderRoutes');
  let writes = 0;
  t.mock.method(Order, 'findById', async () => ({ _id: id, status: 'pending_payment', paymentStatus: 'pending', paymentMethod: 'gcash',
    rescheduleRequest: { status: 'pending', requestedDate: '2030-01-02' }, save: async () => { writes++; } }));
  for (const path of ['/:id/admin-reschedule', '/:id/reschedule-approve']) {
    const handler = router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle, res = response();
    await handler({ params: { id }, body: { scheduledDate: '2030-01-02', timeSlot: '09:00' }, user: actor }, res);
    assert.equal(res.code, 409, path); assert.match(res.body.error, /Verify the submitted payment/); assert.equal(writes, 0);
  }
});
