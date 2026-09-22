const PENDING_REVIEW_STATUS = "pending";
const { manilaDateTime, parseAppointmentTime } = require("./bookingDateTime");

function parseClock(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;

  // Appointment routes historically persist times as minutes after midnight
  // (for example, "1200" means 8:00 PM). Handle those values before parsing
  // human-readable labels; otherwise the generic clock regex reads "1200" as
  // separate 12 and 00 tokens and incorrectly resolves it to midnight.
  if (/^\d{1,4}$/.test(text)) {
    const totalMinutes = parseAppointmentTime(text);
    if (Number.isFinite(totalMinutes)) {
      return {
        hours: Math.floor(totalMinutes / 60),
        minutes: totalMinutes % 60,
      };
    }
  }

  const matches = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3];
  if (minutes > 59 || hours > (meridiem ? 12 : 23)) return null;
  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

function preferredWindowEnd(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("morning")) return { hours: 12, minutes: 0 };
  if (normalized.includes("afternoon")) return { hours: 17, minutes: 0 };
  if (normalized.includes("evening")) return { hours: 20, minutes: 0 };
  return parseClock(normalized);
}

function requestedScheduleCutoff(booking) {
  const dateValue = booking?.preferredDate || booking?.bookingDate;
  if (!dateValue) return null;

  const explicitEnd = parseClock(booking.endTime);
  const selectedEnd = parseClock(booking.selectedTimeLabel);
  const preferredEnd = preferredWindowEnd(booking.preferredTime);
  const start = parseClock(booking.startTime);
  const clock = explicitEnd || selectedEnd || preferredEnd || start;

  if (clock) {
    let cutoffMinutes = clock.hours * 60 + clock.minutes;
    if (!explicitEnd && !selectedEnd && !preferredEnd && start) {
      cutoffMinutes += Math.max(30, Number(booking.serviceDurationMinutes) || 60);
    }
    return manilaDateTime(dateValue, cutoffMinutes);
  }
  return manilaDateTime(dateValue, 24 * 60 - 1, 59 * 1000 + 999);
}

function bookingReviewState(booking, now = new Date()) {
  const pending = booking?.status === PENDING_REVIEW_STATUS;
  const cutoff = requestedScheduleCutoff(booking);
  const isReviewOverdue = Boolean(pending && cutoff && cutoff.getTime() < now.getTime());
  return {
    reviewStatus: pending ? (isReviewOverdue ? "overdue" : "pending") : null,
    isReviewOverdue,
    requestedScheduleAt: cutoff ? cutoff.toISOString() : null,
    reviewOverdueReason: isReviewOverdue
      ? "Requested schedule passed before admin review"
      : null,
  };
}

function withBookingReviewState(booking, now = new Date()) {
  return { ...booking, ...bookingReviewState(booking, now) };
}

module.exports = {
  PENDING_REVIEW_STATUS,
  bookingReviewState,
  requestedScheduleCutoff,
  withBookingReviewState,
};
