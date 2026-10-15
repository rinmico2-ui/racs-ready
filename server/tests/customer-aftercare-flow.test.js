'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const Asset = require('../models/CustomerAsset');
const Schedule = require('../models/MaintenanceSchedule');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const { DEFAULT_AFTERCARE_POLICY: policy } = require('../utils/aftercarePolicy');
const { syncMaintenanceFromOrder, syncMaintenanceFromBooking, orderAssetSeeds } = require('../utils/maintenanceLifecycle');
const { reconcileMissingAftercare } = require('../utils/maintenanceScheduler');
const { bindWorkflowRefresh } = require('../public/js/customer-workflow-refresh');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const id = '507f191e810c19729de860ea', customerId = '507f191e810c19729de860eb';
const query = value => ({ sort() { return this; }, select() { return this; }, limit() { return this; },
  lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

function store(t) {
  const assets = new Map(), cycles = new Map(); let writes = 0;
  t.mock.method(Asset, 'findOneAndUpdate', async (filter, update) => {
    writes++;
    const prior = assets.get(filter.assetKey);
    const row = prior || { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert };
    Object.assign(row, update.$set);
    assets.set(filter.assetKey, row);
    return row;
  });
  t.mock.method(Asset, 'findByIdAndUpdate', async (assetId, update) => {
    const row = [...assets.values()].find(asset => String(asset._id) === String(assetId));
    Object.assign(row, update); return row;
  });
  t.mock.method(Asset, 'updateOne', async () => ({ modifiedCount: 1 }));
  t.mock.method(Schedule, 'findOne', filter => query(filter.cycleKey ? cycles.get(filter.cycleKey) : null));
  t.mock.method(Schedule, 'create', async data => {
    assert.ok(!cycles.has(data.cycleKey));
    const row = { _id: new mongoose.Types.ObjectId(), ...data };
    cycles.set(data.cycleKey, row); return row;
  });
  return { assets, cycles, get writes() { return writes; } };
}
function installedOrder() {
  return { _id: id, userId: customerId, status: 'completed', fulfillmentType: 'delivery_installation',
    completedAt: new Date('2026-10-11T04:00:00Z'), orderReference: 'ORD-TEST',
    delivery: { address: 'Saved service address', lat: 15.4, lng: 121.1 },
    items: [{ inventoryId: id, isHvac: true, brand: 'Carrier', modelLine: 'Nexus', capacity: 1,
      quantity: 2, serialNumbers: ['UNIT-A', 'UNIT-B'] }] };
}

test('an installed order and its linked booking create one aftercare record per aircon, including on retry', async t => {
  const db = store(t), order = installedOrder();
  const assets = await syncMaintenanceFromOrder(order, { policy });
  assert.equal(assets.length, 2);
  const linked = { _id: customerId, sourceOrderId: id, status: 'completed', customerId,
    services: [{ _id: id, name: 'Installation', quantity: 2 }] };
  assert.deepEqual(await syncMaintenanceFromBooking(linked, { policy }), []);
  await syncMaintenanceFromOrder(order, { policy });
  assert.equal(db.assets.size, 2);
  assert.equal(db.cycles.size, 2);
  assert.deepEqual([...db.assets.values()].map(asset => asset.equipment.serialNumber), ['UNIT-A', 'UNIT-B']);
  for (const asset of db.assets.values()) {
    assert.equal(asset.serviceAddress, order.delivery.address);
    assert.equal(asset.serviceLocation.lat, 15.4);
    assert.ok(asset.latestScheduleId);
  }
});

test('aftercare recovery repairs partial aircon writes and missing cycles, then skips complete records', async t => {
  const db = store(t), order = installedOrder();
  const seed = orderAssetSeeds(order)[0];
  db.assets.set(seed.assetKey, { _id: new mongoose.Types.ObjectId(), ...seed, status: 'active', maintenanceIntervalDays: 90 });
  t.mock.method(Booking, 'find', filter => { assert.equal(filter.sourceOrderId, null); return query([]); });
  t.mock.method(Order, 'find', () => query([order]));
  t.mock.method(Asset, 'find', () => query([...db.assets.values()]));
  t.mock.method(Schedule, 'find', () => query([...db.cycles.values()]));
  const settings = require('../models/SiteSetting');
  t.mock.method(settings, 'findOne', () => query(null));
  assert.equal(await reconcileMissingAftercare(), 1);
  assert.equal(db.assets.size, 2);
  assert.equal(db.cycles.size, 2);
  const writes = db.writes;
  assert.equal(await reconcileMissingAftercare(), 0);
  assert.equal(db.writes, writes);
});

test('pickup completion saves aircons but waits for an installation date before starting reminders', async t => {
  const db = store(t), order = { ...installedOrder(), fulfillmentType: 'customer_pickup', delivery: {} };
  await syncMaintenanceFromOrder(order, { policy });
  assert.equal(db.assets.size, 2);
  assert.equal(db.cycles.size, 0);
  for (const asset of db.assets.values()) assert.equal(asset.status, 'installation_date_required');
});

test('My Schedule reads only the customer records without hiding cancelled, repair or reassignment states', async () => {
  const rows = ['pending_reassignment', 'reschedule-required', 'cancelled', 'repair_scheduled', 'repair_completed']
    .map((status, index) => ({ _id: String(index), customerId, status, bookingDate: '2026-10-12' }));
  let handler, filter, limit;
  const feed = read('routes/pages.js').match(/router\.get\("\/tracking\/data",[\s\S]*?\n\}\);/)[0];
  const context = { Date, pageAuth: { requireRole: role => { assert.equal(role, 'customer'); return () => {}; } },
    router: { get(...args) { handler = args.at(-1); } }, require(name) {
      if (name.endsWith('/BookingService')) return { find(value) { filter = value;
        return { select() { return this; }, populate() { return this; }, sort() { return this; },
          limit(value) { limit = value; return this; }, lean: async () => rows }; } };
      if (name.endsWith('/Project')) return { find: () => query([]) };
      if (name.endsWith('/WorkOrder') || name.endsWith('/DailyAssignment')) return {};
      if (name.endsWith('/projectPricing')) return {};
      throw Error(name);
    } };
  vm.runInNewContext(feed, context);
  let result;
  await handler({ user: { _id: customerId } }, { json: data => { result = data; } }, error => { throw error; });
  assert.equal(filter.customerId, customerId);
  assert.equal(filter.status, undefined);
  assert.equal(limit, 100);
  assert.deepEqual(result.bookings.map(row => row.status), rows.map(row => row.status));
});

test('old mutation shortcuts cannot skip assignment ownership, toolkit, payment or proof', async () => {
  const response = () => ({ status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } });
  const contexts = [];
  const auth = { authenticate() {}, requireRole() { return () => {}; } };
  const appointments = read('routes/appointmentRoutes.js');
  for (const action of ['on-the-way', 'in-progress', 'complete', 'mark-paid']) {
    const start = appointments.indexOf(`router.post(\n  "/:id/${action}",`);
    assert.ok(start >= 0);
    const segment = appointments.slice(start, appointments.indexOf('\n);', start) + 4);
    const context = { auth, router: { post(...args) { contexts.push(args.at(-1)); } } };
    vm.runInNewContext(segment, context);
  }
  const source = read('routes/bookingFlow.js');
  const start = source.indexOf('router.post("/:id/sync-status"');
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), { auth,
    router: { post(...args) { contexts.push(args.at(-1)); } } });
  for (const handler of contexts) {
    const res = response(); await handler({ body: { status: 'completed', markComplete: true } }, res);
    assert.equal(res.code, 409); assert.equal(res.body.code, 'ASSIGNMENT_WORKFLOW_REQUIRED');
  }
});

