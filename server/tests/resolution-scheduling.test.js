'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const Booking = require('../models/BookingService');
const Assignment = require('../models/Assignment');
const engine = require('../utils/enterpriseSchedulingEngine');
const calendar = require('../routes/scheduleRoutes');
const scheduling = require('../utils/resolutionScheduling');
const NOW = new Date('2030-01-01T12:00:00+08:00');
const id = '507f191e810c19729de860ea';
const base = { _id: id, customerId: '507f191e810c19729de860eb', quantity: 2, serviceDurationMinutes: 120, status: 'pending', resolutionCases: [] };

function projectMocks(t, project = null, sufficient = true) {
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  t.mock.method(Project, 'findOne', () => ({ lean: async () => project }));
  let input;
  t.mock.method(engine, 'getProjectWindowAvailability', async value => { input = value; return { sufficient, window: { startDate: value.startDate, endDate: value.endDate } }; });
  return () => input;
}

test('classification uses complete units and aggregate workload without multiplying stored duration again', () => {
  assert.deepEqual(scheduling.bookingWorkload(base), { totalUnits: 2, totalEstimatedMinutes: 120, isProject: false });
  assert.equal(scheduling.bookingWorkload({ ...base, quantity: 7, serviceDurationMinutes: 480 }).isProject, false);
  assert.equal(scheduling.bookingWorkload({ ...base, quantity: 8, serviceDurationMinutes: 480 }).isProject, true);
  assert.equal(scheduling.bookingWorkload({ ...base, quantity: 1, serviceDurationMinutes: 481 }).isProject, true);
  assert.equal(scheduling.bookingWorkload({ ...base, serviceDurationMinutes: 361 }, 6).isProject, true);
  assert.equal(scheduling.bookingWorkload({ ...base, isProject: true }).isProject, true);
  const mixed = scheduling.bookingWorkload({ services: [{ quantity: 3, duration: 120 }, { type: 'repair', quantity: 5 }] });
  assert.deepEqual(mixed, { totalUnits: 8, totalEstimatedMinutes: 810, isProject: true });
  assert.equal(scheduling.bookingWorkload({ quantity: 4, service: { duration: 120 } }).totalEstimatedMinutes, 480);
});

test('standard reschedule checks canonical slots for the total workload and excludes only its own booking', async t => {
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  let query, exclusions;
  t.mock.method(calendar, 'getTimeSlotsForQuery', async (q, e) => { query = q; exclusions = e; return { statusCode: 200, payload: { timeSlots: [{ startTime: '09:00', available: true }], capacityPerSlot: 165 } }; });
  const result = await scheduling.validateResolutionSchedule(base, { date: '2030-01-02', time: '9:00 AM', isProject: true, quantity: 99 }, NOW);
  assert.equal(result.isProject, false); assert.equal(result.time, '09:00'); assert.equal(result.endTime, '705');
  assert.equal(result.dateObj.toISOString(), '2030-01-01T16:00:00.000Z');
  assert.equal(query.duration, '120'); assert.equal(query.quantity, '1'); assert.equal(exclusions.excludeBookingId, id);
});

test('standard reschedule rejects invalid, past, and unavailable slots', async t => {
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  let reads = 0;
  t.mock.method(calendar, 'getTimeSlotsForQuery', async () => { reads++; return { statusCode: 200, payload: { timeSlots: [{ startTime: '09:00', available: false }] } }; });
  for (const input of [{ date: '2030-02-30', time: '09:00' }, { date: '2030-01-02', time: '25:00' }, { date: '2030-01-01', time: '09:00' }]) {
    await assert.rejects(scheduling.validateResolutionSchedule(base, input, NOW), error => error.status === 400);
  }
  assert.equal(reads, 0);
  await assert.rejects(scheduling.validateResolutionSchedule(base, { date: '2030-01-02', time: '09:00' }, NOW), error => error.status === 409 && error.refreshSlots);
});

test('project reschedule validates a preferred window using trusted workload, excludes itself, and keeps preferences', async t => {
  const getInput = projectMocks(t, { _id: 'own-project', status: 'pending_project_scheduling' });
  const result = await scheduling.validateResolutionSchedule({ ...base, quantity: 8, serviceDurationMinutes: 660 }, {
    newDate: '2030-01-02', endDate: '2030-01-05', newTime: '09:00', requiredHours: 1, quantity: 1,
    projectScheduling: { preferredWorkingDays: ['monday', 'saturday', 'monday', 'invalid'], preferredWorkingHours: { start: 'afternoon' }, estimatedTotalHours: 1 },
  }, NOW);
  assert.deepEqual(getInput(), { startDate: '2030-01-02', endDate: '2030-01-05', requiredHours: 11, totalUnits: 8, excludeProjectId: 'own-project' });
  assert.equal(result.time, ''); assert.equal(result.endTime, '');
  assert.deepEqual(result.projectScheduling.preferredWorkingDays, ['monday', 'saturday']);
  assert.equal(result.projectScheduling.preferredWorkingHours.start, 'afternoon');
  assert.equal(result.projectScheduling.estimatedTotalHours, 11);
});

