const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBuckets, buildOrderAnalytics, recognizedOrders } = require("../utils/orderAnalytics");

const startDate = new Date(2026, 0, 1, 0, 0, 0, 0);
const endDate = new Date(2026, 0, 31, 23, 59, 59, 999);
const previousStart = new Date(2025, 11, 1, 0, 0, 0, 0);
const previousEnd = new Date(2025, 11, 31, 23, 59, 59, 999);

test("recognizes order revenue on completion rather than creation", () => {
  const orders = [{
    status: "completed",
    createdAt: new Date(2025, 11, 20),
    completedAt: new Date(2026, 0, 10),
    total: 25000,
  }];
  assert.equal(recognizedOrders(orders, startDate, endDate).length, 1);
});

test("uses complete calendar buckets instead of fractional millisecond buckets", () => {
  const daily = buildBuckets(new Date(2026, 0, 1), new Date(2026, 0, 7, 23, 59, 59, 999));
  assert.equal(daily.length, 7);
  assert.equal(daily[0].key, "2026-01-01");
  assert.equal(daily[6].key, "2026-01-07");

  const monthly = buildBuckets(new Date(2026, 0, 1), new Date(2026, 11, 31, 23, 59, 59, 999));
  assert.equal(monthly.length, 12);
});

test("separates booked value, recognized sales, collections, refunds, and outstanding balance", () => {
  const cohortOrders = [
    {
      _id: "order-a",
      status: "completed",
      paymentStatus: "partial",
      createdAt: new Date(2026, 0, 2),
      completedAt: new Date(2026, 0, 5),
      total: 1000,
      items: [{ inventoryId: "inventory-a", quantity: 2, totalPrice: 1000, brand: "Carrier", modelLine: "Alpha" }],
      fulfillmentType: "customer_pickup",
    },
    {
      _id: "order-b",
      status: "cancelled",
      paymentStatus: "refunded",
      createdAt: new Date(2026, 0, 3),
      total: 500,
      items: [{ inventoryId: "inventory-b", quantity: 1, totalPrice: 500, brand: "Daikin" }],
      fulfillmentType: "delivery_only",
    },
  ];
  const payments = [{
    orderId: "order-a",
    amount: 600,
    refundAmount: 100,
    status: "refunded",
    method: "gcash",
    verifiedAt: new Date(2026, 0, 4),
    refundedAt: new Date(2026, 0, 20),
  }];
  const result = buildOrderAnalytics({
    cohortOrders,
    previousCohortOrders: [],
    completionCandidates: cohortOrders,
    payments,
    inventoryItems: [{ _id: "inventory-a", costPrice: 300 }],
    startDate,
    endDate,
    previousStart,
    previousEnd,
  });

  assert.equal(result.grossOrderValue, 1000);
  assert.equal(result.recognizedRevenue, 1000);
  assert.equal(result.grossCollections, 600);
  assert.equal(result.refunds, 100);
  assert.equal(result.netCollections, 500);
  assert.equal(result.outstandingBalance, 500);
  assert.equal(result.unitsSold, 2);
  assert.equal(result.topProducts.length, 1);
  assert.equal(result.estimatedCost, 600);
  assert.equal(result.estimatedGrossMargin, 400);
  assert.equal(result.marginReliable, true);
});

test("does not present gross margin as reliable with incomplete inventory cost coverage", () => {
  const result = buildOrderAnalytics({
    cohortOrders: [],
    completionCandidates: [{
      _id: "order-cost-gap",
      status: "completed",
      createdAt: startDate,
      completedAt: startDate,
      total: 1000,
      items: [{ inventoryId: "missing-cost", quantity: 2, totalPrice: 1000 }],
    }],
    payments: [],
    inventoryItems: [],
    startDate,
    endDate,
    previousStart,
    previousEnd,
  });

  assert.equal(result.costCoveragePercent, 0);
  assert.equal(result.marginReliable, false);
});

test("flags settled snapshots that are not supported by the payment ledger", () => {
  const result = buildOrderAnalytics({
    cohortOrders: [{ _id: "order-c", status: "completed", paymentStatus: "paid", createdAt: startDate, completedAt: startDate, total: 1000, items: [] }],
    completionCandidates: [],
    payments: [],
    startDate,
    endDate,
    previousStart,
    previousEnd,
  });
  assert.equal(result.ledgerMismatchCount, 1);
  assert.equal(result.outstandingBalance, 1000);
});