function refreshFixture() {
  const events = {}, listeners = {}, timers = new Map(); let next = 0, modal = false;
  const doc = { hidden: false, querySelector: () => modal ? {} : null,
    addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener() {} };
  const win = { setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { listeners.poll = fn; return ++next; }, clearInterval() {}, addEventListener() {}, console };
  const socket = { on(name, fn) { events[name] = fn; }, off() {} };
  return { win, doc, socket, events, listeners, timers, set modal(value) { modal = value; },
    async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); } };
}
test('live status refresh groups updates, waits for open forms and resumes when a hidden tab returns', async () => {
  const f = refreshFixture(); let loads = 0;
  const binding = bindWorkflowRefresh({ window: f.win, document: f.doc, socket: f.socket, refresh: async () => { loads++; } });
  f.modal = true;
  f.events['booking:status-change'](); f.events['order:status-change']();
  assert.equal(f.timers.size, 1);
  await f.tick(); assert.equal(loads, 0);
  f.modal = false; await f.tick(); assert.equal(loads, 1);
  f.doc.hidden = true; f.events.connect(); f.listeners.poll(); assert.equal(f.timers.size, 0);
  f.doc.hidden = false; f.listeners.visibilitychange(); await f.tick(); assert.equal(loads, 2);
  binding.stop(); f.events['booking:status-change'](); assert.equal(f.timers.size, 0);
});

