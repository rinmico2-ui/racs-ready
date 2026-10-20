'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createService } = require('../utils/technicianLeaveRequests');
const tech = { _id: '507f1f77bcf86cd799439011', name: 'Technician', email: 'fixture@example.test' };
const day = value => new Date(value + 'T00:00:00+08:00');
function fixture(initial = []) {
  const records = initial.map((item, index) => ({ _id: String(index + 1), technicianId: tech._id, ...item }));
  const keys = [], filters = [], queues = new Map();
  const matches = (item, filter) => item.technicianId === filter.technicianId
    && (!filter._id || (filter._id.$ne ? item._id !== filter._id.$ne : item._id === filter._id))
    && (!filter.status || (typeof filter.status === 'string' ? item.status === filter.status : filter.status.$in.includes(item.status)))
    && (!filter.startDate || item.startDate <= filter.startDate.$lte) && (!filter.endDate || item.endDate >= filter.endDate.$gte);
  const query = work => ({ select() { return this; }, lean: async () => work() });
  const LeaveRequest = {
    findOne: filter => { filters.push(filter); return query(() => records.find(item => matches(item, filter)) || null); },
    create: async value => { await new Promise(resolve => setImmediate(resolve)); const record = { _id: String(records.length + 1), ...value }; records.push(record); return record; },
    findOneAndDelete: filter => { filters.push(filter); return query(() => { const index = records.findIndex(item => matches(item, filter)); return index < 0 ? null : records.splice(index, 1)[0]; }); },
  };
  const lock = async (key, work) => {
    keys.push(key); const previous = queues.get(key) || Promise.resolve(); let release;
    const held = new Promise(resolve => { release = resolve; }); queues.set(key, held); await previous;
    try { return await work(); } finally { release(); if (queues.get(key) === held) queues.delete(key); }
  };
  return { records, keys, filters, LeaveRequest, lock, service: createService({ LeaveRequest, lock, now: () => day('2030-01-01') }) };
}

for (const status of ['pending', 'approved']) {
  test(`${status} leave blocks exact, contained, containing and partially overlapping dates, with inclusive boundaries`, async () => {
    const f = fixture([{ status, startDate: day('2030-01-10'), endDate: day('2030-01-12') }]);
    for (const [startDate, endDate] of [['2030-01-10', '2030-01-12'], ['2030-01-11', '2030-01-11'], ['2030-01-09', '2030-01-13'], ['2030-01-09', '2030-01-10'], ['2030-01-12', '2030-01-15']]) {
      await assert.rejects(f.service.submit(tech, { startDate, endDate }), error => error.status === 409 && error.code === 'LEAVE_OVERLAP' && !!error.fields.startDate && error.message.includes(status));
    }
    assert.equal(f.records.length, 1);
  });
  test(`another request is allowed before or after ${status} leave and always starts pending`, async () => {
    const f = fixture([{ status, startDate: day('2030-01-10'), endDate: day('2030-01-12') }]);
    for (const startDate of ['2030-01-09', '2030-01-13']) {
      const record = await f.service.submit(tech, { startDate, reason: ' Another visit ' });
      assert.equal(record.status, 'pending'); assert.equal(record.reason, 'Another visit');
      assert.equal(record.startDate.getTime(), record.endDate.getTime());
    }
    assert.equal(f.records.length, 3);
  });
}

test('rejected requests and another technician’s leave do not block new requests', async () => {
  const f = fixture([{ status: 'rejected', startDate: day('2030-01-10'), endDate: day('2030-01-10') },
    { technicianId: 'someone-else', status: 'approved', startDate: day('2030-01-10'), endDate: day('2030-01-10') }]);
  assert.equal((await f.service.submit(tech, { startDate: '2030-01-10' })).status, 'pending');
});

