const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COMPLETED_BOOKING_STATUSES,
  validFoundedYear,
  completedYearsSince,
  combineCustomerRatings,
} = require("../utils/publicBusinessStats");

test("counts only unambiguous completed lifecycle statuses", () => {
  assert.equal(COMPLETED_BOOKING_STATUSES.includes("completed"), true);
  assert.equal(COMPLETED_BOOKING_STATUSES.includes("repair_completed"), true);
  assert.equal(COMPLETED_BOOKING_STATUSES.includes("closed"), false);
  assert.equal(COMPLETED_BOOKING_STATUSES.includes("cancelled"), false);
});

test("validates founded year and calculates completed experience years", () => {
  assert.equal(validFoundedYear("2016", 2026), 2016);
  assert.equal(validFoundedYear(1899, 2026), null);
  assert.equal(validFoundedYear(2027, 2026), null);
  assert.equal(completedYearsSince(2016, 2026), 10);
  assert.equal(completedYearsSince(null, 2026), 0);
});

test("combines customer ratings without double-counting booking and order snapshots", () => {
  const result = combineCustomerRatings({
    ratings: [
      { _id: "rating-1", targetType: "booking", targetId: "booking-1", score: 4 },
      { _id: "rating-2", targetType: "technician", targetId: "tech-1", score: 5 },
      { _id: "rating-3", targetType: "technician", targetId: "tech-1", score: 4 },
    ],
    bookingRatings: [{ _id: "booking-1", customerRating: 5 }],
    orderRatings: [{ _id: "order-1", customerRating: 4 }],
  });
  assert.equal(result.ratingCount, 4);
  assert.equal(result.averageRating, 4.5);
  assert.equal(result.satisfactionPercentage, 100);
});

test("calculates satisfaction from four- and five-star responses", () => {
  const result = combineCustomerRatings({
    bookingRatings: [
      { _id: "booking-1", customerRating: 5 },
      { _id: "booking-2", customerRating: 4 },
      { _id: "booking-3", customerRating: 3 },
      { _id: "booking-4", customerRating: 1 },
    ],
  });
  assert.equal(result.averageRating, 3.3);
  assert.equal(result.satisfactionPercentage, 50);
});

test("returns zero satisfaction when no customer ratings exist", () => {
  assert.deepEqual(combineCustomerRatings(), {
    averageRating: 0,
    ratingCount: 0,
    satisfactionPercentage: 0,
  });
});
