'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Order = require('../models/Order');
const Technician = require('../models/Technician');
const teamService = require('../utils/standardJobTeamService');
const team = require('../utils/standardJobTeam');
const router = require('../routes/orderRoutes');

const id = value => value.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), orderId = id(3), owner = id(4);

function query(value) {
  let fields;
  const result = {
    select(selection) { if (selection) fields = selection; return this; },
    populate() { return this; }, maxTimeMS() { return this; },
    async lean() {
      if (!value || !fields) return value;
      return Object.fromEntries(['_id', ...fields.split(/\s+/).map(field => field.split('.')[0])]
        .filter(field => field in value).map(field => [field, value[field]]));
    },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return result;
}

async function fixture(t) {
  let actorId = support, role = 'technician', missingProfile = false, permissions = ['assignments.self.view', 'assignments.self.manage'];
  const responses = [], publications = [];
  let saves = 0;
  const order = {
    _id: orderId, userId: owner, technicianId: lead, status: 'technician_assigned',
    fulfillmentType: 'delivery_installation', delivery: { preferredDate: new Date('2035-01-02T00:00:00Z') }, timeSlot: '08:00',
    items: [{ quantity: 1 }], total: 25000, paymentStatus: 'paid', customer: { name: 'Synthetic customer', email: 'private@example.test' },
    technicianTeam: [{ technicianId: lead, status: 'pending' }, { technicianId: support, status: 'pending' }],
    pushStatus(status) { this.status = status; }, async save() { saves++; },
  };
  t.mock.method(Order, 'findById', key => query(String(key) === orderId ? order : null));
  t.mock.method(Technician, 'findOne', filter => query(!missingProfile && String(filter.user) === actorId ? { _id: actorId } : null));
  t.mock.method(teamService, 'createService', () => ({ async respond(source, key, technicianId, decision) {
    assert.equal(source, 'order'); assert.equal(String(key), orderId);
    const member = team.member(order, technicianId);
    assert.ok(member, 'Only an assigned member may respond');
    responses.push({ technicianId: String(technicianId), decision });
    member.status = decision === 'accept' ? 'accepted' : 'declined';
    if (decision === 'decline') order.status = 'technician_declined';
    else if (team.readiness(order).ready) order.status = 'technician_accepted';
    return { job: order, response: true, decision, technicianId };
  } }));
  t.mock.method(teamService, 'publish', async result => { publications.push(result); });
  const app = express();
  app.use(express.json());
  // Supply the already verified principal as the application's current-user
  // middleware does. The real router, authentication, RBAC and ownership checks run.
  app.use((req, _res, next) => {
    req.authResolved = true;
    req.user = { _id: actorId, role, active: true, emailVerified: true, permissionsOverridden: true, permissions };
    next();
  });
  app.use('/api/orders', router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {
    order, responses, publications, get saves() { return saves; },
    actor(value, nextRole = 'technician') { actorId = value; role = nextRole; },
    missingProfile() { missingProfile = true; }, permissions(value) { permissions = value; },
    async request(action = '', method = 'GET', body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/${orderId}${action}`, {
        method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('the full order router lets both primary and supporting technicians accept their own invitations', async t => {
  const f = await fixture(t);
  f.actor(lead);
  const first = await f.request('/accept', 'POST', {});
  assert.equal(first.status, 200); assert.equal(first.body.success, true);
  assert.equal(first.body.order.status, 'technician_assigned');
  assert.equal(first.body.order.viewerAssignment.technicianId, lead);
  f.actor(support);
  const second = await f.request('/accept', 'POST');
  assert.equal(second.status, 200); assert.equal(second.body.success, true);
  assert.equal(second.body.order.status, 'technician_accepted');
  assert.equal(second.body.order.viewerAssignment.technicianId, support);
  assert.equal(second.body.order.viewerAssignment.status, 'accepted');
  assert.deepEqual(f.responses, [{ technicianId: lead, decision: 'accept' }, { technicianId: support, decision: 'accept' }]);
  assert.equal(f.publications.length, 2); assert.equal(f.order.total, 25000);
});

test('a supporting technician can open order details and decline through the same ownership guard', async t => {
  const f = await fixture(t);
  const details = await f.request();
  assert.equal(details.status, 200);
  assert.equal(details.body.order.viewerAssignment.technicianId, support);
  assert.equal(details.body.order.customer.email, undefined);
  const declined = await f.request('/decline', 'POST', { reason: 'Unavailable for this visit' });
  assert.equal(declined.status, 200); assert.equal(declined.body.success, true);
  assert.equal(f.order.technicianId, lead);
  assert.equal(f.order.technicianTeam[0].status, 'pending');
  assert.equal(f.order.technicianTeam[1].status, 'declined');
});

test('unassigned, removed and stale supporting memberships cannot view or accept an order', async t => {
  for (const scenario of ['unassigned', 'removed', 'released', 'missing profile']) {
    await t.test(scenario, async t => {
      const f = await fixture(t);
      if (scenario === 'unassigned') f.actor(id(99));
      if (scenario === 'removed') f.order.technicianTeam = [{ technicianId: lead, status: 'pending' }];
      if (scenario === 'released') f.order.technicianId = null;
      if (scenario === 'missing profile') f.missingProfile();
      for (const [action, method, body] of [['', 'GET'], ['/accept', 'POST', { technicianId: lead }]]) {
        const result = await f.request(action, method, body);
        assert.equal(result.status, 403); assert.equal(result.body.error, 'Forbidden');
      }
      assert.equal(f.responses.length, 0); assert.equal(f.saves, 0);
    });
  }
});

test('supporting acceptance does not grant primary execution, payment or staff permissions', async t => {
  const f = await fixture(t);
  for (const [action, method, body] of [
    ['/status', 'PATCH', { status: 'out_for_delivery' }], ['/collect-payment', 'POST', {}],
    ['/cancel', 'POST', { reason: 'Synthetic cancellation request' }], ['/dispatch-ready', 'POST', {}],
    ['/payment', 'PATCH', { paymentStatus: 'paid' }], ['/assign-technician', 'POST', { technicianId: support }],
  ]) {
    const result = await f.request(action, method, body);
    assert.equal(result.status, 403, `${method} ${action}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(f.responses.length, 0); assert.equal(f.saves, 0);
});

test('customer ownership and technician view permission cannot be used to bypass acceptance roles or manage permission', async t => {
  const f = await fixture(t);
  f.actor(owner, 'customer');
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/accept', 'POST', { technicianId: support })).status, 403);
  f.actor(support);
  f.permissions(['assignments.self.view']);
  const denied = await f.request('/accept', 'POST', {});
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(f.responses.length, 0);
});

test('legacy delivery-only orders still let their assigned primary accept without a team', async t => {
  const f = await fixture(t);
  f.actor(lead); f.order.technicianTeam = undefined; f.order.fulfillmentType = 'delivery_only';
  const result = await f.request('/accept', 'POST', {});
  assert.equal(result.status, 200); assert.equal(result.body.success, true);
  assert.equal(f.order.status, 'technician_accepted');
  assert.equal(f.saves, 1); assert.equal(f.responses.length, 0);
});
