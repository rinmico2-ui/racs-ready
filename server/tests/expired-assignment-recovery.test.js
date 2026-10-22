'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const resolution = require('../utils/resolutionCenter');
const { assignmentTimingState } = require('../utils/bookingDateTime');
const id = n => n.toString(16).padStart(24, '0');
const afterDeadline = new Date('2026-10-22T09:35:00+08:00');
const afterWindow = new Date('2026-10-22T10:05:00+08:00');
function booking(patch = {}) {
  return { _id: id(1), bookingReference: 'RACS-20261022-TEST-MIXED', status: 'inspection_scheduled',
    serviceType: 'mixed', bookingDate: '2026-10-22', startTime: '09:30', endTime: '15:15', serviceDurationMinutes: 270,
    technicianId: id(2), assignmentId: id(3), paymentStatus: 'partial', paymentMethod: 'gcash',
    services: [{ name: 'Installation', type: 'core', status: 'assigned', quantity: 1, duration: 180 },
      { name: 'Repair inspection', type: 'repair', status: 'inspection_scheduled', quantity: 1, duration: 90 }],
    technicianTeam: [{ technicianId: id(2), assignmentId: id(3), status: 'expired', deadlineAt: '2026-10-22T01:31:00Z' }], ...patch };
}

test('expired mixed invitations need technician review immediately and schedule recovery after dispatch grace, before the job end time', () => {
  const job = booking();
  assert.deepEqual(resolution.bookingOverviewScheduleResolution(job, afterDeadline), { required: true, issueType: 'technician_issue' });
  assert.equal(resolution.bookingScheduleNeedsResolution(job, afterDeadline), false);
  assert.deepEqual(resolution.bookingOverviewScheduleResolution(job, afterWindow), { required: true, issueType: 'past_date' });
  assert.equal(resolution.bookingScheduleNeedsResolution(job, afterWindow), true);
  job.resolutionCases = [{ issueType: 'technician_issue', sourceStatus: job.status, state: 'closed' }];
  assert.equal(resolution.bookingResolutionCaseIsResolved(job, 'technician_issue', afterDeadline), false);
  job.technicianTeam[0].status = 'pending';
  assert.equal(resolution.bookingAcceptanceNeedsResolution(job, afterDeadline), true);
  job.technicianTeam[0].deadlineAt = '2026-10-22T02:00:00Z';
  assert.equal(resolution.bookingAcceptanceNeedsResolution(job, afterDeadline), false);
});

test('current accepted work, projects, linked orders and terminal bookings do not inherit stale expiration warnings', () => {
  for (const patch of [{ status: 'repair_in_progress' }, { status: 'in-progress' }, { status: 'completed' },
    { status: 'cancelled' }, { isProject: true }, { sourceOrderId: id(4) }, { technicianId: null },
    { technicianTeam: [{ status: 'accepted' }] }]) {
    assert.equal(resolution.bookingAcceptanceNeedsResolution(booking(patch), afterWindow), false);
  }
});

const page = fs.readFileSync(require.resolve('../views/pages/admin/Appointments/AppointmentsUnified.ejs'), 'utf8').replace(/\r\n/g, '\n');
function footer(job, now) {
  const elements = new Map(), calls = [];
  const element = () => ({ dataset: {}, children: [], append(...rows) { this.children.push(...rows); },
    replaceChildren() { this.children = []; }, addEventListener(name, handler) { this[name] = handler; }, querySelectorAll() { return []; } });
  const context = { document: { getElementById(name) { if (!elements.has(name)) elements.set(name, element()); return elements.get(name); }, createElement: element },
    APPOINTMENTS_CAN_RESOLVE: true, bookingNeedsResolution: value => resolution.bookingOverviewScheduleResolution(value, now).required,
    bookingResolutionUrl: value => '/admin/operations/resolution-center?focus=booking:' + value._id,
    closeBookingDetailFor: (_id, work) => work(), RACSJobTeams: { open: (...args) => calls.push(args) },
    AU: { Overview: {}, Pending: {} }, showNotification() {},
  };
  const start = page.indexOf('  function renderBookingDetailActions(');
  vm.runInNewContext(page.slice(start, page.indexOf("  document.getElementById('detailModal').addEventListener", start)), context);
  job.overviewScheduleResolution = resolution.bookingOverviewScheduleResolution(job, now); job.assignmentTiming = assignmentTimingState(job, now);
  context.renderBookingDetailActions(job, {});
  return { actions: elements.get('detailFooter').children[1].children, calls };
}

