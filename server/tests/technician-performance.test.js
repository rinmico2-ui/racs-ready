'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const { createService } = require('../utils/technicianDailyKitRead');
const { createQueue } = require('../utils/dailyKitRefresh');
const { preparationRead } = require('../utils/preparationRead');
const { timedMiddleware } = require('../utils/requestTiming');
const { technicianAssignmentScope } = require('../utils/technicianWorkSync');
const { presentTechnicianApiPayload } = require('../utils/technicianDataPresentation');
const id = number => String(number).padStart(24, '0');
const now = new Date('2026-10-23T01:00:00Z');
function query(value) { return { select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value }; }
function kitFixture() {
  const calls = [], refreshes = [];
  const booking = { _id: id(2), technicianId: id(3), assignmentId: id(1), serviceType: 'core', status: 'confirmed', bookingDate: now, startTime: '09:00' };
  const assignment = { _id: id(1), technicianId: id(3), bookingId: booking, serviceType: 'core', status: 'accepted', bookingDate: now, startTime: '09:00' };
  const state = { kit: { _id: id(4), status: 'confirmed', workDate: now, assignmentIds: [id(1)], orderIds: [], dailyAssignmentIds: [],
    items: [{ name: 'Vacuum pump', quantityIssued: 1, preparedChecked: true }], deltaItems: [], automaticSyncedAt: now }, assignments: [assignment], orders: [], projects: [] };
  const deps = { now: () => now, refresh: (...args) => refreshes.push(args), shared: { async read() { return []; } } };
  for (const [model, key] of [['Kit', 'kit'], ['Assignment', 'assignments'], ['Order', 'orders'], ['DailyAssignment', 'projects']]) {
    deps[model] = { [model === 'Kit' ? 'findOne' : 'find'](filter) { calls.push({ model, filter }); return query(state[key]); } };
  }
  return { state, calls, refreshes, read: date => createService(deps).read(id(3), date || now) };
}

test('viewing a current kit uses read-only queries and preserves issued equipment without synchronizing stock', async () => {
  const f = kitFixture(), before = structuredClone(f.state);
  const result = await f.read();
  assert.deepEqual(f.state, before); assert.equal(result.preparationPending, false);
  assert.equal(result.jobDetails.length, 1); assert.equal(result.kit.items[0].quantityIssued, 1);
  assert.equal(result.refreshPending, false);
  assert.equal(f.calls.length, 4); assert.equal(f.refreshes.length, 0);
  for (const call of f.calls) assert.equal(call.filter.technicianId || call.filter.$or?.[0].technicianId, id(3));
});

test('new coverage returns immediately as preparing and queues one background synchronization', async () => {
  const f = kitFixture(); f.state.kit = null;
  const result = await f.read();
  assert.equal(result.preparationPending, true); assert.equal(result.jobDetails.length, 1);
  assert.deepEqual(result.kit.items, []); assert.equal(f.refreshes.length, 1);
  assert.equal(f.refreshes[0][0], id(3));
});

test('a new job cannot inherit an old kit confirmation and removed jobs are not shown as current work', async () => {
  const f = kitFixture(); f.state.kit.assignmentIds = [id(99)];
  assert.equal((await f.read()).preparationPending, true);
  f.state.assignments[0].bookingId.status = 'cancelled';
  const cancelled = await f.read();
  assert.equal(cancelled.jobDetails.length, 0); assert.equal(cancelled.preparationPending, true);
  assert.equal(cancelled.kit.items[0].quantityIssued, 1, 'Read does not erase custody');
});

test('an empty date does not create a kit or run a stock transaction', async () => {
  const f = kitFixture(); f.state.kit = null; f.state.assignments = [];
  const result = await f.read('2026-10-24');
  assert.equal(result.preparationPending, false); assert.equal(result.jobDetails.length, 0); assert.equal(f.refreshes.length, 0);
});

