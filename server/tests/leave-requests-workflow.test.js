'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const ejs = require('ejs');
const { requirePermission, requiredPermissionForRequest } = require('../middleware/requirePermission');
const { validateLeaveDates } = require('../utils/leaveRequestValidation');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const id = '507f1f77bcf86cd799439011';
const userId = '507f1f77bcf86cd799439012';
const query = value => ({ lean: async () => value, select() { return this; }, sort() { return this; }, limit() { return this; } });

function fixture(options = {}) {
  let leave = options.missing ? null : { _id: id, technicianId: userId, status: 'pending',
    technician: { name: 'Fixture Technician', email: 'fixture@example.test' },
    startDate: new Date('2030-01-01T00:00:00+08:00'), endDate: new Date('2030-01-02T00:00:00+08:00'), adminNote: '' };
  const writes = [], notices = [], audits = [];
  const models = {
    find: () => query(leave ? [leave] : []),
    findById: () => query(leave && { ...leave }),
    findOne: () => query(options.overlap || null),
    findOneAndUpdate(filter, change, config) {
      writes.push({ filter, change, config });
      if (options.race) return query(null);
      assert.equal(filter.status, leave.status);
      assert.equal(config.runValidators, true);
      leave = { ...leave, ...change.$set };
      return query(leave);
    },
  };
  const filename = path.join(__dirname, '../controllers/leaveRequestController.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const overrides = { '../models/LeaveRequest': models,
    '../utils/technicianLeaveRequests': { createService: () => require('../utils/technicianLeaveRequests').createService({ LeaveRequest: models, lock: async (_key, work) => work() }) },
    '../utils/notify': { createNotification: async data => { notices.push(data); } },
    '../utils/audit': { logEvent: async data => { audits.push(data); } },
  };
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    name => overrides[name] || nativeRequire(name), module, module.exports);
  return { controller: module.exports, models, writes, notices, audits, get leave() { return leave; } };
}

async function invoke(f, body, params = { id }) {
  let status = 200, payload, error;
  const req = { body, params, query: {}, user: { _id: userId, role: 'admin' }, app: { get: () => null } };
  const res = { status(code) { status = code; return this; }, json(value) { payload = value; return this; }, set() {} };
  await f.controller.review(req, res, e => { error = e; });
  assert.equal(error, undefined, error?.stack);
  return { status, payload };
}

test('leave approval returns success, audits the actual request and notifies the technician once', async () => {
  const f = fixture();
  const result = await invoke(f, { status: 'approved', adminNote: '  Enjoy your leave.  ', expectedStatus: 'pending', expectedReviewedAt: null });
  assert.equal(result.status, 200);
  assert.equal(result.payload.leave.status, 'approved');
  assert.equal(result.payload.leave.adminNote, 'Enjoy your leave.');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].userId, userId);
  assert.equal(f.notices[0].type, 'leave_approved');
  assert.match(f.notices[0].message, /Jan 1, 2030.*Jan 2, 2030/);
  assert.equal(f.audits[0].action, 'leave.approved');
  assert.equal(f.audits[0].entityId, id);
});

test('leave rejection retains the review reason and a repeated decision does not duplicate side effects', async () => {
  const f = fixture();
  assert.equal((await invoke(f, { status: 'rejected', adminNote: 'Please discuss the dates with staff.' })).status, 200);
  assert.equal(f.notices[0].type, 'leave_rejected');
  assert.match(f.notices[0].message, /Please discuss the dates/);
  const result = await invoke(f, { status: 'rejected', adminNote: 'Please discuss the dates with staff.' });
  assert.equal(result.payload.message, 'No changes detected.');
  assert.equal(f.writes.length, 1);
  assert.equal(f.notices.length, 1);
  assert.equal(f.audits.length, 1);
});

test('invalid review status, notes and identifiers are rejected before changing records', async () => {
  const f = fixture();
  for (const body of [{ status: 'pending' }, { status: {} }, { status: 'approved', adminNote: {} }, { status: 'rejected', adminNote: 'x'.repeat(501) }]) {
    assert.equal((await invoke(f, body)).status, 400);
  }
  assert.equal((await invoke(f, { status: 'approved' }, { id: 'bad' })).status, 400);
  assert.equal((await invoke(fixture({ missing: true }), { status: 'approved' })).status, 404);
  assert.equal(f.writes.length, 0);
  assert.equal(f.notices.length, 0);
});

