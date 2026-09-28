"use strict";

const MAX_CALENDAR_RANGE_DAYS = 62;

function parseDateOnly(value) {
  const match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]) ? date : null;
}

function parseOperationsCalendarRange(start, end) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (!startDate || !endDate) {
    throw new RangeError("Calendar start and end must be valid YYYY-MM-DD dates.");
  }
  const days = (endDate.getTime() - startDate.getTime()) / 86400000 + 1;
  if (days < 1 || days > MAX_CALENDAR_RANGE_DAYS) {
    throw new RangeError(`Calendar range must be between 1 and ${MAX_CALENDAR_RANGE_DAYS} days.`);
  }
  return { startDate, endDate };
}

module.exports = { MAX_CALENDAR_RANGE_DAYS, parseOperationsCalendarRange };
