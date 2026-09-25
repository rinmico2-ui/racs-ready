"use strict";

// Overtime is allowed for a booking that starts during the technician's shift.
// Limit it to five extra hours and never schedule past 10:00 PM Manila time.
// A 5:00 PM shift can therefore cover a late booking without permitting
// overnight work. The admin sees the overtime amount before assigning.
const MAX_OVERTIME_MINUTES = 5 * 60;
const LATEST_FINISH_MINUTES = 22 * 60;

function latestAllowedFinish(shiftEndMinutes) {
  const shiftEnd = Number(shiftEndMinutes);
  if (!Number.isFinite(shiftEnd)) return NaN;
  return Math.max(shiftEnd, Math.min(shiftEnd + MAX_OVERTIME_MINUTES, LATEST_FINISH_MINUTES));
}

function overtimeMinutesForWindow(startMinutes, endMinutes, shiftStartMinutes, shiftEndMinutes) {
  const start = Number(startMinutes);
  const end = Number(endMinutes);
  const shiftStart = Number(shiftStartMinutes);
  const shiftEnd = Number(shiftEndMinutes);
  if (![start, end, shiftStart, shiftEnd].every(Number.isFinite) ||
      start < shiftStart || start >= shiftEnd || end <= start || end > latestAllowedFinish(shiftEnd)) {
    return null;
  }
  return Math.max(0, end - shiftEnd);
}

module.exports = { MAX_OVERTIME_MINUTES, LATEST_FINISH_MINUTES, latestAllowedFinish, overtimeMinutesForWindow };
