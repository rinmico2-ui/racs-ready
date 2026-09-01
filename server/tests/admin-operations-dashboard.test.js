const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSnapshot,
  summarizeAttendance,
  summarizeCollections,
  summarizeEquipment,
} = require("../utils/adminOperationsDashboard");

const NOW = new Date("2026-08-29T10:00:00+08:00");
const TECH_1 = "507f1f77bcf86cd799439011";
const TECH_2 = "507f1f77bcf86cd799439012";

test("collections use ledger event dates and report gross, refunds, and net separately", () => {
  const bounds = {
    startOfDay: new Date("2026-08-29T00:00:00+08:00"),
    endOfDay: new Date("2026-08-29T23:59:59.999+08:00"),
    startOfMonth: new Date("2026-08-01T00:00:00+08:00"),
  };
  const summary = summarizeCollections([
    { status: "waiting_for_remittance", amount: 1000, collectedAt: new Date("2026-08-29T09:00:00+08:00") },
    { status: "verified", amount: 500, verifiedAt: new Date("2026-08-20T09:00:00+08:00"), refundedAt: new Date("2026-08-29T09:30:00+08:00"), refundAmount: 200 },
    { status: "pending", amount: 9999, submittedAt: new Date("2026-08-29T08:00:00+08:00") },
  ], bounds);

  assert.deepEqual(summary.today, { gross: 1000, refunds: 200, net: 800, transactions: 1 });
  assert.deepEqual(summary.month, { gross: 1500, refunds: 200, net: 1300, transactions: 2 });
});

test("attendance distinguishes presence, leave, absence, and verification exceptions", () => {
  const technicians = [{ _id: TECH_1, name: "Alex" }, { _id: TECH_2, name: "Sam" }, { _id: "507f1f77bcf86cd799439013", name: "Pat" }];
  const attendance = summarizeAttendance(technicians, [{
    technicianId: TECH_1,
    status: "Late",
    checkInTime: new Date("2026-08-29T08:30:00+08:00"),
    method: "qr_scan",
    qrVerified: false,
  }], [{ technicianId: TECH_2 }]);

  assert.equal(attendance.headcount, 3);
  assert.equal(attendance.late, 1);
  assert.equal(attendance.onLeave, 1);
  assert.equal(attendance.absent, 1);
  assert.equal(attendance.unverified, 1);
  assert.equal(attendance.exceptions.length, 2);
});

test("equipment custody reports overdue assignments and units, not consumables", () => {
  const summary = summarizeEquipment([
    { _id: "a", status: "checked_out", consumable: false, quantity: 2, equipmentName: "Vacuum Pump", technicianId: { _id: TECH_1, name: "Alex" }, expectedReturnAt: new Date("2026-08-28T10:00:00+08:00") },
    { _id: "b", status: "in_use", consumable: false, quantity: 1, equipmentName: "Gauge", technicianId: { _id: TECH_1, name: "Alex" }, expectedReturnAt: new Date("2026-08-29T18:00:00+08:00") },
    { _id: "c", status: "checked_out", consumable: true, quantity: 9, equipmentName: "Tape", technicianId: { _id: TECH_2, name: "Sam" }, expectedReturnAt: new Date("2026-08-28T10:00:00+08:00") },
  ], NOW);

  assert.equal(summary.checkedOut, 2);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.overdueUnits, 2);
  assert.equal(summary.dueToday, 1);
  assert.equal(summary.techniciansWithOverdue, 1);
});

test("operations snapshot separates source orders from their linked booking projections", () => {
  const linkedBookingId = "507f1f77bcf86cd799439021";
  const realBookingId = "507f1f77bcf86cd799439022";
  const source = {
    bookingPipeline: [{ _id: "pending", count: 2 }, { _id: "completed", count: 4 }],
    orderPipeline: [{ _id: "preparing_unit", count: 1 }, { _id: "completed", count: 2 }],
    bookingReviewRows: [
      { _id: linkedBookingId, status: "pending", bookingDate: new Date("2026-08-28T08:00:00+08:00") },
      { _id: realBookingId, status: "pending", bookingDate: new Date("2026-08-28T08:00:00+08:00") },
    ],
    linkedOrderBookingIds: [linkedBookingId],
    orderReviewRows: [{ status: "preparing_unit", fulfillmentType: "delivery_only", delivery: { preferredDate: new Date("2026-08-28T08:00:00+08:00") } }],
    noShowPending: 1,
    cancellations: [{ jobs: 3, events: 5, escalated: 1 }],
    remittanceCounts: [{ _id: "waiting_for_remittance", count: 2, amount: 3000 }, { _id: "remitted", count: 1, amount: 700 }],
    paymentRows: [], equipmentRows: [], technicians: [], attendanceRecords: [], leaves: [],
  };
  const snapshot = buildSnapshot(source, NOW);

  assert.equal(snapshot.review.bookings, 1);
  assert.equal(snapshot.review.orders, 1);
  assert.equal(snapshot.review.noShow, 1);
  assert.equal(snapshot.review.total, 3);
  assert.equal(snapshot.review.overdue, 2);
  assert.equal(snapshot.remittance.actionCount, 3);
  assert.equal(snapshot.cancellations.events, 5);
  assert.ok(snapshot.priorities.some(row => /overdue booking review/.test(row.label)));
  assert.ok(snapshot.priorities.some(row => /overdue order review/.test(row.label)));
});
