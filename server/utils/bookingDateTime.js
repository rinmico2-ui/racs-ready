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

function strictManilaDateKey(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return manilaDateKey(value);
}

/**
 * Evaluate a customer-facing schedule using Philippine wall-clock time.
 * The result is independent of the timezone configured on the Node host.
 */
function manilaSlotTiming(dateValue, timeValue, options = {}) {
  const dateKey = strictManilaDateKey(dateValue);
  const startMinutes = parseAppointmentTime(timeValue);
  const reference = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const minAdvanceMinutes = Math.max(0, Number(options.minAdvanceMinutes) || 0);
  const safetyBufferMinutes = Math.max(0, Number(options.safetyBufferMinutes) || 0);
  const requiredLeadMinutes = Math.max(minAdvanceMinutes, safetyBufferMinutes);
  const slotStartAt = dateKey && Number.isFinite(startMinutes)
    ? manilaDateTime(dateKey, startMinutes)
    : null;

  if (!slotStartAt || Number.isNaN(reference.getTime())) {
    return {
      valid: false,
      allowed: false,
      dateKey,
      startMinutes,
      slotStartAt: null,
      requiredLeadMinutes,
      actualLeadMinutes: NaN,
      reason: 'invalid',
    };
  }

  const actualLeadMinutes = Math.floor((slotStartAt.getTime() - reference.getTime()) / 60000);
  const isPast = slotStartAt.getTime() <= reference.getTime();
  const allowed = actualLeadMinutes >= requiredLeadMinutes;
  return {
    valid: true,
    allowed,
    isPast,
    dateKey,
    startMinutes,
    slotStartAt,
    requiredLeadMinutes,
    actualLeadMinutes,
    reason: allowed ? '' : (isPast ? 'past' : 'advance_notice'),
  };
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
  strictManilaDateKey,
  manilaSlotTiming,
  parseAppointmentTime,
  assignmentTimingState,
  isAssignmentWindowExpired,
};
