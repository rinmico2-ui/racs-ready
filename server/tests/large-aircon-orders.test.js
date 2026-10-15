"use strict";

const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { validateCheckoutSelection, validateCheckoutItems } = require('../utils/orderCheckoutPolicy');
const { validateInstallationWindow, installationWorkload, checkInstallationWindow, buildInstallationProject } = require('../utils/orderInstallationProject');
const { purchasePaymentSummary, validatePurchaseSerials, assertProjectPurchaseReady } = require('../utils/orderProjectLifecycle');
const { persistOrderCheckout } = require('../utils/orderCheckoutWrite');
const engine = require('../utils/enterpriseSchedulingEngine');
const Order = require('../models/Order'), Booking = require('../models/BookingService'), Project = require('../models/Project'), Payment = require('../models/Payment');
const userId = new mongoose.Types.ObjectId(), itemId = new mongoose.Types.ObjectId();
const preferences = { preferredStartDate: '2035-01-02', preferredCompletionDeadline: '2035-01-10' };
const purchaseData = () => ({ _id: new mongoose.Types.ObjectId(), userId, checkoutRequestId: 'large-order-checkout-token',
  fulfillmentType: 'delivery_installation', isProject: true, projectScheduling: { ...validateInstallationWindow(preferences), estimatedTotalHours: 10 },
  items: [{ inventoryId: itemId, quantity: 10, modelLine: 'Split', brand: 'Carrier', capacity: '1', unitPrice: 20000, totalPrice: 200000 }],
  delivery: { address: 'Customer installation site', contactNumber: '09171234567', preferredDate: new Date('2035-01-01T16:00:00Z'), coordinates: { type: 'Point', coordinates: [121, 14] } },
  paymentMethod: 'cod', paymentChannel: 'gcash', total: 200000, downpaymentAmount: 20000, downpaymentPercentage: 10, balanceAmount: 180000 });

test('project installation selection requires two valid future dates, while ordinary checkout still requires time', () => {
  const input = { fulfillmentType: 'delivery_installation', paymentMethod: 'cod', timeSlot: '',
    delivery: { address: 'Customer installation site', contactNumber: '09171234567', preferredDate: preferences.preferredStartDate, coordinates: { lat: 15.4863, lng: 120.9671 } }, projectScheduling: preferences };
  const result = validateCheckoutSelection(input, { isProject: true });
  assert.equal(result.timeSlot, null);
  assert.equal(result.projectScheduling.preferredCompletionDeadline.toISOString(), '2035-01-09T16:00:00.000Z');
  assert.throws(() => validateCheckoutSelection({ ...input, isProject: true }), error => error.code === 'ORDER_TIME_REQUIRED');
  for (const invalid of [null, {}, { ...preferences, preferredCompletionDeadline: '2035-01-02' },
    { ...preferences, preferredStartDate: '2020-01-01' }, { ...preferences, preferredStartDate: '2035-02-30' },
    { ...preferences, preferredCompletionDeadline: '2037-01-01' }]) assert.throws(() => validateInstallationWindow(invalid));
  assert.throws(() => validateInstallationWindow(preferences, new Date('2035-01-03')));
});

test('ten and forty installations are projects and large pickup orders remain pickup orders', async t => {
  for (const quantity of [10, 40]) assert.equal((await installationWorkload([{ quantity }], 'delivery_installation')).isProject, true);
  assert.equal((await installationWorkload([{ quantity: 40 }], 'customer_pickup')).isProject, false);
  t.mock.method(engine, 'isLargeProject', async input => input.totalEstimatedMinutes > 6 * 60);
  assert.equal((await installationWorkload([{ quantity: 7 }], 'delivery_installation')).isProject, true);
  assert.throws(() => validateCheckoutItems([{ inventoryId: String(itemId), quantity: 41 }]));
});