test('a project cannot save a lone appointment, invalid range, insufficient capacity, or replace an approved plan', async t => {
  projectMocks(t, null, false);
  const project = { ...base, quantity: 8 };
  for (const input of [{ date: '2030-01-02', time: '09:00' }, { date: '2030-01-02', endDate: '2030-01-01' }, { date: '2030-01-01', endDate: '2030-01-05' }, { date: '2030-01-02', endDate: '2030-02-30' }]) {
    await assert.rejects(scheduling.validateResolutionSchedule(project, input, NOW), error => error.status === 400);
  }
  await assert.rejects(scheduling.validateResolutionSchedule(project, { date: '2030-01-02', endDate: '2030-01-05' }, NOW), error => error.status === 409 && error.refreshSlots);
  t.mock.method(Project, 'findOne', () => ({ lean: async () => ({ _id: 'project', status: 'ready', scheduleLocked: true }) }));
  await assert.rejects(scheduling.validateResolutionSchedule(project, { date: '2030-01-02', endDate: '2030-01-05' }, NOW), /Operations project planning/);
});

test('project synchronization updates existing preferences and creates mixed-service unit groups for legacy conversions', async t => {
  projectMocks(t);
  const booking = { ...base, services: [{ name: 'Cleaning', type: 'core', quantity: 5, duration: 60 }, { name: 'Repair', type: 'repair', quantity: 3, duration: 90 }] };
  const schedule = await scheduling.validateResolutionSchedule(booking, { date: '2030-01-02', endDate: '2030-01-05' }, NOW);
  let created, update, options;
  t.mock.method(Project, 'create', async (docs, opts) => { created = docs[0]; options = opts; });
  t.mock.method(Project, 'findOneAndUpdate', async (_, value, opts) => { update = value; options = opts; return {}; });
  const session = {};
  await scheduling.syncResolutionProject(booking, schedule, session);
  assert.equal(created.status, 'pending_project_scheduling'); assert.equal(created.totalUnits, 8);
  assert.equal(created.unitGroups.length, 2); assert.equal(created.unitGroups[1].units.length, 3);
  assert.equal(created.preferredCompletionDeadline.toISOString(), '2030-01-04T16:00:00.000Z');
  assert.equal(created.plannedCompletionDate, undefined); assert.equal(options.session, session);
  await scheduling.syncResolutionProject(booking, { ...schedule, project: { _id: 'existing' } }, session);
  assert.equal(update.$set.totalUnits, 8); assert.equal(update.$unset.plannedCompletionDate, 1); assert.equal(options.session, session);
});

test('project booking and project writes share a transaction and always close the session', async t => {
  let closed = 0, attempted = 0;
  const session = { withTransaction: async commit => { attempted++; return commit(); }, endSession: async () => { closed++; } };
  t.mock.method(mongoose, 'startSession', async () => session);
  await scheduling.commitResolutionSchedule({ isProject: true }, async supplied => assert.equal(supplied, session));
  await assert.rejects(scheduling.commitResolutionSchedule({ isProject: true }, async () => { throw Error('write failed'); }), /write failed/);
  await scheduling.commitResolutionSchedule({ isProject: false }, async supplied => assert.equal(supplied, undefined));
  assert.equal(closed, 2); assert.equal(attempted, 2);
});

test('a project approved during date selection cannot have its confirmed plan overwritten', async t => {
  let filter;
  t.mock.method(Project, 'findOneAndUpdate', async query => { filter = query; return null; });
  await assert.rejects(scheduling.syncResolutionProject(base, {
    isProject: true, totalUnits: 8, project: { _id: id }, projectScheduling: { estimatedTotalHours: 11 }, dateObj: new Date('2035-01-02'),
  }, {}), error => error.status === 409);
  assert.equal(filter.scheduleLocked.$ne, true);
  assert.equal(filter['schedulePlan.status'].$ne, 'confirmed');
});

