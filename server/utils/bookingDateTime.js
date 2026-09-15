const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const ASSIGNMENT_GRACE_MINUTES = 30;

/**
 * Resolve the calendar date selected in the Philippines independently of the
 * timezone configured on the Node host.
 */
function manilaDateParts(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const manilaClock = new Date(instant.getTime() + MANILA_OFFSET_MS);
  return {
    year: manilaClock.getUTCFullYear(),
    month: manilaClock.getUTCMonth(),
    day: manilaClock.getUTCDate(),
  };
}

function parseAppointmentTime(value) {
  if (value === undefined || value === null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;

  // Legacy numeric values are minutes after midnight (1020 means 17:00).
  if (/^\d{1,4}$/.test(raw)) {
    const total = Number(raw);
    return total >= 0 && total <= 1439 ? total : NaN;
  }

  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return NaN;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3];
  if (minutes > 59) return NaN;
  if (meridiem) {
    if (hours < 1 || hours > 12) return NaN;
    hours %= 12;
    if (meridiem.toUpperCase() === 'PM') hours += 12;
  } else if (hours > 23) {
    return NaN;
  }
  return hours * 60 + minutes;
}

function manilaDateTime(dateValue, minutesAfterMidnight, milliseconds = 0) {
  const parts = manilaDateParts(dateValue);
  const minutes = Number(minutesAfterMidnight);
  if (!parts || !Number.isFinite(minutes)) return null;
  return new Date(
    Date.UTC(parts.year, parts.month, parts.day) - MANILA_OFFSET_MS
      + minutes * 60 * 1000 + milliseconds,
  );
}

function manilaDateKey(value) {
  const parts = manilaDateParts(value);
  if (!parts) return '';
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function assignmentTimingState(booking, now = new Date()) {
  const startMinutes = parseAppointmentTime(booking?.startTime);
  const scheduledStart = manilaDateTime(booking?.bookingDate, startMinutes);
  const cutoff = scheduledStart
    ? new Date(scheduledStart.getTime() + ASSIGNMENT_GRACE_MINUTES * 60 * 1000)
    : null;
  const reference = now instanceof Date ? now : new Date(now);
  const isExpired = Boolean(
    cutoff
      && !Number.isNaN(reference.getTime())
      && reference.getTime() > cutoff.getTime(),
  );
  return {
    timeZone: 'Asia/Manila',
    graceMinutes: ASSIGNMENT_GRACE_MINUTES,
    scheduledStartAt: scheduledStart ? scheduledStart.toISOString() : null,
    assignmentCutoffAt: cutoff ? cutoff.toISOString() : null,
    isExpired,
  };
}

function isAssignmentWindowExpired(booking, now = new Date()) {
  return assignmentTimingState(booking, now).isExpired;
}

module.exports = {
  MANILA_OFFSET_MS,
  ASSIGNMENT_GRACE_MINUTES,
  manilaDateParts,
  manilaDateTime,
  manilaDateKey,
  parseAppointmentTime,
  assignmentTimingState,
  isAssignmentWindowExpired,
};
