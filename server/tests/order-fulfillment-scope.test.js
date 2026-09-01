const test = require("node:test");
const assert = require("node:assert/strict");
const { orderFulfillmentScopeFilter } = require("../utils/orderFulfillmentScope");

test("delivery workspace includes installation and legacy delivery-only orders", () => {
  assert.deepEqual(orderFulfillmentScopeFilter("delivery"), {
    fulfillmentType: { $in: ["delivery_only", "delivery_installation"] },
  });
});

test("delivery workspace permits a narrower delivery subtype", () => {
  assert.deepEqual(orderFulfillmentScopeFilter("delivery", "delivery_installation"), {
    fulfillmentType: "delivery_installation",
  });
});

test("pickup workspace cannot be overridden by a delivery subtype", () => {
  assert.deepEqual(orderFulfillmentScopeFilter("pickup", "delivery_installation"), {
    fulfillmentType: "customer_pickup",
  });
});

test("unscoped requests retain an explicitly valid fulfillment type", () => {
  assert.deepEqual(orderFulfillmentScopeFilter(undefined, "customer_pickup"), {
    fulfillmentType: "customer_pickup",
  });
});