const routeSource = fs.readFileSync(path.join(__dirname, '../routes/adminApi.js'), 'utf8').replace(/\r\n/g, '\n');
const actualRequire = createRequire(path.join(__dirname, '../routes/adminApi.js'));
function handler(method, route, mocks = {}) {
  const begin = routeSource.indexOf(`router.${method}("${route}"`);
  const start = routeSource.indexOf('async (req, res, next) => {', begin);
  const end = routeSource.indexOf('\n});', start);
  return vm.runInNewContext('(' + routeSource.slice(start, end + 2) + ')', {
    mongoose, console, Date, require: name => name === '../index' ? { io: null } : (mocks[name] || actualRequire(name)),
  });
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; return this; } }; }
const request = body => ({ params: { id }, body, query: {}, user: { _id: base.customerId, name: 'Admin', role: 'admin' }, app: { get: () => null } });

test('cancelled and finished bookings reject resolution calendars and rescheduling before any capacity reads or writes',async t=>{
  let reads=0,writes=0;
  t.mock.method(engine,'getProjectThresholdHours',async()=>{reads++;return 8;});
  for(const status of ['cancelled','completed','closed','repair_completed']) {
    await assert.rejects(scheduling.validateResolutionSchedule({...base,status},{date:'2035-01-02',time:'09:00'}),error=>error.status===409);
    const booking={...base,status,save:async()=>{writes++;}};
    const save=response();
    await handler('post','/review-reschedule/:id/reschedule',{'../models/BookingService':{findById:async()=>booking}})(request({date:'2035-01-02',time:'09:00'}),save,error=>{throw error;});
    assert.equal(save.code,409);
    for(const [method,route] of [['get','/resolution-center/:id/schedule-availability'],['post','/resolution-center/:id/window-availability']]) {
      let failure;
      await handler(method,route,{'../models/BookingService':{findById:()=>({lean:async()=>booking})}})(request({startDate:'2035-01-02',endDate:'2035-01-05'}),response(),error=>{failure=error;});
      assert.equal(failure.status,409);
    }
  }
  assert.equal(reads,0);assert.equal(writes,0);
});

test('both resolution save routes send large projects to planning without an appointment time', async t => {
  projectMocks(t);
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async commit => commit(), endSession: async () => {} }));
  t.mock.method(Project, 'create', async () => []);
  t.mock.method(Assignment, 'updateMany', async () => ({}));
  let written;
  t.mock.method(Booking, 'findByIdAndUpdate', async (_, update) => { written = update; return {}; });
  const mocks = { '../models/Notification': { create: async () => {} }, '../utils/audit': { logEvent: async () => {} }, '../utils/notify': { createNotification: async () => {} } };
  for (const route of ['/review-reschedule/:id/reschedule', '/no-show-review/:id/reschedule']) {
    const booking = { ...base, resolutionCases: [], quantity: 8, status: route.includes('no-show') ? 'no-show-reported' : 'pending', toObject() { return { ...this }; }, async save() { written = { $set: this }; } };
    t.mock.method(Booking, 'findById', async () => booking);
    const res = response();
    await handler('post', route, mocks)(request({ date: '2035-01-02', newDate: '2035-01-02', endDate: '2035-01-05', issueType: 'past_date' }), res, error => { throw error; });
    assert.equal(res.code, 200); assert.equal(written.$set.status, 'pending_project_scheduling');
    assert.equal(written.$set.isProject, true); assert.equal(written.$set.startTime, '');
    assert.equal(written.$set.projectScheduling.preferredCompletionDeadline.toISOString(), '2035-01-04T16:00:00.000Z');
  }
});

test('both resolution save routes reject lost project capacity before any booking or assignment write', async t => {
  projectMocks(t, null, false);
  let writes = 0;
  t.mock.method(Booking, 'findById', async () => ({ ...base, quantity: 8, status: 'no-show-reported', async save() { writes++; } }));
  t.mock.method(Booking, 'findByIdAndUpdate', async () => { writes++; });
  t.mock.method(Assignment, 'updateMany', async () => { writes++; });
  for (const route of ['/review-reschedule/:id/reschedule', '/no-show-review/:id/reschedule']) {
    const res = response();
    await handler('post', route)(request({ date: '2035-01-02', newDate: '2035-01-02', endDate: '2035-01-05' }), res, error => { throw error; });
    assert.equal(res.code, 409); assert.equal(res.body.refreshSlots, true);
  }
  assert.equal(writes, 0);
});