test('simultaneous duplicate submissions from separate tabs produce one request', async () => {
  const f = fixture(), body = { startDate: '2030-01-10', endDate: '2030-01-12' };
  const results = await Promise.allSettled([f.service.submit(tech, body), f.service.submit(tech, body)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'LEAVE_OVERLAP');
  assert.equal(f.records.length, 1); assert.ok(f.keys.every(key => key === 'technician-leave:' + tech._id));
});

test('simultaneous non-overlapping requests remain allowed', async () => {
  const f = fixture();
  await Promise.all([f.service.submit(tech, { startDate: '2030-01-10' }), f.service.submit(tech, { startDate: '2030-01-11' })]);
  assert.equal(f.records.length, 2);
});

test('invalid dates, past dates, invalid end dates and malformed reasons cannot create leave', async () => {
  const f = fixture();
  for (const body of [{ startDate: '2029-12-31' }, { startDate: '2030-02-30' }, { startDate: {} }, { startDate: '2030-01-10', endDate: '2030-01-09' },
    { startDate: '2030-01-10', reason: {} }, { startDate: '2030-01-10', reason: 'x'.repeat(501) }]) {
    await assert.rejects(f.service.submit(tech, body), error => error.status === 400 && error.code === 'INVALID_LEAVE');
  }
  assert.equal(f.records.length, 0); assert.equal(f.keys.length, 0);
});

test('withdrawal is scoped to the owner and pending state; approved leave survives', async () => {
  const f = fixture([{ status: 'pending', startDate: day('2030-01-10'), endDate: day('2030-01-10') }]);
  await assert.rejects(f.service.cancel('other-technician', '1'), error => error.status === 404);
  f.records[0].status = 'approved';
  await assert.rejects(f.service.cancel(tech._id, '1'), error => error.status === 409 && error.code === 'LEAVE_ALREADY_REVIEWED');
  assert.equal(f.records.length, 1);
  f.records[0].status = 'pending'; await f.service.cancel(tech._id, '1'); assert.equal(f.records.length, 0);
  assert.ok(f.filters.filter(filter => filter.status === 'pending').length >= 3);
});

test('approval checks exclude the request being reviewed and reject a conflicting replacement request', async () => {
  const f = fixture([{ status: 'pending', startDate: day('2030-01-10'), endDate: day('2030-01-10') }]);
  await f.service.assertNoOverlap(tech._id, day('2030-01-10'), day('2030-01-10'), '1');
  await assert.rejects(f.service.assertNoOverlap(tech._id, day('2030-01-10'), day('2030-01-10'), 'a-rejected-request'), error => error.code === 'LEAVE_OVERLAP');
});

test('lock timeouts explain the leave operation instead of referring to booking slots', async () => {
  const service = createService({ lock: async () => { throw Object.assign(Error('booking slot'), { code: 'OPERATION_LOCK_TIMEOUT' }); } });
  await assert.rejects(service.withLock(tech._id, () => {}), error => error.code === 'LEAVE_BUSY' && !error.message.includes('booking'));
});

test('real technician routes enforce ownership, expose all blocked ranges, and create only pending requests', async t => {
  const express = require('express'), app = express(), Technician = require('../models/Technician'), LeaveRequest = require('../models/LeaveRequest');
  const f = fixture(), reads = [], notices = [], audits = [];
  const query = value => ({ select(value) { this.projection = value; return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
  t.mock.method(Technician, 'findOne', filter => { assert.equal(filter.user, '507f1f77bcf86cd799439012'); return query(tech); });
  t.mock.method(LeaveRequest, 'create', f.LeaveRequest.create); t.mock.method(LeaveRequest, 'findOne', f.LeaveRequest.findOne);
  t.mock.method(LeaveRequest, 'findOneAndDelete', f.LeaveRequest.findOneAndDelete);
  t.mock.method(LeaveRequest, 'find', filter => { reads.push(filter); assert.equal(String(filter.technicianId), tech._id); return query(f.records); });
  t.mock.method(require('../utils/operationLock'), 'withOperationLock', f.lock);
  t.mock.method(require('../utils/notify'), 'createNotification', async value => { notices.push(value); });
  t.mock.method(require('../utils/audit'), 'logEvent', async value => { audits.push(value); });
  app.use(express.json()); app.use((req, _res, next) => {
    req.authResolved = true; req.user = { _id: '507f1f77bcf86cd799439012', role: req.headers['x-test-role'] || 'technician', accountStatus: 'active',
      permissionsOverridden: true, permissions: ['attendance.self.manage'] }; next();
  });
  app.use('/api/technician', require('../routes/technicianApi'));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (method = 'GET', body, suffix = '', role = 'technician') => fetch(`http://127.0.0.1:${server.address().port}/api/technician/leave-requests${suffix}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-test-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const role of ['admin', 'secretary', 'customer']) assert.equal((await request('GET', null, '', role)).status, 403);
  const input = { startDate: '2030-01-10', endDate: '2030-01-12', status: 'approved', technicianId: 'somebody-else' };
  assert.equal((await request('POST', input)).status, 201); assert.equal(f.records[0].status, 'pending'); assert.equal(f.records[0].technicianId, tech._id);
  assert.equal((await request('POST', input)).status, 409); assert.equal(notices.length, 1); assert.equal(audits.length, 1);
  f.records[0].status = 'approved'; assert.equal((await request('POST', input)).status, 409);
  assert.equal((await request('POST', { startDate: '2030-01-13' })).status, 201);
  const listing = await request(), data = await listing.json(); assert.equal(listing.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(data.unavailableRanges.length, 2); assert.ok(reads.some(filter => filter.endDate?.$gte && filter.status.$in.includes('approved')));
  assert.ok(f.keys.every(key => key === 'technician-leave:' + tech._id));
});
