'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const SiteSetting = require('../models/SiteSetting');
const routeFile = require.resolve('../routes/technicianApi');
const actualRequire = createRequire(routeFile);
const source = fs.readFileSync(routeFile, 'utf8').replace(/\r\n/g, '\n');
const id = number => number.toString(16).padStart(24, '0');
const copy = value => JSON.parse(JSON.stringify(value));
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('the technician policy endpoint imports and reads the configured aftercare policy', async t => {
  const importLine = source.split('\n').find(line => /^const /.test(line) && line.includes("require('../utils/aftercarePolicy')"));
  const begin = source.indexOf('router.get("/aftercare-policy",');
  const end = source.indexOf('\n});', begin) + 4;
  let handler, lookupError;
  t.mock.method(SiteSetting, 'findOne', filter => {
    assert.equal(filter.key, 'aftercarePolicy');
    return { lean: async () => { if (lookupError) throw lookupError; return { value: { maintenance: { bookingsEnabled: false, bookingIntervalDays: 180, allowTechnicianRecommendation: false } } }; } };
  });
  vm.runInNewContext(importLine + '\n' + source.slice(begin, end), {
    require: actualRequire, router: { get(_path, callback) { handler = callback; } },
  });
  const res = response(); let forwarded;
  await handler({}, res, error => { forwarded = error; });
  assert.ifError(forwarded); assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { maintenance: { bookingsEnabled: false, bookingIntervalDays: 180, allowTechnicianRecommendation: false } });
  lookupError = new Error('Database temporarily unavailable');
  await handler({}, response(), error => { forwarded = error; });
  assert.equal(forwarded, lookupError);
});

