const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bookingCompletionDate,
  isRecognizedBooking,
  isRecognizedOrder,
  localDateKey,
  netPaymentsThrough,
  parseReportDate,
  summarizeOrderCosts,
  summarizePaymentLedger,
} = require("../utils/enterpriseRevenue");

const january = {
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  endDate: new Date("2026-01-31T23:59:59.999Z"),
};

test("payment ledger reports collection and refund on their own event dates", () => {
  const payments = [{
    amount: 1000,
    refundAmount: 250,
    status: "refunded",
    method: "gcash",
    verifiedAt: new Date("2026-01-15T03:00:00.000Z"),
    refundedAt: new Date("2026-02-03T03:00:00.000Z"),
  }];

  const collected = summarizePaymentLedger(payments, january);
  const refunded = summarizePaymentLedger(payments, {
    startDate: new Date("2026-02-01T00:00:00.000Z"),
    endDate: new Date("2026-02-28T23:59:59.999Z"),
  });

  assert.deepEqual(collected, {
    grossCollections: 1000,
    refunds: 0,
    netCollections: 1000,
    collectionCount: 1,
    refundCount: 0,
    byMethod: { gcash: 1000, cash: 0, bank: 0, other: 0 },
    grossByMethod: { gcash: 1000, cash: 0, bank: 0, other: 0 },
    refundsByMethod: { gcash: 0, cash: 0, bank: 0, other: 0 },
  });
  assert.equal(refunded.grossCollections, 0);
  assert.equal(refunded.refunds, 250);
  assert.equal(refunded.netCollections, -250);
  assert.equal(refunded.byMethod.gcash, -250);
  assert.equal(refunded.grossByMethod.gcash, 0);
  assert.equal(refunded.refundsByMethod.gcash, 250);
});

test("cohort collections subtract only refunds completed by the report end", () => {
  const payments = [{
    amount: 1000,
    refundAmount: 250,
    status: "refunded",
    verifiedAt: new Date("2026-01-15T03:00:00.000Z"),
    refundedAt: new Date("2026-02-03T03:00:00.000Z"),
  }];

  assert.equal(netPaymentsThrough(payments, january.endDate), 1000);
  assert.equal(netPaymentsThrough(payments, new Date("2026-02-28T23:59:59.999Z")), 750);
});

test("completion recognition uses workflow completion dates, not creation dates", () => {
  const booking = {
    status: "completed",
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
    statusHistory: [{ toStatus: "completed", changedAt: new Date("2026-01-20T05:00:00.000Z") }],
  };
  const order = {
    status: "completed",
    createdAt: new Date("2025-12-10T00:00:00.000Z"),
    statusHistory: [{ status: "completed", timestamp: new Date("2026-01-22T05:00:00.000Z") }],
  };

  assert.equal(bookingCompletionDate(booking).toISOString(), "2026-01-20T05:00:00.000Z");
  assert.equal(isRecognizedBooking(booking, january.startDate, january.endDate), true);
  assert.equal(isRecognizedOrder(order, january.startDate, january.endDate), true);
});

test("order completion prefers the authoritative completedAt timestamp", () => {
  const order = {
    status: "completed",
    completedAt: new Date("2026-01-12T04:00:00.000Z"),
    updatedAt: new Date("2026-02-01T04:00:00.000Z"),
    statusHistory: [{ status: "completed", timestamp: new Date("2026-01-13T04:00:00.000Z") }],
  };
  assert.equal(require("../utils/enterpriseRevenue").orderCompletionDate(order).toISOString(), "2026-01-12T04:00:00.000Z");
});

test("order cost summary exposes incomplete cost coverage", () => {
  const result = summarizeOrderCosts(
    [{ items: [{ inventoryId: "a", quantity: 2 }, { inventoryId: "b", quantity: 1 }] }],
    [{ _id: "a", costPrice: 400 }, { _id: "b", costPrice: 0 }],
  );

  assert.equal(result.totalCost, 800);
  assert.equal(result.totalUnits, 3);
  assert.equal(result.costedUnits, 2);
  assert.ok(Math.abs(result.coveragePercent - 66.6666666667) < 0.0001);
  assert.match(result.basis, /current inventory cost/i);
});

test("date-only report filters cover the complete local business day", () => {
  const start = parseReportDate("2026-08-25");
  const end = parseReportDate("2026-08-25", true);

  assert.equal(localDateKey(start), "2026-08-25");
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.equal(end.getSeconds(), 59);
  assert.equal(end.getMilliseconds(), 999);
});

test("rejects calendar dates that JavaScript would otherwise normalize", () => {
  assert.equal(Number.isNaN(parseReportDate("2026-02-31").getTime()), true);
});