test('stale decisions and concurrent cancellations cannot overwrite another staff review', async () => {
  const f = fixture();
  assert.equal((await invoke(f, { status: 'rejected', expectedStatus: 'approved', expectedReviewedAt: null })).status, 409);
  assert.equal(f.writes.length, 0);
  assert.equal((await invoke(f, { status: 'approved' })).status, 200);
  assert.equal((await invoke(f, { status: 'rejected', expectedStatus: 'approved', expectedReviewedAt: null })).status, 409);
  const race = fixture({ race: true });
  assert.equal((await invoke(race, { status: 'approved' })).status, 409);
  assert.equal(race.notices.length, 0);
  assert.equal(race.audits.length, 0);
});

test('staff cannot approve or reapprove leave that overlaps another pending or approved request', async () => {
  const f = fixture({ overlap: { _id: 'another-request', status: 'pending', startDate: new Date('2030-01-01'), endDate: new Date('2030-01-02') } });
  const blocked = await invoke(f, { status: 'approved' });
  assert.equal(blocked.status, 409); assert.equal(blocked.payload.code, 'LEAVE_OVERLAP');
  assert.equal(f.writes.length, 0); assert.equal(f.notices.length, 0);
  assert.equal((await invoke(f, { status: 'rejected' })).status, 200);
  assert.equal((await invoke(f, { status: 'approved' })).status, 409);
  assert.equal(f.writes.length, 1);
});

test('leave list validates filters and returns private data without caching', async () => {
  const f = fixture();
  let code, payload, cache;
  const response = { status(value) { code = value; return this; }, json(value) { payload = value; }, set(key, value) { cache = [key, value]; } };
  for (const q of [{ status: { $ne: 'approved' } }, { technicianId: ['bad'] }]) {
    await f.controller.list({ query: q }, response, assert.fail);
    assert.equal(code, 400);
  }
  await f.controller.list({ query: { status: 'pending', technicianId: userId } }, response, assert.fail);
  assert.equal(payload.items[0]._id, id);
  assert.deepEqual(cache, ['Cache-Control', 'private, no-store']);
});

