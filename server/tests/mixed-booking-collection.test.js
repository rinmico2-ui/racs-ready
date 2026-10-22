'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const mongoose = require('mongoose');
const { createService } = require('../utils/mixedBookingCollection');
const pricing = require('../public/js/repair-visit-payment');
const id = n => n.toString(16).padStart(24, '0');
const clone = value => structuredClone(value);
function fixture(options = {}) {
  let state = { booking: { _id: id(1), assignmentId: id(3), technicianId: id(2), serviceType: 'mixed', status: 'repair_in_progress',
    totalInitialCost: 1750, totalPrice: 2650, initialCost: 500, travelFare: 50, amountPaid: 250,
    downpaymentAmount: 250, quotation: { totalCost: 900 }, approval: { status: 'approved' },
    services: [{ type: 'core', status: 'completed', initialCost: 1200, quantity: 1 },
      { type: 'repair', status: 'repair_in_progress', initialCost: 500, quantity: 1 }], ...options.booking },
    payments: options.payments || [{ _id: id(4), amount: 250, status: 'verified' }] };
  const assignment = { _id: id(3), bookingId: id(1), technicianId: id(2), status: 'in_progress' };
  const tech = { _id: id(2), name: 'Primary technician' }, events = [], locks = [];
  let staged, tail = Promise.resolve();
  const current = () => staged || state;
  const query = read => ({ session() { return this; }, lean() { return this; }, select() { return this; },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  const session = { async withTransaction(work) {
    staged = clone(state); events.push('begin');
    try { await work(); state = staged; events.push('commit'); }
    catch (error) { events.push('rollback'); throw error; }
    finally { staged = null; }
  }, async endSession() { events.push('end'); } };
  const models = {
    Booking: { findById() { return query(() => {
      const value = clone(current().booking);
      Object.defineProperties(value, { increment: { value() { events.push('version'); } },
        save: { value: async config => { assert.equal(config.session, session); if (options.failSave) throw Error('Booking failed'); staged.booking = clone({ ...value }); } } });
      return value;
    }); } },
    Assignment: { findOne(filter) { return query(() => options.reassigned || filter._id && filter._id !== assignment._id ? null : assignment); } },
    Payment: { find: () => query(() => current().payments), async create(rows, config) {
      assert.equal(config.session, session); if (options.failPayment) throw Error('Payment failed');
      const payment = { _id: id(5), ...rows[0] }; await require('../models/Payment').hydrate(payment).validate();
      staged.payments.push(payment); return [payment];
    } },
  };
  const deps = { ...models, mongoose: { isValidObjectId: mongoose.isValidObjectId, startSession: async () => session },
    async lock(key, work) {
      locks.push(key); const before = tail; let release; tail = new Promise(resolve => { release = resolve; });
      await before; try { return await work(); } finally { release(); }
    },
  };
  const collect = createService(deps);
  const input = { amount: 2400, method: 'cash', cashReceivedConfirmed: true };
  return { models, tech, events, locks, get state() { return state; },
    collect: (body = {}, technician = tech, assignmentId) => collect(id(1), technician, id(9), { ...input, ...body }, assignmentId),
    route(path) {
      const file = require.resolve('../routes/technicianApi'), source = fs.readFileSync(file, 'utf8'), actualRequire = createRequire(file);
      const routeStart = source.indexOf('router.post("' + path + '"'), start = source.indexOf('async (req, res, next) => {', routeStart);
      const handler = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n});', start) + 2) + ')', {
        mongoose, Technician: { findOne: async () => tech }, console,
        require(name) {
          if (name.endsWith('/Assignment')) return models.Assignment;
          if (name.endsWith('/BookingService')) return models.Booking;
          if (name.endsWith('/Payment')) return models.Payment;
          if (name.endsWith('/mixedBookingCollection')) return { createService: () => collect };
          return actualRequire(name);
        },
      });
      return async body => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
        await handler({ params: { id: path.startsWith('/assignments') ? id(3) : id(1) }, user: { _id: id(9) }, body: { ...input, ...body } }, res, error => { throw error; });
        return res;
      };
    },
  };
}

test('one combined collection itemizes aircon, inspection, approved repair and travel, crediting the deposit once', async () => {
  const f = fixture(), result = await f.collect();
  assert.deepEqual(result.paymentLedger.lines.map(line => line.amount), [1200, 500, 900, 50]);
  assert.equal(result.paymentLedger.total, 2650); assert.equal(result.paymentLedger.previouslyPaid, 250);
  assert.equal(result.paymentLedger.collected, 2400); assert.equal(f.state.payments.length, 2);
  assert.equal(f.state.booking.amountPaid, 2650); assert.equal(f.state.booking.balanceAmount, 0);
  assert.equal(f.state.booking.coreServicePaymentCollected, true); assert.equal(f.state.booking.repairPaymentCollected, true);
  assert.equal(f.state.booking.inspectionFeeCollected, true); assert.equal(f.state.booking.repairPaymentAmount, 900);
  assert.deepEqual(f.state.payments[1].events[0].metadata.paymentLedger, result.paymentLedger);
});

test('simultaneous aircon and repair endpoint requests produce one payment and return already collected on the other', async () => {
  const f = fixture(), shared = f.route('/assignments/:id/collect-payment'), repair = f.route('/appointments/:id/collect-repair-payment');
  const responses = await Promise.all([shared(), repair()]);
  assert.ok(responses.every(res => res.body.success)); assert.equal(responses.filter(res => res.body.alreadyCollected).length, 1);
  assert.equal(f.state.payments.length, 2); assert.equal(new Set(f.locks).size, 1);
  const retry = await repair(); assert.equal(retry.body.alreadyCollected, true); assert.equal(f.state.payments.length, 2);
  const legacy = await f.route('/assignments/:id/collect-payment-legacy')();
  assert.equal(legacy.body.alreadyCollected, true); assert.equal(f.state.payments.length, 2);
});