async function fixture(t, options = {}) {
  const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27017');
  const session = client.startSession(); // No connection or database operations.
  const tech = { _id: id(1), name: 'Fixture technician' }, fileId = id(8);
  const proofPhoto = `/api/appointments/${id(2)}/completion-photo`;
  let assignment = { _id: id(3), bookingId: id(2), technicianId: tech._id, status: options.alreadyComplete ? 'completed' : 'in_progress',
    ...(options.alreadyComplete ? { proofPhoto } : {}), bookingDate: new Date('2026-10-20') };
  let booking = { _id: id(2), assignmentId: assignment._id, technicianId: tech._id, serviceType: 'core', status: 'in-progress',
    totalPrice: 5247, amountPaid: options.unpaid ? 0 : 5247, balanceAmount: options.unpaid ? 5247 : 0,
    services: [{ _id: id(4), type: 'core', name: 'Aircon Installation', status: 'completed', serviceId: id(5) }] };
  let usage = 0, staged, attempt = 0, upload;
  const calls = { stores: 0, deleted: [], committed: 0, rolledBack: 0, kitAttempts: 0, assignmentReads: 0, bookingReads: 0, sideEffects: 0, errors: [] };
  const startTransaction = session.startTransaction.bind(session);
  const withTransaction = session.withTransaction.bind(session);
  session.startTransaction = (...args) => { attempt++; staged = { assignment: copy(assignment), booking: copy(booking), usage }; return startTransaction(...args); };
  session.abortTransaction = async () => { calls.rolledBack++; staged = undefined; session.transaction.transition('TRANSACTION_ABORTED'); };
  session.commitTransaction = async () => {
    if (options.unknownCommit) {
      throw new mongoose.mongo.MongoServerError({ errmsg: 'Commit confirmation delayed', errorLabels: ['UnknownTransactionCommitResult'] });
    }
    assignment = staged.assignment; booking = staged.booking; usage = staged.usage; staged = undefined; calls.committed++;
    session.transaction.transition('TRANSACTION_COMMITTED');
  };
  session.withTransaction = async (work, config) => {
    assert.equal(config.timeoutMS, 15000);
    return withTransaction(work, options.persistentConflict || options.unknownCommit ? { ...config, timeoutMS: 30 } : config);
  };
  t.after(async () => { await session.endSession(); await client.close(); });
  const conflict = () => new mongoose.mongo.MongoServerError({ code: 112, errmsg: 'Write conflict during plan execution', errorLabels: ['TransientTransactionError'] });
  const query = get => {
    let inSession = false;
    return { session(value) { assert.equal(value, session); inSession = true; return this; }, populate() { return this; },
      lean: async () => get(inSession), then(resolve, reject) { return Promise.resolve().then(() => get(inSession)).then(resolve, reject); } };
  };
  const models = {
    Technician: { findOne: () => query(() => tech) }, User: {},
    Assignment: {
      findById: () => query(() => assignment),
      findOne: () => query(() => {
        calls.assignmentReads++;
        if (options.assignmentChanged) return null;
        return options.concurrentCompletion ? { ...staged.assignment, status: 'completed', proofPhoto } : staged.assignment;
      }),
      findByIdAndUpdate: (_id, update, config) => query(() => { assert.equal(config.session, session); Object.assign(staged.assignment, update.$set); return staged.assignment; }),
    },
    BookingService: {
      findById: () => query(inSession => {
        calls.bookingReads++;
        const value = inSession ? staged.booking : booking;
        if (inSession && options.bookingChanged) return { ...value, status: 'cancelled' };
        if (inSession && options.reopenedRepair) return { ...value, serviceType: 'mixed', services: [...value.services,
          { type: 'repair', name: 'Aircon Repair', status: 'repair_in_progress' }] };
        return { ...value, save: async () => {} };
      }),
      findByIdAndUpdate: (_id, update, config) => query(() => {
        assert.equal(config.session, session);
        if (options.failAfterAssignment && attempt === 1) throw conflict();
        if (options.permanentFailure) throw new Error('Permanent database failure');
        Object.assign(staged.booking, update.$set); return staged.booking;
      }),
    },
    Payment: { find: () => query(() => options.unpaid ? [] : [{ amount: 5247, status: 'waiting_for_remittance', type: 'final', method: 'cash' }]),
      create() { assert.fail('Completion must never collect a second payment.'); } },
  };
  const begin = source.indexOf('router.post("/assignments/:id/proof-of-completion",');
  const first = source.indexOf('async (req, res) => {', begin), last = source.indexOf('\n});', first);
  const context = {
    mongoose: { startSession: async () => session },
    console: { error(...args) { calls.errors.push(args); } },
    proofUpload(req, res, callback) { upload = callback(options.uploadError); },
    configuredBookingWarranty: async () => { if (options.policyError) throw new Error('Policy read failed'); return { coverage: { days: 180 } }; },
    storeCompletionProof: async () => { calls.stores++; if (options.storageError) throw Object.assign(new Error('Invalid photo'), { status: 400 }); return { fileId }; },
    deleteCompletionProof: async value => { calls.deleted.push(value); },
    recordBookingConsumableUsage: async config => {
      assert.equal(config.session, session); calls.kitAttempts++; staged.usage++;
      if (options.persistentConflict || options.failFirstKit && attempt === 1) throw conflict();
    },
    require(name) {
      if (name.startsWith('../models/')) return models[name.split('/').at(-1)];
      if (name === '../utils/maintenanceLifecycle') return { syncMaintenanceFromBooking: async () => { calls.sideEffects++; } };
      if (name === '../utils/availability') return { resolveAvailabilityStatus: async () => { if (options.availabilityFailure) throw new Error('Availability refresh failed'); } };
      if (name === '../utils/mailer') return { sendBookingCompletedEmail() { assert.fail('No email should be sent by this fixture.'); } };
      return actualRequire(name);
    },
  };
  const handler = vm.runInNewContext('(' + source.slice(first, last + 2) + ')', context);
  return { calls, get attempt() { return attempt; }, get assignment() { return assignment; }, get booking() { return booking; }, get usage() { return usage; },
    async submit() {
      const res = response();
      await handler({ params: { id: assignment._id }, user: { _id: id(6), role: 'technician' }, file: {}, body: { consumables: '[]' }, app: { get: () => null } }, res);
      await upload; return res;
    } };
}

for (const failure of ['failFirstKit', 'failAfterAssignment']) {
  test(`a transient ${failure} conflict retries with fresh reads and commits photo, job and kit once`, async t => {
    const f = await fixture(t, { [failure]: true }); const res = await f.submit();
    assert.equal(res.statusCode, 200, res.body?.error); assert.equal(f.attempt, 2);
    assert.equal(f.calls.rolledBack, 1); assert.equal(f.calls.committed, 1); assert.equal(f.usage, 1);
    assert.equal(f.calls.stores, 1); assert.deepEqual(f.calls.deleted, []);
    assert.equal(f.calls.assignmentReads, 2); assert.equal(f.calls.kitAttempts, 2);
    assert.equal(f.assignment.status, 'completed'); assert.equal(f.booking.status, 'completed');
    assert.equal(f.booking.amountPaid, 5247); assert.equal(f.booking.warranty.days, 180); assert.equal(f.calls.sideEffects, 1);
  });
}

