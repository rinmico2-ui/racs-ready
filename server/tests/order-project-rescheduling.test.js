const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Booking = require('../models/BookingService');
const Project = require('../models/Project');
const Assignment = require('../models/Assignment');
const engine = require('../utils/enterpriseSchedulingEngine');
const scheduling = require('../utils/orderResolutionScheduling');
const { orderResolutionCase } = require('../utils/resolutionCenter');
const routes = require('../routes/orderRoutes');
const id = '507f191e810c19729de860ea', customerId = '507f191e810c19729de860eb';
function fixture(extra = {}) {
  return new Order({ _id: id, userId: customerId, orderReference: 'ORD-20260827-REGG', status: 'preparing_unit',
    fulfillmentType: 'delivery_installation', customer: { name: 'Jamie', phone: '09170000000' },
    items: [{ inventoryId: id, brand: 'Carrier', modelLine: 'Split', quantity: 8 }],
    delivery: { address: 'Customer site', preferredDate: new Date('2020-01-01') }, timeSlot: '09:00', ...extra });
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; return this; } }; }
async function invoke(route, method, body = {}, query = {}) {
  const fn = routes.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack.at(-1).handle;
  const res = response();
  await fn({ params: { id }, body, query, user: { _id: customerId, role: 'admin', name: 'Admin' }, app: { get: () => null } }, res);
  return res;
}
function mockProject(t, sufficient = true) {
  t.mock.method(require('../utils/audit'), 'logEvent', async () => {});
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  t.mock.method(Project, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(engine, 'getProjectWindowAvailability', async input => ({ sufficient, window: input }));
}

test('installation orders use unit count, linked work hours, and configured thresholds for project date selection', () => {
  assert.equal(scheduling.orderWorkload(fixture().toObject()).isProject, true);
  const standard = fixture({ items: [{ inventoryId: id, quantity: 7 }] }).toObject();
  assert.equal(scheduling.orderWorkload(standard).isProject, false);
  assert.equal(scheduling.orderWorkload(standard, 6).isProject, true);
  const hourly = { ...standard, items: [{ quantity: 2 }], bookingId: { _id: id, serviceDurationMinutes: 600 } };
  assert.equal(scheduling.orderWorkload(hourly).isProject, true);
  assert.equal(scheduling.orderWorkload(hourly).totalEstimatedMinutes, 600);
  assert.equal(scheduling.orderWorkload({ ...hourly, fulfillmentType: 'delivery_only' }).isProject, false);
  const item = orderResolutionCase(fixture().toObject());
  assert.equal(item.isProject, true); assert.equal(item.totalUnits, 8); assert.equal(item.totalEstimatedMinutes, 480);
});

test('saving a large order keeps both preferred dates and creates linked planning records without a time slot', async t => {
  mockProject(t);
  const session = { withTransaction: async commit => commit(), endSession: async () => {} };
  t.mock.method(mongoose, 'startSession', async () => session);
  let booking, project, assignedSession, orderSession;
  t.mock.method(Booking.prototype, 'save', async function (options) { await this.validate(); booking = this; assert.equal(options.session, session); });
  t.mock.method(Project, 'create', async (docs, options) => { project = new Project(docs[0]); await project.validate(); assert.equal(options.session, session); return [project]; });
  t.mock.method(Assignment, 'updateMany', async (_, __, options) => { assignedSession = options.session; return {}; });
  const order = fixture();
  t.mock.method(order, 'save', async options => { await order.validate(); orderSession = options.session; });
  const result = await scheduling.saveOrderProjectWindow(order, { scheduledDate: '2035-01-02', endDate: '2035-01-06',
    projectScheduling: { preferredWorkingDays: ['monday', 'saturday'], preferredWorkingHours: { start: 'afternoon' } } }, { _id: customerId, role: 'admin' });
  assert.equal(result.isProject, true); assert.equal(order.isProject, true); assert.equal(order.timeSlot, null);
  assert.equal(order.projectScheduling.preferredStartDate.toISOString(), '2035-01-01T16:00:00.000Z');
  assert.equal(order.projectScheduling.preferredCompletionDeadline.toISOString(), '2035-01-05T16:00:00.000Z');
  assert.equal(order.rescheduleRequest.requestedEndDate, '2035-01-06');
  assert.equal(String(order.bookingId), String(booking._id)); assert.equal(String(project.bookingId), String(booking._id));
  assert.equal(booking.status, 'pending_project_scheduling'); assert.equal(booking.startTime, undefined);
  assert.equal(project.totalUnits, 8); assert.equal(project.unitGroups[0].units.length, 8);
  assert.equal(orderSession, session); assert.equal(assignedSession, session);
});

test('invalid or insufficient project windows cannot save an order or its booking', async t => {
  mockProject(t, false);
  let writes = 0;
  t.mock.method(Booking.prototype, 'save', async () => { writes++; });
  const order = fixture();
  t.mock.method(order, 'save', async () => { writes++; });
  for (const input of [{ scheduledDate: '2035-01-02', timeSlot: '09:00' }, { scheduledDate: '2035-01-02', endDate: '2035-01-01' }, { scheduledDate: '2035-01-02', endDate: '2035-01-06' }]) {
    await assert.rejects(scheduling.saveOrderProjectWindow(order, input, { _id: customerId }));
  }
  assert.equal(writes, 0); assert.equal(order.isProject, false); assert.equal(order.timeSlot, '09:00');
});

test('staff calendar metadata and capacity validation ignore browser classification and workload overrides', async t => {
  mockProject(t);
  t.mock.method(Order, 'findById', async () => fixture());
  const metadata = await invoke('/:id/admin-reschedule-availability', 'get', {}, { isProject: false, quantity: 1 });
  assert.equal(metadata.code, 200); assert.equal(metadata.body.scheduling.isProject, true); assert.equal(metadata.body.scheduling.totalUnits, 8);
  let input;
  t.mock.method(engine, 'getProjectWindowAvailability', async value => { input = value; return { sufficient: true }; });
  const verdict = await invoke('/:id/admin-project-window-availability', 'post', { startDate: '2035-01-02', endDate: '2035-01-06', requiredHours: 1, totalUnits: 1 });
  assert.equal(verdict.code, 200); assert.equal(input.requiredHours, 8); assert.equal(input.totalUnits, 8);
});

test('the order save endpoint accepts a project range and rejects missing or lost capacity without writing', async t => {
  mockProject(t, false);
  let writes = 0;
  const order = fixture();
  t.mock.method(order, 'save', async () => { writes++; });
  t.mock.method(Order, 'findById', async () => order);
  // Use the route's real lease helper with in-memory storage.
  const Lock = require('../models/OperationLock');
  t.mock.method(Lock, 'findOneAndUpdate', (_, update) => ({ lean: async () => ({ owner: update.$set.owner }) }));
  t.mock.method(Lock, 'deleteOne', async () => ({}));
  const missing = await invoke('/:id/admin-reschedule', 'post', { scheduledDate: '2035-01-02' });
  assert.equal(missing.code, 400); assert.match(missing.body.error, /finish-by/);
  const lost = await invoke('/:id/admin-reschedule', 'post', { scheduledDate: '2035-01-02', endDate: '2035-01-06' });
  assert.equal(lost.code, 409); assert.equal(lost.body.refreshSlots, true); assert.equal(writes, 0);
});

test('the order endpoint successfully saves a project window and announces Operations planning', async t => {
  mockProject(t);
  const order = fixture(); let saved = false, notification;
  t.mock.method(Order, 'findById', async () => order);
  t.mock.method(order, 'save', async () => { await order.validate(); saved = true; });
  t.mock.method(Booking.prototype, 'save', async function () { await this.validate(); });
  t.mock.method(Project, 'create', async () => []);
  t.mock.method(Assignment, 'updateMany', async () => ({}));
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async commit => commit(), endSession: async () => {} }));
  const Lock = require('../models/OperationLock');
  t.mock.method(Lock, 'findOneAndUpdate', (_, update) => ({ lean: async () => ({ owner: update.$set.owner }) }));
  t.mock.method(Lock, 'deleteOne', async () => ({}));
  t.mock.method(require('../utils/notify'), 'createNotification', async value => { notification = value; });
  const res = await invoke('/:id/admin-reschedule', 'post', { scheduledDate: '2035-01-02', endDate: '2035-01-06' });
  assert.equal(res.code, 200, JSON.stringify(res.body)); assert.equal(saved, true);
  assert.equal(res.body.order.isProject, true); assert.equal(res.body.order.timeSlot, null);
  assert.equal(res.body.order.rescheduleRequest.requestedEndDate, '2035-01-06');
  assert.match(res.body.message, /Operations/); assert.match(notification.message, /2035-01-02 through 2035-01-06/);
});

