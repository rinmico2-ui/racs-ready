'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Order = require('../models/Order'), Technician = require('../models/Technician');
const service = require('../utils/standardJobTeamService'), team = require('../utils/standardJobTeam');
const router = require('../routes/orderRoutes');
const { presentTechnicianOrder } = require('../utils/technicianDataPresentation');
const id = value => value.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), orderId = id(3);
function query(value) { return { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
  lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const handler = route => router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle;
const job = () => ({ _id: orderId, technicianId: lead, status: 'technician_assigned', fulfillmentType: 'delivery_installation',
  delivery: { preferredDate: new Date('2035-01-02T00:00:00Z') }, timeSlot: '08:00',
  technicianTeam: [{ technicianId: lead, role: 'primary', status: 'accepted' }, { technicianId: support, role: 'support', status: 'pending' }] });

test('a bodyless Accept POST reaches the assigned team member and returns their own response state', async t => {
  const order = job(); let reason, publications = 0;
  t.mock.method(Order, 'findById', () => query(order));
  t.mock.method(Technician, 'findOne', () => query({ _id: support }));
  t.mock.method(service, 'createService', () => ({ async respond(source, key, technicianId, decision, value) {
    assert.equal(source, 'order'); assert.equal(key, orderId); assert.equal(technicianId, support); assert.equal(decision, 'accept');
    reason = value; order.technicianTeam[1].status = 'accepted'; order.status = 'technician_accepted'; return { job: order, response: true };
  } }));
  t.mock.method(service, 'publish', async () => { publications++; });
  const res = response();
  await handler('/:id/accept')({ params: { id: orderId }, user: { _id: id(4), role: 'technician' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true); assert.equal(reason, undefined);
  assert.equal(publications, 1); assert.equal(res.body.order.viewerAssignment.technicianId, support);
  assert.equal(res.body.order.viewerAssignment.status, 'accepted');
});

test('team authorization failures remain forbidden instead of falling through to a legacy acceptance', async t => {
  t.mock.method(Order, 'findById', () => query(job()));
  t.mock.method(Technician, 'findOne', () => query({ _id: id(99) }));
  t.mock.method(service, 'createService', () => ({ async respond() { throw Object.assign(Error('Not assigned to this team.'), { status: 403 }); } }));
  const res = response(); await handler('/:id/accept')({ params: { id: orderId }, user: { _id: id(9), role: 'technician' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.success, undefined);
});

test('supporting orders stay in the ownership scope when search and date filters are added', async t => {
  const order = job(); let filter, aggregateScope;
  t.mock.method(Technician, 'findOne', () => query({ _id: support }));
  t.mock.method(Order, 'find', input => { filter = input; return query([order]); });
  t.mock.method(Order, 'countDocuments', async () => 1);
  t.mock.method(Order, 'aggregate', async pipeline => { aggregateScope = pipeline[0].$match; return [{ _id: 'technician_assigned', count: 1 }]; });
  const res = response(); await handler('/technician/all')({ query: { search: 'unit', scheduledFrom: '2035-01-02', scheduledTo: '2035-01-03' }, user: { _id: id(4) } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(filter.$and[0], team.scope(support)); assert.equal(filter.$and.length, 2);
  assert.ok(filter.$or.some(row => row.orderReference));
  assert.deepEqual(aggregateScope.$and[0], team.scope(support));
  assert.equal(res.body.orders[0].viewerAssignment.status, 'pending');
  assert.equal(res.body.kpi.awaitingAcceptance, 1);
});

test('the presenter derives the logged-in member state and removes a stored or forged viewer state', () => {
  const order = { ...job(), viewerAssignment: { technicianId: support, status: 'accepted' } };
  assert.equal(presentTechnicianOrder(order, { technicianId: support }).viewerAssignment.status, 'pending');
  assert.equal(presentTechnicianOrder(order, { technicianId: lead }).viewerAssignment.status, 'accepted');
  assert.equal(presentTechnicianOrder(order, { technicianId: id(99) }).viewerAssignment, undefined);
  assert.equal(presentTechnicianOrder(order).viewerAssignment, undefined);
});

test('each technician sees their own response deadline, and accepted members never become expired', () => {
  const order = job();
  order.technicianTeam[0].deadlineAt = new Date('2035-01-01T00:15:00Z');
  order.technicianTeam[1].deadlineAt = new Date('2035-01-01T00:30:00Z');
  const before = new Date('2035-01-01T00:29:59.999Z');
  assert.equal(presentTechnicianOrder(order, { technicianId: support, now: before }).viewerAssignment.isResponseExpired, false);
  const now = new Date('2035-01-01T00:30:00Z');
  const expired = presentTechnicianOrder(order, { technicianId: support, now }).viewerAssignment;
  assert.equal(expired.isResponseExpired, true);
  assert.equal(expired.status, 'pending');
  assert.equal(expired.deadlineAt.toISOString(), '2035-01-01T00:30:00.000Z');
  assert.equal(presentTechnicianOrder(order, { technicianId: lead, now }).viewerAssignment.isResponseExpired, false);
  order.technicianTeam[1].deadlineAt = new Date('2035-01-01T01:30:00Z');
  assert.equal(presentTechnicianOrder(order, { technicianId: support, now }).viewerAssignment.isResponseExpired, false);
});

test('an expired response returns its specific recovery message and code to the technician', async t => {
  t.mock.method(Order, 'findById', () => query(job()));
  t.mock.method(Technician, 'findOne', () => query({ _id: support }));
  t.mock.method(service, 'createService', () => ({ async respond() {
    throw Object.assign(Error('Your assignment response deadline has passed. Ask Operations to extend the deadline or review the team.'), { status: 409, code: 'TEAM_RESPONSE_EXPIRED' });
  } }));
  const res = response(); await handler('/:id/accept')({ params: { id: orderId }, user: { _id: id(4), role: 'technician' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TEAM_RESPONSE_EXPIRED');
  assert.match(res.body.error, /extend the deadline/);
  assert.equal(res.body.success, undefined);
});

const view = fs.readFileSync(path.join(__dirname, '../views/pages/technician/technicianorders.ejs'), 'utf8');
test('a supporting member can accept after the primary has accepted; an accepted viewer sees the waiting message', () => {
  const start = view.indexOf("    var aHtml = '';");
  const code = view.slice(start, view.indexOf('    var actDiv =', start)) + '\naHtml;';
  const render = status => vm.runInNewContext(code, { o: { ...job(), viewerAssignment: { technicianId: support, status } }, esc: String,
    scheduleRecovery: false, installReady: false, dispatchReady: false, preparationDate: '2035-01-02' });
  assert.match(render('pending'), /data-action="accept"/);
  assert.doesNotMatch(render('accepted'), /data-action="accept"/);
  assert.match(render('accepted'), /Waiting for the other team members/);
});

test('an expired invitation explains how to recover instead of presenting an unusable Accept button', () => {
  const start = view.indexOf("    var aHtml = '';");
  const code = view.slice(start, view.indexOf('    var actDiv =', start)) + '\naHtml;';
  const html = vm.runInNewContext(code, { o: { ...job(), viewerAssignment: { status: 'pending', isResponseExpired: true } }, esc: String,
    scheduleRecovery: false, installReady: false, dispatchReady: false, preparationDate: '2035-01-02' });
  assert.match(html, /Response deadline passed/);
  assert.match(html, /Ask admin or secretary to extend/);
  assert.doesNotMatch(html, /data-action="accept"|data-action="decline"/);
});

test('order detail emergency action is limited to travel and arrival before installation starts', () => {
  const start = view.indexOf("    var aHtml = '';");
  const code = view.slice(start, view.indexOf('    var actDiv =', start)) + '\naHtml;';
  const render = overrides => vm.runInNewContext(code, {
    o: { ...job(), viewerAssignment: { status: 'accepted' }, ...overrides }, esc: String,
    scheduleRecovery: false, installReady: true, dispatchReady: true, preparationDate: '2035-01-02'
  });
  for (const fulfillmentType of ['delivery_installation', 'delivery_only']) {
    for (const status of ['out_for_delivery', 'arrived']) {
      assert.match(render({ status, fulfillmentType }), /Report Emergency/);
      assert.doesNotMatch(render({ status, fulfillmentType, continuation: { status: 'pending' } }), /Report Emergency/);
      assert.doesNotMatch(render({ status, fulfillmentType, isProject: true }), /Report Emergency/);
    }
    for (const status of ['technician_assigned', 'technician_accepted', 'preparing_unit', 'installing', 'completed', 'cancelled', 'pending_reassignment']) {
      for (const memberStatus of ['pending', 'accepted']) {
        assert.doesNotMatch(render({ status, fulfillmentType, viewerAssignment: { status: memberStatus } }), /Report Emergency/);
      }
    }
  }
});

test('supporting installation cards use the same emergency stages and require an accepted member', async () => {
  const window = { addEventListener() {} }, appended = [];
  const body = { append: node => appended.push(node) };
  const host = { querySelectorAll: selector => selector === 'article .card-body' ? [body] : [] };
  let current;
  const location = { pathname: '/fixture' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/standard-job-team.js'), 'utf8'), {
    window, location,
    document: { getElementById: () => host, createElement: () => ({ addEventListener() {} }), head: { append() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ jobs: [current] }) })
  });
  location.pathname = '/technician/orders';
  for (const status of ['technician_assigned', 'technician_accepted', 'preparing_unit', 'out_for_delivery', 'arrived', 'installing', 'completed', 'cancelled', 'pending_reassignment']) {
    for (const myStatus of ['pending', 'accepted', 'declined', 'expired']) {
      for (const continuation of [undefined, 'pending']) {
        current = { id: orderId, date: '2035-01-02', status, myStatus, continuation };
        appended.length = 0;
        await window.RACSJobTeams.supportingOrders();
        const visible = appended.some(node => node.textContent === 'Report Emergency');
        assert.equal(visible, ['out_for_delivery', 'arrived'].includes(status) && myStatus === 'accepted' && continuation !== 'pending', `${status}/${myStatus}/${continuation}`);
      }
    }
  }
});

test('the Accept button sends JSON and waits for team acceptance before opening daily preparation', async () => {
  const start = view.indexOf('  window.doAccept = async function(id)');
  let request, kitOpened = false; const messages = [];
  const sandbox = { window: {}, _allOrders: [job()], orderNeedsScheduleRecovery: () => false, orderDateKey: () => '2035-01-02',
    fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ success: true, order: job() }) }; },
    Swal: { fire: async (...args) => { messages.push(args); return { isConfirmed: true }; } },
    openOrderDailyKit() { kitOpened = true; }, fetchOrders() {} };
  vm.runInNewContext(view.slice(start, view.indexOf('  window.doDecline', start)), sandbox);
  await sandbox.window.doAccept(orderId);
  assert.equal(request.options.headers['Content-Type'], 'application/json'); assert.equal(request.options.body, '{}');
  assert.equal(messages[0][0].title, 'Assignment Accepted'); assert.equal(kitOpened, false);
});

test('legacy staff assignment rejects schedule changes before saving or notifying a technician', async t => {
  const order = { ...job(), status:'preparing_unit', technicianId:null, technicianTeam:[] };
  t.mock.method(Order, 'findById', () => query(order));
  t.mock.method(Order.prototype, 'save', () => assert.fail('A different date must be rescheduled first.'));
  for (const role of ['admin', 'secretary']) for (const fulfillmentType of ['delivery_only', 'delivery_installation']) {
    order.fulfillmentType = fulfillmentType;
    const res = response();
    await handler('/:id/assign-technician')({ params:{id:orderId}, body:{technicianId:lead,scheduledDate:'2035-01-03',timeSlot:'08:00'}, user:{_id:id(9),role} }, res);
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'ORDER_SCHEDULE_CHANGE_REQUIRES_RESCHEDULE');
    assert.equal(order.technicianId, null); assert.equal(order.status, 'preparing_unit');
  }
});