test('calendar availability uses persisted workload and trusted exclusions rather than browser overrides', async t => {
  projectMocks(t);
  t.mock.method(Booking, 'findById', () => ({ lean: async () => base }));
  let query, exclusions;
  t.mock.method(calendar, 'getTimeSlotsForQuery', async (q, e) => { query = q; exclusions = e; return { statusCode: 200, payload: { timeSlots: [] } }; });
  const res = response(); const req = request({});
  req.query = { date: '2035-01-02', quantity: 99, duration: 1, excludeBookingId: 'another-booking' };
  await handler('get', '/resolution-center/:id/schedule-availability')(req, res, error => { throw error; });
  assert.equal(res.code, 200); assert.equal(query.duration, '120'); assert.equal(query.quantity, '1'); assert.equal(exclusions.excludeBookingId, id);
});

test('the resolution queue includes overdue project requests and distinguishes their workload from standard bookings', async t => {
  t.mock.method(engine, 'getProjectThresholdHours', async () => 8);
  let bookingQuery, projection;
  const rows = [
    { ...base, bookingDate: new Date('2020-01-01'), startTime: '09:00' },
    { ...base, _id: '507f191e810c19729de860ec', quantity: 8, isProject: true, status: 'pending_project_scheduling',
      projectScheduling: { preferredStartDate: new Date('2020-01-01') }, bookingDate: new Date('2020-01-01') },
    { ...base, _id: '507f191e810c19729de860ed', quantity: 8, isProject: true, status: 'confirmed', bookingDate: new Date('2035-01-01') },
  ];
  const chain = values => ({ sort() { return this; }, allowDiskUse() { return this; }, limit() { return this; }, populate() { return this; },
    select(value) { projection = value; return this; }, lean: async () => values });
  const mocks = {
    '../models/BookingService': { find(query) { bookingQuery = query; return chain(rows); } },
    '../models/Order': { find: () => chain([]), distinct: async () => [] },
    '../models/ServiceReport': { find: () => chain([]) },
  };
  const res = response();
  await handler('get', '/resolution-center', mocks)(request({}), res, error => { throw error; });
  assert.equal(res.code, 200); assert.equal(bookingQuery.isProject, undefined);
  assert.ok(projection.includes('services.quantity')); assert.ok(projection.includes('projectScheduling'));
  assert.equal(res.body.cases.length, 2);
  const standard = res.body.cases.find(row => row.id === id);
  const project = res.body.cases.find(row => row.id !== id);
  assert.equal(standard.isProject, false); assert.equal(standard.totalEstimatedMinutes, 120);
  assert.equal(project.isProject, true); assert.equal(project.totalUnits, 8);
  assert.equal(project.issueType, 'past_date'); assert.equal(project.canReassign, false);
  assert.ok(!project.allowedActions.includes('reassign'));
});

test('all resolution queue sorts opt into disk use when MongoDB exceeds its sort memory budget', async () => {
  const Order = require('../models/Order');
  const ServiceReport = require('../models/ServiceReport');
  const queries = new Map();
  function sortedQuery(model, filter) {
    // Use real Mongoose query options; replace execution so no database is needed.
    const query = new mongoose.Query({}, {}, model, model.collection).find(filter);
    query.exec = async function () {
      if (this.getOptions().allowDiskUse !== true) throw Error('Sort exceeded memory limit of 33554432 bytes');
      queries.set(model.modelName, this.getOptions());
      return [];
    };
    return query;
  }
  const mocks = {
    '../models/BookingService': { find: filter => sortedQuery(Booking, filter) },
    '../models/Order': { find: filter => sortedQuery(Order, filter), distinct: async () => [] },
    '../models/ServiceReport': { find: filter => sortedQuery(ServiceReport, filter) },
    '../utils/enterpriseSchedulingEngine': { getProjectThresholdHours: async () => 8 },
  };
  const res = response();
  await handler('get', '/resolution-center', mocks)(request({}), res, error => { throw error; });
  assert.equal(res.code, 200);
  assert.equal(res.body.summary.total, 0);
  assert.deepEqual([...queries.keys()].sort(), ['BookingService', 'Order', 'ServiceReport']);
  for (const options of queries.values()) assert.equal(options.allowDiskUse, true);
  assert.deepEqual(queries.get('BookingService').sort, { bookingDate: 1, updatedAt: -1 });
  assert.equal(queries.get('BookingService').limit, 500);
  assert.equal(queries.get('Order').limit, 500);
  assert.ok(Booking.schema.indexes().some(([keys]) => keys.bookingDate === 1 && keys.updatedAt === -1));
});
