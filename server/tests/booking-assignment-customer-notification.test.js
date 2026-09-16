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
const appointmentRoutes = read('routes/appointmentRoutes.js');
const technicianApi = read('routes/technicianApi.js');
const completionProofStorage = read('utils/completionProofStorage.js');
const bookingModel = read('models/BookingService.js');

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

test('customer rating modal previews completion photos inside the application', () => {
  assert.match(tracking, /id="trkProofPhotoLink"[\s\S]*onclick="openCompletionPhotoViewer\(\)"/);
  assert.doesNotMatch(tracking, /id="trkProofPhotoLink"[^>]*target="_blank"/);
  assert.match(tracking, /id="trkCompletionPhotoViewer"[\s\S]*aria-modal="true"/);
  assert.match(tracking, /function normalizeCompletionPhotoUrl/);
  assert.match(tracking, /function completionPhotoViewerUrl/);
  assert.match(tracking, /\['http:', 'https:'\]\.includes\(parsed\.protocol\)/);
  assert.match(tracking, /\/api\/appointments\/\$\{encodeURIComponent\(normalizedBookingId\)\}\/completion-photo/);
  assert.match(tracking, /proofButton\.dataset\.bookingId/);
  assert.equal((tracking.match(/^\s+setRatingProofPhoto\(booking\);/gm) || []).length, 2);
  assert.match(tracking, /image\.onload = function\(\)/);
  assert.match(tracking, /image\.onerror = function\(\)/);
  assert.match(tracking, /event\.key === 'Escape'/);
});

test('completion photos are streamed from an authorized booking endpoint', () => {
  assert.match(appointmentRoutes, /router\.get\("\/:id\/completion-photo"/);
  assert.match(appointmentRoutes, /\.select\("customerId technicianId proofPhoto \+completionProofFileId"\)/);
  assert.match(appointmentRoutes, /canAccessBooking\(req\.user, booking\)/);
  assert.match(appointmentRoutes, /findCompletionProof\(booking\.completionProofFileId\)/);
  assert.match(appointmentRoutes, /openCompletionProofDownload\(booking\.completionProofFileId\)/);
  assert.match(appointmentRoutes, /completion-proofs\|proofs/);
  assert.match(appointmentRoutes, /fs\.promises\.stat\(absolutePhotoPath\)/);
  assert.match(appointmentRoutes, /res\.sendFile\(absolutePhotoPath/);
});

test('new completion photos use persistent GridFS storage', () => {
  assert.match(completionProofStorage, /new mongoose\.mongo\.GridFSBucket/);
  assert.match(completionProofStorage, /bucketName: BUCKET_NAME/);
  assert.match(completionProofStorage, /imageMimeFromSignature\(file\.buffer\)/);
  assert.match(technicianApi, /storage: multer\.memoryStorage\(\)/);
  assert.match(technicianApi, /storeCompletionProof\(req\.file/);
  assert.match(technicianApi, /completionProofFileId: storedProof\.fileId/);
  assert.match(technicianApi, /`\/api\/appointments\/\$\{assignment\.bookingId\}\/completion-photo`/);
  assert.match(bookingModel, /completionProofFileId:[\s\S]*select: false/);
});
