const test = require("node:test");
const assert = require("node:assert/strict");
const { orderAttentionState, requestedOrderCutoff } = require("../utils/orderAttention");

test("flags an unreviewed payment after the requested delivery window", () => {
  const order = {
    status: "pending_payment",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date(2026, 7, 25) },
    timeSlot: "10:00 AM",
  };
  const state = orderAttentionState(order, new Date(2026, 7, 25, 11, 0));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionType, "payment_review_overdue");
  assert.equal(order.status, "pending_payment");
});

test("keeps a future pending order in its normal queue", () => {
  const order = {
    status: "pending_payment",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date(2026, 7, 26) },
    timeSlot: "09:00",
  };
  assert.equal(orderAttentionState(order, new Date(2026, 7, 25, 12, 0)).isPastDate, false);
});

test("uses the pickup date for customer pickup orders", () => {
  const cutoff = requestedOrderCutoff({
    status: "ready_for_pickup",
    fulfillmentType: "customer_pickup",
    pickupDate: new Date(2026, 7, 24),
  });
  assert.equal(cutoff.getDate(), 24);
  assert.equal(cutoff.getHours(), 23);
});

test("does not flag active delivery work as an admin review delay", () => {
  const state = orderAttentionState({
    status: "out_for_delivery",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date(2026, 7, 20) },
  }, new Date(2026, 7, 25));
  assert.equal(state.isPastDate, false);
});

test("flags a prepared delivery that reached its date without assignment", () => {
  const state = orderAttentionState({
    status: "preparing_unit",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date(2026, 7, 24) },
  }, new Date(2026, 7, 25));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionType, "assignment_overdue");
});

test("keeps an assigned order in the acceptance workflow instead of past-date review", () => {
  const state = orderAttentionState({
    status: "technician_assigned",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date(2026, 7, 24) },
  }, new Date(2026, 7, 25));
  assert.equal(state.isPastDate, false);
});
