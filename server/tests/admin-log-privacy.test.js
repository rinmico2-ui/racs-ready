'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const privacy = require('../utils/logPrivacy'), presentation = require('../utils/emailOperationsPresentation');
const id = n => n.toString(16).padStart(24, '0');
const providerId = '<202610191504.58431521988@smtp-relay.mailin.fr>';
const date = new Date('2026-10-19T15:04:00Z');
const raw = { _id: id(1), action: 'auth.password_reset_completed', category: 'auth', actorName: 'Admin Person',
  actor: { _id: id(2), email: 'admin@example.test', name: 'Admin Person', role: 'admin' },
  target: { _id: id(3), email: 'customer@example.test', name: 'Customer Person' },
  createdAt: date, ip: '203.0.113.72', requestId: 'review-reference', requestPath: '/reset-password/private-reset-token?token=private-token',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0',
  details: { email: 'customer@example.test', phone: '09171234567', address: 'Private street address', nested: { apiKey: 'provider-secret', password: 'private-password',
    accessToken: 'private-token', otp: '431256' }, reason: 'Verification code: 431256 for customer@example.test; password=private-password' } };
function assertPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of ['admin@example.test', 'customer@example.test', '09171234567', 'Private street address', 'provider-secret',
    'private-password', 'private-reset-token', 'private-token', '431256', '203.0.113.72']) assert.equal(text.includes(secret), false, secret);
}
test('nested details and legacy JSON redact secrets and contact data while retaining operational references', () => {
  const value = privacy.sanitize({ ...raw.details, bookingReference: 'RACS-20261019-001', paidAmount: 1500, enabled: true,
    headers: { 'api-key': 'provider-secret', authorization: 'Bearer private-token' }, verificationCode: 431256 });
  assertPrivate(value); assert.equal(value.bookingReference, 'RACS-20261019-001'); assert.equal(value.paidAmount, 1500); assert.equal(value.enabled, true);
  assertPrivate(privacy.sanitize(JSON.stringify(raw.details)));
});
test('free-text redaction handles connection credentials, links, authorization and verification messages', () => {
  const value = privacy.text('mongodb://user:private-password@db.example.test/test; Bearer private-token; OTP is 431256; https://app.test/reset?token=private-token; customer@example.test');
  assertPrivate(value); assert.match(value, /\[REDACTED\]/);
  assertPrivate(privacy.text('Service error {"password":"private-password with spaces","api-key":"provider-secret"}; Your OTP Code: 431256'));
  assert.equal(privacy.maskIp('2001:db8:abcd:0012::1234'), '2001:db8:abcd:…');
  assert.equal(privacy.maskIp('::ffff:203.0.113.72'), '203.0.113.xxx');
});
test('circular details are bounded and object IDs retain their record reference', () => {
  const value = { id: new (require('mongoose').Types.ObjectId)(id(8)) }; value.circular = value;
  const safe = privacy.sanitize(value); assert.equal(safe.id, id(8)); assert.equal(safe.circular, '[CIRCULAR]');
});
test('email display removes provider IDs, addresses, raw response text and event body details', () => {
  const email = presentation.record({ _id: id(4), provider: 'brevo', recipient: 'customer@example.test', subject: 'Verification code: 431256',
    status: 'accepted', messageId: providerId, error: 'password=private-password', createdAt: date });
  assertPrivate(email); assert.equal(email.messageId, undefined); assert.equal(email.canCheckDelivery, true); assert.match(email.summary, /Accepted/);
  const failed = presentation.record({ status: 'failed', error: 'EAUTH customer@example.test password=private-password', recipient: 'customer@example.test' });
  assertPrivate(failed); assert.match(failed.summary, /could not sign in/);
  const events = presentation.delivery({ status: 'rejected', message: 'A delivery problem was reported.', events: [{ event: 'hardBounce', reason: 'private-password', email: 'customer@example.test', date }] });
  assertPrivate(events); assert.equal(events.events[0].event, 'Address could not receive the message');
});
test('new audit writes redact secrets before persistence and exclude tokens in request paths', async t => {
  let saved;
  t.mock.method(require('../models/ActivityLog'), 'create', async value => { saved = value; });
  await require('../utils/audit').logEvent({ actor: id(2), action: 'auth.password_reset_completed', module: 'auth', details: raw.details,
    req: { ip: raw.ip, originalUrl: raw.requestPath, method: 'POST', headers: {} } });
  assertPrivate({ details: saved.details, path: saved.requestPath });
  assert.equal(saved.ip, raw.ip, 'The protected security record retains the incident network address');
});
test('the actual audit JSON and CSV exports redact legacy records without changing stored history', async t => {
  const ActivityLog = require('../models/ActivityLog'), controller = require('../controllers/adminController');
  t.mock.method(ActivityLog, 'countDocuments', async () => 1);
  t.mock.method(ActivityLog, 'aggregate', async () => []);
  t.mock.method(ActivityLog, 'find', () => ({ sort() { return this; }, populate() { return this; }, limit() { return this; }, skip() { return this; }, lean: async () => [raw] }));
  for (const format of ['', 'csv']) {
    const headers = {}, response = { set(name, value) { headers[name] = value; return this; }, setHeader(name, value) { headers[name] = value; },
      json(value) { this.body = value; }, send(value) { this.body = value; } };
    await controller.listAuditTrail({ query: { format } }, response, error => { throw error; });
    assertPrivate(response.body); assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.match(JSON.stringify(response.body), /203\.0\.113\.xxx/);
    if (!format) assert.equal(response.body.items[0].userAgent, 'Chrome on Windows');
  }
  assert.equal(raw.details.nested.password, 'private-password'); assert.equal(raw.ip, '203.0.113.72');
});
test('mail delivery retains the original message for its recipient but writes a redacted operational log', async () => {
  const filename = path.join(__dirname, '../utils/mailer.js'), source = fs.readFileSync(filename, 'utf8');
  const saved = [], delivered = [], module = { exports: {} };
  const relative = require('node:module').createRequire(filename);
  vm.runInNewContext(source, { module, exports: module.exports, process: { env: { NODE_ENV: 'development', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'sender@example.test', SMTP_PASS: 'smtp-secret', FROM_EMAIL: 'sender@example.test' } },
    console: { log() {} }, Buffer, Date, setTimeout, clearTimeout,
    require: name => name === 'nodemailer' ? { createTransport: () => ({ sendMail: async message => { delivered.push(message); return { messageId: providerId }; } }) }
      : name === 'mongoose' ? { connection: { readyState: 1 } } : name === '../models/EmailDeliveryLog' ? { create: async value => saved.push(value) }
        : name === './logger' ? { create: () => ({ warn() {}, info() {} }) } : relative(name),
  }, { filename });
  await module.exports.deliverMailNow({ to: 'customer@example.test', subject: 'Verification code: 431256', text: 'Your OTP is 431256', html: '<p>Your OTP is 431256</p>' });
  assert.equal(delivered[0].to, 'customer@example.test'); assert.match(delivered[0].text, /431256/);
  assertPrivate({ recipient: saved[0].recipient, subject: saved[0].subject }); assert.equal(saved[0].messageId, providerId);
  assert.equal(saved[0].html, undefined); assert.equal(saved[0].text, undefined);
});
test('protected email endpoints enforce roles and return safe errors, tracking summaries and delivery checks', async t => {
  const express = require('express'), app = express(), mailer = require('../utils/mailer');
  const EmailLog = require('../models/EmailDeliveryLog'), Outbox = require('../models/EmailOutbox');
  const log = { _id: id(4), recipient: 'customer@example.test', subject: 'Login code 431256', status: 'accepted', provider: 'brevo', messageId: providerId, createdAt: date };
  t.mock.method(EmailLog, 'find', () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [log] }));
  t.mock.method(EmailLog, 'findById', () => ({ lean: async () => log }));
  t.mock.method(EmailLog, 'findOne', () => ({ sort() { return this; }, select() { return this; }, lean: async () => log }));
  t.mock.method(EmailLog, 'aggregate', async () => []); t.mock.method(Outbox, 'aggregate', async () => []);
  t.mock.method(require('../utils/audit'), 'logEvent', async () => {});
  t.mock.method(mailer, 'verifyMailerConfiguration', async () => { throw Error('EAUTH customer@example.test password=private-password'); });
  t.mock.method(mailer, 'sendMail', async () => ({ messageId: providerId, provider: 'brevo' }));
  let lookedUp;
  t.mock.method(require('../utils/brevoDelivery'), 'lookupDelivery', async value => { lookedUp = value; return { status: 'delivered', message: 'Delivery confirmed.', events: [{ event: 'delivered', reason: 'private-password', date }] }; });
  app.use(express.json()); app.use((req, _res, next) => { req.authResolved = true; req.user = { _id: id(2), role: req.headers['x-test-role'], accountStatus: 'active' }; next(); });
  app.use('/api/admin', require('../routes/adminApi'));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, role = 'admin', method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/settings/${route}`, { method,
    headers: { 'Content-Type': 'application/json', 'x-test-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const role of ['customer', 'technician', 'secretary']) for (const route of ['email-status', 'email-logs', `email-logs/${id(4)}/delivery`]) assert.equal((await request(route, role)).status, 403);
  const response = await request('email-logs'), records = await response.json(); assert.equal(response.status, 200); assertPrivate(records);
  assert.equal(JSON.stringify(records).includes(providerId), false); assert.equal(records.records[0].canCheckDelivery, true);
  const verify = await request('email-verify', 'admin', 'POST'); assert.equal(verify.status, 502); assertPrivate(await verify.json());
  const sent = await request('email-test', 'admin', 'POST', { recipient: 'test@example.test' }); assert.equal(sent.status, 200); assert.equal(JSON.stringify(await sent.json()).includes(providerId), false);
  const delivery = await request(`email-logs/${id(4)}/delivery`); assert.equal(delivery.status, 200); assertPrivate(await delivery.json()); assert.equal(lookedUp, providerId);
});