test('failed payment or booking writes roll back the entire collection', async () => {
  for (const options of [{ failSave: true }, { failPayment: true }]) {
    const f = fixture(options); await assert.rejects(f.collect(), /failed/);
    assert.equal(f.state.payments.length, 1); assert.equal(f.state.booking.amountPaid, 250);
    assert.ok(f.events.includes('rollback'));
  }
});

test('recorded payments override a stale paid snapshot and cannot be charged again', async () => {
  const f = fixture({ booking: { amountPaid: 0 }, payments: [{ amount: 2650, status: 'waiting_for_remittance' }] });
  const result = await f.collect(); assert.equal(result.alreadyCollected, true); assert.equal(result.amountPaid, 2650);
  assert.equal(f.state.payments.length, 1);
});

test('a pending quotation cannot trigger an early collection that would leave another repair charge later', async () => {
  const f = fixture({ booking: { approval: { status: 'pending' }, services: [{ type: 'core', status: 'completed', initialCost: 1200 },
    { type: 'repair', status: 'inspection_completed', initialCost: 500 }] } });
  await assert.rejects(f.collect(), /quotation decisions/); assert.equal(f.state.payments.length, 1);
});
test('approved but unstarted Phase 2 cannot collect its quotation through any mixed collection endpoint', async () => {
  for (const route of ['/assignments/:id/collect-payment','/appointments/:id/collect-repair-payment','/assignments/:id/collect-payment-legacy']) {
    const f = fixture({ booking: { status:'repair_approved', repairExecution:{status:'deferred'}, amountPaid:1750,
      services:[{type:'core',status:'completed',initialCost:1200},{type:'repair',status:'repair_approved',initialCost:500}] }, payments:[{amount:1750,status:'verified'}] });
    await f.route(route)({amount:900}).then(res=>{
      assert.equal(res.statusCode,409);assert.equal(res.body.code,'PHASE_TWO_NOT_STARTED');
    },error=>{assert.equal(error.status,409);assert.equal(error.code,'PHASE_TWO_NOT_STARTED');});
    assert.equal(f.state.payments.length,1);assert.equal(f.state.booking.amountPaid,1750);
    assert.ok(!f.events.includes('commit'));
  }
});

test('wrong technicians, stale assignments, short collection and missing receipt confirmation cannot record money', async () => {
  const f = fixture();
  await assert.rejects(f.collect({}, { _id: id(99) }), { status: 403 });
  await assert.rejects(f.collect({}, f.tech, id(99)), { status: 409 });
  for (const body of [{ amount: 900 }, { amount: 5000 }, { cashReceivedConfirmed: false }, { method: 'gcash', reference: '' }]) {
    await assert.rejects(f.collect(body), { status: 400 });
  }
  assert.equal(f.state.payments.length, 1);
});

test('cancelled core work is excluded from the itemized bill and tracked appliances must all have a decision', () => {
  const bill = pricing.breakdown({ serviceType: 'mixed', travelFare: 50, totalInitialCost: 1750, quotation: { totalCost: 900 },
    services: [{ type: 'core', status: 'cancelled', initialCost: 1200 }, { type: 'repair', initialCost: 500, status: 'repair_in_progress' }] });
  assert.equal(bill.total, 1450); assert.equal(bill.lines[0].amount, 0);
  assert.equal(bill.lines.reduce((sum, line) => sum + line.amount, 0), bill.total);
  assert.equal(pricing.breakdown({ serviceType: 'mixed', repairUnitTracking: true, services: [{ type: 'repair', units: [
    { repairReview: { state: 'approved' } }, { repairReview: { state: 'pending' } },
  ] }] }).ready, false);
  assert.equal(pricing.breakdown({ serviceType: 'mixed', repairUnitTracking: true, approval: { status: 'approved' }, services: [] }).ready, false);
});

test('the current mixed booking response reconciles the payment ledger before opening either collection action', async () => {
  const f = fixture({ booking: { amountPaid: 0 }, payments: [{ amount: 2650, status: 'waiting_for_remittance' }] });
  const file = require.resolve('../routes/technicianApi'), source = fs.readFileSync(file, 'utf8'), actualRequire = createRequire(file);
  const start = source.indexOf('async (req, res, next) => {', source.indexOf('router.get("/appointments/:id",'));
  const handler = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n});', start) + 2) + ')', {
    mongoose, loadTechnicianContext: async () => ({ tech: f.tech, technicianIds: [id(2)] }), presentTechnicianBooking: value => value,
    require(name) {
      if (name.endsWith('/BookingService')) return f.models.Booking;
      if (name.endsWith('/Payment')) return f.models.Payment;
      return actualRequire(name);
    },
  });
  const res = { json(body) { this.body = body; } };
  await handler({ params: { id: id(1) }, user: { _id: id(9) } }, res, error => { throw error; });
  assert.equal(res.body.booking.amountPaid, 2650); assert.equal(res.body.booking.balanceAmount, 0);
  assert.equal(res.body.booking.balanceCollected, true); assert.equal(f.state.booking.amountPaid, 0, 'Read reconciliation must not rewrite the booking.');
});

test('the rendered technician payment dialogs contain valid JavaScript', async () => {
  const html = await require('ejs').renderFile(require.resolve('../views/pages/technician/assignments.ejs'), {
    companyLat: 15.5, companyLng: 121, companyAddress: 'Test address', technician: { name: 'Synthetic technician' },
  });
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0); for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});