test('the order modal initializes the customer project picker and submits both dates without an appointment time', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AttentionQueue.ejs'), 'utf8');
  const body = source.slice(source.indexOf('  let openingOrderSchedule = false;'), source.indexOf('  async function reschedulePickupOrder('));
  let options, payload, init;
  const calendar = { init: async value => { init = value; }, getSelectedDate: () => new Date(2035, 0, 2), getSelectedEndDate: () => new Date(2035, 0, 6),
    getSelectedSlot: () => null, getWindowVerdict: () => ({ sufficient: true }), formatDateKey: value => `${value.getFullYear()}-01-${String(value.getDate()).padStart(2, '0')}`,
    getProjectSelection: () => ({ endDate: new Date(2035, 0, 6), preferences: { workingDays: ['monday'], preferredWorkingHours: 'afternoon' } }) };
  const Swal = { getHtmlContainer: () => ({ querySelector: () => ({ value: 'Customer agreed' }) }), isLoading: () => false,
    fire: async value => { options = value; value.didOpen(); await value.preConfirm(); return { isConfirmed: false }; }, showValidationMessage: assert.fail };
  const context = { window: { Swal, EnterpriseCalendar: calendar }, Swal, EnterpriseCalendar: calendar, console,
    contactActions: () => '', escapeHtml: value => value, showToast: assert.fail,
    fetch: async (url, value) => {
      if (value?.method === 'POST') { payload = JSON.parse(value.body); return { ok: true, json: async () => ({ success: true }) }; }
      return { ok: true, json: async () => ({ scheduling: { isProject: true, totalUnits: 8, totalEstimatedMinutes: 480 } }) };
    } };
  vm.runInNewContext(body, context);
  await context.rescheduleDeliveryOrder({ id, reference: 'ORD-REGG', fulfillmentType: 'delivery_installation', itemCount: 8 });
  assert.equal(init.mode, 'project'); assert.equal(init.quantity, 8); assert.equal(init.showStartDatePrompt, false);
  assert.match(options.html, /id="projectPrefs"/); assert.equal(options.confirmButtonText, 'Save project window');
  assert.equal(payload.scheduledDate, '2035-01-02'); assert.equal(payload.endDate, '2035-01-06'); assert.equal(payload.timeSlot, undefined);
  assert.equal(payload.projectScheduling.preferredWorkingHours.start, 'afternoon');
});
