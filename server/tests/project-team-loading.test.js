'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { projectTeamEligibility } = require('../utils/projectTeamEligibility');
const projectId = '6acd3b47678aa45bd94a7354';
const project = { _id: projectId, preferredStartDate: '2035-01-01T00:00:00', preferredCompletionDeadline: '2035-01-05T00:00:00' };
const techs = Array.from({ length: 9 }, (_, i) => ({ _id: String(i + 1), name: 'Technician ' + (i + 1) }));

function dependencies({ projects = [], leaves = [], bookings = [], fail = false } = {}) {
  const calls = [], pending = [];
  function query(kind, filter, rows) {
    calls.push({ kind, filter });
    const promise = new Promise((resolve, reject) => pending.push(() => fail ? reject(Error('Temporary database error')) : resolve(rows)));
    return { select() { return this; }, lean() { return promise; } };
  }
  return { calls, resolve() { pending.forEach(resolve => resolve()); }, models: {
    Project: { find: filter => query('projects', filter, projects) },
    LeaveRequest: { find: filter => query('leaves', filter, leaves) },
    BookingService: { aggregate: stages => query('bookings', stages, bookings).lean() },
  } };
}

test('nine technicians use three concurrent batch checks and preserve conflicts for every team member', async () => {
  const original = JSON.stringify(techs);
  const d = dependencies({ projects: [{ assignedTechnicians: [{ _id: '1' }, { _id: '2' }] }],
    leaves: [{ technicianId: '2' }, { technicianId: '3' }], bookings: [{ _id: '4', count: 2 }] });
  const work = projectTeamEligibility(project, techs, d.models);
  assert.equal(d.calls.length, 3, 'All checks start before any of the queries resolves'); d.resolve();
  const result = await work;
  assert.equal(d.calls.length, 3); assert.equal(result.technicians.length, 9);
  assert.match(result.technicians[0].conflictReason, /another project/);
  assert.match(result.technicians[1].conflictReason, /another project/);
  assert.match(result.technicians[2].conflictReason, /approved leave/);
  assert.match(result.technicians[3].conflictReason, /2 fixed booking/);
  assert.equal(result.technicians[4].availableDuringProject, true);
  assert.equal(JSON.stringify(techs), original, 'Saved technician objects are not mutated');
  assert.deepEqual(d.calls[0].filter['assignedTechnicians._id'].$in, techs.map(t => t._id));
  assert.equal(d.calls[0].filter._id.$ne, projectId);
  assert.deepEqual(d.calls[1].filter.technicianId.$in, techs.map(t => t._id));
  const match = d.calls[2].filter[0].$match;
  assert.deepEqual(match.technicianId.$in, techs.map(t => t._id));
  assert.ok(!match.status.$in.includes('cancelled')); assert.equal(match.$or.length, result.projectSpan.workingDays);
});

test('missing dates do not launch needless conflict queries or present an unchecked list as checked', async () => {
  const d = dependencies(); const result = await projectTeamEligibility({ _id: projectId }, techs, d.models);
  assert.equal(d.calls.length, 0); assert.equal(result.projectSpan, null);
  assert.equal(result.technicians[0].availabilityChecked, false);
  const empty = await projectTeamEligibility(project, [], d.models); assert.equal(empty.technicians.length, 0); assert.equal(d.calls.length, 0);
});

test('failed checks reject the response instead of claiming technicians are available', async () => {
  const d = dependencies({ fail: true }); const work = projectTeamEligibility(project, techs, d.models); d.resolve();
  await assert.rejects(work, /Temporary database error/);
});

test('the actual eligible-technicians endpoint keeps its staff guard, active roster filter and batch result', async () => {
  const route = fs.readFileSync(require.resolve('../routes/projectRoutes'), 'utf8').replace(/\r\n/g, '\n');
  const start = route.indexOf('router.get("/projects/:id/eligible-technicians"'); const end = route.indexOf('\n});', start);
  let handler, rosterFilter, batches = 0;
  vm.runInNewContext(route.slice(start, end + 4), { router: { get(_path, guard, fn) { assert.equal(guard, 'staff'); handler = fn; } },
    auth: { requireRole: roles => { assert.deepEqual(Array.from(roles), ['admin', 'secretary']); return 'staff'; } },
    mongoose: { Types: { ObjectId: { isValid: () => true } } },
    Project: { findById: () => ({ lean: async () => project }) },
    Technician: { find(filter) { rosterFilter = filter; return { select() { return this; }, lean: async () => techs }; } }, BookingService: {},
    require(name) { if (name.includes('projectTeamEligibility')) return { projectTeamEligibility: async (p, rows) => { batches++; assert.equal(p, project); assert.equal(rows, techs); return { technicians: rows }; } }; return {}; }, console: { error() {} },
  });
  let output; await handler({ params: { id: projectId } }, { json(value) { output = value; } });
  assert.equal(rosterFilter.active.$ne, false); assert.equal(batches, 1); assert.equal(output.technicians.length, 9);
});

test('allocation calendar reads independent data together and avoids the extra unassigned-roster query', async () => {
  const source = fs.readFileSync(require.resolve('../utils/projectAllocation'), 'utf8');
  const calls = [], pending = [];
  const makeQuery = (name, data) => ({ select() { return this; }, lean() {
    if (name === 'project' || name === 'technicians' || name === 'settings') { calls.push(name); return Promise.resolve(data); }
    return { then(resolve) { calls.push(name); return new Promise(complete => pending.push(() => complete(resolve(data)))); } };
  } });
  const p = { ...project, assignedTechnicians: [], reservedTechnicians: 1 };
  const models = {
    Project: { findById: () => makeQuery('project', p), computeActiveSpan: () => ({ start: new Date('2035-01-01'), end: new Date('2035-01-05') }), find: () => makeQuery('otherProjects', []) },
    Technician: { find(filter) { assert.equal(filter.active.$ne, false); return makeQuery('technicians', [{ _id: '1', name: 'Technician' }]); } },
    BookingService: { find: () => makeQuery('bookings', []) }, LeaveRequest: { find: () => makeQuery('leaves', []) },
    NonWorkingDay: { find: () => makeQuery('holidays', []) }, TechnicianSchedule: { find: () => makeQuery('schedules', []) },
    SiteSetting: { findOne: () => makeQuery('settings', null) },
  };
  const context = { module: { exports: {} }, require(name) { if (name === 'mongoose') return {}; const model = name.split('/').pop(); assert.ok(models[model], name); return models[model]; } };
  vm.runInNewContext(source, context);
  const work = context.module.exports.buildAllocationCalendar(projectId);
  for (let i = 0; i < 20 && pending.length < 5; i++) await Promise.resolve();
  assert.equal(pending.length, 5, 'Holiday, schedule, project, leave and booking reads overlap');
  pending.forEach(resolve => resolve()); const result = await work;
  assert.equal(calls.filter(name => name === 'technicians').length, 1);
  assert.equal(result.technicians.length, 1); assert.ok(result.days.length > 0);
  assert.ok(result.days.every(day => day.matrix[0].status === 'free'));
});
