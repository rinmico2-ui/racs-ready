(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RACSVisitSchedule = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function dateKey(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const probe = new Date(value + 'T00:00:00Z');
      return Number.isFinite(probe.getTime()) && probe.toISOString().slice(0, 10) === value ? value : '';
    }
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) ? new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 10) : '';
  }
  function state(visit, now = new Date()) {
    const scheduledDate = dateKey(visit?.bookingDate), today = dateKey(now);
    const result = { ready: false, scheduledDate, timeZone: 'Asia/Manila' };
    if (!scheduledDate || !today) return { ...result, code: 'SCHEDULE_REQUIRED', error: 'Operations must confirm a valid visit date before travel or on-site work.' };
    if (scheduledDate > today) return { ...result, code: 'SCHEDULE_NOT_TODAY', error: 'This visit is scheduled for ' + scheduledDate + '. You can preview Daily Preparation now; travel and on-site work are available on the scheduled Philippine date.' };
    if (scheduledDate < today) return { ...result, code: 'SCHEDULE_MISSED', error: 'The scheduled visit date has passed. Ask operations to confirm the next visit before going En Route.' };
    return { ...result, ready: true, code: null, error: null };
  }
  return { dateKey, state };
});
