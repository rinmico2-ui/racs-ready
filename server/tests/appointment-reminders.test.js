'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Booking = require('../models/BookingService'), User = require('../models/User'), Assignment = require('../models/Assignment');
const notify = require('../utils/notify'), mailer = require('../utils/mailer'), outbox = require('../utils/emailOutbox');
const { checkForCustomerServiceReminders, customerReminderSlot } = require('../utils/overdueBookingScheduler');
const now = new Date('2026-10-16T00:00:00Z');
const booking = changes => ({ _id: 'fixture-booking', customerId: 'fixture-customer', status: 'confirmed', bookingReference: 'FIXTURE-001',
  bookingDate: new Date('2026-10-16T16:00:00Z'), startTime: '07:00', serviceName: 'Aircon Cleaning', customer: {}, ...changes });
const same = (left, right) => left instanceof Date || right instanceof Date ? new Date(left).getTime() === new Date(right).getTime() : String(left) === String(right);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => value == null ? row[key] == null :
    value && typeof value === 'object' && '$ne' in value ? !same(row[key], value.$ne) : same(row[key], value));
}
function fixture(t, rows = [booking()], options = {}) {
  const notifications = [], emails = [], claims = [], searches = [];
  t.mock.method(Booking, 'find', filter => ({ select(fields) { searches.push({ filter, fields }); return this; }, lean: async () => rows.map(row => ({ ...row })) }));
  t.mock.method(Booking, 'findOneAndUpdate', (filter, update) => {
    options.beforeClaim?.(rows); claims.push(filter);
    const row = rows.find(row => matches(row, filter)); if (row) Object.assign(row, update.$set);
    return { select: async () => row ? { _id: row._id } : null };
  });
  t.mock.method(Booking, 'updateOne', async (filter, update) => { const row = rows.find(row => matches(row, filter)); if (row) Object.assign(row, update.$set); });
  t.mock.method(Assignment, 'findOne', filter => ({ select() { return this; }, lean: async () => options.accepted === false ? null : { _id: filter._id } }));
  t.mock.method(User, 'findById', () => ({ lean: async () => ({ email: 'account@example.test' }) }));
  t.mock.method(notify, 'createNotification', async value => { notifications.push(value); return options.notify ? options.notify(value) : { _id: 'notification' }; });
  t.mock.method(mailer, 'sendMail', async value => { emails.push(value); return { queued: true }; });
  return { rows, notifications, emails, claims, searches };
}

test('confirmed appointments create one private notification and queue email to the current account address', async t => {
  const f = fixture(t);
  assert.equal(await checkForCustomerServiceReminders(now), 1);
  assert.equal(f.notifications[0].userId, 'fixture-customer'); assert.equal(f.notifications[0].role, undefined);
  assert.equal(f.notifications[0].link, '/book-history?highlight=FIXTURE-001');
  assert.match(f.notifications[0].message, /Oct 17, 2026.*7:00/);
  assert.equal(f.emails[0].to, 'account@example.test'); assert.equal(f.emails[0].validUntil, '2026-10-16T23:00:00.000Z');
  assert.equal(f.emails[0].bookingReminder.bookingId, 'fixture-booking');
  assert.equal(await checkForCustomerServiceReminders(now), 0); assert.equal(f.emails.length, 1);
  assert.equal(f.searches[0].filter.testDataExcludedAt, null); assert.match(f.searches[0].fields, /assignmentId/);
});

test('concurrent reminder workers claim the same schedule only once', async t => {
  const f = fixture(t); const counts = await Promise.all([checkForCustomerServiceReminders(now), checkForCustomerServiceReminders(now)]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1); assert.equal(f.notifications.length, 1); assert.equal(f.emails.length, 1);
});

