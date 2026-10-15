'use strict';
const { manilaDateKey, manilaDateParts, manilaDateTime, strictManilaDateKey } = require('./bookingDateTime');
const DAY = 86400000;
const TIME_ZONE = 'Asia/Manila';
function startOfDay(value) { return manilaDateTime(value, 0); }
function endOfDay(value) { const start = startOfDay(value); return start ? new Date(start.getTime() + DAY - 1) : new Date(NaN); }
function startOfMonth(value, offset = 0) {
  const parts = manilaDateParts(value);
  return parts ? new Date(Date.UTC(parts.year, parts.month + offset, 1) - 8 * 3600000) : new Date(NaN);
}
function addDays(value, days) { return new Date(new Date(value).getTime() + days * DAY); }
function parseDate(value, end = false) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (strictManilaDateKey(value) !== value) return new Date(NaN);
    return end ? endOfDay(value) : startOfDay(value);
  }
  return new Date(value);
}
function period(source = {}, { now = new Date(), defaultRange = '90', maxDays = 1827, allowAll = false } = {}) {
  const allowed = ['today','7','30','90','365','mtd','qtd','ytd','custom', ...(allowAll ? ['all'] : [])];
  const range = allowed.includes(source.range) ? source.range : defaultRange;
  let start = startOfDay(now), end = endOfDay(now);
  if (range === 'all') start = null;
  else if (range === 'custom') {
    start = parseDate(source.from); end = parseDate(source.to, true);
    if (!source.from || !source.to || !Number.isFinite(start?.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw Object.assign(Error('Choose valid reporting start and end dates in chronological order.'), { status: 400, statusCode: 400 });
  } else if (range === 'mtd') start = startOfMonth(now);
  else if (range === 'qtd') start = startOfMonth(now, -(manilaDateParts(now).month % 3));
  else if (range === 'ytd') start = startOfMonth(now, -manilaDateParts(now).month);
  else if (range !== 'today') start = addDays(start, -(Number(range) - 1));
  if (start && end - start > maxDays * DAY) throw Object.assign(Error(`Reporting date range must be within ${maxDays} days.`), { status: 400, statusCode: 400 });
  const previousEnd = start ? new Date(start.getTime() - 1) : null;
  const previousStart = start ? new Date(previousEnd.getTime() - (end - start)) : null;
  return { range, start, end, previousStart, previousEnd };
}
module.exports = { DAY, TIME_ZONE, dateKey: manilaDateKey, startOfDay, endOfDay, startOfMonth, addDays, parseDate, period };
