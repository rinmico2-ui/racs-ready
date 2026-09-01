const test = require("node:test");
const assert = require("node:assert/strict");
const {
  orderDepartureReadiness,
  orderInstallationReadiness,
  orderUnitCount,
} = require("../utils/orderPreparation");

const orderId = "507f1f77bcf86cd799439011";
const technicianId = "507f1f77bcf86cd799439012";

function installationOrder(overrides = {}) {
  return {
    _id: orderId,
    technicianId,
    fulfillmentType: "delivery_installation",
    items: [{ quantity: 2 }],
    preparation: { dispatch: { status: "ready" } },
    ...overrides,
  };
}

function confirmedKit(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439013",
    technicianId,
    status: "confirmed",
    confirmedAt: new Date("2026-08-29T07:00:00Z"),
    items: [{
      name: "Vacuum Pump",
      category: "equipment",
      quantity: 1,
      unit: "pcs",
      checkoutStatus: "checked_out",
      orderIds: [orderId],
    }],
    deltaItems: [],
    ...overrides,
  };
}

test("delivery-only departure needs dispatch readiness but no Daily Kit", () => {
  const blocked = orderDepartureReadiness({
    fulfillmentType: "delivery_only",
    preparation: { dispatch: { status: "pending" } },
  }, null);
  assert.equal(blocked.ready, false);
  assert.match(blocked.blockers[0], /dispatch-ready/i);

  const ready = orderDepartureReadiness({
    fulfillmentType: "delivery_only",
    preparation: { dispatch: { status: "ready" } },
  }, null);
  assert.equal(ready.ready, true);
  assert.equal(ready.installation.status, "not_required");
});

test("installation departure requires a confirmed kit linked to that order", () => {
  const missing = orderDepartureReadiness(installationOrder(), null);
  assert.equal(missing.ready, false);
  assert.match(missing.blockers.join(" "), /Daily Preparation/i);

  const ready = orderDepartureReadiness(installationOrder(), confirmedKit());
  assert.equal(ready.ready, true);
  assert.equal(ready.installation.requiredItems.length, 1);
});

test("a late Daily Kit delta blocks only the installation that introduced it", () => {
  const otherOrderId = "507f1f77bcf86cd799439099";
  const unrelated = confirmedKit({
    deltaItems: [{ name: "Copper", category: "consumable", quantity: 2, orderIds: [otherOrderId] }],
  });
  assert.equal(orderInstallationReadiness(installationOrder(), unrelated).status, "confirmed");

  const related = confirmedKit({
    deltaItems: [{ name: "Copper", category: "consumable", quantity: 2, orderIds: [orderId] }],
  });
  const readiness = orderInstallationReadiness(installationOrder(), related);
  assert.equal(readiness.status, "pending");
  assert.match(readiness.blockers.join(" "), /Copper/);
});

test("unresolved unavailable equipment blocks installation departure", () => {
  const kit = confirmedKit({
    items: [{
      name: "Vacuum Pump",
      category: "equipment",
      quantity: 1,
      checkoutStatus: "unavailable",
      orderIds: [orderId],
      conflict: { message: "Vacuum Pump is checked out to another technician" },
    }],
  });
  const readiness = orderDepartureReadiness(installationOrder(), kit);
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join(" "), /another technician/);
});

test("installation consumable multiplier uses total ordered unit quantity", () => {
  assert.equal(orderUnitCount({ items: [{ quantity: 2 }, { quantity: 3 }] }), 5);
  assert.equal(orderUnitCount({ items: [] }), 1);
});

test("shared Daily Kit rows expose only this order's allocated quantity", () => {
  const otherOrderId = "507f1f77bcf86cd799439099";
  const readiness = orderInstallationReadiness(installationOrder(), confirmedKit({
    items: [{
      name: "Copper Tube",
      category: "consumable",
      quantity: 8,
      unit: "m",
      checkoutStatus: "issued",
      orderIds: [orderId, otherOrderId],
      orderAllocations: [
        { orderId, quantity: 3 },
        { orderId: otherOrderId, quantity: 5 },
      ],
    }],
  }));

  assert.equal(readiness.requiredItems.length, 1);
  assert.equal(readiness.requiredItems[0].quantity, 3);
});
