const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../utils/productReturnPolicy");
const ProductReturn = require("../models/ProductReturn");
const ProductRefund = require("../models/ProductRefund");

const paidAt = new Date("2026-09-01T08:00:00.000Z");
function order(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011", status: "completed", completedAt: paidAt,
    items: [
      { inventoryId: "507f1f77bcf86cd799439012", brand: "Samsung", modelLine: "Split", quantity: 2, unitPrice: 25500, totalPrice: 51000, serialNumbers: ["ABC123", "ABC124"] },
      { inventoryId: "507f1f77bcf86cd799439013", brand: "Carrier", modelLine: "Window", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
    ],
    subtotal: 54000, discount: 0, installationFee: 1500, transportationFee: 45, total: 55545,
    warranty: { coverages: [{ itemKey: "507f1f77bcf86cd799439012", coverageType: "product", endDate: "2027-09-01T08:00:00.000Z" }] },
    ...overrides,
  };
}
function walkIn(overrides = {}) {
  return { _id: "507f1f77bcf86cd799439014", status: "completed", completedAt: paidAt,
    items: [{ toolId: "507f1f77bcf86cd799439015", itemName: "Capacitor", quantity: 3, unitPrice: 1000, totalPrice: 3000 }],
    subtotal: 3000, discount: 0, totalAmount: 3000, amountPaid: 3000, ...overrides };
}
const verified = [{ status: "verified", amount: 55545, _id: "507f1f77bcf86cd799439016" }];
const context = (overrides = {}) => ({ returns: [], refunds: [], payments: verified, returnDays: 30, ...overrides });

