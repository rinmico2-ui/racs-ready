const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { createAdminReadCache } = require('../middleware/adminReadCache');
const reports = require('../utils/reportCache');
const { summaryPipeline } = require('../utils/maintenanceSummary');
const { measureRequest } = require('../utils/requestTiming');

class Response extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = {}; }
  set(name, value) { this.headers[name] = value; return this; }
  json(body) { return this.send(JSON.stringify(body)); }
  send(body) { this.body = body; this.writableFinished = true; this.emit('finish'); return this; }
}
function request(overrides = {}) {
  return { method: 'GET', originalUrl: '/api/admin/navigation-summary', authResolved: true,
    user: { _id: 'admin-1', role: 'admin' }, ...overrides };
}
async function read(cache, req = request(), body = { count: 1 }, status = 200) {
  const res = new Response();
  let calls = 0;
  await cache(req, res, () => { calls++; res.statusCode = status; res.json(body); });
  return { res, calls };
}

test('summary cache isolates administrators and exact query parameters', async () => {
  const cache = createAdminReadCache();
  assert.equal((await read(cache)).calls, 1);
  const hit = await read(cache);
  assert.equal(hit.calls, 0);
  assert.equal(hit.res.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(JSON.parse(hit.res.body), { count: 1 });
  assert.equal((await read(cache, request({ user: { _id: 'admin-2', role: 'admin' } }))).calls, 1);
  assert.equal((await read(cache, request({ originalUrl: '/api/admin/navigation-summary?range=7' }))).calls, 1);
});

test('summary cache never bypasses authentication, roles or record-detail authorization', async () => {
  const cache = createAdminReadCache();
  for (const overrides of [{ authResolved: false }, { user: null },
    { user: { _id: 'admin-1', role: 'secretary' } },
    { originalUrl: '/api/payments/507f1f77bcf86cd799439011' },
    { originalUrl: '/api/admin/dashboard/operations' }]) {
    const req = request(overrides);
    assert.equal((await read(cache, req)).calls, 1);
    assert.equal((await read(cache, req)).calls, 1);
  }
});

test('summary cache expires, rejects error responses and respects a bounded capacity', async () => {
  let now = 0;
  const cache = createAdminReadCache({ now: () => now, ttlMs: 100, maxEntries: 1 });
  await read(cache, request(), { error: true }, 500);
  assert.equal((await read(cache)).calls, 1);
  now = 101;
  assert.equal((await read(cache)).calls, 1);
  await read(cache, request({ originalUrl: '/api/projects/dashboard' }));
  assert.equal((await read(cache)).calls, 1);
});

test('concurrent summary readers share successful work, not failed work', async () => {
  for (const status of [200, 500]) {
    const cache = createAdminReadCache();
    const first = new Response();
    cache(request(), first, () => {});
    const second = new Response();
    let calls = 0;
    const waiting = cache(request(), second, () => { calls++; second.json({ retry: true }); });
    first.statusCode = status;
    first.json({ ready: true });
    await waiting;
    assert.equal(calls, status === 200 ? 0 : 1);
    assert.deepEqual(JSON.parse(second.body), status === 200 ? { ready: true } : { retry: true });
  }
});

test('mutations invalidate summaries both before and after writes and fence pending reads', async () => {
  const cache = createAdminReadCache();
  await read(cache);
  const write = new Response();
  cache(request({ method: 'PATCH', originalUrl: '/api/orders/one' }), write, () => {});
  assert.equal((await read(cache)).calls, 1);
  write.json({ saved: true });
  assert.equal((await read(cache)).calls, 1);

  cache.invalidate();
  const pending = new Response();
  cache(request(), pending, () => {});
  const waiter = read(cache);
  cache.invalidate();
  pending.json({ stale: true });
  assert.equal((await waiter).calls, 1);
  assert.equal((await read(cache)).calls, 1);
});

test('abandoned or all-pending summary slots do not poison subsequent requests', async () => {
  const cache = createAdminReadCache({ maxEntries: 1 });
  const abandoned = new Response();
  cache(request(), abandoned, () => {});
  assert.equal((await read(cache, request({ originalUrl: '/api/projects/dashboard' }))).calls, 1);
  const waiting = read(cache);
  abandoned.emit('close');
  assert.equal((await waiting).calls, 1);
  assert.equal((await read(cache)).calls, 1);
});

test('invalidated reporting promises cannot repopulate or delete replacement cache entries', async () => {
  reports.clearAll();
  let release;
  const first = reports.remember('fence-test', {}, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  reports.clearAll();
  assert.equal(await reports.remember('fence-test', {}, () => 2), 2);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await reports.remember('fence-test', {}, () => 3), 2);
  reports.clearAll();
  let reject;
  const failure = reports.remember('fence-test', {}, () => new Promise((_, fail) => { reject = fail; }));
  await Promise.resolve();
  reports.clearAll();
  await reports.remember('fence-test', {}, () => 4);
  reject(new Error('old failure'));
  await assert.rejects(failure, /old failure/);
  assert.equal(await reports.remember('fence-test', {}, () => 5), 4);
  reports.clearAll();
});

// A small expression interpreter exercises badge policy fixtures without a live DB.
function evaluate(expression, row) {
  if (typeof expression === 'string' && expression.startsWith('$')) {
    return expression.slice(1).split('.').reduce((value, key) => value?.[key], row);
  }
  if (!expression || typeof expression !== 'object' || expression instanceof Date) return expression;
  if (Array.isArray(expression)) return expression.map(item => evaluate(item, row));
  const [operator, input] = Object.entries(expression)[0];
  if (operator === '$switch') {
    const branch = input.branches.find(item => evaluate(item.case, row));
    return evaluate(branch ? branch.then : input.default, row);
  }
  const values = evaluate(input, row);
  switch (operator) {
    case '$cond': return values[0] ? values[1] : values[2];
    case '$ifNull': return values[0] ?? values[1];
    case '$in': return values[1].includes(values[0]);
    case '$and': return values.every(Boolean);
    case '$or': return values.some(Boolean);
    case '$eq': return values[0] === values[1];
    case '$ne': return values[0] !== values[1];
    case '$lt': return values[0] < values[1];
    case '$gte': return values[0] >= values[1];
    case '$lte': return values[0] <= values[1];
    default: throw new Error('Unsupported expression: ' + operator);
  }
}

test('maintenance badges calculate current due states without writes or double-counting responses', () => {
  const now = new Date(2026, 8, 29, 12);
  const pipeline = summaryPipeline({}, now, 7);
  const rows = [
    { status: 'upcoming', dueDate: new Date(2026, 8, 28), customerResponse: { status: 'callback_requested' } },
    { status: 'overdue', dueDate: new Date(2026, 8, 29, 20) },
    { status: 'due', dueDate: new Date(2026, 8, 30), customerResponse: { status: 'booking_started' } },
    { status: 'completed', dueDate: new Date(2026, 8, 28), customerResponse: { status: 'callback_requested' } },
    { status: 'upcoming', dueDate: new Date(2026, 8, 31), customerResponse: { status: 'callback_requested', acknowledgedAt: now } },
    { status: 'scheduled', dueDate: new Date(2026, 8, 28) },
    { status: 'paused', dueDate: new Date(2026, 8, 28) },
  ].map(row => ({ ...row, effectiveStatus: evaluate(pipeline[1].$set.effectiveStatus, row) }));
  const result = {};
  for (const [name, accumulator] of Object.entries(pipeline[2].$group)) {
    if (name !== '_id') result[name] = rows.reduce((sum, row) => sum + evaluate(accumulator.$sum, row), 0);
  }
  assert.deepEqual(result, { upcoming: 2, due: 1, overdue: 1, scheduled: 1, completed: 1,
    paused: 1, dueSoon: 2, responses: 2, actionable: 3 });
});

test('navigation counts retain queue policies and do not call full dashboards', async t => {
  const Booking = require('../models/BookingService');
  const now = new Date(2026, 8, 29, 12);
  let failExpenses = false;
  const fixtures = [{ status: 'pending' }, { status: 'awaiting_assignment' },
    { status: 'in-progress' }, { status: 'repair_approved', repairSchedule: { preference: 'later' } },
    { status: 'cancelled', escalated: true }, { status: 'pending_reassignment', reassignmentCount: 3 }];
  t.mock.method(Booking, 'aggregate', async pipeline => {
    const result = {};
    for (const [name, expression] of Object.entries(pipeline[0].$group)) {
      if (name !== '_id') result[name] = fixtures.reduce((sum, row) => sum + evaluate(expression.$sum, row), 0);
    }
    return [result];
  });
  for (const [name, count] of [['Expense', 2], ['LeaveRequest', 3], ['ActivityLog', 4],
    ['Order', 5], ['Project', 6], ['EquipmentAssignment', 7]]) {
    t.mock.method(require('../models/' + name), 'countDocuments', async filter => {
      if (name === 'Expense' && failExpenses) throw new Error('temporary database timeout');
      if (name === 'Order') assert.deepEqual(filter.status.$in, ['pending_payment', 'preparing_unit', 'ready_for_pickup', 'technician_declined']);
      if (name === 'Project') assert.equal(filter.status, 'pending_project_scheduling');
      if (name === 'EquipmentAssignment') {
        assert.deepEqual(filter.status.$in, ['checked_out', 'in_use']);
        assert.equal(filter.consumable.$ne, true);
      }
      return count;
    });
  }
  t.mock.method(require('../utils/maintenanceSummary'), 'maintenanceSummary', async () => ({ actionable: 8 }));
  const result = await require('../utils/adminNavigationSummary').buildAdminNavigationSummary(now);
  assert.deepEqual(result.counts, { pendingBookings: 1, activeJobs: 1, assignmentQueue: 2,
    escalatedBookings: 2, pendingExpenses: 2, pendingLeaveRequests: 3, auditToday: 4 });
  assert.deepEqual(result.orders, { actionable: 5 });
  assert.deepEqual(result.projects, { pendingScheduling: 6 });
  assert.deepEqual(result.returns, { overdue: 7 });
  assert.deepEqual(result.repairScheduling, { pendingScheduling: 1 });
  assert.equal(result.maintenance.actionable, 8);
  assert.equal(result.asOf, now.toISOString());
  failExpenses = true;
  const degraded = await require('../utils/adminNavigationSummary').buildAdminNavigationSummary(now);
  assert.equal(degraded.degraded, true);
  assert.deepEqual(degraded.failedSources, ['expenses']);
  assert.deepEqual(degraded.staleSources, ['expenses']);
  assert.equal(degraded.counts.pendingExpenses, 2);
  assert.equal(degraded.counts.pendingBookings, 1);
});

test('payment compact lists preserve proof availability and legacy detail evidence', async t => {
  const mongoose = require('mongoose');
  const Payment = require('../models/Payment');
  const Booking = require('../models/BookingService');
  const Order = require('../models/Order');
  const controller = require('../controllers/paymentController');
  const bookingId = new mongoose.Types.ObjectId();
  const fixture = { _id: new mongoose.Types.ObjectId(), bookingId, status: 'completed', proofUrl: 'data:image/png;base64,proof', customerSignature: 'signature', gatewayCheckoutUrl: 'private-checkout' };
  t.mock.method(Payment, 'aggregate', async pipeline => {
    assert.equal(String(pipeline[0].$match.bookingId), String(bookingId));
    assert.ok(pipeline[0].$match.bookingId instanceof mongoose.Types.ObjectId);
    const row = { ...fixture, hasProof: evaluate(pipeline[3].$set.hasProof, fixture) };
    for (const [field, included] of Object.entries(pipeline[4].$project)) if (!included) delete row[field];
    return [row];
  });
  t.mock.method(Payment, 'find', () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ ...fixture }] }) }) }));
  t.mock.method(Booking, 'find', () => ({ select: () => ({ lean: async () => [{ _id: bookingId, customer: { name: 'Test', email: 'test@example.com' } }] }) }));
  t.mock.method(Order, 'find', () => { throw new Error('No order query needed'); });
  for (const compact of [true, false]) {
    const res = new Response();
    await controller.listPayments({ query: { bookingId: String(bookingId), ...(compact ? { view: 'list' } : {}) } }, res, error => { throw error; });
    const row = JSON.parse(res.body).payments[0];
    assert.equal(row.status, 'paid');
    assert.equal(row.customerName, 'Test');
    assert.equal(row.proofUrl, compact ? undefined : fixture.proofUrl);
    assert.equal(row.customerSignature, compact ? undefined : fixture.customerSignature);
    if (compact) {
      assert.equal(row.hasProof, true);
      assert.equal(row.gatewayCheckoutUrl, undefined);
    }
  }
});

