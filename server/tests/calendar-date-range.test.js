const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCalendarBookingDateRange,
  parseCalendarDate,
} = require("../utils/calendarDateRange");

test("builds inclusive local-day boundaries for calendar appointment queries", () => {
  const range = buildCalendarBookingDateRange({ start: "2026-08-01", end: "2026-08-31" });

  assert.equal(range.$gte.getFullYear(), 2026);
  assert.equal(range.$gte.getMonth(), 7);
  assert.equal(range.$gte.getDate(), 1);
  assert.equal(range.$gte.getHours(), 0);
  assert.equal(range.$lte.getDate(), 31);
  assert.equal(range.$lte.getHours(), 23);
  assert.equal(range.$lte.getMilliseconds(), 999);
});

test("supports an open-ended calendar range and no range", () => {
  assert.deepEqual(buildCalendarBookingDateRange({ start: "2026-08-29" }), {
    $gte: parseCalendarDate("2026-08-29"),
  });
  assert.equal(buildCalendarBookingDateRange(), null);
});

test("rejects normalized or malformed calendar dates", () => {
  assert.throws(
    () => buildCalendarBookingDateRange({ start: "2026-02-30" }),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () => buildCalendarBookingDateRange({ end: "08/31/2026" }),
    /valid YYYY-MM-DD/,
  );
});

test("rejects a reversed calendar range", () => {
  assert.throws(
    () => buildCalendarBookingDateRange({ start: "2026-09-01", end: "2026-08-31" }),
    /must not be after/,
  );
});
