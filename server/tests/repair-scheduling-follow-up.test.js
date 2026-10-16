'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('../models/User');
const Booking = require('../models/BookingService'), Tool = require('../models/Tool'), Reservation = require('../models/StockReservation');
const teams = require('../utils/standardJobTeamService'), notify = require('../utils/notify');
const router = require('../routes/adminApi');
const id = number => number.toString(16).padStart(24, '0');
function query(value) { return { select() { return this; }, session() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
function fixture(t) {
  const booking = { _id: id(1), customerId: id(2), technicianId: id(3), technicianTeam: [{ technicianId: id(3) }, { technicianId: id(4) }], status: 'repair_approved', repairUnitTracking: true, serviceType: 'repair',
    services: [{ type: 'repair', units: [{ repairReview: { state: 'approved' }, quotation: { parts: [] } }] }], quotation: { parts: [] }, localPurchase: [] };
  const calls = [], messages = [];
  t.mock.method(Booking, 'findById', () => query(booking));
  t.mock.method(Reservation, 'find', () => query([{ toolId: id(6), quantity: 1 }]));
  t.mock.method(Tool, 'findOne', () => query({ quantity: 0, active: true }));
  t.mock.method(teams, 'createService', () => ({ assign: async (...args) => { calls.push(args); return { source: 'booking', job: booking, assignment: { _id: id(8) } }; } }));
  t.mock.method(teams, 'publish', async () => {});
  t.mock.method(notify, 'createNotification', async value => { messages.push(value); });
  const handler = router.stack.find(layer => layer.route?.path === '/repair-scheduling-queue/:id/assign').route.stack.at(-1).handle;
  async function schedule() {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: booking._id }, body: { technicianId: id(3), scheduledDate: '2035-01-02', scheduledTime: '08:00' }, user: { _id: id(9), role: 'admin' }, app: { get: () => null } }, res, error => { throw error; });
    return res;
  }
  return { booking, calls, messages, schedule };
}

test('same-day on-site repairs appear in the scheduling monitor and its aggregate totals', async t => {
  const records = [
    { _id: id(31), status: 'repair_in_progress', repairSchedule: { preference: 'today' }, approval: { method: 'on_site' }, repairExecution: { status: 'in_progress', startedAt: new Date('2026-10-19T02:00:00Z') } },
    { _id: id(32), status: 'repair_approved', repairSchedule: { preference: 'later' } },
    { _id: id(33), status: 'repair_scheduled', repairSchedule: { preference: 'later' } },
    { _id: id(34), status: 'repair_completed', repairSchedule: { preference: 'today' } },
  ].map(row => ({ ...row, quotation: { parts: [], totalCost: 650 }, customer: { name: 'Fixture customer' }, services: [] }));
  const matches = (row, filter) => Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some(item => matches(row, item));
    const actual = key.split('.').reduce((value, part) => value?.[part], row);
    return condition && typeof condition === 'object' && condition.$in ? condition.$in.includes(actual) : actual === condition;
  });
  const resultQuery = value => ({ populate() { return this; }, sort() { return this; }, lean: async () => value });
  t.mock.method(Booking, 'find', filter => resultQuery(records.filter(row => matches(row, filter))));
  t.mock.method(Booking, 'countDocuments', async filter => records.filter(row => matches(row, filter)).length);
  t.mock.method(require('../models/PartsRequest'), 'findOne', () => resultQuery(null));
  const call = async path => {
    let body; const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods.get).route.stack.at(-1).handle;
    await handler({}, { json(value) { body = value; } }, error => { throw error; }); return body;
  };
  const list = await call('/repair-scheduling-queue'), stats = await call('/repair-scheduling-queue/stats');
  assert.equal(list.bookings.length, 3); assert.equal(stats.total, 3); assert.equal(stats.inProgress, 1);
  assert.equal(stats.pendingScheduling, 1); assert.equal(stats.scheduled, 1);
  const current = list.bookings.find(row => row.status === 'repair_in_progress');
  assert.equal(current.repairTiming, 'today'); assert.equal(current.decisionMethod, 'on_site'); assert.equal(current.stockAvailable, true);
});
test('the repair scheduling queue preserves the support crew and delegates new visit acceptance to the canonical team workflow', async t => {
  const f = fixture(t), res = await f.schedule(); assert.equal(res.statusCode, 200);
  assert.deepEqual(f.calls[0][2].technicianIds, [id(3), id(4)]); assert.equal(f.calls[0][2].scheduledDate, '2035-01-02'); assert.equal(f.calls[0][4].repairVisit, true);
  assert.equal(f.messages[0].userId, id(2)); assert.match(f.messages[0].message, /2035-01-02/);
});
test('duplicate approved part lines cannot reuse one reserved part to schedule an understocked repair', async t => {
  const f = fixture(t), part = { name: 'Capacitor', toolId: id(6), quantity: 1, cost: 500 };
  f.booking.services[0].units[0].quotation.parts = [{ ...part }, { ...part }];
  const res = await f.schedule(); assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'PARTS_NOT_READY'); assert.equal(f.calls.length, 0);
});
test('verified nearby purchases cover only their received quantity, and incomplete receipts do not substitute for stock', async t => {
  const f = fixture(t), part = { name: 'Capacitor', toolId: id(6), quantity: 2, cost: 500 };
  f.booking.services[0].units[0].quotation.parts = [part];
  f.booking.localPurchase = [{ quotationKey: `id:${id(6)}`, quantity: 1, purchaseByType: 'technician', purchaseStatus: 'receipt_uploaded', actualPurchaseCost: 350 }];
  assert.equal((await f.schedule()).statusCode, 409);
  f.booking.localPurchase[0].receiptUrl = `/api/receipts/${id(7)}`;
  assert.equal((await f.schedule()).statusCode, 200); assert.equal(f.calls.length, 1);
});
