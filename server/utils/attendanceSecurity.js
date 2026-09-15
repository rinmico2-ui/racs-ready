const crypto = require('crypto');
const SiteSetting = require('../models/SiteSetting');
const { attendanceDay } = require('./attendanceTime');

class AttendanceSecurityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AttendanceSecurityError';
    this.code = code;
    this.status = status;
  }
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function securityConfig() {
  return {
    qrTtlSeconds: Math.round(boundedNumber(process.env.ATTENDANCE_QR_TTL_SECONDS, 45, 20, 120)),
    geofenceRadiusMeters: Math.round(boundedNumber(process.env.ATTENDANCE_GEOFENCE_RADIUS_METERS, 250, 50, 2000)),
    maxGpsAccuracyMeters: Math.round(boundedNumber(process.env.ATTENDANCE_MAX_GPS_ACCURACY_METERS, 100, 20, 500)),
    locationMaxAgeSeconds: Math.round(boundedNumber(process.env.ATTENDANCE_LOCATION_MAX_AGE_SECONDS, 120, 30, 300)),
  };
}

function signingSecret() {
  const secret = process.env.ATTENDANCE_QR_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (secret) return String(secret);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Attendance QR signing secret is not configured');
  }
  return 'development-only-attendance-secret';
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', signingSecret()).update(encodedPayload).digest('base64url');
}