test('admin and secretary API mounts enforce leave-specific permissions without requiring inventory access', async t => {
  const f = fixture(), adminRouter = express.Router(), secretaryRouter = express.Router(), hvacRouter = express.Router();
  const auth = {
    authenticate(req, res, next) {
      const role = req.headers['x-fixture-role'];
      if (!role) return res.status(401).json({ error: 'Not authenticated' });
      req.user = { _id: userId, role, permissionsOverridden: true,
        permissions: (req.headers['x-fixture-permissions'] || '').split(',').filter(Boolean) };
      next();
    },
    requireRole: roles => (req, res, next) => (Array.isArray(roles) ? roles : [roles]).includes(req.user.role)
      ? next() : res.status(403).json({ error: 'Forbidden' }),
  };
  const register = (router, code) => vm.runInNewContext(code, { router, auth, requirePermission,
    isSecretaryReportRequest: () => false, require: name => {
      assert.equal(name, '../controllers/leaveRequestController'); return f.controller;
    } });
  const admin = source('routes/adminApi.js');
  register(adminRouter, admin.slice(admin.indexOf('router.use(auth.authenticate);'), admin.indexOf('async function reconcileOrderRefundState')));
  const begin = admin.indexOf('const leaveRequests =');
  register(adminRouter, admin.slice(begin, admin.indexOf('// Roles and permissions', begin)));
  const secretary = source('routes/secretaryApi.js');
  register(secretaryRouter, secretary.slice(secretary.indexOf('router.use(auth.authenticate);'), secretary.indexOf('const secretaryServiceImageDir')));
  const hvac = source('routes/hvacApi.js');
  const hvacBegin = hvac.indexOf("router.use('/hvac'");
  register(hvacRouter, hvac.slice(hvacBegin, hvac.indexOf('\n});', hvacBegin) + 4));
  hvacRouter.get('/hvac', (_req, res) => res.json({ items: [] }));
  const app = express(); app.use(express.json());
  // Mirror the production ordering: the shared inventory router comes first.
  app.use('/api/admin', adminRouter);
  app.use('/api/secretary', hvacRouter, secretaryRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (url, role, permissions, body) => fetch(base + url, { method: body ? 'PATCH' : 'GET',
    headers: { ...(role ? { 'x-fixture-role': role } : {}), 'x-fixture-permissions': permissions || '', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await send('/api/admin/leave-requests', 'admin')).status, 200);
  assert.equal((await send('/api/admin/leave-requests', 'secretary', 'technicians.view,technicians.manage')).status, 403);
  assert.equal((await send('/api/secretary/leave-requests', 'secretary', 'technicians.view')).status, 200);
  assert.equal((await send('/api/secretary/leave-requests', 'secretary')).status, 403);
  assert.equal((await send('/api/secretary/hvac', 'secretary', 'technicians.view')).status, 403);
  assert.equal((await send('/api/secretary/leave-requests/' + id, 'secretary', 'technicians.view', { status: 'approved' })).status, 403);
  assert.equal((await send('/api/secretary/leave-requests/' + id, 'secretary', 'technicians.manage', { status: 'approved' })).status, 200);
  assert.equal((await send('/api/secretary/leave-requests', 'customer')).status, 403);
  assert.equal((await send('/api/secretary/leave-requests')).status, 401);
  assert.equal(f.writes.length, 1);
});

test('both leave page URLs require technician view access for secretaries', () => {
  const user = { role: 'secretary' };
  for (const originalUrl of ['/admin/technicians/leaves', '/secretary/technicians/leaves', '/api/secretary/leave-requests']) {
    assert.equal(requiredPermissionForRequest(user, { method: 'GET', originalUrl }), 'technicians.view');
  }
  assert.equal(requiredPermissionForRequest(user, { method: 'PATCH', originalUrl: '/api/secretary/leave-requests/' + id }), 'technicians.manage');
});

test('leave page safely embeds technician-supplied text, including closing script tags', () => {
  const filename = path.join(__dirname, '../views/pages/admin/Technicians/TechnicianLeaves.ejs');
  const reason = '</script><img src=x onerror="window.leaveXss=true">';
  const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
    initialLeaves: [{ _id: id, reason }], leaveApiBase: '/api/secretary/leave-requests', leaveCanManage: false,
  }, { filename });
  const data = html.match(/<script id="techLeavesInitial"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(data).items[0].reason, reason);
  assert.equal(data.includes('</script>'), false);
  assert.equal(JSON.parse(data).canManage, false);
});

test('technician end-date minimum tracks start changes, rejects stale end dates and resets on reopening', () => {
  function input() { return { value: '', listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, setCustomValidity(value) { this.validationMessage = value; } }; }
  const start = input(), end = input();
  const document = { getElementById: key => key === 'leaveStart' ? start : end };
  const view = source('public/js/technician-leave-requests.js');
  const begin = view.indexOf("  const leaveStart = document.getElementById('leaveStart');");
  const context = { document, Intl, Date };
  vm.runInNewContext(view.slice(begin, view.indexOf('// Leave request state', begin)), context);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  assert.equal(end.min, today);
  start.value = '2030-01-10'; start.listeners.input();
  assert.equal(end.min, '2030-01-10');
  end.value = '2030-01-09'; end.listeners.input();
  assert.match(end.validationMessage, /on or after/);
  end.value = start.value; end.listeners.change();
  assert.equal(end.validationMessage, '');
  start.value = '2030-01-12'; start.listeners.change();
  assert.ok(end.validationMessage);
  start.value = ''; end.value = ''; context.syncLeaveDates();
  assert.equal(end.min, today);
  assert.equal(end.validationMessage, '');
});

test('server leave dates enforce inclusive ordering and real Manila calendar days independently of the browser', () => {
  const now = new Date('2026-10-15T16:00:00Z'); // Oct 16 in Manila
  assert.ok(validateLeaveDates('2026-10-15', '', now).fields.startDate);
  for (const end of ['2026-10-17', '2025-01-01', '2026-02-30', {}, null]) {
    assert.ok(validateLeaveDates('2026-10-18', end, now).fields.endDate);
  }
  assert.deepEqual(validateLeaveDates('2026-10-18', '2026-10-18', now).fields, {});
  const single = validateLeaveDates('2026-10-18', '', now);
  assert.equal(single.start.getTime(), single.end.getTime());
  assert.deepEqual(single.fields, {});
});