test("aircon item refund excludes installation, transportation, and other products", () => {
  const sale = order();
  assert.equal(policy.allocationCap("order", sale, sale.items[0], 1, 55545), 25500);
  assert.equal(policy.allocationCap("order", sale, sale.items[1], 1, 55545), 3000);
});
test("part refund and replacement use only the selected part quantity", () => {
  const sale = walkIn();
  assert.equal(policy.allocationCap("walk_in", sale, sale.items[0], 1, 3000), 1000);
  assert.equal(policy.remainingQuantity("walk_in", sale, 0, [{ itemIndex: 0, quantity: 1, status: "refund_pending" }]), 2);
  assert.equal(policy.remainingQuantity("walk_in", sale, 0, [{ itemIndex: 0, quantity: 1, status: "completed", resolution: { type: "replacement" } }]), 2);
});
test("partial payment caps the product refund at paid share", () => {
  const sale = order();
  assert.equal(policy.allocationCap("order", sale, sale.items[0], 1, 11109), 5100);
});
test("approved refunds cannot exceed confirmed money or be reserved twice", () => {
  const sale = order();
  const singlePayment = [{ status: "verified", amount: 30000, _id: "pay-1" }];
  const existing = [{ amount: 20000, originalPaymentId: "pay-1", status: "approved" }];
  const request = { maxRefundable: 25500 };
  assert.equal(policy.refundApprovalLimit("order", sale, { payments: singlePayment, refunds: existing }, request), 10000);
  assert.equal(policy.paymentForRefund(singlePayment, existing, 11000), null);
  assert.equal(policy.paymentForRefund(singlePayment, existing, 10000)._id, "pay-1");
});
test("legacy refunds reduce available item refund without rewriting the payment", () => {
  const sale = order();
  const payment = [{ status: "verified", amount: 30000, refundStatus: "partial", refundAmount: 10000, _id: "pay-2" }];
  assert.equal(policy.refundApprovalLimit("order", sale, { payments: payment, refunds: [] }, { maxRefundable: 25500 }), 20000);
  assert.equal(policy.paymentForRefund(payment, [], 25000), null);
});
test("a pending payment is not refundable", () => {
  const result = policy.evaluateItem("order", order(), 0, context({ payments: [{ status: "pending", amount: 55545 }] }), paidAt);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /Payment/);
});
test("warranty expiry and return-period expiry are checked centrally", () => {
  const expiredOrder = order({ warranty: { coverages: [] } });
  assert.equal(policy.evaluateItem("order", expiredOrder, 0, context(), new Date("2026-11-01")).eligible, false);
  assert.equal(policy.evaluateItem("order", order(), 0, context(), new Date("2026-11-01")).eligible, true);
  assert.equal(policy.evaluateItem("walk_in", walkIn(), 0, context({ payments: [] }), new Date("2026-11-01")).eligible, false);
});
test("active, refunded, and replaced units cannot be requested twice", () => {
  const sale = order();
  const returns = [{ itemIndex: 0, quantity: 1, status: "refund_pending" }, { itemIndex: 0, quantity: 1, status: "completed", resolution: { type: "refund" } }];
  assert.equal(policy.evaluateItem("order", sale, 0, context({ returns }), paidAt).remaining, 0);
  assert.equal(policy.evaluateItem("order", sale, 0, context({ returns }), paidAt).eligible, false);
});
test("repaired, rejected, and cancelled units are not permanently consumed", () => {
  const sale = walkIn();
  const returns = ["rejected", "cancelled"].map(status => ({ itemIndex: 0, quantity: 1, status }));
  returns.push({ itemIndex: 0, quantity: 1, status: "completed", resolution: { type: "repair" } });
  assert.equal(policy.remainingQuantity("walk_in", sale, 0, returns), 3);
});
test("status machine requires receiving and inspection before refund or replacement", () => {
  assert.equal(policy.canTransition("requested", "refund_pending"), false);
  assert.equal(policy.canTransition("under_review", "awaiting_return"), true);
  assert.equal(policy.canTransition("awaiting_return", "received"), true);
  assert.equal(policy.canTransition("received", "inspected"), true);
  assert.equal(policy.canTransition("inspected", "refund_pending"), true);
  assert.equal(policy.canTransition("inspected", "replacement_pending"), true);
  assert.equal(policy.canTransition("rejected", "refund_approved"), false);
});
test("serialized units under RMA cannot be handed over again", async () => {
  const originalExists = ProductReturn.exists;
  try {
    ProductReturn.exists = async filter => {
      assert.match(String(filter.$or[0].serialNumbers.$in[0]), /ABC123/i);
      return { _id: "existing-rma" };
    };
    await assert.rejects(policy.assertNoReturnSerialConflict(["ABC123"]), /returned or replacement unit/);
  } finally { ProductReturn.exists = originalExists; }
});
test("refund ledger requires a return and records the original payment separately", async () => {
  const refund = new ProductRefund({ returnId: "507f1f77bcf86cd799439018", sourceType: "order", sourceId: "507f1f77bcf86cd799439011", itemIndex: 0, originalPaymentId: verified[0]._id, amount: 25500, approvedBy: "507f1f77bcf86cd799439019" });
  assert.equal(await refund.validate(), undefined);
  assert.equal(refund.originalPaymentId.toString(), verified[0]._id);
  assert.equal(refund.status, "approved");
});
test("RMA preserves item identity, quarantine state, and audit history", async () => {
  const row = new ProductReturn({ rmaNumber: "RMA-2026-TEST", sourceType: "order", sourceId: "507f1f77bcf86cd799439011", sourceReference: "ORD-1", itemIndex: 0, productId: "507f1f77bcf86cd799439012", productName: "Samsung Split", quantity: 1, originalQuantity: 2, unitPrice: 25500, maxRefundable: 25500, purchaseDate: paidAt, coverageType: "seller_warranty", reason: "defective", description: "Unit does not cool at all", requestedResolution: "refund", history: [{ action: "requested", to: "requested" }] });
  assert.equal(await row.validate(), undefined);
  assert.equal(row.inventoryDisposition, "customer_held");
  assert.equal(row.history.length, 1);
});
