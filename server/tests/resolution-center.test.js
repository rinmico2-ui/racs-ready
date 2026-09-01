const test = require("node:test");
const assert = require("node:assert/strict");
const {
  filterResolutionCases,
  orderResolutionCase,
  paginateResolutionCases,
  sortResolutionCases,
  summarizeResolutionCases,
} = require("../utils/resolutionCenter");

const NOW = new Date("2026-08-29T12:00:00+08:00");

test("normalizes an overdue order into the shared resolution contract", () => {
  const item = orderResolutionCase({
    _id: "64b000000000000000000001",
    bookingId: "64b000000000000000000002",
    orderReference: "ORD-1001",
    status: "pending_payment",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date("2026-08-27T00:00:00+08:00"), contactNumber: "09170000000" },
    timeSlot: "09:00",
    customer: { name: "Ana Cruz", email: "ana@example.test" },
    items: [{ modelLine: "Premium Inverter", quantity: 2 }],
    paymentStatus: "pending",
    total: 85000,
  }, NOW);

  assert.equal(item.sourceType, "order");
  assert.equal(item.issueType, "payment_review_overdue");
  assert.equal(item.linkedBookingId, "64b000000000000000000002");
  assert.equal(item.itemCount, 2);
  assert.equal(item.severity, "critical");
  assert.deepEqual(item.allowedActions, ["view", "verify_payment", "reschedule", "call"]);
});

test("does not create a resolution case for an order with a future schedule", () => {
  const item = orderResolutionCase({
    _id: "64b000000000000000000003",
    status: "preparing_unit",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-31T00:00:00+08:00") },
    timeSlot: "09:00",
  }, NOW);
  assert.equal(item, null);
});

test("filters the unified queue by source, issue, severity, and search", () => {
  const cases = [
    { sourceType: "booking", issueType: "no_show", severity: "critical", reference: "BK-1", customer: "Juan Dela Cruz" },
    { sourceType: "order", issueType: "pickup_overdue", severity: "high", reference: "ORD-2", customer: "Maria Santos", serviceName: "Split Type" },
  ];
  assert.equal(filterResolutionCases(cases, { source: "order" }).length, 1);
  assert.equal(filterResolutionCases(cases, { issue: "no_show", severity: "critical" }).length, 1);
  assert.equal(filterResolutionCases(cases, { q: "maria" })[0].reference, "ORD-2");
});

test("summary facets and pagination remain based on the normalized queue", () => {
  const cases = [
    { sourceType: "booking", issueType: "past_date", severity: "high", isPastDate: true, daysPast: 1, reference: "BK-2" },
    { sourceType: "order", issueType: "pickup_overdue", severity: "critical", isPastDate: true, daysPast: 4, reference: "ORD-1" },
    { sourceType: "booking", issueType: "no_show", severity: "critical", isPastDate: false, daysPast: 0, reference: "BK-1" },
  ];
  sortResolutionCases(cases);
  assert.equal(cases[0].reference, "ORD-1");
  assert.deepEqual(summarizeResolutionCases(cases), {
    total: 3,
    pastDue: 2,
    byIssue: { pickup_overdue: 1, no_show: 1, past_date: 1 },
    bySource: { booking: 2, order: 1 },
    bySeverity: { critical: 2, high: 1 },
  });
  const page = paginateResolutionCases(cases, 1, 10);
  assert.equal(page.cases.length, 3);
  assert.deepEqual(page.pagination, { page: 1, perPage: 10, total: 3, pages: 1 });
});
