"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextProjectWork, dailyConfirmation, endProjectDay, confirmProjectDay } = require('../utils/projectDailyContinuation');
const { projectCrewCalendar, calendarWindow } = require('../utils/projectCrewCalendar');
const { notifyProjectScheduleChange } = require('../utils/projectScheduleNotifications');
const { atomicWorkflowChanges } = require('../utils/atomicWorkflowChanges');
const fs = require('node:fs');
const vm = require('node:vm');
const now = new Date('2026-10-14T18:30:00Z'); // October 15 in Manila.
const query = value => ({ select() { return this; }, populate() { return this; }, lean: async () => structuredClone(value) });
const project = { _id: 'project', status: 'in_progress', leadTechnicianId: 'lead', assignedTechnicians: [{ _id: 'lead' }, { _id: 'crew', name: 'Crew' }, { _id: 'later', name: 'Later crew' }] };
const orders = [{ _id: 'wo', status: 'in_progress', unitCount: 3, completedUnitCount: 1, units: [{ unitKey: '1', status: 'completed' }, { unitKey: '2', status: 'in_progress' }, { unitKey: '3', status: 'pending' }] }];
const future = [{ _id: 'future', workOrderId: 'wo', technicianId: 'crew', date: '2026-10-19T01:00:00Z', status: 'pending', unitKeys: ['2', '3'] }];