test('a status event during a request schedules another read, without parallel reads', async () => {
  const f = refreshFixture(); let loads = 0, resolve;
  bindWorkflowRefresh({ window: f.win, document: f.doc, socket: f.socket,
    refresh: () => { loads++; return loads === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(); } });
  f.events['booking:status-change'](); const running = f.tick();
  f.events['order:status-change'](); assert.equal(f.timers.size, 0);
  resolve(); await running; await f.tick(); assert.equal(loads, 2);
});

test('customer appointment payment totals include a verified partial receipt and exclude pending or rejected proof', async () => {
  const source = read('routes/appointmentRoutes.js');
  const start = source.indexOf('    // Attach related payment records and compute amountPaid');
  const end = source.indexOf('    // Merge large-scale project data', start);
  const appt = { _id: id };
  const context = { appt, Payment: { find: () => query([
    { amount: 600, status: 'partial' }, { amount: 100, status: 'paid' },
    { amount: 999, status: 'pending' }, { amount: 888, status: 'rejected' },
  ]) }, console: { warn: () => assert.fail('Unexpected payment error') } };
  await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context);
  assert.equal(appt.amountPaid, 700);
});

test('My Schedule never treats the required downpayment as received money, or creates a second order balance', () => {
  const source = read('views/pages/tracking.ejs');
  const start = source.indexOf('    // Payment summary');
  const end = source.indexOf('    const quantity =', start);
  for (const amountPaid of [0, 600, 1200]) {
    const evaluate = vm.runInNewContext(`(b) => { ${source.slice(start, end)} return { paid, balance, showPayment }; }`);
    const booking = { totalPrice: 1200, downpaymentAmount: 600, amountPaid };
    assert.equal(evaluate(booking).paid, amountPaid);
    assert.equal(evaluate(booking).balance, 1200 - amountPaid);
    assert.equal(evaluate({ ...booking, sourceOrderId: id }).showPayment, false);
  }
});

test('tracking detail refresh does not select a job after the customer has switched jobs', async () => {
  const source = read('views/pages/tracking.ejs');
  const start = source.indexOf('  async function trkLoadBooking(');
  const end = source.indexOf('  window.showListView', start);
  let resolve, renders = 0;
  const context = { currentBookingId: id, bookings: [{ _id: id }], isRatingModalOpen: false,
    document: { getElementById: () => null, querySelector: () => null },
    fetch: () => new Promise(done => { resolve = done; }), normalizeFetchedBooking: row => row,
    refreshSelected: () => { renders++; } };
  vm.runInNewContext(source.slice(start, end), context);
  const request = context.trkLoadBooking(id, { quiet: true });
  context.currentBookingId = customerId;
  resolve({ ok: true, json: async () => ({ appointment: { _id: id, status: 'completed' } }) });
  await request;
  assert.equal(context.currentBookingId, customerId);
  assert.equal(renders, 0);
  assert.equal(context.bookings[0].status, 'completed');
});

test('maintenance cards, reminders and counts use the same Manila day at midnight', () => {
  const { effectiveScheduleStatus } = require('../utils/maintenanceLifecycle');
  const { reminderFor } = require('../utils/maintenanceScheduler');
  const { summaryPipeline } = require('../utils/maintenanceSummary');
  const now = new Date('2026-10-10T16:01:00Z'); // October 11 in Manila.
  const due = { status: 'upcoming', dueDate: '2026-10-11T02:00:00Z' };
  assert.equal(effectiveScheduleStatus(due, now), 'due');
  assert.equal(reminderFor(due, now).type, 'maintenance_due');
  assert.equal(effectiveScheduleStatus({ status: 'upcoming', dueDate: '2026-10-10T10:00:00Z' }, now), 'overdue');
  const boundaries = summaryPipeline({}, now, 30)[1].$set.effectiveStatus.$cond[1].$switch.branches;
  assert.equal(boundaries[0].case.$lt[1].toISOString(), '2026-10-10T16:00:00.000Z');
  assert.equal(boundaries[1].case.$lt[1].toISOString(), '2026-10-11T16:00:00.000Z');
});