test('capacity checks use server-derived installation hours rather than browser workload claims', async t => {
  let args;
  t.mock.method(engine, 'getProjectWindowAvailability', async input => { args = input; return { sufficient: false, earliestCompletionDate: '2035-01-12' }; });
  const result = await checkInstallationWindow([{ inventoryId: String(itemId), quantity: 10 }], { ...preferences, estimatedTotalHours: 1, totalUnits: 1 });
  assert.equal(args.requiredHours, 10); assert.equal(args.totalUnits, 10); assert.equal(result.sufficient, false);
  assert.equal(result.earliestCompletionDate, '2035-01-12');
});

test('the installation mirror preserves all bought units, models and HP without another customer charge', async () => {
  const order = new Order(purchaseData());
  const ids = { bookingId: new mongoose.Types.ObjectId(), projectId: new mongoose.Types.ObjectId() };
  const plan = buildInstallationProject(order, { _id: userId, firstName: 'Maria', lastName: 'Santos' }, ids);
  const booking = new Booking(plan.booking), project = new Project(plan.project);
  await booking.validate(); await project.validate();
  assert.equal(booking.quantity, 10); assert.equal(booking.serviceDurationMinutes, 600); assert.equal(booking.paymentMethod, 'other');
  assert.equal(booking.services[0].unitPrice, 0); assert.equal(booking.services[0].brand, 'Carrier');
  assert.equal(booking.services[0].hpDescription, '1 HP'); assert.equal(project.unitGroups[0].units.length, 10);
  assert.equal(project.unitGroups[0].model, 'Split'); assert.equal(String(project.sourceOrderId), String(order._id));
  assert.equal(project.plannedCompletionDate, undefined); assert.equal(booking.startTime, undefined);
  assert.equal(project.payment.totalAmount, 0);
  assert.equal(require('../utils/revenueRecognition').bookingApprovedValue(booking), 0);
});

function writeFixture(failure) {
  const state = { stock: 20, orders: [], payments: [], bookings: [], projects: [], cartRemoved: false };
  const docs = key => class {
    constructor(data) { Object.assign(this, data); this._id ||= new mongoose.Types.ObjectId(); }
    async save() { if (!state[key].includes(this)) state[key].push(this); if (failure === key) throw new Error(key + ' write failed'); }
    static async deleteOne(filter) { state[key] = state[key].filter(row => String(row._id) !== String(filter._id)); }
    static async deleteMany() { state[key] = []; }
  };
  const args = { mongoose: { Types: mongoose.Types, connection: { getClient: () => ({ topology: { description: { servers: new Map([['local', { type: 'Standalone' }]]) } } }) } },
    Order: docs('orders'), Payment: docs('payments'), BookingService: docs('bookings'), Project: docs('projects'),
    Inventory: { findOneAndUpdate: async (_, update) => { state.stock += update.$inc.quantity; return {}; }, updateOne: async (_, update) => { state.stock += update.$inc.quantity; return { matchedCount: 1 }; } },
    HVACProduct: {}, AirconCart: {}, orderData: purchaseData(), enrichedItems: [{ inventoryId: itemId, quantity: 10 }],
    requestedItems: [{ inventoryId: String(itemId), quantity: 10 }], cartItemIds: null, user: { _id: userId, firstName: 'Maria' }, receiptPresent: true };
  return { args, state };
}

test('standalone bulk checkout persists the purchase, payment, booking and project with shared references', async () => {
  const { args, state } = writeFixture(); const order = await persistOrderCheckout(args);
  assert.equal(state.stock, 10); assert.equal(state.orders.length, 1); assert.equal(state.payments.length, 1);
  assert.equal(state.bookings.length, 1); assert.equal(state.projects.length, 1);
  assert.equal(String(order.projectId), String(state.projects[0]._id)); assert.equal(String(order.bookingId), String(state.bookings[0]._id));
  assert.equal(String(state.payments[0].orderId), String(order._id)); assert.equal(state.projects[0].unitGroups[0].units.length, 10);
});