test('old saved preparation is displayed while its availability refresh is queued', async () => {
  const f = kitFixture(); f.state.kit.automaticSyncedAt = new Date(now - 120000);
  const result = await f.read();
  assert.equal(result.preparationPending, false); assert.equal(result.kit.status, 'confirmed'); assert.equal(f.refreshes.length, 1);
  assert.equal(result.refreshPending, true, 'Clients refresh the displayed availability when planning completes');
});

test('read coverage includes only primary installation orders and open project work', async () => {
  const f = kitFixture(); f.state.assignments = []; f.state.kit = null;
  f.state.orders = [{ _id: id(5), technicianId: id(3), orderReference: 'ORDER-1', status: 'technician_accepted' },
    { _id: id(6), technicianId: id(99), orderReference: 'SUPPORT', status: 'technician_accepted' }];
  f.state.projects = [{ _id: id(7), projectId: { _id: id(8), status: 'active' }, workOrderId: { _id: id(9), status: 'pending', title: 'Installation' } },
    { _id: id(10), projectId: { _id: id(11), status: 'completed' }, workOrderId: { _id: id(12), status: 'pending' } },
    { _id: id(13), projectId: { _id: id(14), status: 'active' }, workOrderId: { _id: id(15), status: 'rescheduled' } }];
  const result = await f.read();
  assert.deepEqual(result.jobDetails.map(job => job.serviceType), ['order_installation', 'project']);
  assert.equal(result.preparationPending, true); assert.equal(f.refreshes.length, 1);
});

test('kit refreshes are bounded, coalesce duplicate requests and share the monitor lease', async () => {
  const timers = [], calls = [];
  let active = 0, peak = 0;
  const queue = createQueue({ limit: 2, schedule: fn => timers.push(fn),
    lock: async (key, work) => { calls.push(key); return work(); },
    async sync(_tech, _date, options) { active++; peak = Math.max(peak, active); assert.equal(options.automatic, true); await Promise.resolve(); active--; } });
  assert.equal(queue.enqueue(id(3), now), true); assert.equal(queue.enqueue(id(3), now), true);
  assert.equal(queue.enqueue(id(5), now), true); assert.equal(queue.enqueue(id(6), now), false);
  assert.equal(queue.size, 2); assert.equal(timers.length, 1);
  await timers[0](); assert.equal(peak, 1); assert.equal(calls.length, 2); assert.equal(queue.size, 0);
  assert.match(calls[0], /^daily-kit-generation:/);
});

test('a failed refresh releases its slot and can be retried without reporting success', async () => {
  let fail = true; const warnings = [], work = [];
  const queue = createQueue({ schedule: fn => work.push(fn), lock: async (_key, fn) => fn(), warn: (...args) => warnings.push(args),
    async sync() { if (fail) throw Error('Temporary outage'); } });
  queue.enqueue(id(3), now); await work.shift()();
  assert.equal(queue.size, 0); assert.equal(warnings.length, 1);
  fail = false; queue.enqueue(id(3), now); await work.shift()(); assert.equal(queue.size, 0);
});

test('planning reuses identical reads only within one operation and distinguishes service names', async () => {
  let reads = 0; const options = { readCache: new Map() };
  const load = expression => preparationRead(options, 'catalog', { name: expression }, async () => { reads++; return expression.source; });
  const result = await Promise.all([load(/^Cleaning$/i), load(/^Cleaning$/i), load(/^Repair$/i)]);
  assert.deepEqual(result, ['^Cleaning$', '^Cleaning$', '^Repair$']); assert.equal(reads, 2);
  await preparationRead({ readCache: new Map() }, 'catalog', { name: /^Cleaning$/i }, () => { reads++; });
  assert.equal(reads, 3);
});

test('date and status constrain lifecycle scope reads before pagination', async () => {
  let captured;
  const filter = { status: { $in: ['accepted', 'in_progress'] }, bookingDate: { $gte: now } };
  const scope = await technicianAssignmentScope(id(3), { filter,
    Assignments: { find(value) { captured = value; return query([]); } },
    Bookings: { find() { assert.fail('No parent reads are needed for an empty date'); } } });
  assert.deepEqual(captured, { ...filter, technicianId: id(3) }); assert.equal(scope.technicianId, id(3));
});

