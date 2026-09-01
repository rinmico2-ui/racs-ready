const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildOrderFilter,
  combineOrderFilters,
  parseOrderReportFilters,
  serializableOrderFilters,
} = require("../utils/orderReportFilters");

test("normalizes supported order report filters and rejects unknown enum values", () => {
  const filters = parseOrderReportFilters({
    q: "  ORD-2026  ",
    status: "completed",
    paymentStatus: "not-a-status",
    fulfillment: "delivery_installation",
    minValue: "5000",
    maxValue: "1000",
  });

  assert.equal(filters.q, "ORD-2026");
  assert.equal(filters.status, "completed");
  assert.equal(filters.paymentStatus, "");
  assert.equal(filters.fulfillment, "delivery_installation");
  assert.equal(filters.minValue, 1000);
  assert.equal(filters.maxValue, 5000);
  assert.equal(filters.activeCount, 5);
});

test("escapes search and brand input before constructing case-insensitive regex filters", () => {
  const filters = parseOrderReportFilters({ q: "(customer)+", brand: "A.C[1]" });
  const query = buildOrderFilter(filters);

  assert.equal(query.$and[0]["items.brand"].source, "^A\\.C\\[1\\]$");
  assert.equal(query.$and[1].$or[0].orderReference.source, "\\(customer\\)\\+");
});

test("keeps multiple $or filters isolated through an explicit $and", () => {
  const technicianId = "507f1f77bcf86cd799439011";
  const query = buildOrderFilter(parseOrderReportFilters({ technician: technicianId, q: "Marcus" }));

  assert.ok(Array.isArray(query.$and));
  assert.equal(query.$and.length, 2);
  assert.ok(query.$and.every(clause => Array.isArray(clause.$or)));
});

test("combines report, chart, and date constraints without overwriting fields", () => {
  const query = combineOrderFilters(
    { status: "completed" },
    { status: { $ne: "cancelled" } },
    { createdAt: { $gte: new Date("2026-01-01") } },
  );

  assert.equal(query.$and.length, 3);
  assert.deepEqual(serializableOrderFilters(parseOrderReportFilters({ status: "completed" })), {
    q: "",
    status: "completed",
    paymentStatus: "",
    fulfillment: "",
    paymentMethod: "",
    technician: "",
    brand: "",
    minValue: null,
    maxValue: null,
  });
});
