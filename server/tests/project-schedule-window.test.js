'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const mongoose = require('mongoose');
const P = '670000000000000000000001';
const query = value => ({ lean: async () => structuredClone(value) });
function fixture(options = {}) {
  const routes = new Map(), writes = [], notices = [];
  const project = { _id: P, status: 'planning', bookingId: 'booking', estimatedTotalHours: 12, ...options.project };
  const booking = { _id: 'booking', status: 'confirmed', totalPrice: 15000 };
  const draft = [{ _id: 'draft-allocation', status: 'pending' }];
  const orders = [{ _id: 'work-order', status: 'assigned', planningStatus: 'scheduled' }];
  const Project = { findById: () => query(project) }, BookingService = { findById: () => query(booking) };
  const DailyAssignment = { find: filter => { assert.equal(filter.planningOnly, true); return query(draft); } };
  const WorkOrder = { find: () => query(orders) };
  let availableHours = options.hours ?? 16;
  const source = fs.readFileSync(require.resolve('../routes/projectRoutes'), 'utf8');
  const start = source.indexOf("router.post('/projects/:id/change-schedule/preview'");
  const end = source.indexOf('router.post("/projects/:id/schedule-preview"', start);
  const nativeRequire = require;
  vm.runInNewContext(source.slice(start, end), { router: { post: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, auth: { requireRole: () => () => {} },
    mongoose, Project, BookingService, DailyAssignment, WorkOrder, audit: { logEvent: async () => {} },
    require: path => {
      if (path === '../utils/projectCrewCalendar') return { calendarWindow: nativeRequire('../utils/projectCrewCalendar').calendarWindow,
        projectCrewCalendar: async () => ({ availableHours, hasAvailability: availableHours > 0, days: [], unavailableTechnicianIds: options.inactiveCrew ? ['inactive'] : [] }) };
      if (path === '../utils/operationLock') return { withOperationLock: async (_, work) => work() };
      if (path === '../utils/bookingDateTime') return nativeRequire('../utils/bookingDateTime');
      if (path === '../utils/atomicWorkflowChanges') return { atomicWorkflowChanges: async changes => { writes.push(changes); return changes.map(change => ({ ...change.before, ...change.set })); } };
      if (path === '../utils/projectScheduleNotifications') return { notifyProjectScheduleChange: async (...args) => { notices.push(args); return { status: options.noticeFailure ? 'failed' : 'sent' }; } };
      throw Error('Unexpected dependency: ' + path);
    }, console });
  async function run(preview = false, body = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await routes.get(`/projects/:id/change-schedule${preview ? '/preview' : ''}`)({ params: { id: P }, user: { _id: 'admin' }, app: { get: () => null },
      body: { startDate: '2099-10-19', endDate: '2099-10-23', reason: 'Customer confirmed new site access dates.', ...body } }, res);
    return res;
  }
  return { run, project, writes, notices, Project, BookingService, DailyAssignment, WorkOrder, setHours: hours => { availableHours = hours; } };
}
test('project schedule preview is read-only and saving synchronizes the linked calendar while invalidating drafts', async () => {
  const f = fixture(); const preview = await f.run(true);
  assert.equal(preview.body.viable, true); assert.equal(f.writes.length, 0); assert.equal(f.notices.length, 0);
  const saved = await f.run(); assert.equal(saved.statusCode, 200); assert.equal(f.writes.length, 1);
  const changes = f.writes[0];
  assert.equal(changes.find(change => change.Model === f.Project).set['schedulePlan.status'], 'not_generated');
  assert.equal(changes.find(change => change.Model === f.DailyAssignment).set.status, 'skipped');
  assert.equal(changes.find(change => change.Model === f.WorkOrder).set.planningStatus, 'draft');
  const booking = changes.find(change => change.Model === f.BookingService);
  assert.equal(booking.set.bookingDate.toISOString(), '2099-10-18T16:00:00.000Z');
  assert.equal(booking.set.totalPrice, undefined); assert.equal(f.notices.length, 1);
});
test('saving rechecks capacity after a successful preview and does not notify on a rejected change', async () => {
  const f = fixture(); assert.equal((await f.run(true)).body.viable, true); f.setHours(4);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.writes.length, 0); assert.equal(f.notices.length, 0);
});
test('approved work requires recovery governance and schedule changes need a reason', async () => {
  for (const project of [{ scheduleLocked: true }, { schedulePlan: { status: 'confirmed' } }, { status: 'in_progress' }]) {
    const f = fixture({ project }); assert.equal((await f.run()).statusCode, 409); assert.equal(f.notices.length, 0);
  }
  const f = fixture(); assert.equal((await f.run(false, { reason: 'x' })).statusCode, 400); assert.equal(f.writes.length, 0);
});
test('saved schedule returns its notification failure for retry without claiming the save failed', async () => {
  const f = fixture({ noticeFailure: true }); const result = await f.run();
  assert.equal(result.statusCode, 200); assert.equal(result.body.customerNotification.status, 'failed'); assert.equal(f.writes.length, 1);
});
test('inactive assigned accounts block a window even if other crew have sufficient hours', async () => {
  const f = fixture({ inactiveCrew: true });
  assert.equal((await f.run(true)).body.viable, false);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.writes.length, 0);
});
test('recovery always requests customer notification and blocks inactive crew at approval checks', async () => {
  const source = fs.readFileSync(require.resolve('../routes/projectRoutes'), 'utf8');
  const start = source.indexOf('async function buildRecoveryProposal('), end = source.indexOf('/** Preview a recovery', start);
  let checked = false;
  const build = vm.runInNewContext(source.slice(start, end) + '\nbuildRecoveryProposal;', {
    normalizeRecoveryRequest(body) { assert.equal(body.notifyCustomer, true); return { recoveryStartDate: '2099-10-19', revisedCompletionDate: '2099-10-23', workingDays: [1,2,3,4,5] }; },
    generateProjectSchedule: async () => ({ status: 'ready', conflicts: [], allocations: [] }),
    require: () => ({ projectCrewCalendar: async () => { checked = true; return { unavailableTechnicianIds: ['inactive'] }; } }),
  });
  const result = await build({ _id: P }, { notifyCustomer: false });
  assert.equal(checked, true); assert.equal(result.result.conflicts[0].blocking, true);
  assert.equal(result.result.conflicts[0].type, 'crew_unavailable');
});