test('normal technician responses exclude inline arrival/start photos but retain captured timestamps', () => {
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024);
  const source = { assignment: { _id: id(1), status: 'in_progress', arrivalProofUrl: image, startProofUrl: image, proofPhoto: image, arrivalProofCapturedAt: now, startProofCapturedAt: now } };
  const payload = presentTechnicianApiPayload(source);
  assert.equal(payload.assignment.arrivalProofUrl, undefined); assert.equal(payload.assignment.startProofUrl, undefined);
  assert.equal(payload.assignment.startProofCapturedAt, now);
  assert.equal(payload.assignment.hasCompletionProof, true); assert.equal(payload.assignment.proofPhoto, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < Buffer.byteLength(JSON.stringify(source)) / 1000);
  assert.equal(source.assignment.startProofUrl, image, 'Stored evidence is unchanged');
});

test('middleware stage timing ends before downstream work and records rejected responses too', async () => {
  const req = {}, res = new EventEmitter(); let finish;
  const downstream = new Promise(resolve => { finish = resolve; });
  timedMiddleware('identity', (_req, _res, next) => next())(req, res, () => downstream);
  assert.equal(typeof req.performanceTimings.identity, 'number'); assert.equal(res.listenerCount('finish'), 0);
  finish();
  const denied = {}; let loggedIdentity;
  res.once('finish', () => { loggedIdentity = denied.performanceTimings?.identity; });
  timedMiddleware('identity', (_req, response) => response.emit('finish'))(denied, res, () => assert.fail('Rejected request cannot continue'));
  assert.equal(typeof denied.performanceTimings.identity, 'number');
  assert.equal(typeof loggedIdentity, 'number', 'Timing is available before the telemetry finish listener logs the response');
});

const api = fs.readFileSync(require.resolve('../routes/technicianApi'), 'utf8');
function detailFixture({ owner = id(3), includeResources = true, failure } = {}) {
  const calls = [], pending = [];
  const tech = { _id: id(3), user: id(30), location: { lat: 15, lng: 121 } };
  const booking = { _id: id(2), technicianId: owner, status: 'confirmed', totalPrice: 1000, customer: { name: 'Customer' } };
  const assignment = { _id: id(1), bookingId: id(2), technicianId: tech._id, serviceType: 'core', status: 'accepted' };
  const resources = name => ({ find(filter) {
    calls.push({ name, filter });
    return { select(fields) { calls.at(-1).select = fields; return this; }, populate() { return this; }, sort() { return this; },
      lean() { return new Promise((resolve, reject) => pending.push(() => failure === name ? reject(Error('Unavailable')) : resolve([{ _id: id(10), status: name }]))); } };
  } });
  const begin = api.indexOf('router.get("/assignments/:id",'), start = api.indexOf('async (req, res, next) => {', begin), end = api.indexOf('\n});', start);
  const handler = vm.runInNewContext('(' + api.slice(start, end + 2) + ')', {
    require(name) {
      if (name.endsWith('/Assignment')) return { findOne() { assert.fail('The access guard already read this assignment'); } };
      if (name.endsWith('/Payment')) return resources('payments');
      if (name.endsWith('/StockReservation')) return resources('parts');
      throw Error('Unexpected dependency: ' + name);
    }, mongoose: require('mongoose'), Technician: { findOne() { assert.fail('The access guard already read this technician'); } },
    EquipmentAssignment: resources('equipment'), getNoShowWaitMinutes: async () => 20,
    assignmentWorkDecision: require('../utils/technicianWorkSync').assignmentWorkDecision,
    presentTechnicianBooking: require('../utils/technicianDataPresentation').presentTechnicianBooking, assertNotMissedSchedule: () => false,
  });
  let response;
  return { calls, pending, async read() {
    const reading = handler({ params: { id: assignment._id }, query: includeResources ? { includeResources: '1' } : {},
      technicianWorkContext: { tech, assignment, booking } }, { json(value) { response = value; } }, error => { throw error; });
    await Promise.resolve();
    for (const release of pending) release();
    await reading;
    return response;
  } };
}

