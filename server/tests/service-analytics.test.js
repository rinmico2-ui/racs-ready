const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allocateServiceRevenue,
  buildDailyTrend,
  buildWeekdayForecast,
  getWeekBounds,
  ratingForBooking,
  resolveBookedValue,
  statusGroup,
  summarizeLifecycle,
} = require("../utils/serviceAnalytics");

test("groups core and repair workflow statuses consistently", () => {
  assert.equal(statusGroup("completed"), "completed");
  assert.equal(statusGroup("repair_completed"), "completed");
  assert.equal(statusGroup("closed"), "completed");
  assert.equal(statusGroup("inspection_in_progress"), "in_progress");
  assert.equal(statusGroup("repair_in_progress"), "in_progress");
  assert.equal(statusGroup("repair_declined"), "cancelled");
  assert.deepEqual(
    summarizeLifecycle([
      { status: "completed" },
      { status: "repair_completed" },
      { status: "repair_in_progress" },
      { status: "awaiting_approval" },
      { status: "cancelled" },
    ]),
    { completed: 2, cancelled: 1, inProgress: 1, pending: 1 },
  );
});

test("uses Rating records when the booking snapshot has no rating", () => {
  const ratings = new Map([["booking-1", 4.5]]);
  assert.equal(ratingForBooking({ _id: "booking-1" }, ratings), 4.5);
  assert.equal(ratingForBooking({ _id: "booking-1", customerRating: 5 }, ratings), 5);
});

test("allocates unpriced multi-service revenue without losing the booking value", () => {
  const rows = allocateServiceRevenue({
    services: [
      { name: "Cleaning", quantity: 1 },
      { name: "Installation", quantity: 2 },
    ],
  }, 3000);
  assert.equal(rows[0].allocatedRevenue, 1000);
  assert.equal(rows[1].allocatedRevenue, 2000);
  assert.equal(rows.reduce((sum, row) => sum + row.allocatedRevenue, 0), 3000);
});

test("resolves core and repair booked value consistently", () => {
  assert.equal(resolveBookedValue({ serviceType: "core", totalPrice: 2048, amountPaid: 205 }), 2048);
  assert.equal(resolveBookedValue({
    serviceType: "repair",
    inspectionFeeAmount: 500,
    inspectionFeeDistanceFare: 48,
    totalFinalCost: 3000,
    repairPaymentAmount: 1000,
  }), 3548);
});

test("daily trends anchor to the selected report end date", () => {
  const rows = buildDailyTrend([
    { createdAt: "2026-01-14T05:00:00Z", status: "repair_completed" },
  ], new Date("2026-01-15T23:59:59"), 2);
  assert.deepEqual(rows.map((row) => row.bookings), [1, 0]);
  assert.deepEqual(rows.map((row) => row.completed), [1, 0]);
});

test("weekly bounds include seven complete local calendar days", () => {
  const { start, endExclusive } = getWeekBounds(new Date("2026-01-15T23:59:59"), 0);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 0);
  assert.equal(start.getDate(), 9);
  assert.equal(start.getHours(), 0);
  assert.equal(endExclusive.getDate(), 16);
  assert.equal(endExclusive.getHours(), 0);
});

test("weekday forecast uses historical weekday averages instead of a fixed uplift", () => {
  const rows = buildWeekdayForecast([
    { createdAt: "2026-01-05T09:00:00" },
    { createdAt: "2026-01-12T09:00:00" },
    { createdAt: "2026-01-12T10:00:00" },
  ], new Date("2026-01-05T00:00:00"), new Date("2026-01-18T23:59:59"));
  assert.equal(rows[0].day, "Mon");
  assert.equal(rows[0].bookings, 1.5);
  assert.equal(rows[0].sampleSize, 2);
});