function createAttendanceChallenge(now = new Date()) {
  const config = securityConfig();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    v: 1,
    purpose: 'attendance_checkin',
    day: attendanceDay(now).key,
    iat: issuedAt,
    exp: issuedAt + config.qrTtlSeconds,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${encoded}.${sign(encoded)}`,
    challengeId: payload.jti,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    refreshAfterMs: Math.max(5000, Math.floor(config.qrTtlSeconds * 1000 * 0.65)),
  };
}

function verifyAttendanceChallenge(token, now = new Date()) {
  const raw = String(token || '').trim();
  if (!raw || raw.length > 2048) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is invalid.');
  }
  const parts = raw.split('.');
  if (parts.length !== 2) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is invalid.');
  }
  const [encoded, suppliedSignature] = parts;
  const expectedSignature = sign(encoded);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is invalid.');
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const currentDay = attendanceDay(now).key;
  if (
    payload.v !== 1 ||
    payload.purpose !== 'attendance_checkin' ||
    payload.day !== currentDay ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.jti !== 'string' ||
    !/^[a-f0-9]{32}$/.test(payload.jti)
  ) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is invalid or belongs to another day.');
  }
  if (payload.iat > nowSeconds + 5) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code is not active yet.');
  }
  if (payload.exp < nowSeconds) {
    throw new AttendanceSecurityError('QR_EXPIRED', 'The QR code refreshed before the scan completed. Scan the current code again.');
  }
  if (payload.exp - payload.iat > securityConfig().qrTtlSeconds + 5) {
    throw new AttendanceSecurityError('QR_INVALID', 'This attendance QR code has an invalid validity period.');
  }
  return {
    challengeId: payload.jti,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    day: payload.day,
  };
}

function normalizeLocation(location, now = new Date()) {
  const source = location && typeof location === 'object' ? location : {};
  const latitude = Number(source.latitude ?? source.lat);
  const longitude = Number(source.longitude ?? source.lng);
  const accuracyMeters = Number(source.accuracyMeters ?? source.accuracy);
  const capturedAt = new Date(source.capturedAt ?? source.timestamp);
  const config = securityConfig();

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new AttendanceSecurityError('LOCATION_REQUIRED', 'Allow precise location access to record attendance.');
  }
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > config.maxGpsAccuracyMeters) {
    throw new AttendanceSecurityError(
      'LOCATION_INACCURATE',
      `Location accuracy must be within ${config.maxGpsAccuracyMeters} meters. Move near a window and try again.`,
    );
  }
  if (Number.isNaN(capturedAt.getTime())) {
    throw new AttendanceSecurityError('LOCATION_REQUIRED', 'A fresh device location is required.');
  }
  const ageMs = now.getTime() - capturedAt.getTime();
  if (ageMs < -10000 || ageMs > config.locationMaxAgeSeconds * 1000) {
    throw new AttendanceSecurityError('LOCATION_STALE', 'Your location is stale. Request a fresh location and try again.');
  }
  return { latitude, longitude, accuracyMeters, capturedAt };
}

function distanceMeters(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function companyGeofence() {
  const [latSetting, lngSetting] = await Promise.all([
    SiteSetting.findOne({ key: 'companyLocationLat' }).lean(),
    SiteSetting.findOne({ key: 'companyLocationLng' }).lean(),
  ]);
  const latitude = Number(latSetting && latSetting.value);
  const longitude = Number(lngSetting && lngSetting.value);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

async function verifyAttendanceLocation(location, {
  now = new Date(),
  enforceCompanyGeofence = false,
  enforceAllowedGeofence = false,
  allowedSites = [],
} = {}) {
  const normalized = normalizeLocation(location, now);
  const config = securityConfig();
  const company = await companyGeofence();
  if (enforceCompanyGeofence && !company) {
    throw new AttendanceSecurityError(
      'GEOFENCE_NOT_CONFIGURED',
      'Attendance location is not configured. Ask an administrator to set the company map location.',
      503,
    );
  }

  const distanceFromCompanyMeters = company ? Math.round(distanceMeters(normalized, company)) : null;
  const withinCompanyGeofence = distanceFromCompanyMeters === null
    ? null
    : distanceFromCompanyMeters <= config.geofenceRadiusMeters;
  if (enforceCompanyGeofence && !withinCompanyGeofence) {
    throw new AttendanceSecurityError(
      'OUTSIDE_GEOFENCE',
      `Check-in is allowed only within ${config.geofenceRadiusMeters} meters of the company location. You are approximately ${distanceFromCompanyMeters} meters away.`,
      403,
    );
  }

  const siteCandidates = [];
  if (company) {
    siteCandidates.push({ type: 'company', id: null, label: 'Company', ...company });
  }
  for (const site of Array.isArray(allowedSites) ? allowedSites : []) {
    const latitude = Number(site && (site.latitude ?? site.lat));
    const longitude = Number(site && (site.longitude ?? site.lng));
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
    siteCandidates.push({
      type: 'worksite',
      id: site.id ? String(site.id) : null,
      label: String(site.label || 'Completed worksite').slice(0, 160),
      latitude,
      longitude,
    });
  }
  const nearestSite = siteCandidates
    .map(site => ({ ...site, distanceMeters: Math.round(distanceMeters(normalized, site)) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)[0] || null;
  if (enforceAllowedGeofence && !nearestSite) {
    throw new AttendanceSecurityError(
      'GEOFENCE_NOT_CONFIGURED',
      'No approved attendance location is configured. Ask an administrator for an audited override.',
      503,
    );
  }
  if (enforceAllowedGeofence && nearestSite.distanceMeters > config.geofenceRadiusMeters) {
    throw new AttendanceSecurityError(
      'OUTSIDE_WORKSITE_GEOFENCE',
      `Check-out is allowed only at the company or a worksite you completed today. The nearest approved location is approximately ${nearestSite.distanceMeters} meters away.`,
      403,
    );
  }

  return {
    ...normalized,
    receivedAt: now,
    distanceFromCompanyMeters,
    geofenceRadiusMeters: config.geofenceRadiusMeters,
    withinCompanyGeofence,
    verifiedGeofenceType: nearestSite && nearestSite.distanceMeters <= config.geofenceRadiusMeters ? nearestSite.type : null,
    verifiedGeofenceId: nearestSite && nearestSite.distanceMeters <= config.geofenceRadiusMeters ? nearestSite.id : null,
    verifiedGeofenceLabel: nearestSite && nearestSite.distanceMeters <= config.geofenceRadiusMeters ? nearestSite.label : null,
    distanceFromVerifiedSiteMeters: nearestSite ? nearestSite.distanceMeters : null,
  };
}

function requestMetadata(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  const ipAddress = String(req.ip || (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0]) || '').slice(0, 128);
  const userAgent = String((req.headers && req.headers['user-agent']) || '').slice(0, 512);
  return { ipAddress, userAgent };
}

function securityErrorResponse(res, error) {
  if (!(error instanceof AttendanceSecurityError)) return false;
  res.status(error.status).json({ code: error.code, error: error.message });
  return true;
}

function safeAttendanceRecord(record) {
  if (!record) return record;
  const value = typeof record.toObject === 'function' ? record.toObject() : { ...record };
  delete value.token;
  delete value.checkInEvidence;
  delete value.checkOutEvidence;
  return value;
}

module.exports = {
  AttendanceSecurityError,
  createAttendanceChallenge,
  verifyAttendanceChallenge,
  verifyAttendanceLocation,
  securityConfig,
  requestMetadata,
  securityErrorResponse,
  safeAttendanceRecord,
  _private: { normalizeLocation, distanceMeters, signingSecret },
};
