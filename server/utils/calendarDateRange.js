const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDate(value, endOfDay = false) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(DATE_ONLY_PATTERN);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );

  // The Date constructor normalizes invalid values such as February 30.
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function buildCalendarBookingDateRange({ start, end } = {}) {
  const hasStart = start !== undefined && start !== null && start !== "";
  const hasEnd = end !== undefined && end !== null && end !== "";
  if (!hasStart && !hasEnd) return null;

  const startDate = hasStart ? parseCalendarDate(start) : null;
  const endDate = hasEnd ? parseCalendarDate(end, true) : null;

  if ((hasStart && !startDate) || (hasEnd && !endDate)) {
    throw new RangeError("Calendar dates must use a valid YYYY-MM-DD value");
  }
  if (startDate && endDate && startDate > endDate) {
    throw new RangeError("Calendar start date must not be after the end date");
  }

  return {
    ...(startDate ? { $gte: startDate } : {}),
    ...(endDate ? { $lte: endDate } : {}),
  };
}

module.exports = { buildCalendarBookingDateRange, parseCalendarDate };