test('failed planning writes compensate every owned record and restore all ten stock units', async () => {
  for (const failure of ['bookings', 'projects']) {
    const { args, state } = writeFixture(failure);
    await assert.rejects(persistOrderCheckout(args), /write failed/);
    assert.equal(state.stock, 20); assert.equal(state.orders.length, 0); assert.equal(state.payments.length, 0);
    assert.equal(state.bookings.length, 0); assert.equal(state.projects.length, 0);
  }
});

test('the purchase ledger distinguishes submitted proof, received deposits, final collection and refunds', () => {
  const order = purchaseData();
  const pending = { amount: 20000, status: 'pending' };
  assert.equal(purchasePaymentSummary(order, [pending]).amountPaid, 0);
  const partial = purchasePaymentSummary(order, [{ ...pending, status: 'verified' }]);
  assert.equal(partial.amountPaid, 20000); assert.equal(partial.balance, 180000);
  const paid = purchasePaymentSummary(order, [{ ...pending, status: 'verified' }, { amount: 180000, status: 'waiting_for_remittance' }]);
  assert.equal(paid.balance, 0);
  assert.equal(purchasePaymentSummary(order, [{ amount: 200000, status: 'refunded', refundAmount: 200000 }]).amountPaid, 0);
});

test('purchase project approval and departure enforce payment, ownership and physical preparation', async t => {
  const project = { _id: new mongoose.Types.ObjectId(), sourceOrderId: new mongoose.Types.ObjectId() };
  const order = { ...purchaseData(), _id: project.sourceOrderId, projectId: project._id, paymentStatus: 'pending', status: 'pending_payment', preparation: { dispatch: { status: 'pending' } } };
  let payments = [{ amount: 20000, status: 'pending' }];
  t.mock.method(Order, 'findById', () => ({ session() { return this; }, then(resolve) { return Promise.resolve(order).then(resolve); } }));
  t.mock.method(Payment, 'find', () => ({ session() { return this; }, lean: async () => payments }));
  await assert.rejects(assertProjectPurchaseReady(project), error => error.code === 'ORDER_PAYMENT_NOT_VERIFIED');
  payments = [{ amount: 20000, status: 'verified' }]; order.paymentStatus = 'partial'; order.status = 'preparing_unit';
  await assertProjectPurchaseReady(project);
  await assert.rejects(assertProjectPurchaseReady(project, { prepared: true }), error => error.code === 'ORDER_PREPARATION_REQUIRED');
  order.preparation.dispatch.status = 'ready'; await assertProjectPurchaseReady(project, { prepared: true });
  order.status = 'cancelled'; await assert.rejects(assertProjectPurchaseReady(project));
});

test('large-order handover requires one distinct serial number for every purchased unit', () => {
  const order = purchaseData(); const serials = Array.from({ length: 10 }, (_, index) => ` AC-${index} `);
  assert.equal(validatePurchaseSerials(order, serials)[0], 'AC-0');
  assert.throws(() => validatePurchaseSerials(order, serials.slice(1)), error => error.code === 'ORDER_SERIAL_NUMBERS_REQUIRED');
  assert.throws(() => validatePurchaseSerials(order, [...serials.slice(1), 'ac-1']), error => error.code === 'ORDER_SERIAL_NUMBERS_DUPLICATE');
});