test('job details offer replacement before cutoff and a focused Resolve Issue link after cutoff', async () => {
  const early = footer(booking(), afterDeadline);
  const reassign = early.actions.find(action => action.dataset.detailAction === 'reassign');
  assert.equal(reassign.textContent, 'Reassign Technician'); await reassign.click();
  assert.equal(early.calls[0][0], 'booking'); assert.equal(early.calls[0][1], id(1));
  const late = footer(booking(), afterWindow);
  const resolve = late.actions.find(action => action.dataset.detailAction === 'resolve');
  assert.equal(resolve.textContent, 'Resolve Issue'); assert.match(resolve.href, new RegExp('focus=booking:' + id(1)));
  assert.equal(late.actions.some(action => action.dataset.detailAction === 'reassign'), false);
});

function query(value, selections) {
  return { sort() { return this; }, allowDiskUse() { return this; }, limit() { return this; }, populate() { return this; },
    select(fields) { selections?.push(fields); return this; }, lean() { return Promise.resolve(value); } };
}
async function resolutionQueue(job, now) {
  const file = require.resolve('../routes/adminApi'), source = fs.readFileSync(file, 'utf8'), actualRequire = createRequire(file);
  const start = source.indexOf('async (req, res, next) => {', source.indexOf('router.get("/resolution-center",'));
  const selections = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return Number(now); } }
  const handler = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n});', start) + 2) + ')', {
    Date: Clock, mongoose: require('mongoose'), hasPermission: async () => true,
    require(name) {
      if (name.endsWith('/BookingService')) return { findById: () => query(job, selections),
        find: filter => query(filter['customerCancellation.status'] ? [] : [job], selections) };
      if (name.endsWith('/Order')) return { find: () => query([]), distinct: async () => [] };
      if (name.endsWith('/ServiceReport')) return { find: () => query([]) };
      if (name.endsWith('/enterpriseSchedulingEngine')) return { getProjectThresholdHours: async () => 8 };
      return actualRequire(name);
    },
  });
  const res = { set() { return this; }, json(body) { this.body = body; return this; } };
  await handler({ user: { role: 'admin' }, query: { focus: 'booking:' + job._id } }, res, error => { throw error; });
  assert.ok(selections.some(fields => fields.includes('technicianTeam.status') && fields.includes('technicianTeam.deadlineAt')));
  return res.body;
}

test('the focused Resolution Center returns this expired mixed job with recovery actions instead of no active case', async () => {
  for (const now of [afterDeadline, afterWindow]) {
    const response = await resolutionQueue(booking(), now);
    assert.equal(response.focus.state, 'open'); assert.equal(response.cases.length, 1);
    const row = response.cases[0], issue = row.issues.find(value => value.issueType === 'technician_issue');
    assert.ok(issue); assert.equal(issue.canReassign, now === afterDeadline);
    assert.ok(row.allowedActions.includes('recover')); assert.equal(row.issues.some(value => value.issueType === 'incomplete'), false);
  }
});

test('Resolution Center reassignment uses the team transaction during grace and rejects an expired schedule before any release', async () => {
  const file = require.resolve('../routes/adminApi'), source = fs.readFileSync(file, 'utf8'), actualRequire = createRequire(file);
  const start = source.indexOf('async (req, res, next) => {', source.indexOf('router.post("/resolution-center/:id/reassign",'));
  for (const now of [afterDeadline, afterWindow]) {
    const job = booking(), calls = [];
    const handler = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n});', start) + 2) + ')', {
      mongoose: require('mongoose'), require(name) {
        if (name.endsWith('/BookingService')) return { findById: async () => job };
        if (name.endsWith('/Assignment')) return { updateMany() { assert.fail('Team release must use its transaction.'); } };
        if (name.endsWith('/standardJobTeamService')) return { createService: () => ({ releaseBooking: async (...args) => { calls.push(args); return { job }; } }), publish: async () => {} };
        if (name.endsWith('/bookingDateTime')) return { isAssignmentWindowExpired: value => assignmentTimingState(value, now).isExpired };
        return actualRequire(name);
      },
    });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: job._id }, body: { issueType: 'technician_issue', note: 'Expired response' }, user: { _id: id(9) } }, res, error => { throw error; });
    if (now === afterDeadline) { assert.equal(res.body.success, true); assert.equal(calls.length, 1); assert.equal(calls[0][0], job._id); }
    else { assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'RESCHEDULE_REQUIRED'); assert.equal(calls.length, 0); }
  }
});