test('next-day confirmation follows committed Monday allocations rather than assuming tomorrow', () => {
  const next = nextProjectWork(project, orders, future, now);
  assert.equal(next.date, future[0].date); assert.equal(next.scheduleRequired, false);
  assert.deepEqual(dailyConfirmation(project, next).membersAccepted.map(row => row._id), ['crew']);
});
test('missed units require a new plan even when other work already has future allocations', () => {
  assert.equal(nextProjectWork(project, orders, [{ ...future[0], unitKeys: ['3'] }], now).scheduleRequired, true);
  assert.equal(nextProjectWork(project, orders, [{ ...future[0], planningOnly: true }], now).scheduleRequired, true);
  assert.equal(nextProjectWork(project, orders, [{ ...future[0], date: now }], now).scheduleRequired, true);
  assert.equal(nextProjectWork(project, [{ ...orders[0], status: 'completed' }], [], now).unfinished, false);
});
for (const initialStatus of ['in_progress', 'completed']) test(`project day closure preserves progress and confirmations from ${initialStatus}`, async () => {
  const today = [{ _id: 'today', projectId: 'project', workOrderId: 'wo', status: initialStatus, completedUnits: 1, date: now }];
  const writes = [];
  const p = structuredClone(project);
  const Project = { findById: () => query(p) }, WorkOrder = { find: () => query(orders) };
  const DailyAssignment = { find: filter => { assert.equal(filter.planningOnly.$ne, true); return query(filter.date.$lt ? today : future); } };
  const options = { projectId: 'project', leadId: 'lead', now, Project, WorkOrder, DailyAssignment, lock: async (_, work) => work(),
    write: async changes => { writes.push(changes); for (const change of changes) { if (change.Model === Project) Object.assign(p, change.set); if (change.Model === DailyAssignment) Object.assign(today[0], change.set); } return changes.map(change => ({ ...change.before, ...change.set })); } };
  const result = await endProjectDay(options);
  assert.equal(result.scheduleRequired, false); assert.equal(today[0].status, 'completed'); assert.equal(today[0].completedUnits, 1);
  assert.equal(writes[0].find(change => change.Model === WorkOrder).set.status, 'accepted');
  assert.equal(orders[0].completedUnitCount, 1);
  assert.equal((await endProjectDay(options)).duplicate, true); assert.equal(writes.length, 1);
  await assert.rejects(endProjectDay({ ...options, leadId: 'outsider' }), error => error.status === 403);
});
test('non-crew and crew not allocated on the next workday cannot decline that day', async () => {
  const p = { ...project, dailyAcceptance: dailyConfirmation(project, nextProjectWork(project, orders, future, now)) };
  for (const technicianId of ['outsider', 'later']) {
    await assert.rejects(confirmProjectDay({ projectId: p._id, technicianId, accept: false, reason: 'Unavailable', Project: { findById: () => query(p) } }), error => error.status === 403);
  }
});
test('crew decline keeps the confirmation gate closed and accepts are blocked pending review', async () => {
  const p = { ...project, dailyAcceptance: dailyConfirmation(project, nextProjectWork(project, orders, future, now)) };
  let update;
  const Project = { findById: () => query(p), findOneAndUpdate: async (filter, fields) => { update = { filter, fields }; return p; } };
  await confirmProjectDay({ projectId: p._id, technicianId: 'crew', accept: false, reason: 'Unavailable', Project });
  assert.equal(update.fields.$set['dailyAcceptance.required'], true);
  assert.equal(update.fields.$push['dailyAcceptance.declined']._id, 'crew');
  p.dailyAcceptance.declined.push({ _id: 'crew' });
  await assert.rejects(confirmProjectDay({ projectId: p._id, technicianId: 'lead', accept: true, Project }), /resolve staffing/);
});
test('lead confirmation allows a coordinating lead while members must have their own committed allocation', async () => {
  const p = { ...project, dailyAcceptance: dailyConfirmation(project, nextProjectWork(project, orders, future, now)) };
  const filters = [];
  const Project = { findById: () => query(p), findOneAndUpdate: async filter => { filters.push(filter); return filters.length === 1 ? p : null; } };
  const DailyAssignment = { exists: async filter => { assert.equal(filter.technicianId, undefined); assert.equal(filter.date.$gte.toISOString(), '2026-10-18T16:00:00.000Z'); assert.equal(filter.date.$lt.toISOString(), '2026-10-19T16:00:00.000Z'); return true; } };
  const result = await confirmProjectDay({ projectId: p._id, technicianId: 'lead', accept: true, Project, DailyAssignment });
  assert.equal(result.allConfirmed, false); assert.equal(filters[0].leadTechnicianId, 'lead');
  assert.deepEqual(filters[1]['dailyAcceptance.membersAccepted'], { $not: { $elemMatch: { accepted: false } } });
});
test('invalid, past, reversed and excessively long project windows are rejected', () => {
  for (const dates of [{ startDate: 'bad', endDate: '2026-10-19' }, { startDate: '2025-10-15', endDate: '2026-10-19' }, { startDate: '2026-10-20', endDate: '2026-10-19' }, { startDate: '2026-10-19', endDate: '2027-10-19' }]) {
    assert.throws(() => calendarWindow(dates, now), error => error.status === 400);
  }
});
test('project forecast accepts numbered, named and legacy working days without an empty-day loop', () => {
  const source = fs.readFileSync(require.resolve('../views/pages/admin/Projects/ProjectDetail.ejs'), 'utf8');
  const start = source.indexOf('  function projectWorkingDays('), end = source.indexOf('  function defaultRecoveryMode(', start);
  const days = vm.runInNewContext(source.slice(start, end) + '\nprojectWorkingDays;');
  for (const input of [{ preferredWorkingDays: ['1','2','3','4','5'] }, { preferredWorkingDays: ['Mon','Tuesday','Wed','Thu','Friday'] }, { schedulePlan: { workingDays: [1,2,3,4,5] } }, { preferredWorkingDays: ['invalid'] }]) {
    assert.deepEqual([...days(input)], [1,2,3,4,5]);
  }
});
test('crew calendar subtracts bookings, travel and other project overlaps without double counting', async () => {
  const context = { schedules: [], leaves: [], holidays: [], bookings: [{ technicianId: 'crew', bookingDate: '2026-10-19', startTime: '09:00', endTime: '11:00', travelDurationMinutes: 30 }],
    otherAssignments: [{ technicianId: 'crew', date: '2026-10-19', startTime: '10:00', endTime: '12:00' }] };
  const result = await projectCrewCalendar({ ...project, assignedTechnicians: [{ _id: 'crew' }] }, { startDate: '2026-10-19', endDate: '2026-10-19' },
    { now, Technician: { find: () => query([{ _id: 'crew', name: 'Crew', user: { active: true, role: 'technician' } }]) }, contextBuilder: async () => context });
  assert.equal(result.days[0].date, '2026-10-19'); assert.equal(result.availableHours, 5);
  assert.deepEqual(result.days[0].technicians[0].conflicts, ['Customer booking', 'Another project']);
});
test('approved leave, holidays, rest dates and inactive accounts are unavailable in the calendar', async () => {
  for (const [field, rows, label] of [ ['leaves', [{ technicianId: 'crew', startDate: '2026-10-18', endDate: '2026-10-20' }], 'Approved leave'],
    ['holidays', [{ date: '2026-10-19' }], 'Non-working day'], ['schedules', [{ technicianId: 'crew', restDates: [{ date: '2026-10-19' }] }], 'Rest date'] ]) {
    const context = { schedules: [], leaves: [], holidays: [], bookings: [], otherAssignments: [], [field]: rows };
    const result = await projectCrewCalendar(project, { startDate: '2026-10-19', endDate: '2026-10-19' }, { now,
      Technician: { find: () => query([{ _id: 'crew', user: { active: true, role: 'technician' } }, { _id: 'blocked', user: { active: false, role: 'technician' } }]) }, contextBuilder: async () => context });
    assert.equal(result.hasAvailability, false); assert.equal(result.technicians.length, 1);
    assert.equal(result.days[0].technicians[0].conflicts[0], label);
  }
});
test('schedule notices include the changed Philippine dates through both customer channels', async () => {
  const sent = [], mail = [];
  const result = await notifyProjectScheduleChange({ ...project, customerId: 'customer', customer: { email: 'customer@example.test' } },
    { startDate: '2026-10-18T16:00:00Z', endDate: '2026-10-20T16:00:00Z', reason: 'Access confirmed.', confirmed: true }, { app: { get: () => null } },
    { User: { findById: () => query({ _id: 'customer' }) }, notify: async input => { sent.push(input); return true; }, mailer: { sendMail: async input => { mail.push(input); return true; } } });
  assert.equal(result.status, 'sent'); assert.match(sent[0].message, /2026-10-19 to 2026-10-21/); assert.match(mail[0].text, /Access confirmed/);
});
test('a notification outage is reported without turning an already-saved schedule into a failed save', async () => {
  const result = await notifyProjectScheduleChange({ ...project, customerId: 'customer', customer: { email: 'customer@example.test' } },
    { startDate: '2026-10-19', endDate: '2026-10-20' }, { app: { get: () => null } },
    { User: { findById: () => ({ select() { return this; }, lean: async () => { throw Error('offline'); } }) }, notify: async () => { throw Error('offline'); }, mailer: { sendMail: async () => { throw Error('offline'); } } });
  assert.equal(result.status, 'failed'); assert.match(result.error, /email/);
});
test('standalone multi-document updates reverse prior fields if the second document changed', async () => {
  const writes = [], reversals = [];
  const Model = { findOneAndUpdate: async (filter, update) => { writes.push({ filter, update }); return writes.length === 1 ? { _id: 'one', __v: 2 } : null; },
    updateOne: async (filter, update) => { reversals.push({ filter, update }); return { matchedCount: 1 }; } };
  const standalone = { connection: { getClient: () => ({ topology: { description: { servers: new Map([['local', { type: 'Standalone' }]]) } } }) } };
  await assert.rejects(atomicWorkflowChanges([{ Model, before: { _id: 'one', status: 'in_progress', __v: 1, continuation: { status: 'pending' } }, set: { status: 'accepted' }, unset: { continuation: '' } },
    { Model, before: { _id: 'two', status: 'in_progress', __v: 1 }, set: { status: 'accepted' } }], standalone), error => error.status === 409);
  assert.equal(reversals.length, 1); assert.equal(reversals[0].filter.__v, 2);
  assert.equal(reversals[0].update.$set.status, 'in_progress'); assert.equal(reversals[0].update.$set.continuation.status, 'pending');
});