test('a persistent conflict is bounded, removes the uncommitted photo, and returns a useful retry response', async t => {
  const f = await fixture(t, { persistentConflict: true }); const res = await f.submit();
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'COMPLETION_RETRY_REQUIRED');
  assert.match(res.body.error, /payment is still recorded/); assert.equal(f.calls.committed, 0);
  assert.equal(f.calls.deleted.length, 1); assert.equal(f.usage, 0); assert.equal(f.assignment.status, 'in_progress');
  assert.equal(f.booking.amountPaid, 5247);
});

test('unknown commit results preserve the photo and ask for a status refresh', async t => {
  const f = await fixture(t, { unknownCommit: true }); const res = await f.submit();
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'COMPLETION_STATUS_UNCONFIRMED');
  assert.deepEqual(f.calls.deleted, []); assert.match(res.body.error, /Refresh the assignment/);
});

test('a permanent failure rolls back completion and usage and removes the unattached photo', async t => {
  const f = await fixture(t, { permanentFailure: true }); const res = await f.submit();
  assert.equal(res.statusCode, 500); assert.equal(res.body.code, 'COMPLETION_COMMIT_FAILED');
  assert.equal(f.calls.committed, 0); assert.equal(f.usage, 0); assert.equal(f.calls.deleted.length, 1);
  assert.equal(f.assignment.status, 'in_progress'); assert.equal(f.booking.status, 'in-progress');
});

test('a reassignment during upload prevents completion and removes the unattached photo', async t => {
  const f = await fixture(t, { assignmentChanged: true }); const res = await f.submit();
  assert.equal(res.statusCode, 409); assert.equal(f.calls.committed, 0); assert.equal(f.usage, 0);
  assert.equal(f.calls.deleted.length, 1); assert.equal(f.assignment.status, 'in_progress');
});

for (const change of ['bookingChanged', 'reopenedRepair']) {
  test(`the transactional read rejects ${change} after upload before consuming materials`, async t => {
    const f = await fixture(t, { [change]: true }); const res = await f.submit();
    assert.equal(res.statusCode, 409); assert.equal(f.calls.kitAttempts, 0); assert.equal(f.calls.committed, 0);
    assert.equal(f.calls.deleted.length, 1); assert.equal(f.assignment.status, 'in_progress');
  });
}

test('a repeated completed request creates no new photo, usage, payment or follow-up', async t => {
  const f = await fixture(t, { alreadyComplete: true }); const res = await f.submit();
  assert.equal(res.statusCode, 200); assert.equal(res.body.alreadyCompleted, true);
  assert.equal(f.calls.stores, 0); assert.equal(f.attempt, 0); assert.equal(f.usage, 0); assert.equal(f.calls.sideEffects, 0);
});

test('a concurrent completion found on the transaction read discards only this request\'s extra photo', async t => {
  const f = await fixture(t, { concurrentCompletion: true }); const res = await f.submit();
  assert.equal(res.statusCode, 200); assert.equal(res.body.alreadyCompleted, true);
  assert.equal(f.calls.stores, 1); assert.equal(f.calls.deleted.length, 1); assert.equal(f.calls.kitAttempts, 0); assert.equal(f.calls.sideEffects, 0);
});

test('a warranty policy failure is handled before any photo is stored', async t => {
  const f = await fixture(t, { policyError: true }); const res = await f.submit();
  assert.equal(res.statusCode, 500); assert.equal(res.body.code, 'COMPLETION_FAILED');
  assert.equal(f.calls.stores, 0); assert.equal(f.attempt, 0);
});

test('an availability refresh failure after commit does not report a failed completion', async t => {
  const f = await fixture(t, { availabilityFailure: true }); const res = await f.submit();
  assert.equal(res.statusCode, 200); assert.equal(f.assignment.status, 'completed'); assert.equal(f.calls.committed, 1);
  assert.equal(f.calls.errors.length, 1);
});

test('an unpaid balance still blocks completion before photo storage and transaction writes', async t => {
  const f = await fixture(t, { unpaid: true }); const res = await f.submit();
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'BOOKING_BALANCE_REQUIRED');
  assert.equal(f.calls.stores, 0); assert.equal(f.attempt, 0);
});
