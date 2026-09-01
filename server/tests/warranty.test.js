const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAY_MS,
  buildWarrantyCoverage,
  resolveWarrantyCoverage,
  bookingCompletionDate,
} = require("../utils/warrantyLifecycle");

test("builds warranty dates from the authoritative completion timestamp", () => {
  const completedAt = new Date("2026-08-01T08:00:00.000Z");
  const warranty = buildWarrantyCoverage(completedAt, 30);

  assert.equal(warranty.startDate.toISOString(), completedAt.toISOString());
  assert.equal(warranty.endDate.getTime(), completedAt.getTime() + 30 * DAY_MS);
  assert.equal(warranty.status, "active");
});

test("reconstructs legacy warranty dates and derives expiry without mutating the record", () => {
  const stored = { days: 30, status: "active" };
  const completedAt = new Date("2026-06-01T08:00:00.000Z");
  const resolved = resolveWarrantyCoverage(stored, completedAt, new Date("2026-08-01T08:00:00.000Z"));

  assert.equal(resolved.startDate.toISOString(), completedAt.toISOString());
  assert.equal(resolved.endDate.getTime(), completedAt.getTime() + 30 * DAY_MS);
  assert.equal(resolved.status, "expired");
  assert.equal(resolved.datesInferred, true);
  assert.equal(stored.startDate, undefined);
});

test("does not report an undated warranty as active", () => {
  const resolved = resolveWarrantyCoverage({ days: 30, status: "active" }, null);
  assert.equal(resolved.status, "incomplete");
  assert.equal(resolved.startDate, null);
  assert.equal(resolved.endDate, null);
});

test("preserves a filed claim while reconstructing its coverage window", () => {
  const resolved = resolveWarrantyCoverage(
    { days: 30, status: "claimed", claimedAt: new Date("2026-08-10T08:00:00.000Z") },
    new Date("2026-08-01T08:00:00.000Z"),
    new Date("2026-08-20T08:00:00.000Z"),
  );

  assert.equal(resolved.status, "claimed");
  assert.equal(resolved.datesInferred, true);
});

test("uses assignment completion for legacy bookings without a stored completion date", () => {
  const assignmentCompletedAt = new Date("2026-08-12T09:30:00.000Z");
  const resolved = bookingCompletionDate(
    { statusHistory: [], services: [] },
    { completedAt: assignmentCompletedAt },
  );

  assert.equal(resolved.toISOString(), assignmentCompletedAt.toISOString());
});
