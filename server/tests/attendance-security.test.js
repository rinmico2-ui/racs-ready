const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SiteSetting = require('../models/SiteSetting');
const TechnicianAttendance = require('../models/TechnicianAttendance');
const SecretaryAttendance = require('../models/SecretaryAttendance');
const {
  createAttendanceChallenge,
  verifyAttendanceChallenge,
  verifyAttendanceLocation,
  safeAttendanceRecord,
  _private,
} = require('../utils/attendanceSecurity');

const originalSecret = process.env.ATTENDANCE_QR_SECRET;
process.env.ATTENDANCE_QR_SECRET = 'test-attendance-signing-secret-with-sufficient-entropy';
test.after(() => {
  if (originalSecret === undefined) delete process.env.ATTENDANCE_QR_SECRET;
  else process.env.ATTENDANCE_QR_SECRET = originalSecret;
});

test('attendance QR challenges are signed, short-lived, and bound to a Manila day', () => {
  const issuedAt = new Date('2026-09-14T00:00:00.000Z');
  const challenge = createAttendanceChallenge(issuedAt);
  const verified = verifyAttendanceChallenge(challenge.token, new Date(issuedAt.getTime() + 20_000));
  assert.equal(verified.challengeId, challenge.challengeId);
  assert.equal(verified.day, '2026-09-14');
  assert.ok(challenge.expiresAt.getTime() - issuedAt.getTime() <= 120_000);

  const lastCharacter = challenge.token.at(-1);
  const tampered = challenge.token.slice(0, -1) + (lastCharacter === 'a' ? 'b' : 'a');
  assert.throws(() => verifyAttendanceChallenge(tampered, issuedAt), error => error.code === 'QR_INVALID');
  assert.throws(
    () => verifyAttendanceChallenge(challenge.token, new Date(challenge.expiresAt.getTime() + 1_000)),
    error => error.code === 'QR_EXPIRED',
  );
});

test('attendance location rejects stale and inaccurate browser coordinates', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');
  assert.throws(() => _private.normalizeLocation({
    latitude: 14.5995,
    longitude: 120.9842,
    accuracyMeters: 1000,
    capturedAt: now,
  }, now), error => error.code === 'LOCATION_INACCURATE');

  assert.throws(() => _private.normalizeLocation({
    latitude: 14.5995,
    longitude: 120.9842,
    accuracyMeters: 10,
    capturedAt: new Date(now.getTime() - 10 * 60_000),
  }, now), error => error.code === 'LOCATION_STALE');
});

test('technician check-in location is constrained to the configured company geofence', async t => {
  t.mock.method(SiteSetting, 'findOne', filter => ({
    lean: async () => ({ value: filter.key === 'companyLocationLat' ? 14.5995 : 120.9842 }),
  }));
  const now = new Date('2026-09-14T00:00:00.000Z');
  const inside = await verifyAttendanceLocation({
    latitude: 14.5995,
    longitude: 120.9842,
    accuracyMeters: 10,
    capturedAt: now,
  }, { now, enforceCompanyGeofence: true });
  assert.equal(inside.withinCompanyGeofence, true);
  assert.equal(inside.distanceFromCompanyMeters, 0);

  await assert.rejects(() => verifyAttendanceLocation({
    latitude: 14.6095,
    longitude: 120.9842,
    accuracyMeters: 10,
    capturedAt: now,
  }, { now, enforceCompanyGeofence: true }), error => error.code === 'OUTSIDE_GEOFENCE');
});

test('checkout accepts only the company or a completed-worksite geofence', async t => {
  t.mock.method(SiteSetting, 'findOne', filter => ({
    lean: async () => ({ value: filter.key === 'companyLocationLat' ? 14.5995 : 120.9842 }),
  }));
  const now = new Date('2026-09-14T00:00:00.000Z');
  const completedWorksite = { id: 'assignment-1', label: 'Completed worksite', latitude: 14.65, longitude: 121.05 };
  const atWorksite = await verifyAttendanceLocation({
    latitude: 14.65,
    longitude: 121.05,
    accuracyMeters: 12,
    capturedAt: now,
  }, { now, enforceAllowedGeofence: true, allowedSites: [completedWorksite] });
  assert.equal(atWorksite.verifiedGeofenceType, 'worksite');
  assert.equal(atWorksite.verifiedGeofenceId, 'assignment-1');
  assert.equal(atWorksite.distanceFromVerifiedSiteMeters, 0);

  await assert.rejects(() => verifyAttendanceLocation({
    latitude: 14.75,
    longitude: 121.15,
    accuracyMeters: 12,
    capturedAt: now,
  }, { now, enforceAllowedGeofence: true, allowedSites: [completedWorksite] }), error => error.code === 'OUTSIDE_WORKSITE_GEOFENCE');
});

test('raw attendance secrets and evidence are never included in self-service responses', () => {
  assert.equal(TechnicianAttendance.schema.path('token').options.select, false);
  assert.equal(SecretaryAttendance.schema.path('token').options.select, false);
  const safe = safeAttendanceRecord({
    status: 'Present',
    token: 'secret',
    checkInEvidence: { latitude: 1 },
    checkOutEvidence: { latitude: 2 },
  });
  assert.deepEqual(safe, { status: 'Present' });
});

test('attendance routes and pages enforce the layered verification workflow', () => {
  const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const technicianRoutes = read('routes/technicianApi.js');
  const secretaryRoutes = read('routes/secretaryApi.js');
  const adminRoutes = read('routes/adminApi.js');
  const technicianPage = read('views/pages/technician/Attendance.ejs');
  const adminPage = read('views/pages/admin/Staff/Attendance.ejs');

  assert.match(technicianRoutes, /ADMIN_OVERRIDE_REQUIRED/);
  assert.match(technicianRoutes, /verifyAttendanceDevice\(req, res\)/);
  assert.match(technicianRoutes, /enforceCompanyGeofence:\s*true/);
  assert.match(technicianRoutes, /checkInEvidence:\s*evidence/);
  assert.match(technicianRoutes, /ACTIVE_JOB_REMAINING/);
  assert.match(technicianRoutes, /enforceAllowedGeofence:\s*true/);
  assert.doesNotMatch(technicianRoutes, /attendance_qr_token/);
  assert.match(secretaryRoutes, /verifyAttendanceChallenge\(token, now\)/);
  assert.doesNotMatch(secretaryRoutes, /attendance_qr_token/);
  assert.match(adminRoutes, /Cache-Control", "no-store/);
  assert.match(adminRoutes, /overrideReason\.length < 5/);
  assert.match(adminRoutes, /checkInEvidence:\s*1, checkOutEvidence:\s*1/);
  assert.match(technicianPage, /maximumAge:\s*0/);
  assert.match(technicianPage, /JSON\.stringify\(\{ token, location \}\)/);
  assert.match(adminPage, /setTimeout\(\(\) => loadQrToken\(true\)/);
  assert.match(adminPage, /Manual Attendance Override/);
});
