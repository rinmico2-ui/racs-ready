const test = require("node:test");
const assert = require("node:assert/strict");
const { bookingReviewState, requestedScheduleCutoff } = require("../utils/bookingReview");

test("keeps a past pending booking pending while flagging review overdue", () => {
  const booking = { status: "pending", bookingDate: new Date(2026, 7, 25), startTime: "08:00", endTime: "12:00" };
  const state = bookingReviewState(booking, new Date(2026, 7, 25, 13, 0));
  assert.equal(state.reviewStatus, "overdue");
  assert.equal(state.isReviewOverdue, true);
  assert.equal(booking.status, "pending");
});

test("does not flag a pending booking before its requested window ends", () => {
  const booking = { status: "pending", bookingDate: new Date(2026, 7, 25), preferredTime: "Morning" };
  const state = bookingReviewState(booking, new Date(2026, 7, 25, 11, 59));
  assert.equal(state.reviewStatus, "pending");
  assert.equal(state.isReviewOverdue, false);
});

test("uses the last time in a selected time range as the cutoff", () => {
  const cutoff = requestedScheduleCutoff({ bookingDate: new Date(2026, 7, 25), selectedTimeLabel: "8:00 AM - 10:30 AM" });
  assert.equal(cutoff.getHours(), 10);
  assert.equal(cutoff.getMinutes(), 30);
});

test("never reports non-pending bookings as review overdue", () => {
  const state = bookingReviewState({ status: "confirmed", bookingDate: new Date(2020, 0, 1) }, new Date(2026, 7, 25));
  assert.equal(state.reviewStatus, null);
  assert.equal(state.isReviewOverdue, false);
});