test('request stages are recorded even on failure without copying response data', async () => {
  const req = {};
  assert.equal(await measureRequest(req, 'read', () => 42), 42);
  await assert.rejects(measureRequest(req, 'save', () => { throw new Error('failure'); }), /failure/);
  assert.deepEqual(Object.keys(req.performanceTimings), ['read', 'save']);
  assert.ok(Object.values(req.performanceTimings).every(value => typeof value === 'number' && value >= 0));
});

test('deferred order report renders data before replaying chart dependencies in order', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../public/js/admin-deferred-order-report.js'), 'utf8');
  const sequence = [];
  function node(tag) {
    return { tag, attributes: [], setAttribute(name, value) { this[name] = value; },
      addEventListener() {}, remove() {} };
  }
  const scripts = [Object.assign(node('script'), { src: '/chart.js', attributes: [{ name: 'src', value: '/chart.js' }] }),
    Object.assign(node('script'), { src: '/drilldown.js', attributes: [{ name: 'src', value: '/drilldown.js' }] }),
    Object.assign(node('script'), { textContent: 'initializeCharts()' })];
  const target = Object.assign(node('div'), {
    replaceChildren() { sequence.push('render'); },
    appendChild(script) { sequence.push(script.src || script.textContent); if (script.onload) queueMicrotask(script.onload); },
    append() { assert.fail('Unexpected report error'); },
  });
  const document = {
    getElementById: () => target,
    createElement: node,
    importNode: item => item,
    createDocumentFragment: () => ({ appendChild() {} }),
  };
  const context = { document, window: { location: { search: '?range=7' } },
    fetch: async (url, options) => {
      assert.equal(url, '/admin/reports/orders/data?range=7');
      assert.equal(options.credentials, 'same-origin');
      return { ok: true, redirected: false, text: async () => '<report>' };
    }, DOMParser: class { parseFromString() {
      return { querySelectorAll: () => scripts, head: { childNodes: [node('link')] }, body: { childNodes: [node('section')] } };
    } },
  };
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sequence, ['render', '/chart.js', '/drilldown.js', 'initializeCharts()']);
  assert.equal(target['aria-busy'], 'false');
});

