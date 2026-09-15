const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const scheduler = read('utils/overdueBookingScheduler.js');
const mailer = read('utils/mailer.js');
const notificationModel = read('models/Notification.js');
const tracking = read('views/pages/tracking.ejs');
const adminApi = read('routes/adminApi.js');

test('expired assignment creates a durable customer notification and email', () => {
  assert.match(notificationModel, /"booking_assignment_delayed"/);
  assert.match(scheduler, /type: 'booking_assignment_delayed'[\s\S]*userId: customerId[\s\S]*link: '\/tracking'/);
  assert.match(scheduler, /sendBookingAssignmentDelayedEmail\(\{/);
  assert.match(mailer, /async function sendBookingAssignmentDelayedEmail/);
  assert.match(mailer, /Your booking remains active/);
  assert.match(mailer, /sendBookingAssignmentDelayedEmail,/);
});

test('customer My Schedule applies the assignment exception in real time', () => {
  assert.match(scheduler, /io\.to\('customer:' \+ customerId\)\.emit\('booking:auto-reschedule-pending'/);
  assert.match(tracking, /socket\.on\("booking:auto-reschedule-pending"/);
  assert.match(tracking, /booking\.status = data\.status \|\| 'pending_reassignment'/);
  assert.match(tracking, /alertTitle: 'Service Schedule Update'/);
});

test('admin reschedule updates use the authenticated customer socket room', () => {
  assert.match(adminApi, /io\.to\("customer:" \+ booking\.customerId\)\.emit\("booking:rescheduled"/);
  assert.doesNotMatch(adminApi, /io\.to\("customer-" \+ booking\.customerId\)/);
});
