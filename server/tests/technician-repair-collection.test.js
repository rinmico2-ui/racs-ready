'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const pricing = require('../public/js/repair-visit-payment');
const page = fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'), 'utf8');
const routes = fs.readFileSync(require.resolve('../routes/technicianApi'), 'utf8');
const bookingId = '507f1f77bcf86cd799439011', techId = '507f1f77bcf86cd799439012';
const bookingData = () => ({ _id: bookingId, technicianId: techId, customerId: 'customer', serviceType: 'repair', status: 'repair_in_progress',
  initialCost: 500, totalInitialCost: 550, travelFare: 50, totalPrice: 1450, amountPaid: 550, downpaymentAmount: 0,
  quotation: { totalCost: 900 }, inspectionFeeCollected: true, inspectionFeeAmount: 500, inspectionFeeDistanceFare: 50,
  services: [{ type: 'repair', initialCost: 500, unitPrice: 500, totalPrice: 500, quantity: 1 }] });

function apiFixture(options = {}) {
  const payments = [], notifications = [], writes = [];
  const booking = { ...bookingData(), ...options.booking, async save() { writes.push('booking'); } };
  let handler;
  const context = { console, global: {}, Technician: { findOne: async () => ({ _id: techId, name: 'Technician' }) },
    getMixedPhaseOnePayment: pricing.summary, router: { post(path, callback) { handler = callback; } },
    require(name) {
      if (name.endsWith('/BookingService')) return { findById: async () => booking };
      if (name.endsWith('/Payment')) return { create: async data => { payments.push(data); return data; } };
      if (name.endsWith('/repair-visit-payment')) return pricing;
      if (name.endsWith('/notify')) return { createNotification: async data => notifications.push(data) };
      throw Error('Unexpected dependency: ' + name);
    },
  };
  const start = routes.indexOf('router.post("/appointments/:id/collect-repair-payment",');
  const end = routes.indexOf('// POST /appointments/:id/upload-proof', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(routes.slice(start, end), context);
  return { booking, payments, notifications, writes, async collect(body = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await handler({ params: { id: bookingId }, user: { _id: techId }, body: { amount: 900, method: 'cash', ...body }, app: { get() {} } }, res);
    return res;
  } };
}

test('repair final collection settles the exact balance without payment evidence and notifies admin', async () => {
  for (const method of ['cash', 'gcash']) {
    const f = apiFixture(), res = await f.collect({ method });
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assert.equal(f.payments.length, 1); assert.equal(f.payments[0].amount, 900);
    assert.equal(f.payments[0].status, 'waiting_for_remittance'); assert.equal(f.payments[0].proofUrl, undefined);
    assert.equal(f.payments[0].customerSignature, undefined); assert.equal(f.payments[0].collectedBy, techId);
    assert.equal(f.booking.amountPaid, 1450); assert.equal(f.booking.balanceAmount, 0); assert.equal(f.booking.repairPaymentProof, undefined);
    assert.equal(f.notifications[0].role, 'admin');
  }
});

test('repair collection ignores uploaded evidence sent by older clients', async () => {
  const f = apiFixture();
  assert.equal((await f.collect({ proofUrl: '/legacy-proof.png', customerSignature: 'Name', customerPhotoUrl: '/legacy-customer.png' })).body.success, true);
  assert.equal(f.payments[0].proofUrl, undefined); assert.equal(f.payments[0].customerSignature, undefined);
  assert.equal(f.payments[0].customerPhotoUrl, undefined); assert.equal(f.booking.repairPaymentProof, undefined);
});
test('inspection arrival and a scheduled or deferred Phase 2 cannot collect the quoted repair', async () => {
  for (const status of ['arrived','in-progress','repair_approved','repair_scheduled']) {
    const f=apiFixture({booking:{status}}),res=await f.collect();
    assert.equal(res.statusCode,409);assert.equal(res.body.code,'PHASE_TWO_NOT_STARTED');
    assert.equal(f.payments.length,0);assert.equal(f.writes.length,0);
  }
  const deferred=apiFixture({booking:{status:'repair_scheduled',repairExecution:{status:'deferred',startedAt:'2026-10-21T02:00:00Z'}}});
  assert.equal((await deferred.collect()).body.code,'PHASE_TWO_NOT_STARTED');assert.equal(deferred.payments.length,0);
});

test('proof-free repair collection preserves assignment, amount and already-paid guards', async () => {
  for (const [options, body, status] of [
    [{ booking: { technicianId: 'other-technician' } }, {}, 403],
    [{ booking: { status: 'cancelled' } }, {}, 400],
    [{}, { amount: 100 }, 400], [{}, { amount: 1000 }, 400],
  ]) {
    const f = apiFixture(options), res = await f.collect(body);
    assert.equal(res.statusCode, status); assert.equal(f.payments.length, 0); assert.equal(f.writes.length, 0);
  }
  const paid = apiFixture({ booking: { amountPaid: 1450, repairPaymentCollected: true } });
  assert.equal((await paid.collect()).body.alreadyCollected, true); assert.equal(paid.payments.length, 0);
});

test('repair collection dialog submits directly without uploads and keeps customer confirmation', async () => {
  for (const method of ['cash', 'gcash', 'card']) {
    const requests = [], errors = [], elements = { rpMethod: { value: method }, rpAmount: { value: '900' }, rpCustomerConfirmed: { checked: false } };
    const context = { window: { RepairVisitPayment: pricing, _allAssignments: [] }, console,
      document: { getElementById(id) { assert.doesNotMatch(id, /Proof|Signature|Photo/); return elements[id]; } },
      fetch: async (url, options = {}) => {
        if (!options.method) return { ok: true, json: async () => ({ booking: bookingData() }) };
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ booking: { repairPaymentAmount: 900 } }) };
      },
      Swal: { close() {}, showValidationMessage(message) { errors.push(message); }, async fire(config) {
        if (!config.preConfirm) return { isConfirmed: true };
        assert.doesNotMatch(config.html, /type="file"|Proof of Payment|Screenshot|Signature|Photo/);
        assert.equal(config.preConfirm(), undefined); assert.match(errors.at(-1), /customer acknowledged/);
        elements.rpCustomerConfirmed.checked = true;
        return { isConfirmed: true, value: config.preConfirm() };
      } }, setTimeout() {}, loadAssignments: async () => {}, currentFilter: 'active', currentPage: 1,
    };
    const start = page.indexOf('    window.collectRepairPayment = async function');
    const end = page.indexOf('    let proofTargetId = null;', start);
    vm.runInNewContext(page.slice(start, end), context);
    await context.window.collectRepairPayment(bookingId, 900);
    assert.equal(requests.length, 1); assert.match(requests[0].url, /collect-repair-payment$/);
    assert.equal(requests[0].body.amount, 900); assert.equal(requests[0].body.method, method);
    assert.equal(requests[0].body.proofUrl, undefined);
  }
});

test('mixed repair collection opens the shared itemized dialog and never posts a second repair payment', async () => {
  const calls = [], mixed = { ...bookingData(), assignmentId: 'current-assignment', serviceType: 'mixed', services: [
    { type: 'core', status: 'completed' }, { type: 'repair', status: 'repair_in_progress' },
  ] };
  const context = { window: { RepairVisitPayment: pricing, openCollectPaymentModal: (...args) => calls.push(args) },
    fetch: async (_url, request) => { assert.equal(request?.method, undefined); return { ok: true, json: async () => ({ booking: mixed }) }; },
    Swal: { fire() { assert.fail('Mixed collection uses the shared payment dialog.'); } },
  };
  const start = page.indexOf('    window.collectRepairPayment = async function'), end = page.indexOf('    let proofTargetId = null;', start);
  vm.runInNewContext(page.slice(start, end), context);
  await context.window.collectRepairPayment(bookingId, 900);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'current-assignment');
  assert.equal(calls[0][1].bookingId.serviceType, 'mixed'); assert.equal(typeof calls[0][3], 'function');
});
