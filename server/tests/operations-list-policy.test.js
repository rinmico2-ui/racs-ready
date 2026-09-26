const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { listSortStages, bookingPendingFilters } = require('../utils/operationsListPolicy');

test('booking and order date sorting uses the effective schedule with stable tie-breakers', () => {
  const booking = listSortStages('booking', 'date_desc');
  assert.deepEqual(booking[0].$addFields._listDate, { $ifNull: [{ $ifNull: ['$preferredDate', '$bookingDate'] }, null] });
  assert.deepEqual(booking[1].$sort, { _listUndated: 1, _listDate: -1, createdAt: -1, _id: -1 });
  const order = listSortStages('order', 'date_asc');
  assert.deepEqual(order[0].$addFields._listDate.$ifNull[0], {
    $cond: [{ $eq: ['$fulfillmentType', 'customer_pickup'] }, '$pickupDate', '$delivery.preferredDate'],
  });
  assert.equal(order[1].$sort._listDate, 1);
  assert.equal(order[1].$sort._listUndated, 1);
  assert.deepEqual(listSortStages('order', 'not-a-sort')[1], listSortStages('order')[1]);
  assert.deepEqual(listSortStages('booking', 'newest')[1].$sort, { createdAt: -1, _id: -1 });
});

test('pending date filters are bounded Manila ranges and do not include future weeks', () => {
  const today = bookingPendingFilters({ dateRange: 'today' }, new Date('2026-09-26T01:00:00Z'));
  assert.equal(today[0].$expr.$and[0].$gte[1].toISOString(), '2026-09-25T16:00:00.000Z');
  assert.equal(today[0].$expr.$and[1].$lt[1].toISOString(), '2026-09-26T16:00:00.000Z');
  const week = bookingPendingFilters({ dateRange: 'this_week' }, new Date('2026-09-26T01:00:00Z'));
  assert.equal(week[0].$expr.$and[0].$gte[1].toISOString(), '2026-09-19T16:00:00.000Z');
  assert.equal(week[0].$expr.$and[1].$lt[1].toISOString(), '2026-09-26T16:00:00.000Z');
  const month = bookingPendingFilters({ dateRange: 'last_month' }, new Date('2026-01-05T01:00:00Z'));
  assert.equal(month[0].$expr.$and[0].$gte[1].toISOString(), '2025-11-30T16:00:00.000Z');
  assert.equal(month[0].$expr.$and[1].$lt[1].toISOString(), '2025-12-31T16:00:00.000Z');
});

test('shared operational views have explicit sort controls and compilable scripts', () => {
  for (const relative of ['../views/pages/admin/Appointments/AppointmentsUnified.ejs', '../views/pages/admin/Inventory/AirconOrders.ejs']) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.doesNotThrow(() => ejs.compile(source));
    for (const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (!match[1].includes('<%')) assert.doesNotThrow(() => new vm.Script(match[1]));
    }
    assert.match(source, /operations-request\.js/);
    assert.match(source, /Date: Latest First/);
  }
});

function requestHelper(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/operations-request.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, fetch, AbortController, setTimeout, clearTimeout });
  return window.operationsFetchJson;
}

test('details request rejects timeouts rather than leaving a spinner forever', async () => {
  const request = requestHelper((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('Aborted'); error.name = 'AbortError'; reject(error);
    });
  }));
  await assert.rejects(request('/booking', { timeoutMs: 10 }), /Loading took too long/);
});

test('details request checks HTTP errors and supports cancellation when the modal closes', async () => {
  const errorRequest = requestHelper(async () => ({ ok: false, async json() { return { error: 'Booking not found' }; } }));
  await assert.rejects(errorRequest('/booking'), /Booking not found/);
  const controller = new AbortController();
  const request = requestHelper((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); });
  }));
  const pending = request('/booking', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('every booking tab uses the same cancellable lightweight modal loader', () => {
  const source = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AppointmentsUnified.ejs'), 'utf8');
  for (const method of ['Queue.viewBooking', 'Active.viewDetail', 'Completed.viewDetail']) {
    const start = source.indexOf('AU.' + method + '=function(id)');
    assert.ok(start > 0);
    assert.match(source.slice(start, start + 180), /return AU\.Pending\.viewDetail\(id,null,function/);
  }
  assert.match(source, /encodeURIComponent\(id\)\+'\?view=modal'/);
  assert.match(source, /if\(data\.photosDeferred\)/);
  assert.match(source, /View photos and receipts/);
  const orders = fs.readFileSync(path.join(__dirname, '../public/js/admin-aircon-orders.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(orders));
  assert.match(orders, /encodeURIComponent\(id\) \+ '\?view=modal'/);
  assert.match(orders, /container\.isConnected/);
});

test('deferred evidence endpoints retain staff-only role checks and existing permission boundaries', () => {
  const appointments = fs.readFileSync(path.join(__dirname, '../routes/appointmentManagement.js'), 'utf8');
  const orders = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
  assert.match(appointments, /router\.get\('\/:id\/photos', requireRole\(\['admin', 'secretary'\]\)/);
  assert.match(appointments, /'appointments\.view'/);
  assert.match(orders, /router\.get\('\/:id\/photos', authenticate, requireRole\(\['admin', 'secretary'\]\)/);
  assert.match(orders, /Every order-id endpoint inherits the same record-level access policy/);
});

test('admin and secretary rendered booking modal scripts remain valid JavaScript', async () => {
  for (const role of ['admin', 'secretary']) {
    const html = await ejs.renderFile(path.join(__dirname, '../views/pages/admin/Appointments/AppointmentsUnified.ejs'), {
      appointmentsWorkspaceRole: role, appointmentsApiBase: '/api/' + role + '/appointments',
    });
    for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      assert.doesNotThrow(() => new vm.Script(match[1]));
    }
  }
});
