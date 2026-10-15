'use strict';
const { manilaDateKey } = require('./bookingDateTime');

function validateLeaveDates(startValue, endValue, now = new Date()) {
  const fields = {};
  function parse(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fields[field] = 'Enter a date in YYYY-MM-DD format.';
      return null;
    }
    const date = new Date(value + 'T00:00:00+08:00');
    if (!Number.isFinite(date.getTime()) || manilaDateKey(date) !== value) {
      fields[field] = 'Enter a valid calendar date.';
      return null;
    }
    return date;
  }
  const start = parse(startValue, 'startDate');
  const end = parse(endValue === undefined || endValue === '' ? startValue : endValue, 'endDate');
  if (start && startValue < manilaDateKey(now)) fields.startDate = 'Leave must start today or on a future date.';
  if (start && end && end < start) fields.endDate = 'End date cannot be before start date.';
  return { start, end, fields };
}
module.exports = { validateLeaveDates };
