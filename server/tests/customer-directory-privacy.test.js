'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const presentation = require('../utils/customerDirectoryPresentation');
const User = require('../models/User'), controller = require('../controllers/adminController');
const id = value => value.toString(16).padStart(24, '0');
const raw = { _id: id(1), role: 'customer', firstName: 'Test', lastName: 'Customer', email: 'customer@example.test', phone: '09171234567',
  address: { barangay: 'Private barangay', city: 'Private city', province: 'Private province', postalCode: '1234', coordinates: [120, 15] },
  blocked: false, vip: true, createdAt: new Date('2026-10-19T00:00:00Z'), accountStatus: 'active', bookingLimit: 0,
  passwordHash: 'private-password', currentSessionId: 'private-session', permissions: ['private-permission'], invitationInvitedBy: id(5),
  invitationTokenHash: 'private-token', internalFutureField: 'future-secret', violations: [{ type: 'no_show', message: 'OTP is 431256; customer@example.test; password=private-password' }] };
function response() {
  return { headers: {}, statusCode: 200, set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
const next = error => { throw error; };
function assertMasked(value) {
  const output = JSON.stringify(value);
  for (const secret of ['customer@example.test', '09171234567', 'Private barangay', 'Private city', 'private-password', 'private-session', 'private-token', 'future-secret', 'private-permission', '431256']) assert.equal(output.includes(secret), false, secret);
}

test('directory responses allow only required fields and keep contacts masked, even for legacy or future fields', () => {
  const row = presentation.summary(raw), detail = presentation.detail(raw);
  assertMasked(row); assertMasked(detail);
  assert.equal(row.email, 'c***@example.test'); assert.equal(row.phone, '***4567'); assert.equal(row.address, undefined);
  assert.equal(detail.currentSessionId, undefined); assert.equal(detail.permissions, undefined); assert.equal(detail.invitationInvitedBy, undefined);
  assert.equal(detail.violations[0].type, 'no_show'); assert.equal(raw.violations[0].message.includes('431256'), true);
  const contact = presentation.contact(raw);
  assert.equal(contact.email, raw.email); assert.equal(contact.phone, raw.phone); assert.equal(contact.address.coordinates, undefined);
  assert.deepEqual(Object.keys(contact).sort(), ['address', 'email', 'phone']);
});

test('server pagination and contact search work across the directory without returning bulk personal data', async t => {
  let filter, selected, skipped, limited;
  t.mock.method(User, 'find', query => { filter = query; return { select(value) { selected = value; return this; }, sort() { return this; },
    skip(value) { skipped = value; return this; }, limit(value) { limited = value; return this; }, lean: async () => [raw] }; });
  t.mock.method(User, 'countDocuments', async () => 73);
  t.mock.method(User, 'aggregate', async () => [{ total: 180, active: 170, vip: 73, blocked: 10 }]);
  const res = response();
  await controller.listCustomers({ query: { page: '6', limit: '10', search: 'customer+test@example.test', status: 'vip' } }, res, next);
  assertMasked(res.body); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(filter.role, 'customer'); assert.equal(filter.vip, true); assert.equal(filter.$or[2].email.test('customer+test@example.test'), true);
  assert.equal(filter.$or[2].email.test('customerrtest@exampleXtest'), false);
  assert.equal(skipped, 60); assert.equal(limited, 10); assert.equal(selected.startsWith('-'), false); assert.equal(selected.includes('address'), false);
  assert.equal(res.body.total, 73); assert.equal(res.body.stats.total, 180); assert.equal(res.body.stats.active, 170);
});

test('directory inputs are bounded, integer-only and cannot inject role/status filters', async t => {
  let filter, skipped, limited;
  t.mock.method(User, 'find', query => { filter = query; return { select() { return this; }, sort() { return this; }, skip(value) { skipped = value; return this; }, limit(value) { limited = value; return this; }, lean: async () => [] }; });
  t.mock.method(User, 'countDocuments', async () => 0); t.mock.method(User, 'aggregate', async () => []);
  const res = response();
  await controller.listCustomers({ query: { page: 'Infinity', limit: '999999999', search: { $ne: '' }, status: { $ne: 'blocked' }, role: 'admin' } }, res, next);
  assert.deepEqual(filter, { role: 'customer' }); assert.equal(skipped, 0); assert.equal(limited, 100); assert.equal(res.body.stats.total, 0);
});

test('customer detail and concerns use scoped allowlisted reads with private cache headers', async t => {
  const queries = [];
  t.mock.method(User, 'findOne', filter => { queries.push(filter); return { select() { return this; }, lean: async () => raw }; });
  for (const method of ['getCustomer', 'getCustomerViolations']) {
    const res = response(); await controller[method]({ params: { id: id(1) } }, res, next);
    assertMasked(res.body); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  }
  assert.ok(queries.every(query => query.role === 'customer' && query._id === id(1)));
});

test('explicit contact access records actor, customer and fields without placing contacts in the audit event', async t => {
  let recorded, selected;
  t.mock.method(User, 'findOne', query => { assert.equal(query.role, 'customer'); return { select(value) { selected = value; return this; }, lean: async () => raw }; });
  t.mock.method(require('../utils/audit'), 'logEvent', async event => { recorded = event; });
  const req = { params: { id: id(1) }, user: { _id: id(2), role: 'admin' }, headers: {}, query: {} }, res = response();
  await controller.getCustomerContact(req, res, next);
  assert.equal(res.body.contact.email, raw.email); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(recorded.actor, id(2)); assert.equal(recorded.target, id(1)); assert.equal(recorded.action, 'customer.contact_viewed');
  assertMasked(recorded.details); assert.deepEqual(recorded.details.fields, ['email', 'phone', 'address']); assert.equal(selected, presentation.CONTACT_FIELDS);
});

test('staff IDs cannot be read, revealed or changed through customer endpoints', async t => {
  let queries = 0, auditCalls = 0;
  t.mock.method(User, 'findOne', query => { ++queries; assert.equal(query.role, 'customer');
    return { select() { return this; }, lean: async () => null, then(resolve) { return Promise.resolve(null).then(resolve); } }; });
  t.mock.method(require('../utils/audit'), 'logEvent', async () => { ++auditCalls; });
  for (const method of ['getCustomer', 'getCustomerContact', 'getCustomerViolations', 'updateCustomer']) {
    const res = response(); await controller[method]({ params: { id: id(9) }, body: { action: 'block' }, user: { _id: id(2) } }, res, next);
    assert.equal(res.statusCode, 404);
  }
  assert.equal(queries, 4); assert.equal(auditCalls, 0);
  const invalid = response(); await controller.getCustomerContact({ params: { id: 'invalid' } }, invalid, next);
  assert.equal(invalid.statusCode, 400); assert.equal(queries, 4);
});

test('real customer API routes protect contact access by role and secretary customer-view permission', async t => {
  const express = require('express'), app = express();
  t.mock.method(User, 'findOne', () => ({ select() { return this; }, lean: async () => raw }));
  t.mock.method(require('../utils/audit'), 'logEvent', async () => {});
  app.use(express.json()); app.use((req, _res, next) => { req.authResolved = true;
    req.user = { _id: id(2), role: req.headers['x-test-role'], accountStatus: 'active', permissionsOverridden: true,
      permissions: req.headers['x-test-permission'] === 'view' ? ['customers.view'] : [] }; next(); });
  app.use('/api/admin', require('../routes/adminApi')); app.use('/api/secretary', require('../routes/secretaryApi'));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (mount, role, permission = '', suffix = '/contact') => fetch(`http://127.0.0.1:${server.address().port}/api/${mount}/customers/${id(1)}${suffix}`, {
    headers: { 'x-test-role': role, 'x-test-permission': permission } });
  for (const role of ['customer', 'technician', 'secretary']) assert.equal((await request('admin', role, 'view')).status, 403);
  for (const role of ['customer', 'technician', 'admin']) assert.equal((await request('secretary', role, 'view')).status, 403);
  assert.equal((await request('secretary', 'secretary')).status, 403);
  const allowed = await request('secretary', 'secretary', 'view'); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).contact.email, raw.email);
  const detail = await request('admin', 'admin', '', ''); assert.equal(detail.status, 200); assertMasked(await detail.json());
});
