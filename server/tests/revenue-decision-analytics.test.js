"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRevenueForecast, buildServiceProfitability } = require("../utils/revenueDecisionAnalytics");
const { buildServiceLineAllocations } = require("../utils/serviceCostAnalytics");

test("multi-service allocation reconciles revenue and every direct-cost component", () => {
  const rows = buildServiceLineAllocations({
    serviceType: "core",
    services: [
      { name: "Cleaning", type: "core", quantity: 1, totalPrice: 800 },
      { name: "Installation", type: "core", quantity: 1, totalPrice: 1200 },
    ],
  }, { revenue: 2200, partsCost: 500, consumablesCost: 200, laborCost: 300, localPurchaseCost: 100 });

  const total = field => rows.reduce((sum, row) => sum + row[field], 0);
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`);
  closeTo(total("revenue"), 2200);
  closeTo(total("partsCost"), 500);
  closeTo(total("consumablesCost"), 200);
  closeTo(total("laborCost"), 300);
  closeTo(total("localPurchaseCost"), 100);
  closeTo(total("grossProfit"), 1100);
});

test("service-item saved cost details is attributed before shared booking costs", () => {
  const rows = buildServiceLineAllocations({
    serviceType: "core",
    services: [
      { _id: "line-clean", name: "Cleaning", type: "core", totalPrice: 1000 },
      { _id: "line-install", name: "Installation", type: "core", totalPrice: 1000 },
    ],
  }, {
    revenue: 2000,
    partsCost: 500,
    consumablesCost: 200,
    laborCost: 300,
    itemCosts: new Map([
      ["line-install", { partsCost: 500, laborCost: 300 }],
    ]),
  });

  const cleaning = rows.find(row => row.serviceName === "Cleaning");
  const installation = rows.find(row => row.serviceName === "Installation");
  assert.equal(cleaning.partsCost, 0);
  assert.equal(cleaning.laborCost, 0);
  assert.equal(cleaning.consumablesCost, 100);
  assert.equal(installation.partsCost, 500);
  assert.equal(installation.laborCost, 300);
  assert.equal(installation.consumablesCost, 100);
  assert.equal(installation.allocationMethod, "service_item_then_revenue_share");
});

test("service profitability ranks individual service lines without double counting", () => {
  const result = buildServiceProfitability([{
    bookingId: "booking-1",
    reference: "BK-1",
    customer: "Customer",
    completedAt: "2026-09-20T08:00:00Z",
    serviceLines: [
      { serviceName: "Aircon Cleaning", serviceCategory: "core", quantity: 2, revenue: 2000, partsCost: 100, consumablesCost: 200, laborCost: 300, grossProfit: 1400 },
      { serviceName: "Aircon Installation", serviceCategory: "core", quantity: 1, revenue: 1500, partsCost: 700, consumablesCost: 50, laborCost: 400, grossProfit: 350 },
    ],
  }], { startDate: "2026-09-01", endDate: "2026-09-30" });

  assert.equal(result.rows[0].serviceName, "Aircon Cleaning");
  assert.equal(result.rows[0].grossProfit, 1400);
  assert.equal(result.rows[1].serviceName, "Aircon Installation");
  assert.equal(result.rows.reduce((sum, row) => sum + row.revenue, 0), 3500);
  assert.equal(result.rows.reduce((sum, row) => sum + row.grossProfit, 0), 1750);
  assert.equal(result.mostProfitable.serviceName, "Aircon Cleaning");
  assert.equal(result.leastProfitable.serviceName, "Aircon Installation");
});

test("service decisions warn when direct-saved cost details is missing", () => {
  const result = buildServiceProfitability([{
    bookingId: "booking-2",
    completedAt: "2026-09-20T08:00:00Z",
    serviceLines: [{ serviceName: "Preventive Maintenance", serviceCategory: "core", revenue: 1000, grossProfit: 1000 }],
  }], { startDate: "2026-09-01", endDate: "2026-09-30" });

  assert.equal(result.rows[0].costEvidenceCoverage, 0);
  assert.equal(result.rows[0].action.label, "Save missing costs");
  assert.match(result.insights[1].text, /estimate/);
});

test("revenue forecast preserves weekday seasonality and exposes a bounded range", () => {
  const history = [];
  const start = new Date("2026-07-01T12:00:00");
  for (let index = 0; index < 70; index += 1) {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    const weekday = date.getDay();
    history.push({
      date: date.toISOString().slice(0, 10),
      booked: weekday === 0 ? 0 : weekday === 6 ? 500 : 1000,
    });
  }
  const result = buildRevenueForecast(history, { anchorDate: "2026-09-08T23:59:59", horizonDays: 30 });

  assert.equal(result.forecast.length, 30);
  assert.ok(result.total > 0);
  assert.ok(result.lower < result.total);
  assert.ok(result.upper > result.total);
  assert.ok(Math.abs(result.cappedTrendPercent) <= 30);
  assert.match(result.caveat, /does not promise future sales or money received/);
});
