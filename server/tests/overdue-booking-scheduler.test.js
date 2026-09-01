const test = require("node:test");
const assert = require("node:assert/strict");

const BookingService = require("../models/BookingService");
const {
  checkForDelayedBookings,
  checkForServiceDelays,
  checkForUnassignedOverdueBookings,
  checkForUpcomingUnverifiedBookings,
  isCommittedAssignmentStatus,
  parseBookingDateTime,
  shouldNotifyDelay,
} = require("../utils/overdueBookingScheduler");

test("booking schedule parser supports operational time formats", () => {
  const date = new Date(2026, 7, 31);
  assert.equal(parseBookingDateTime(date, "8:15 AM").getHours(), 8);
  assert.equal(parseBookingDateTime(date, "17:30").getHours(), 17);
  assert.equal(parseBookingDateTime(date, 540).getHours(), 9);
});

test("only accepted or started assignments are treated as committed", () => {
  assert.equal(isCommittedAssignmentStatus("pending_acceptance"), false);
  assert.equal(isCommittedAssignmentStatus("declined"), false);
  assert.equal(isCommittedAssignmentStatus("accepted"), true);
  assert.equal(isCommittedAssignmentStatus("en_route"), true);
});

test("delay notification is emitted once per scheduled occurrence", () => {
  const scheduled = new Date("2026-08-31T09:00:00.000Z");
  assert.equal(shouldNotifyDelay({}, scheduled), true);
  assert.equal(shouldNotifyDelay({ delayNotifiedAt: new Date("2026-08-30T09:00:00.000Z") }, scheduled), true);
  assert.equal(shouldNotifyDelay({ delayNotifiedAt: new Date("2026-08-31T09:30:00.000Z") }, scheduled), false);
});

test("monitor projections include every lifecycle field used after querying", async () => {
  const originalFind = BookingService.find;
  const projections = [];
  BookingService.find = function mockFind(filter) {
    const rows = filter.technicianId
      ? [{
          _id: "000000000000000000000001",
          status: "confirmed",
          technicianId: "000000000000000000000002",
          bookingDate: new Date("2099-08-31T00:00:00.000Z"),
          startTime: "9:00 AM",
        }]
      : [];
    const query = {
      select(fields) {
        projections.push({ filter, fields });
        return query;
      },
      lean() {
        return Promise.resolve(rows);
      },
      then(resolve, reject) {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  };

  try {
    await checkForUnassignedOverdueBookings();
    await checkForUpcomingUnverifiedBookings();
    await checkForDelayedBookings();
    await checkForServiceDelays();
  } finally {
    BookingService.find = originalFind;
  }

  assert.ok(projections.length >= 5);
  projections.forEach(({ fields }) => assert.match(fields, /\bstatus\b/));
  const mutable = projections.filter(({ fields }) => fields.includes("cancellationHistory"));
  assert.equal(mutable.length, 2);
  mutable.forEach(({ fields }) => {
    assert.match(fields, /\bassignmentId\b/);
    assert.match(fields, /\breassignmentCount\b/);
    assert.match(fields, /\bstatusHistory\b/);
  });
});