test('detail reuses authenticated records and reads the primary technician resources in parallel', async () => {
  const f = detailFixture(), result = await f.read();
  assert.equal(f.pending.length, 3, 'All resource queries started before any was released');
  assert.deepEqual(f.calls.map(call => call.name), ['equipment', 'payments', 'parts']);
  for (const call of f.calls) assert.equal(String(call.filter.bookingId), id(2));
  assert.doesNotMatch(f.calls[1].select, /proof|reference|gcash/i);
  assert.equal(result.assignment.resourceHistoryIncluded, true); assert.equal(result.assignment.noShowWaitMinutes, 20);
  assert.equal(result.assignment.payments.length, 1); assert.equal(result.techLocation.lat, 15);
});

test('supporting or replaced technicians receive no primary resource history', async () => {
  const f = detailFixture({ owner: id(99) }), result = await f.read();
  assert.equal(f.calls.length, 0); assert.equal(result.assignment.resourceHistoryIncluded, true);
  for (const field of ['equipmentItems', 'payments', 'reservedParts']) assert.equal(result.assignment[field].length, 0);
});

test('legacy ownership keeps equipment/payment access without granting reserved-parts access', async () => {
  const f = detailFixture({ owner: id(30) }), result = await f.read();
  assert.deepEqual(f.calls.map(call => call.name), ['equipment', 'payments']);
  assert.equal(result.assignment.reservedParts.length, 0);
});

test('resource history is optional and a failed history read cannot hide the visit', async () => {
  const without = detailFixture({ includeResources: false });
  assert.equal((await without.read()).assignment.resourceHistoryIncluded, undefined); assert.equal(without.calls.length, 0);
  const failed = detailFixture({ failure: 'payments' }), result = await failed.read();
  assert.equal(result.assignment.status, 'accepted'); assert.equal(result.assignment.payments.length, 0);
  assert.equal(result.assignment.equipmentItems.length, 1);
});

const page = fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'), 'utf8');
test('saved status updates render immediately while a slow workspace refresh remains in the background', async () => {
  let requests = 0, notices = [], renders = 0;
  const row = { _id: id(1), status: 'en_route', bookingId: { _id: id(2), status: 'on-the-way' }, payments: [], equipmentItems: [], reservedParts: [] };
  const window = { _detailAssignment: row, _currentDetailId: id(1),
    TechnicianWorkUpdates: { beginMutation: () => () => new Promise(() => {}) },
    _btnLoading: (_button, work) => work(),
    async showDetail(_id, snapshot) { assert.equal(snapshot.assignment.status, 'on_site'); assert.equal(snapshot.assignment.bookingId.status, 'arrived'); renders++; } };
  const context = { window, allItems: [row], currentFilter: 'active', renderCardPage() {}, renderTodayWorkOrder() {},
    fetch: async () => { requests++; return { ok: true, json: async () => ({ assignment: { _id: id(1), status: 'on_site', bookingId: id(2) }, bookingStatus: 'arrived' }) }; },
    captureArrivalProof: async () => ({ arrivalProofUrl: 'data:image/png;base64,synthetic' }),
    showNotification: notice => notices.push(notice), setTimeout() {} };
  const applyStart = page.indexOf('    window.applySavedAssignment ='), applyEnd = page.indexOf('    let detailLoadSequence', applyStart);
  const start = page.indexOf('    window.transitionStatus = async function'), end = page.indexOf('    window.markNoShow', start);
  vm.runInNewContext(page.slice(applyStart, applyEnd) + page.slice(start, end), context);
  await window.transitionStatus(id(1), 'on_site', null);
  assert.equal(requests, 1); assert.equal(renders, 1); assert.equal(notices[0].title, 'Status Updated');
  assert.equal(window.allItems[0].status, 'on_site'); assert.equal(window.allItems[0].bookingId.status, 'arrived');
});