test('inspection reminders require the technician to have accepted that booking assignment', async t => {
  const f = fixture(t, [booking({ status: 'inspection_scheduled', assignmentId: 'inspection-assignment' })], { accepted: false });
  assert.equal(await checkForCustomerServiceReminders(now), 0); assert.equal(f.claims.length, 0);
  t.mock.method(Assignment, 'findOne', filter => {
    assert.equal(filter.status, 'accepted'); assert.equal(filter.bookingId, 'fixture-booking');
    return { select() { return this; }, lean: async () => ({ _id: 'inspection-assignment' }) };
  });
  assert.equal(await checkForCustomerServiceReminders(now), 1); assert.equal(f.emails.length, 1);
});

test('a concurrent reschedule prevents a reminder for the previous schedule', async t => {
  const f = fixture(t, [booking()], { beforeClaim: rows => { rows[0].startTime = '10:00'; } });
  assert.equal(await checkForCustomerServiceReminders(now), 0); assert.equal(f.notifications.length, 0); assert.equal(f.emails.length, 0);
});

test('failed notification delivery releases its claim and does not prevent other customers being reminded', async t => {
  const f = fixture(t, [booking(), booking({ _id: 'second-booking' })], { notify: value => {
    if (value.referenceId === 'fixture-booking') throw Error('Fixture notification failure'); return { _id: 'notification' };
  } });
  assert.equal(await checkForCustomerServiceReminders(now), 1); assert.equal(f.rows[0].customerReminder24hFor, null);
  assert.equal(f.emails.length, 1); assert.equal(f.emails[0].bookingReminder.bookingId, 'second-booking');
});

test('reminder windows exclude cancelled, pending, archived and elapsed work while allowing a new schedule', () => {
  for (const changes of [{ status: 'pending' }, { status: 'cancelled' }, { testDataExcludedAt: now }, { startTime: '' }]) assert.equal(customerReminderSlot(booking(changes), now), null);
  const first = customerReminderSlot(booking(), now); assert.equal(first.marker, 'customerReminder24hFor');
  assert.equal(customerReminderSlot(booking({ customerReminder24hFor: first.start }), now), null);
  assert.equal(customerReminderSlot(booking(), new Date('2026-10-16T22:00:00Z')).marker, 'customerReminder2hFor');
  assert.equal(customerReminderSlot(booking(), new Date('2026-10-16T23:00:00Z')), null);
  assert.ok(customerReminderSlot(booking({ startTime: '06:30', customerReminder24hFor: first.start }), now));
});

test('queued appointment email checks the original schedule before delivery', async t => {
  let query; t.mock.method(Booking, 'exists', async filter => { query = filter; return { _id: 'fixture-booking' }; });
  const payload = { source: 'service-reminder', validUntil: '2026-10-16T23:00:00Z', bookingReminder: {
    bookingId: 'fixture-booking', bookingDate: '2026-10-16T16:00:00Z', startTime: '07:00', marker: 'customerReminder24hFor', scheduledFor: '2026-10-16T23:00:00Z' } };
  assert.equal(await outbox._private.cancellationReason(payload, now.getTime()), '');
  assert.equal(query.startTime, '07:00'); assert.equal(query.testDataExcludedAt, null);
  assert.equal(query.customerReminder24hFor.toISOString(), '2026-10-16T23:00:00.000Z');
  t.mock.method(Booking, 'exists', async () => null);
  assert.match(await outbox._private.cancellationReason(payload, now.getTime()), /rescheduled, cancelled/);
  assert.match(await outbox._private.cancellationReason(payload, Date.parse(payload.validUntil)), /expired/);
});

test('queued reminders retain schedule metadata inside encrypted payloads', async t => {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'fixture-outbox-secret-for-appointment-tests';
  t.after(() => previous === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = previous);
  let saved; t.mock.method(require('../models/EmailOutbox'), 'create', async row => { saved = row; return { _id: 'fixture-job' }; });
  const metadata = { bookingId: 'fixture-booking', marker: 'customerReminder2hFor', scheduledFor: '2026-10-16T23:00:00Z' };
  await outbox.enqueueEmail({ to: 'account@example.test', source: 'service-reminder', text: 'Fixture reminder', bookingReminder: metadata });
  assert.deepEqual(outbox._private.decryptPayload(saved).bookingReminder, metadata);
  assert.equal(JSON.stringify(saved).includes('account@example.test'), false);
});
