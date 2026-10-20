'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), mongoose = require('mongoose');
const sift = require('sift').default;
const recovery = require('../utils/visitRecovery'), emergency = require('../utils/orderEmergency');
const { atomicWorkflowChanges } = require('../utils/atomicWorkflowChanges');
const { orderResolutionCase, filterResolutionCases } = require('../utils/resolutionCenter');
const id = n => n.toString(16).padStart(24, '0');
const B = id(1), O = id(2), T = id(3), S = id(4), A = id(5), U = id(6), I = id(7);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const at = '2026-10-19T13:00:00.000Z', date = '2026-10-19T00:00:00+08:00';
function fixture({ failAt = 0, noTeam = false, slotUnavailable = false } = {}) {
  let store = { booking: { _id: B, __v: 0, updatedAt: at, status: 'pending_reassignment', bookingDate: date, startTime: '20:00', endTime: '21:00',
    serviceType: 'mixed', serviceDurationMinutes: 90, paymentMethod: 'cash_after_service', paymentChannel: 'cash', paymentStatus: 'partial', amountPaid: 200, balanceAmount: 1300, totalPrice: 1500,
    staffingEmergencies: [{ _id: I, reportedAt: at, reportedBy: T, reporterName: 'Tech', assignmentId: A, reason: 'Vehicle breakdown', team: [{ technicianId: T, name: 'Tech' }] }],
    technicianId: null, technicianTeam: [], services: [{ type: 'core', name: 'Cleaning', status: 'completed', serviceReportId: id(11) },
      { type: 'repair', name: 'Repair', status: 'ready_for_repair', phase: 'repair_phase_2', units: [{ unitIndex: 1, repairReview: { state: 'approved', revision: 2 } }] }] },
  order: { _id: O, __v: 0, updatedAt: at, status: 'out_for_delivery', userId: U, total: 5000, paymentStatus: 'partial', amountPaid: 1000, balanceAmount: 4000,
    fulfillmentType: 'delivery_installation', delivery: { preferredDate: date }, timeSlot: '20:00', technicianId: T, technician: { name: 'Primary' },
    technicianAcceptance: { status: 'accepted' }, items: [{ inventoryId: id(9), brand: 'Demo', quantity: 1, unitPrice: 5000 }],
    technicianTeam: noTeam ? [] : [{ technicianId: T, name: 'Primary', status: 'accepted' }, { technicianId: S, name: 'Support', status: 'accepted' }],
    preparation: { dispatch: { status: 'ready', readyBy: U, readyAt: at, note: 'Units verified by staff.' } } },
  assignments: [{ _id: A, __v: 0, bookingId: B, technicianId: T, status: 'accepted', serviceType: 'mixed', bookingDate: date }] };
  const real = { booking: require('../models/BookingService'), order: require('../models/Order'), assignments: require('../models/Assignment') };
  let writes = 0; const locks = [];
  const query = value => ({ lean: async () => clone(value) });
  const rows = name => name === 'assignments' ? store.assignments : [store[name]];
  const models = {};
  for (const [name, label] of [['booking', 'Booking'], ['order', 'Order'], ['assignments', 'Assignment']]) models[label] = {
    findById: key => query(rows(name).find(row => row && String(row._id) === String(key))),
    find: filter => query(rows(name).filter(sift(filter))),
    async findOneAndUpdate(filter, update) {
      const row = rows(name).find(sift(filter)); if (!row) return null;
      if (++writes === failAt) throw Error('Synthetic write failed');
      for (const [key, value] of Object.entries(update.$set || {})) { const parts = key.split('.'); let object = row;
        while (parts.length > 1) object = object[parts.shift()] ||= {}; object[parts[0]] = clone(value); }
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      row.__v += Number(update.$inc?.__v || 0);
      await real[name].hydrate(row).validate();
      return clone(row);
    },
  };
  const database = { Types: mongoose.Types, isValidObjectId: mongoose.isValidObjectId, connection: {}, startSession: async () => ({
    async withTransaction(fn) { const snapshot = clone(store); try { await fn(); } catch (error) { store = snapshot; throw error; } }, async endSession() {} }) };
  const shared = { ...models, mongoose: database, lock: async (key, fn) => { locks.push(key); return fn(); }, write: changes => atomicWorkflowChanges(changes, database), now: () => new Date(at) };
  const schedule = async () => { if (slotUnavailable) throw Object.assign(Error('Slot unavailable'), { status: 409 });
    return { date: '2026-10-19', dateObj: new Date(date), time: '22:00', endTime: '1430' }; };
  return { get store() { return store; }, get writes() { return writes; }, models, shared, locks,
    service: recovery.createService({ ...shared, bookingSchedule: schedule, orderSchedule: schedule }),
    report: (support = false) => emergency.createService(shared).report(O, { _id: support ? S : T, name: support ? 'Support' : 'Primary' }, { reason: 'vehicle_breakdown', details: 'Vehicle stopped on the road.' }),
    input: () => ({ requestId: 'recovery-request-001', expectedUpdatedAt: at, decision: 'late_visit', contactMethod: 'call', customerConfirmed: true,
      notes: 'Customer agreed to a replacement arriving later tonight.', date: '2026-10-19', time: '22:00' }),
  };
}
test('saving customer agreement preserves mixed-service evidence and all recorded money', async () => {
  const f = fixture(), before = clone(f.store.booking), result = await f.service.recover('booking', B, f.input(), { _id: U, name: 'Admin' });
  assert.equal(result.job.status, 'pending_reassignment'); assert.equal(result.job.startTime, '22:00');
  assert.equal(result.job.visitRecoveryHistory[0].incidentId, I); assert.equal(result.job.visitRecoveryHistory[0].customerConfirmed, true);
  assert.equal(result.job.services[0].status, 'completed'); assert.deepEqual(result.job.services[0], before.services[0]);
  assert.equal(result.job.services[1].status, 'ready_for_repair'); assert.deepEqual(result.job.services[1].units, before.services[1].units);
  for (const key of ['amountPaid', 'balanceAmount', 'totalPrice', 'paymentMethod']) assert.equal(result.job[key], before[key]);
  assert.equal(f.store.assignments[0].status, 'expired'); assert.equal(result.job.technicianId, null);
  assert.doesNotThrow(() => recovery.assertContact('booking', result.job)); assert.equal(f.locks.length, 2);
});
test('a retry returns the saved visit without duplicating agreement or assignments', async () => {
  const f = fixture(), input = f.input(); await f.service.recover('booking', B, input, { _id: U }); const writes = f.writes;
  const result = await f.service.recover('booking', B, input, { _id: U }); assert.equal(result.duplicate, true); assert.equal(f.writes, writes);
});
test('customer confirmation, contact details, exact reply and a current case are required before mutation', async () => {
  for (const changed of [{ customerConfirmed: false }, { contactMethod: '' }, { notes: 'No' }, { expectedUpdatedAt: '2026-10-18' }, { requestId: '' }]) {
    const f = fixture(), before = clone(f.store); await assert.rejects(f.service.recover('booking', B, { ...f.input(), ...changed }, { _id: U }));
    assert.deepEqual(f.store, before); assert.equal(f.writes, 0);
  }
});
test('unavailable slots and work already underway leave records untouched', async () => {
  const unavailable = fixture({ slotUnavailable: true }); await assert.rejects(unavailable.service.recover('booking', B, unavailable.input(), {}), /Slot unavailable/);
  assert.equal(unavailable.writes, 0);
  for (const status of ['in-progress', 'cancelled', 'completed']) {
    const f = fixture(); f.store.booking.status = status; await assert.rejects(f.service.recover('booking', B, f.input(), {})); assert.equal(f.writes, 0);
  }
});
test('assignment writes roll back when one document cannot be saved', async () => {
  const f = fixture({ failAt: 2 }), before = clone(f.store); await assert.rejects(f.service.recover('booking', B, f.input(), {}), /Synthetic write failed/); assert.deepEqual(f.store, before);
});
for (const support of [false, true]) test(`order ${support ? 'supporting' : 'primary'} technician can report en-route emergency for the whole team`, async () => {
  const f = fixture(), before = clone(f.store.order), result = await f.report(support);
  assert.equal(result.order.status, 'technician_declined'); assert.equal(result.order.technicianId, null); assert.deepEqual(result.order.technicianTeam, []);
  assert.equal(result.incident.reporterRole, support ? 'support' : 'primary'); assert.equal(result.incident.team.length, 2);
  assert.equal(result.order.amountPaid, before.amountPaid); assert.equal(result.order.balanceAmount, before.balanceAmount);
  assert.deepEqual(result.incident.previousPreparation, before.preparation);
  assert.equal(result.order.preparation.dispatch.status, 'pending'); assert.equal(result.order.preparation.installation.status, 'pending');
  assert.throws(() => recovery.assertContact('order', result.order), error => error.code === 'CUSTOMER_CONTACT_REQUIRED');
  const writes = f.writes; assert.equal((await f.report(support)).duplicate, true); assert.equal(f.writes, writes);
});
test('order emergency supports legacy single-technician deliveries and rejects strangers and started work', async () => {
  const f = fixture({ noTeam: true }); assert.equal((await f.report()).incident.team.length, 1);
  const other = fixture(); await assert.rejects(emergency.createService(other.shared).report(O, { _id: U }, { reason: 'emergency' }), error => error.status === 403);
  other.store.order.status = 'installing'; await assert.rejects(other.report(), /Continue on another visit/); assert.equal(other.writes, 0);
});
test('order recovery commits the installation mirror together and preserves order payments', async () => {
  const f = fixture(); f.store.order.bookingId = B; f.store.booking.sourceOrderId = O; f.store.booking.status = 'assigned';
  await f.report(true); const input = { ...f.input(), expectedUpdatedAt: f.store.order.updatedAt };
  const result = await f.service.recover('order', O, input, { _id: U, name: 'Admin' });
  assert.equal(result.job.status, 'preparing_unit'); assert.equal(result.job.timeSlot, '22:00'); assert.equal(f.store.booking.startTime, '22:00');
  assert.equal(f.store.booking.technicianId, null); assert.equal(result.job.amountPaid, 1000); assert.equal(result.job.balanceAmount, 4000);
  assert.equal(result.job.visitRecoveryHistory.length, 1); assert.equal(f.store.booking.visitRecoveryHistory.length, 1);
});
test('order emergency rolls back its parent when the installation mirror write fails', async () => {
  const f = fixture({ failAt: 2 }); f.store.order.bookingId = B; f.store.booking.sourceOrderId = O; f.store.booking.status = 'assigned';
  const before = clone(f.store); await assert.rejects(f.report(), /Synthetic write failed/); assert.deepEqual(f.store, before);
});
test('future order emergencies and waiting replacement cases remain visible; past-date filter includes overdue orders', () => {
  const f = fixture(); const job = { ...f.store.order, status: 'technician_declined', technicianId: null, staffingEmergencies: f.store.booking.staffingEmergencies };
  const item = orderResolutionCase(job, new Date(at)); assert.equal(item.issueType, 'technician_issue'); assert.ok(item.recoveryAvailable);
  assert.equal(filterResolutionCases([item], { issue: 'emergency' }).length, 1);
  const pending = orderResolutionCase({ ...job, status: 'preparing_unit', visitRecoveryHistory: [{ customerConfirmed: true }] }, new Date(at));
  assert.match(pending.reason, /Assign the replacement/);
  const overdue = orderResolutionCase({ ...f.store.order, status: 'preparing_unit' }, new Date('2026-10-20T13:00Z'));
  assert.equal(filterResolutionCases([overdue], { issue: 'past_date' }).length, 1);
});
test('internal emergency details and customer contact notes stay out of customer order responses', () => {
  const value = recovery.customerOrder({ staffingEmergencies: [{ reportedAt: at, reason: 'Private emergency' }],
    visitRecoveryHistory: [{ recordedAt: at, notes: 'Private reply' }], technicianAcceptance: { status: 'declined', declineReason: 'Private emergency' },
    statusHistory: [{ status: 'technician_declined', timestamp: at, note: 'Private emergency' }] });
  assert.equal(value.staffingEmergencies, undefined); assert.equal(value.visitRecoveryHistory, undefined);
  assert.doesNotMatch(JSON.stringify(value), /Private/);
});
test('consent is tied to the incident and selected schedule, and cannot authorize another visit', () => {
  const f = fixture(), job = f.store.booking;
  job.visitRecoveryHistory = [{ customerConfirmed: true, incidentId: I, date: job.bookingDate, time: job.startTime }];
  assert.doesNotThrow(() => recovery.assertContact('booking', job));
  job.startTime = '23:00'; assert.throws(() => recovery.assertContact('booking', job));
  job.visitRecoveryHistory[0].time = '23:00'; job.staffingEmergencies[0]._id = id(99); assert.throws(() => recovery.assertContact('booking', job));
  const order = { delivery: { preferredDate: date }, timeSlot: '22:00', visitRecoveryHistory: [{ customerConfirmed: true }] };
  assert.doesNotThrow(() => recovery.assertRecoverySchedule('order', order, { scheduledDate: '2026-10-19', timeSlot: '22:00' }));
  assert.throws(() => recovery.assertRecoverySchedule('order', order, { timeSlot: '23:00' }), error => error.code === 'CUSTOMER_CONTACT_REQUIRED');
});
test('the recovery API permits operational staff and rejects customers and technicians before any mutation', async t => {
  const express = require('express'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../routes/standardJobTeamRoutes.js'), 'utf8');
  const start = source.indexOf("router.post('/:source/:id/recovery',"), end = source.indexOf('\n});', start);
  const f = fixture(), app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { _id: U, name: 'Staff', role: req.headers['x-test-role'] }; next(); });
  vm.runInNewContext(source.slice(start, end + 5), { router: app, staff: require('../middleware/authenticate').requireRole(['admin', 'secretary']),
    require: name => name.endsWith('visitRecovery') ? { createService: () => f.service, publish: async () => {} } : require('../utils/bookingDateTime') });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (role, key = B) => fetch(`http://127.0.0.1:${server.address().port}/booking/${key}/recovery`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(f.input()) });
  for (const role of ['customer', 'technician']) assert.equal((await post(role)).status, 403);
  assert.equal(f.writes, 0); assert.equal((await post('admin', 'bad-id')).status, 400);
  for (const role of ['admin', 'secretary']) { const response = await post(role); assert.equal(response.status, 200); assert.equal((await response.json()).time, '22:00'); }
  assert.equal(f.store.booking.visitRecoveryHistory.length, 1);
});
test('order emergency notification reaches admin, customer and every former team member with a required type', async () => {
  const f = fixture(), result = await f.report(true), notices = [], events = [], cleanup = [];
  await emergency.publish(result, { user: { _id: U }, app: { get: () => ({ to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) }) } }, {
    Technician: { find: () => ({ select() { return this; }, lean: async () => [{ user: T }, { user: S }] }) },
    notify: async row => { await new (require('../models/Notification'))(row).validate(); notices.push(row); },
    syncEquipment: async row => cleanup.push(row),
  });
  assert.equal(notices.length, 4); assert.ok(notices.every(row => row.type === 'assignment_update'));
  assert.match(notices.find(row => row.role === 'admin').link, /issue=emergency.*focus=order:/);
  assert.doesNotMatch(notices.find(row => String(row.userId) === U).message, /Vehicle stopped/);
  assert.ok([T, S].every(tech => events.some(row => row.room === `tech:${tech}`))); assert.equal(cleanup.length, 1);
});