test('prepaid project handover completes the purchase and snapshots warranty for all recorded serials', async t => {
  const project = { _id: new mongoose.Types.ObjectId(), sourceOrderId: new mongoose.Types.ObjectId(), actualCompletionDate: new Date('2035-01-04T08:00:00Z') };
  const order = new Order({ ...purchaseData(), _id: project.sourceOrderId, projectId: project._id, status: 'installing', paymentStatus: 'paid' });
  let saves = 0;
  t.mock.method(order, 'save', async () => { await order.validate(); saves++; });
  t.mock.method(Order, 'findById', async () => order);
  t.mock.method(Payment, 'find', () => ({ lean: async () => [{ amount: 200000, status: 'verified' }] }));
  t.mock.method(require('../utils/productReturnPolicy'), 'assertNoReturnSerialConflict', async () => {});
  const policy = require('../utils/aftercarePolicy');
  t.mock.method(policy, 'getAftercarePolicy', async () => policy.DEFAULT_AFTERCARE_POLICY);
  const serials = Array.from({ length: 10 }, (_, index) => `INSTALLED-${index}`);
  await require('../utils/orderProjectLifecycle').recordProjectOrderStage(project, 'completed', null, serials);
  assert.equal(order.status, 'completed'); assert.equal(order.balanceAmount, 0);
  assert.deepEqual(Array.from(order.items[0].serialNumbers), serials);
  assert.equal(order.preparation.installation.status, 'completed');
  assert.equal(order.completedAt.toISOString(), project.actualCompletionDate.toISOString());
  assert.equal(saves, 1); assert.ok(order.warranty?.startDate);
});

test('unsettled purchase balances cannot bypass project handover, and confirmed crews avoid a false response deadline', async t => {
  const project = { _id: new mongoose.Types.ObjectId(), sourceOrderId: new mongoose.Types.ObjectId(), assignedTechnicians: [] };
  const order = new Order({ ...purchaseData(), _id: project.sourceOrderId, projectId: project._id, status: 'preparing_unit', paymentStatus: 'partial' });
  let saves = 0;
  t.mock.method(order, 'save', async () => { saves++; });
  t.mock.method(Order, 'findById', async () => order);
  t.mock.method(Payment, 'find', () => ({ lean: async () => [{ amount: 20000, status: 'verified' }] }));
  const lifecycle = require('../utils/orderProjectLifecycle');
  await assert.rejects(lifecycle.recordProjectOrderStage(project, 'completed', null, []), error => error.code === 'ORDER_BALANCE_REQUIRED');
  assert.equal(saves, 0); assert.equal(order.status, 'preparing_unit');
  await lifecycle.recordProjectOrderStage(project, 'ready');
  assert.equal(order.status, 'technician_accepted'); assert.equal(order.technicianAcceptance.status, 'accepted');
});

test('customers request a new project range without a time slot and cannot alter a confirmed plan', async t => {
  const order = new Order({ ...purchaseData(), projectId: new mongoose.Types.ObjectId(), status: 'preparing_unit' });
  const project = { _id: order.projectId, status: 'pending_project_scheduling', scheduleLocked: false };
  t.mock.method(Order, 'findById', async () => order);
  t.mock.method(Project, 'findOne', () => ({ lean: async () => project }));
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  t.mock.method(engine, 'getProjectWindowAvailability', async () => ({ sufficient: true }));
  let writes = 0, saved;
  t.mock.method(Order, 'findOneAndUpdate', async (filter, update) => { writes++; saved = update.$set.rescheduleRequest; return order; });
  const router = require('../routes/orderRoutes');
  const handler = router.stack.find(layer => layer.route?.path === '/:id/reschedule-request').route.stack.at(-1).handle;
  async function request(actor = userId) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: String(order._id) }, body: { requestedDate: '2035-01-03', requestedEndDate: '2035-01-12', reason: 'Site access changed' }, user: { _id: actor, role: 'customer' }, app: { get: () => null } }, res);
    return res;
  }
  assert.equal((await request(new mongoose.Types.ObjectId())).code, 403); assert.equal(writes, 0);
  assert.equal((await request()).code, 200); assert.equal(saved.requestedEndDate, '2035-01-12'); assert.equal(saved.requestedTime, '');
  order.rescheduleRequest = undefined; project.scheduleLocked = true;
  assert.equal((await request()).code, 409); assert.equal(writes, 1);
});
