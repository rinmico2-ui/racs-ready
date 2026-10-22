'use strict';
const mongoose = require('mongoose');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const Booking = require('../../models/BookingService');
const Payment = require('../../models/Payment');
const { createService } = require('../../utils/customerCancellationService');
const id = number => number.toString(16).padStart(24, '0');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  const customer = { _id: id(1), role: 'customer', name: 'Customer' }, admin = { _id: id(2), role: 'admin', name: 'Administrator' };
  const bookingId = id(3), client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27017'), session = client.startSession();
  let store = { booking: { _id: bookingId, customerId: customer._id, bookingReference: 'DEMO-CANCELLATION', status: 'pending', bookingDate: '2099-01-01T00:00:00+08:00',
    startTime: '09:00', serviceType: 'core', serviceModel: 'CoreService', services: [{ _id: id(5), name: 'Cleaning', type: 'core', status: 'pending', quantity: 1, unitPrice: 1000 }],
    totalPrice: 1000, amountPaid: 0, paymentMethod: 'cash_after_service', paymentChannel: 'cash', paymentStatus: 'pending', ...options.booking },
  payments: copy(options.payments || []), assignments: copy(options.assignments || []), reopened: 0 };
  let staged, failWrite = options.failWrite, writes = 0, conflict = options.conflict;
  const events = [], startTransaction = session.startTransaction.bind(session);
  session.startTransaction = (...args) => { staged = copy(store); events.push('begin'); return startTransaction(...args); };
  session.commitTransaction = async () => { store = copy(staged); staged = undefined; events.push('commit'); session.transaction.transition('TRANSACTION_COMMITTED'); };
  session.abortTransaction = async () => { staged = undefined; events.push('abort'); session.transaction.transition('TRANSACTION_ABORTED'); };
  const query = get => {
    let inSession = false;
    const result = { session(value) { inSession = Boolean(value); return this; }, select() { return this; }, lean: async () => get(inSession ? staged : store),
      then(resolve, reject) { return Promise.resolve().then(() => get(inSession ? staged : store)).then(resolve, reject); } };
    return result;
  };
  function document(value, model, target, kind) {
    if (!value) return null;
    const doc = copy(value);
    Object.defineProperty(doc, 'save', { enumerable: false, value: async () => {
      if (++writes === failWrite) throw Error('Synthetic persistence failure');
      if (conflict && kind === 'booking') { conflict = false; throw new mongoose.mongo.MongoServerError({ code: 112, errmsg: 'Write conflict', errorLabels: ['TransientTransactionError'] }); }
      await model.hydrate(doc).validate(kind === 'booking' ? ['status', 'customerCancellation', 'refundStatus', 'services.0.status'] : ['status', 'refundStatus', 'refundAmount', 'events']);
      target(copy(doc)); return doc;
    } });
    return doc;
  }
  const deps = {
    mongoose: { isValidObjectId: mongoose.isValidObjectId, Types: mongoose.Types, startSession: async () => session },
    Booking: { findById: value => query(db => value === bookingId ? document(db.booking, Booking, saved => { db.booking = saved; }, 'booking') : null) },
    Payment: { find: () => query(db => db.payments.map((row, i) => document(row, Payment, saved => { db.payments[i] = saved; }, 'payment'))) },
    Assignment: {
      exists: filter => query(db => db.assignments.find(row => filter.status.$in ? filter.status.$in.includes(row.status) : !filter.status.$nin.includes(row.status)) || null),
      updateMany: async (filter, update) => { for (const row of staged.assignments) if (!filter.status.$nin.includes(row.status)) Object.assign(row, update.$set); },
    },
    lock: async (key, work) => { events.push(key); await options.insideLock?.(store); return work(); },
    now: () => new Date('2026-10-20T10:00:00Z'), reopen: async () => { staged.reopened++; },
  };
  const service = createService(deps);
  const input = { reasonCode: 'no_technician', reason: 'The appointment passed without technician assignment.' };
  return { service, customer, admin, bookingId, events, get store() { return store; }, get writes() { return writes; }, input,
    submit: body => service.submit(bookingId, customer, { ...input, ...body }),
    decide: body => service.decide(bookingId, admin, { requestId: store.booking.customerCancellation?.requestId, revision: store.booking.customerCancellation?.revision,
      action: 'approve', refundDecision: 'none', note: 'We confirmed the delay and approved your cancellation.', ...body }),
    dispose: async () => { await session.endSession(); await client.close(); },
  };
}
module.exports = { fixture, id };
