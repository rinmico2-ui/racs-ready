(function (root, factory) {
  'use strict';
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.OrderSchedulePolicy = policy;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANILA_OFFSET = 8 * 60 * 60 * 1000;

  function todayKey(now = new Date()) {
    const clock = new Date(new Date(now).getTime() + MANILA_OFFSET);
    return Number.isNaN(clock.getTime()) ? '' : clock.toISOString().slice(0, 10);
  }

  function validDateKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return false;
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
  }

  function isOrderDate(key, now = new Date()) {
    const today = todayKey(now);
    return Boolean(today && validDateKey(key) && key >= today);
  }

  function requiredLeadMinutes(value) {
    const minutes = Number(value);
    // Match the scheduling API's minimum safety buffer, including when staff
    // configure an advance notice shorter than the default two hours.
    return Math.max(30, value != null && Number.isFinite(minutes) && minutes >= 0 ? minutes : 120);
  }

  function isSlotBookable(key, startMinutes, advanceMinutes, now = new Date()) {
    if (!isOrderDate(key, now) || !Number.isFinite(startMinutes) || startMinutes < 0 || startMinutes >= 1440) return false;
    const start = new Date(`${key}T00:00:00+08:00`).getTime() + startMinutes * 60000;
    return start - new Date(now).getTime() >= requiredLeadMinutes(advanceMinutes) * 60000;
  }

  function isPickupAvailable(key, hours, advanceMinutes, now = new Date()) {
    if (!isOrderDate(key, now) || !Array.isArray(hours)) return false;
    const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
    const row = hours.find(day => Number(day.dayOfWeek) === weekday);
    const start = Number(row?.startMinutes), end = Number(row?.endMinutes);
    if (!row?.open || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1440 || end <= start) return false;
    const closing = new Date(`${key}T00:00:00+08:00`).getTime() + end * 60000;
    return closing > new Date(now).getTime() + requiredLeadMinutes(advanceMinutes) * 60000;
  }

  return { todayKey, validDateKey, isOrderDate, requiredLeadMinutes, isSlotBookable, isPickupAvailable };
});
