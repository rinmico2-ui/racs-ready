const axios = require('axios');

// Simple Google Calendar helper for read-only public calendars (uses API key)
// Exports getHolidaysInRange(startDate, endDate, calendarId, apiKey)
// - startDate / endDate are JS Date objects
// - calendarId defaults to PUBLIC_HOLIDAYS_CALENDAR_ID env var

async function getHolidaysInRange(startDate, endDate, calendarId, apiKey) {
  if (!startDate || !endDate) return [];
  const calId = encodeURIComponent(calendarId || process.env.PUBLIC_HOLIDAYS_CALENDAR_ID || 'en.ph#holiday@group.v.calendar.google.com');
  const key = apiKey || process.env.GOOGLE_CALENDAR_API_KEY;
  if (!key) throw new Error('GOOGLE_CALENDAR_API_KEY not configured');

  const timeMin = (new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())).toISOString();
  // include full day of endDate
  const ed = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23,59,59,999);
  const timeMax = ed.toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;
  try {
    const res = await axios.get(url, {
      params: {
        key,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime'
      },
      timeout: 10 * 1000
    });

    const items = (res.data && res.data.items) ? res.data.items : [];
    // normalize to { date: 'YYYY-MM-DD', name }
    const out = items.map(it => {
      const start = it.start && (it.start.date || it.start.dateTime);
      // prefer all-day date value (date) otherwise convert dateTime
      const dateOnly = it.start && it.start.date ? it.start.date : (start ? (new Date(start)).toISOString().slice(0,10) : null);
      return { id: it.id, date: dateOnly, name: it.summary || it.description || '', raw: it };
    }).filter(x => x.date);

    return out;
  } catch (err) {
    // don't expose remote errors — return empty
    console.warn('googleCalendarService.getHolidaysInRange failed', (err && err.message) || err);
    return [];
  }
}

module.exports = { getHolidaysInRange };
