const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBookingDateTime } = require('../utils/overdueBookingScheduler');
const { computeBookingEndDateTime, isBookingPast } = require('../utils/bookingPolicy');
const { bookingReviewState } = require('../utils/bookingReview');
const { assignmentTimingState, manilaSlotTiming, strictManilaDateKey } = require('../utils/bookingDateTime');

const assignmentView = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'pages', 'admin', 'Appointments', 'AppointmentsUnified.ejs'),
  'utf8',
);
const appointmentRoute = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'appointmentManagement.js'),
  'utf8',
);

// Midnight selected in a Manila browser is commonly persisted as 16:00Z on
// the preceding UTC day. A UTC-hosted server must still treat this as Sep 14.
const manilaSeptember14 = new Date('2026-09-13T16:00:00.000Z');

test('overdue scheduler combines the selected Manila date with its start time', () => {
  assert.equal(
    parseBookingDateTime(manilaSeptember14, '17:00').toISOString(),
    '2026-09-14T09:00:00.000Z',
  );
});

test('service lifecycle guard uses the Manila service window on any host', () => {
  const booking = { bookingDate: manilaSeptember14, startTime: '17:00', endTime: '18:00' };
  assert.equal(computeBookingEndDateTime(booking).toISOString(), '2026-09-14T10:00:00.000Z');
  assert.equal(isBookingPast(booking, new Date('2026-09-14T05:41:00.000Z')), false);
  assert.equal(isBookingPast(booking, new Date('2026-09-14T10:01:00.000Z')), true);
});

test('assignment cutoff allows the scheduled start and applies one 30-minute grace rule', () => {
  const booking = { bookingDate: manilaSeptember14, startTime: '15:00', endTime: '16:00' };
  const beforeStart = assignmentTimingState(booking, new Date('2026-09-14T06:00:00.000Z'));
  const atCutoff = assignmentTimingState(booking, new Date('2026-09-14T07:30:00.000Z'));
  const afterCutoff = assignmentTimingState(booking, new Date('2026-09-14T07:31:00.000Z'));
  assert.equal(beforeStart.assignmentCutoffAt, '2026-09-14T07:30:00.000Z');
  assert.equal(beforeStart.isExpired, false);
  assert.equal(atCutoff.isExpired, false);
  assert.equal(afterCutoff.isExpired, true);
});

test('customer slots use the Philippine clock even when the server clock is UTC', () => {
  const now = new Date('2026-09-17T02:00:00.000Z'); // 10:00 AM in Manila
  assert.equal(manilaSlotTiming('2026-09-17', '08:00', { now, minAdvanceMinutes: 120, safetyBufferMinutes: 30 }).reason, 'past');
  assert.equal(manilaSlotTiming('2026-09-17', '11:30', { now, minAdvanceMinutes: 120, safetyBufferMinutes: 30 }).reason, 'advance_notice');
  assert.equal(manilaSlotTiming('2026-09-17', '12:00', { now, minAdvanceMinutes: 120, safetyBufferMinutes: 30 }).allowed, true);
  assert.equal(manilaSlotTiming('2026-09-18', '08:00', { now, minAdvanceMinutes: 120, safetyBufferMinutes: 30 }).allowed, true);
  assert.equal(strictManilaDateKey('2026-02-30'), '');
});

test('pending review does not mark a future Manila schedule overdue', () => {
  const state = bookingReviewState(
    { status: 'pending', bookingDate: manilaSeptember14, endTime: '18:00' },
    new Date('2026-09-14T05:41:00.000Z'),
  );
  assert.equal(state.isReviewOverdue, false);
});

test('assignment UI does not let a stale auto-reschedule flag override a future schedule', () => {
  assert.match(assignmentView, /b\.assignmentTiming\.isExpired/);
  assert.match(assignmentView, /appointmentDateTime\(b\.bookingDate,Number\.isFinite\(sMin\)\?sMin\+30:NaN\)/);
  assert.doesNotMatch(assignmentView, /if\(!overdue\)overdue=!!b\.autoReschedulePending/);
  assert.match(appointmentRoute, /assignmentTiming:\s*assignmentTimingState\(booking\)/);
  assert.match(appointmentRoute, /if \(isAssignmentWindowExpired\(booking\)\)/);
  assert.match(appointmentRoute, /booking\.autoReschedulePending = false/);
});

test('waiting-for-acceptance UI renders schedules and deadlines in Philippine 12-hour time', () => {
  assert.match(assignmentView, /var scheduleTime=formatTime\(b\.startTime\)\+' – '\+formatTime\(b\.endTime\)/);
  assert.match(assignmentView, /deadline\.toLocaleString\('en-PH',\{timeZone:'Asia\/Manila'/);
  assert.match(assignmentView, /scheduleTime\+' <small class="text-muted">PHT<\/small><\/span>'/);
  assert.doesNotMatch(assignmentView, /\+\(b\.startTime\|\|'[^']*'\)\+' - '\+\(b\.endTime/);
});
