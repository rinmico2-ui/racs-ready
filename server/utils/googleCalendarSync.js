const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Server-side Google Calendar sync using a service account.
// Configuration via environment variables:
// - GOOGLE_SERVICE_ACCOUNT_KEY (JSON string) OR GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to JSON)
// - GOOGLE_CALENDAR_ID (target calendar to use; if omitted, service account's primary is used)

let authClient = null;

function loadServiceAccountCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '';
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error('Invalid JSON in GOOGLE_SERVICE_ACCOUNT_KEY');
    }
  }
  if (keyFile) {
    const p = path.isAbsolute(keyFile) ? keyFile : path.join(process.cwd(), keyFile);
    if (!fs.existsSync(p)) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE not found: ' + p);
    const content = fs.readFileSync(p, 'utf8');
    try { return JSON.parse(content); } catch (e) { throw new Error('Invalid JSON in service account file'); }
  }
  return null;
}

function isConfigured() {
  try {
    const cred = loadServiceAccountCredentials();
    return !!cred;
  } catch (e) {
    return false;
  }
}

async function getAuth() {
  if (authClient) return authClient;
  const cred = loadServiceAccountCredentials();
  if (!cred) throw new Error('Google service account credentials not configured');
  const clientEmail = cred.client_email;
  const privateKey = cred.private_key;
  if (!clientEmail || !privateKey) throw new Error('Invalid service account credentials');

  authClient = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  await authClient.authorize();
  return authClient;
}

function parseBookingStart(bookingDate, startTime) {
  const start = new Date(bookingDate);
  start.setHours(0,0,0,0);
  if (!startTime) return start;
  const t = String(startTime).trim();
  const m1 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m1) {
    start.setHours(parseInt(m1[1],10), parseInt(m1[2],10), 0, 0);
    return start;
  }
  const m2 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m2) {
    let hh = parseInt(m2[1],10) % 12;
    if (m2[3].toUpperCase() === 'PM') hh += 12;
    start.setHours(hh, parseInt(m2[2],10), 0, 0);
    return start;
  }
  return start;
}

async function createEventForBooking({ booking, durationMinutes = 60, calendarIdOverride = null } = {}) {
  if (!booking) throw new Error('booking required');
  const auth = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = calendarIdOverride || process.env.GOOGLE_CALENDAR_ID || 'primary';

  const start = parseBookingStart(booking.bookingDate || booking.date || new Date(), booking.startTime);
  const end = new Date(start.getTime() + (Number(durationMinutes) || 60) * 60000);

  const event = {
    summary: (booking.service || booking.serviceType || 'Booking') + ' — CALIDRO',
    description: (booking.notes ? booking.notes + '\n' : '') + `Booking ID: ${booking._id || booking.id || ''}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    location: (booking.location && booking.location.address) ? booking.location.address : (booking.location || '')
  };

  const resp = await calendar.events.insert({ calendarId, requestBody: event });
  return { calendarId, eventId: resp.data && resp.data.id ? resp.data.id : null, raw: resp.data };
}

async function updateEventForBooking({ booking, eventId, durationMinutes = 60, calendarIdOverride = null } = {}) {
  if (!booking) throw new Error('booking required');
  if (!eventId) throw new Error('eventId required');
  const auth = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = calendarIdOverride || booking.googleCalendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';

  const start = parseBookingStart(booking.bookingDate || booking.date || new Date(), booking.startTime);
  const end = new Date(start.getTime() + (Number(durationMinutes) || 60) * 60000);

  const event = {
    summary: (booking.service || booking.serviceType || 'Booking') + ' — CALIDRO',
    description: (booking.notes ? booking.notes + '\n' : '') + `Booking ID: ${booking._id || booking.id || ''}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    location: (booking.location && booking.location.address) ? booking.location.address : (booking.location || '')
  };

  const resp = await calendar.events.patch({ calendarId, eventId, requestBody: event });
  return resp.data;
}

async function deleteEvent({ eventId, calendarIdOverride = null } = {}) {
  if (!eventId) throw new Error('eventId required');
  const auth = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = calendarIdOverride || process.env.GOOGLE_CALENDAR_ID || 'primary';
  try {
    await calendar.events.delete({ calendarId, eventId });
    return true;
  } catch (err) {
    // treat 404 as success
    if (err && err.code === 404) return true;
    throw err;
  }
}

module.exports = {
  isConfigured,
  createEventForBooking,
  updateEventForBooking,
  deleteEvent
};
