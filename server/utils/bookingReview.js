const PENDING_REVIEW_STATUS = "pending";

function parseClock(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;

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
  const cutoff = new Date(dateValue);
  if (Number.isNaN(cutoff.getTime())) return null;

  const explicitEnd = parseClock(booking.endTime);
  const selectedEnd = parseClock(booking.selectedTimeLabel);
  const preferredEnd = preferredWindowEnd(booking.preferredTime);
  const start = parseClock(booking.startTime);
  const clock = explicitEnd || selectedEnd || preferredEnd || start;

  if (clock) {
    cutoff.setHours(clock.hours, clock.minutes, 0, 0);
    if (!explicitEnd && !selectedEnd && !preferredEnd && start) {
      cutoff.setMinutes(cutoff.getMinutes() + Math.max(30, Number(booking.serviceDurationMinutes) || 60));
    }
  } else {
    cutoff.setHours(23, 59, 59, 999);
  }
  return cutoff;
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