test('deferred order report rejects redirected login HTML and provides a retry', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../public/js/admin-deferred-order-report.js'), 'utf8');
  let shown;
  const target = { setAttribute() {}, append(...nodes) { shown = nodes; } };
  vm.runInNewContext(code, {
    document: { getElementById: () => target, createElement: () => ({ setAttribute() {}, addEventListener() {} }) },
    window: { location: { search: '' } }, fetch: async () => ({ ok: true, redirected: true }),
    DOMParser: class { constructor() { assert.fail('Login page must not be parsed or injected'); } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(shown[0].textContent, /Check your session/);
  assert.equal(shown[1].textContent, 'Retry report');
});

test('changed admin views compile and blocking browser/network patterns stay removed', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['admin-dashboard', 'AuditTrail', 'Inventory/InventoryList', 'Inventory/AirconOrders',
    'Payments/Payments', 'Projects/ProjectList', 'Technicians/TechnicianList', 'Maintenance/Maintenance',
    'Reports/DeferredOrderReport']) ejs.compile(read('views/pages/admin/' + file + '.ejs'));
  for (const file of ['admin-sidebar', 'admin-navbar']) ejs.compile(read('views/partials/' + file + '.ejs'));
  assert.doesNotMatch(read('public/js/admin-dashboard.js'), /XMLHttpRequest|\.open\([^\n]+false\)/);
  const inventory = read('views/pages/admin/Inventory/InventoryList.ejs');
  assert.doesNotMatch(inventory, /await waitForChart\(\)/);
  assert.match(inventory, /applyAirconFilters\(\);[\s\S]*?waitForChart\(\)\.then/);
  const projects = read('routes/projectRoutes.js');
  const detail = projects.slice(projects.indexOf('router.get("/projects/:id",'), projects.indexOf('router.get("/projects/:id",') + 2600);
  assert.match(detail, /Promise\.all/);
  assert.doesNotMatch(detail, /await Project\.updateOne/);
  const pages = read('routes/pages.js');
  assert.match(pages, /"\/admin\/reports\/orders\/data",[\s\S]*?pageAuth\.requireRole\("admin"\)/);
});
