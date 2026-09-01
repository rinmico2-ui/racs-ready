const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyReviewFilters,
  buildAnalytics,
  buildCanonicalReviews,
  parseServiceRatingFilters,
} = require("../utils/serviceRatingReport");

const booking = {
  _id: "507f1f77bcf86cd799439011",
  bookingReference: "RACS-20260801-TEST",
  customerRating: 2,
  customerRatingComment: "Legacy comment",
  createdAt: new Date(2026, 6, 1),
  updatedAt: new Date(2026, 7, 10),
  serviceType: "repair",
  service: { name: "Aircon Repair" },
  customer: { name: "Marcus Customer", email: "customer@example.com" },
  technicianId: { _id: "507f191e810c19729de860ea", name: "Tech One" },
};

test("uses the normalized booking rating once and enriches it from the booking", () => {
  const rows = buildCanonicalReviews({
    bookings: [booking],
    ratingDocs: [{
      _id: "507f1f77bcf86cd799439013",
      targetId: booking._id,
      score: 1,
      comment: "Older duplicate",
      createdAt: new Date(2026, 7, 11),
    }, {
      _id: "507f1f77bcf86cd799439012",
      targetId: booking._id,
      score: 5,
      comment: "Canonical comment",
      createdAt: new Date(2026, 7, 12),
      customerId: { firstName: "Marcus", lastName: "Customer", email: "customer@example.com" },
    }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, 5);
  assert.equal(rows[0].serviceName, "Aircon Repair");
  assert.equal(rows[0].technician, "Tech One");
  assert.equal(rows[0].source, "normalized");
});

test("keeps a legacy booking snapshot when no normalized rating exists", () => {
  const rows = buildCanonicalReviews({ bookings: [booking], ratingDocs: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, 2);
  assert.equal(rows[0].comment, "Legacy comment");
  assert.equal(rows[0].source, "legacy");
  assert.equal(new Date(rows[0].date).getTime(), booking.updatedAt.getTime());
});

test("normalizes bounded filters and applies quality, technician, and search constraints", () => {
  const filters = parseServiceRatingFilters({
    range: "custom",
    from: "2026-08-01",
    to: "2026-08-31",
    attention: "requires_attention",
    technician: "507f191e810c19729de860ea",
    q: "legacy",
    perPage: "100",
  }, new Date(2026, 7, 28));
  const rows = buildCanonicalReviews({ bookings: [booking], ratingDocs: [] });

  assert.equal(filters.perPage, 100);
  assert.equal(filters.activeCount, 3);
  assert.equal(applyReviewFilters(rows, filters).length, 1);
});

test("computes satisfaction, low-rating exposure, comparisons, and trend from the filtered cohort", () => {
  const filters = parseServiceRatingFilters({ range: "30" }, new Date(2026, 7, 28));
  const current = [
    { ...buildCanonicalReviews({ bookings: [booking] })[0], rating: 5, date: new Date(2026, 7, 10) },
    { ...buildCanonicalReviews({ bookings: [booking] })[0], id: "second", rating: 1, date: new Date(2026, 7, 11) },
  ];
  const previous = [{ ...current[0], rating: 3, date: new Date(2026, 6, 10) }];
  const analytics = buildAnalytics(current, previous, filters);

  assert.equal(analytics.stats.totalReviews, 2);
  assert.equal(analytics.stats.overallRating, 3);
  assert.equal(analytics.stats.satisfactionRate, 50);
  assert.equal(analytics.stats.lowRatingCount, 1);
  assert.equal(analytics.changes.overallRating, 0);
  assert.ok(analytics.trend.length > 0);
});
