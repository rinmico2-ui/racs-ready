'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { projectPaymentSummary, projectPaymentSnapshot, verifyProjectPayment, projectCanUsePlanning, paymentFilter, syncProjectPayment } = require('../utils/projectPaymentReview');
const { calculateProjectCustomerPricing } = require('../utils/projectPricing');
const bookingId = '6acd3b3f678aa45bd94a733c', projectId = '6acd3b47678aa45bd94a7354', paymentId = '6acd3b41678aa45bd94a7347';
const routeSource = fs.readFileSync(require.resolve('../routes/projectRoutes'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(require.resolve('../views/pages/admin/Projects/ProjectDetail.ejs'), 'utf8').replace(/\r\n/g, '\n');
function data() {
  return { project: { _id: projectId, bookingId, status: 'pending_project_scheduling', requestedUnitCount: 7, totalUnits: 7,
    estimatedTotalHours: 10.5, isLargeScale: false, payment: { totalAmount: 0, amountPaid: 0, balanceAmount: 0, paymentStatus: 'unpaid' } },
  booking: { _id: bookingId, status: 'pending_project_scheduling', isProject: true, quantity: 7, serviceDurationMinutes: 630,
    totalPrice: 3578, estimatedFee: 578, amountPaid: 0, balanceAmount: 3399, downpaymentAmount: 179,
    paymentMethod: 'cod', paymentChannel: 'gcash', paymentStatus: 'pending', paymentProofFileId: 'original-receipt' },
  payment: { _id: paymentId, bookingId, amount: 179, type: 'downpayment', status: 'pending', reference: 'ORIGINAL-REFERENCE', events: [] } };
}
function fixture({ failProjectSave = false } = {}) {
  const saved = data(), calls = { transactions: 0, ended: 0, writes: [], queries: [] };
  const query = value => ({ session(session) { assert.equal(session, dbSession); return this; }, lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  for (const [name, doc] of Object.entries(saved)) doc.save = async options => {
    assert.equal(options.session, dbSession); calls.writes.push(name);
    if (name === 'project' && failProjectSave) throw Error('Injected project save failure');
    return doc;
  };
  const dbSession = { async withTransaction(fn) {
    calls.transactions++;
    const before = Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, structuredClone(JSON.parse(JSON.stringify(value)))]));
    try { await fn(); } catch (error) {
      for (const [key, value] of Object.entries(before)) { const save = saved[key].save; Object.keys(saved[key]).forEach(field => delete saved[key][field]); Object.assign(saved[key], value, { save }); }
      throw error;
    }
  }, async endSession() { calls.ended++; } };
  const Payment = { findOne(filter) { calls.queries.push(filter); return query(filter._id === saved.payment._id && !saved.payment.unrelated ? saved.payment : null); },
    find(filter) { calls.queries.push(filter); return query([saved.payment]); } };
  const dependencies = { mongoose: { startSession: async () => dbSession, Types: { ObjectId: { isValid: value => /^[a-f\d]{24}$/.test(String(value)) } } },
    Project: { findById: () => query(saved.project) }, BookingService: { findById: () => query(saved.booking) }, Payment,
    projectId, paymentId, actor: { _id: 'staff', role: 'secretary', name: 'Test staff' } };
  return { ...saved, calls, dependencies, run: () => verifyProjectPayment(dependencies) };
}

test('the reported downpayment is pending, not missing or received; total uses totalPrice rather than estimatedFee', () => {
  const { project, booking, payment } = data(); const before = JSON.stringify({ project, booking, payment });
  const summary = projectPaymentSummary(project, booking, [payment]);
  assert.equal(summary.total, 3578); assert.equal(summary.amountPaid, 0);
  assert.equal(summary.submittedAmount, 179); assert.equal(summary.submittedDownpayment, 179);
  assert.equal(summary.balance, 3578); assert.equal(summary.balanceAfterReview, 3399);
  assert.equal(summary.status, 'pending'); assert.equal(summary.requiresVerification, true);
  assert.equal(summary.pendingPayments[0].id, paymentId);
  assert.equal(JSON.stringify({ project, booking, payment }), before);
  const snapshot = projectPaymentSnapshot(booking);
  assert.equal(snapshot.paymentStatus, 'pending'); assert.equal(snapshot.amountPaid, 0); assert.equal(snapshot.totalAmount, 3578);
});

test('ledger receipts and refunds override stale project and booking snapshots without counting a shared row twice', () => {
  const { project, booking, payment } = data(); booking.amountPaid = 9999; project.payment.amountPaid = 9999;
  payment.status = 'verified'; payment.projectId = projectId; payment.refundAmount = 50;
  const summary = projectPaymentSummary(project, booking, [payment]);
  assert.equal(summary.amountPaid, 129); assert.equal(summary.balance, 3449); assert.equal(summary.submittedAmount, 0);
  assert.deepEqual(paymentFilter(project), { $or: [{ projectId }, { bookingId }] });
});

test('payment review commits the actual amount once across all three records and preserves receipt and work status', async () => {
  const f = fixture(); const first = await f.run();
  assert.equal(first.paymentSummary.amountPaid, 179); assert.equal(first.paymentSummary.balance, 3399);
  assert.deepEqual(f.calls.writes, ['payment', 'booking', 'project']);
  assert.equal(f.booking.amountPaid, 179); assert.equal(f.project.payment.amountPaid, 179);
  assert.equal(f.booking.balanceAmount, 3399); assert.equal(f.project.payment.balanceAmount, 3399);
  assert.equal(f.booking.paymentStatus, 'partial'); assert.equal(f.project.payment.paymentStatus, 'partial');
  assert.equal(f.payment.status, 'verified'); assert.equal(f.payment.events.length, 1);
  assert.equal(f.payment.projectId, projectId); assert.equal(f.payment.reference, 'ORIGINAL-REFERENCE');
  assert.equal(f.booking.paymentProofFileId, 'original-receipt');
  assert.equal(f.booking.status, 'pending_project_scheduling'); assert.equal(f.project.status, 'pending_project_scheduling');
  const second = await f.run(); assert.equal(second.alreadyVerified, true);
  assert.equal(second.paymentSummary.amountPaid, 179); assert.equal(f.payment.events.length, 1);
  assert.equal(f.calls.writes.length, 3); assert.equal(f.calls.ended, 2);
});

test('a failed project write rolls the ledger and source booking back and closes the transaction', async () => {
  const f = fixture({ failProjectSave: true }); await assert.rejects(f.run(), /Injected project save failure/);
  assert.equal(f.payment.status, 'pending'); assert.equal(f.booking.amountPaid, 0);
  assert.equal(f.payment.events.length, 0); assert.equal(f.project.payment.amountPaid, 0); assert.equal(f.calls.ended, 1);
});

test('unrelated payments, cancelled work, failed receipts and missing amounts cannot be verified', async () => {
  for (const change of [f => { f.payment.unrelated = true; }, f => { f.project.status = 'cancelled'; },
    f => { f.booking.status = 'cancelled'; }, f => { f.payment.status = 'failed'; }, f => { f.payment.amount = 0; },
    f => { f.payment.projectId = 'another-project'; },
    f => { f.booking.paymentProofFileId = ''; f.payment.reference = ''; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run()); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.ended, 1);
  }
});

test('approval uses the actual scheduling engine for quantity and duration including repair inspection workload', async t => {
  const engine = require('../utils/enterpriseSchedulingEngine'); const settings = require('../models/SiteSetting');
  const original = settings.findOne; settings.findOne = () => ({ lean: async () => ({ value: 8 }) }); engine.invalidateProjectThresholdCache();
  t.after(() => { settings.findOne = original; engine.invalidateProjectThresholdCache(); });
  const { project, booking } = data();
  assert.equal(await projectCanUsePlanning(project, booking, engine), true);
  booking.serviceDurationMinutes = 480; assert.equal(await projectCanUsePlanning(project, booking, engine), false);
  project.requestedUnitCount = 8; booking.serviceDurationMinutes = 60; assert.equal(await projectCanUsePlanning(project, booking, engine), true);
  project.totalUnits = 2; assert.equal(await projectCanUsePlanning(project, booking, engine), true);
  project.requestedUnitCount = 40; assert.equal(await projectCanUsePlanning(project, booking, engine), true);
  project.requestedUnitCount = 41; assert.equal(await projectCanUsePlanning(project, booking, engine), false);
});

function approval(f) {
  const start = routeSource.indexOf('router.post("/projects/:id/verify",'); const end = routeSource.indexOf('\n});', start);
  let handler; const notifications = [];
  vm.runInNewContext(routeSource.slice(start, end + 4), { router: { post(_path, guard, fn) { assert.equal(guard, 'staff'); handler = fn; } },
    auth: { requireRole: roles => { assert.deepEqual(Array.from(roles), ['admin', 'secretary']); return 'staff'; } },
    ...f.dependencies, schedulingEngine: { MAX_BOOKING_UNITS: 40, isLargeProject: async input => input.totalUnits >= 8 || input.totalEstimatedMinutes > 480 },
    projectCanUsePlanning, projectPaymentSummary, syncProjectPayment, projectPaymentFilter: paymentFilter,
    assertProjectPurchaseReady: require('../utils/orderProjectLifecycle').assertProjectPurchaseReady,
    audit: { logEvent: async () => {} }, createNotification: async value => notifications.push(value), console: { error() {} },
  });
  return async () => {
    let status = 200, body;
    await handler({ params: { id: projectId }, user: f.dependencies.actor, body: {}, app: { get: () => null } },
      { status(value) { status = value; return this; }, json(value) { body = value; } });
    return { status, body, notifications };
  };
}

test('actual approval route accepts a seven-unit multi-day repair after payment review and refuses unreviewed payment', async () => {
  const f = fixture(); const approve = approval(f); const pending = await approve();
  assert.equal(pending.status, 409); assert.equal(pending.body.code, 'PROJECT_PAYMENT_REVIEW_REQUIRED');
  assert.equal(f.project.status, 'pending_project_scheduling'); assert.equal(f.calls.writes.length, 0);
  await f.run(); const accepted = await approve(); assert.equal(accepted.status, 200, accepted.body.error);
  assert.equal(f.project.status, 'accepted'); assert.equal(f.project.isLargeScale, false);
  assert.equal(f.project.payment.amountPaid, 179); assert.equal(f.project.payment.balanceAmount, 3399);
  assert.equal(f.booking.status, 'pending_project_scheduling'); assert.equal(f.payment.events.length, 1);
});

test('approval permits a valid zero-deposit project but blocks insufficient received money and invalid scope', async () => {
  for (const [change, expected] of [
    [f => { f.booking.downpaymentAmount = 0; f.payment.status = 'failed'; }, 200],
    [f => { f.booking.downpaymentAmount = 0; f.payment.amount = 0; }, 200],
    [f => { f.payment.status = 'verified'; f.payment.amount = 100; }, 409],
    [f => { f.project.requestedUnitCount = 41; }, 409],
    [f => { f.booking.serviceDurationMinutes = 60; }, 409],
    [f => { f.booking.status = 'cancelled'; }, 409],
  ]) { const f = fixture(); change(f); const response = await approval(f)(); assert.equal(response.status, expected, response.body.error); }
});

test('the payment review route requires staff access and explicit confirmation before any write', async () => {
  const start = routeSource.indexOf('router.post("/projects/:id/verify-payment",'); const end = routeSource.indexOf('\n});', start);
  let handler, writes = 0;
  vm.runInNewContext(routeSource.slice(start, end + 4), { router: { post(_path, guard, fn) { assert.equal(guard, 'staff'); handler = fn; } },
    auth: { requireRole: roles => { assert.deepEqual(Array.from(roles), ['admin', 'secretary']); return 'staff'; } },
    mongoose: { Types: { ObjectId: { isValid: value => /^[a-f\d]{24}$/.test(String(value)) } } }, Project: {}, BookingService: {}, Payment: {},
    verifyProjectPayment: async () => { writes++; return {}; }, audit: { logEvent: async () => {} }, console: { error() {} } });
  for (const body of [{ paymentId }, { paymentId, receiptConfirmed: 'true' }, { paymentId: 'invalid', receiptConfirmed: true }]) {
    let status; await handler({ params: { id: projectId }, body }, { status(value) { status = value; return this; }, json() {} });
    assert.equal(status, 400); assert.equal(writes, 0);
  }
});

test('the project payment view displays the real pending deposit separately from received money', () => {
  const start = page.indexOf('  function customerPayment(data)'); const end = page.indexOf('\n  function fmtDate', start);
  const read = vm.runInNewContext(page.slice(start, end) + '\ncustomerPayment;');
  const d = data(); const value = read({ ...d, payments: [d.payment], paymentSummary: projectPaymentSummary(d.project, d.booking, [d.payment]) });
  assert.equal(value.total, 3578); assert.equal(value.submittedAmount, 179); assert.equal(value.amountPaid, 0);
  assert.equal(value.balanceAfterReview, 3399); assert.equal(value.method, 'gcash');
  assert.equal(value.proofUrl, '/api/appointments/' + bookingId + '/payment-proof');
});

test('repair collection does not treat an inspection estimate as an approved repair quote or a pending deposit as received', () => {
  const pricing = calculateProjectCustomerPricing({ project: { payment: { totalAmount: 3578 }, totalUnits: 7 },
    booking: { serviceType: 'repair', travelFare: 78, downpaymentAmount: 179, amountPaid: 0 }, workOrders: [], dailyRows: [] });
  assert.equal(pricing.pricingReady, false); assert.equal(pricing.alreadyPaid, 0);
  const approved = calculateProjectCustomerPricing({ project: { payment: { amountPaid: 179 }, totalUnits: 7,
    quotationReview: { status: 'approved', totalAmount: 5000 } }, booking: { serviceType: 'repair', travelFare: 78, amountPaid: 179 }, workOrders: [], dailyRows: [] });
  assert.equal(approved.total, 5078); assert.equal(approved.alreadyPaid, 179); assert.equal(approved.balance, 4899);
});

test('the confirmation button prevents repeat clicks, reports failures and restores controls for a retry', async () => {
  const start = page.indexOf('  window.verifyProjectSubmittedPayment ='); const end = page.indexOf('\n  //', start);
  let reply, requests = 0, closed = 0, reloads = 0;
  const window = {}, input = { checked: true, disabled: false }, button = { disabled: false, textContent: 'Confirm payment received' }, message = {};
  const close = { disabled: false, click() { closed++; } };
  const section = { querySelector: selector => selector === 'input' ? input : button };
  const modal = { querySelector: () => close, querySelectorAll: selector => selector === 'section' ? [section] : [input, button, close] };
  vm.runInNewContext(page.slice(start, end), { window, projectId, toast() {}, loadProject: async () => { reloads++; },
    fetch: async (_url, options) => { requests++; assert.equal(JSON.parse(options.body).receiptConfirmed, true); return new Promise(resolve => { reply = resolve; }); } });
  input.checked = false; await window.verifyProjectSubmittedPayment(paymentId, input, button, message, modal); assert.equal(requests, 0);
  input.checked = true;
  const saving = window.verifyProjectSubmittedPayment(paymentId, input, button, message, modal);
  await window.verifyProjectSubmittedPayment(paymentId, input, button, message, modal);
  assert.equal(requests, 1); assert.equal(button.disabled, true); assert.equal(input.disabled, true);
  reply({ ok: false, json: async () => ({ error: 'Temporary connection problem' }) }); await saving;
  assert.equal(message.textContent, 'Temporary connection problem'); assert.equal(button.disabled, false);
  assert.equal(window.__projectPaymentBusy, false); assert.equal(reloads, 0); assert.equal(closed, 0);
  const retry = window.verifyProjectSubmittedPayment(paymentId, input, button, message, modal);
  reply({ ok: true, json: async () => ({ success: true }) }); await retry;
  assert.equal(requests, 2); assert.equal(closed, 1); assert.equal(reloads, 1); assert.equal(window.__projectPaymentBusy, false);
});
