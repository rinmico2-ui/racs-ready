"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const routes = require("../routes/orderRoutes");
const { OrderCheckoutError } = require("../utils/orderCheckoutPolicy");

const id = "507f191e810c19729de860ea";
const userId = "507f191e810c19729de860eb";
const unsupported = () => Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), { code: 20 });
const route = (url, method) => routes.stack.find(layer => layer.route?.path === url && layer.route.methods[method]).route;
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function sessionFixture(t) {
  const calls = [];
  const session = {
    startTransaction() { calls.push("start"); },
    async commitTransaction() { calls.push("commit"); },
    async abortTransaction() { calls.push("abort"); },
    async endSession() { calls.push("end"); },
  };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(console, "error", () => {});
  return { calls, session };
}

test("payment review and pickup explain the database setup error without writing or reporting success", async t => {
  for (const role of ["admin", "secretary"]) {
    for (const [url, method, action] of [["/:id/payment", "patch", "Payment review"], ["/:id/confirm-pickup", "post", "Pickup confirmation"]]) {
      await t.test(`${role}: ${action}`, async t => {
        const { calls, session } = sessionFixture(t);
        t.mock.method(Order, "findById", () => ({ session: async value => { assert.equal(value, session); throw unsupported(); } }));
        t.mock.method(Order.prototype, "save", () => assert.fail("Must not save an order"));
        t.mock.method(Payment, "findById", () => assert.fail("Must not read or change payment"));
        t.mock.method(Payment.prototype, "save", () => assert.fail("Must not save payment"));
        const res = response();
        await route(url, method).stack.at(-1).handle({ params: { id }, body: { paymentStatus: "paid" }, user: { _id: userId, role } }, res);
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, "ORDER_DATABASE_SETUP_REQUIRED");
        assert.match(res.body.error, new RegExp(`^${action} is unavailable`));
        assert.match(res.body.error, /MongoDB replica set setup/);
        assert.doesNotMatch(res.body.error, /Ordering|Transaction numbers|receipt/);
        assert.equal(res.body.success, undefined);
        assert.deepEqual(calls, ["start", "abort", "end"]);
      });
    }
  }
});

test("failed cancellation names the action and shows database setup details only to staff", async t => {
  for (const role of ["admin", "secretary", "customer"]) {
    await t.test(role, async t => {
      const { calls, session } = sessionFixture(t);
      const original = { _id: id, userId, status: "pending_payment", items: [] };
      t.mock.method(Order, "findById", async () => original);
      t.mock.method(Order, "findOne", () => ({ session: async value => { assert.equal(value, session); throw unsupported(); } }));
      t.mock.method(Order.prototype, "save", () => assert.fail("Must not cancel the order"));
      t.mock.method(Payment, "find", () => assert.fail("Must not change refunds"));
      const res = response();
      await route("/:id/cancel", "post").stack.at(-1).handle({ params: { id }, body: { reason: "Customer requested cancellation" }, user: { _id: userId, role } }, res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, /^Order cancellation is/);
      assert.doesNotMatch(res.body.error, /Ordering|Transaction numbers/);
      assert.equal(original.status, "pending_payment");
      assert.deepEqual(calls, ["start", "abort", "end"]);
      if (role === "customer") {
        assert.equal(res.body.code, "ORDER_DATABASE_UNAVAILABLE");
        assert.doesNotMatch(res.body.error, /MongoDB|replica set/);
      } else assert.equal(res.body.code, "ORDER_DATABASE_SETUP_REQUIRED");
    });
  }
});

test("a failed session start returns an action error rather than rejecting the request handler", async t => {
  for (const [url, method, action] of [["/:id/payment", "patch", "Payment review"], ["/:id/confirm-pickup", "post", "Pickup confirmation"]]) {
    await t.test(action, async t => {
      t.mock.method(mongoose, "startSession", async () => { throw new Error("Private database connection details"); });
      t.mock.method(console, "error", () => {});
      t.mock.method(Order, "findById", () => assert.fail("Must not query after session failure"));
      const res = response();
      await route(url, method).stack.at(-1).handle({ params: { id }, body: { paymentStatus: "paid" }, user: { role: "admin" } }, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, `${action} could not be completed. Please try again.`);
    });
  }
});

test("invalid payment status is rejected before starting any session", async t => {
  t.mock.method(mongoose, "startSession", () => assert.fail("Must validate before opening a session"));
  for (const paymentStatus of [undefined, "verified", "anything"]) {
    const res = response();
    await route("/:id/payment", "patch").stack.at(-1).handle({ params: { id }, body: { paymentStatus } }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("supported payment review saves both records in the same transaction before notifying the customer", async t => {
  for (const deposit of [false, true]) {
    await t.test(deposit ? "downpayment" : "full payment", async t => {
      const { calls, session } = sessionFixture(t);
      const expectedStatus = deposit ? "partial" : "paid";
      const order = { _id: id, userId, status: "pending_payment", paymentStatus: "pending", paymentMethod: "gcash_full", paymentId: id,
        total: 5000, downpaymentAmount: deposit ? 500 : 0, balanceAmount: deposit ? 4500 : 0,
        pushStatus(status) { this.status = status; },
        async save(options) { assert.equal(options.session, session); calls.push("save-order"); },
      };
      const payment = { status: "pending", proofUrl: "/receipt.png", events: [], async save(options) { assert.equal(options.session, session); calls.push("save-payment"); } };
      t.mock.method(Order, "findById", () => ({ session: async value => { assert.equal(value, session); return order; } }));
      t.mock.method(Payment, "findById", () => ({ session: async value => { assert.equal(value, session); return payment; } }));
      const req = { params: { id }, body: { paymentStatus: "paid" }, user: { _id: userId, role: "admin" },
        app: { get: () => ({ to: room => ({ emit() { calls.push(`notify:${room}`); } }) }) } };
      const res = response();
      await route("/:id/payment", "patch").stack.at(-1).handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.paymentStatus, expectedStatus);
      assert.equal(order.status, "preparing_unit");
      assert.equal(order.paymentStatus, expectedStatus);
      assert.equal(payment.status, expectedStatus);
      assert.equal(payment.verifiedBy, userId);
      assert.deepEqual(calls, ["start", "save-order", "save-payment", "commit", `notify:customer:${userId}`, "notify:admin-room", "end"]);
    });
  }
});

test("action-specific errors preserve checkout receipt guidance and validation errors", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/orderRoutes.js"), "utf8");
  const begin = source.indexOf("function checkoutErrorResponse(");
  const end = source.indexOf("\nfunction emitOrderStatus", begin);
  const present = vm.runInNewContext(`(${source.slice(begin, end)})`, {
    isUnsupportedMongoWriteFeature: require("../utils/mongoWriteSupport").isUnsupportedMongoWriteFeature,
    OrderCheckoutError, loyaltyRewards: require("../utils/loyaltyRewards"),
  });
  const checkout = response();
  present(checkout, unsupported());
  assert.equal(checkout.statusCode, 503);
  assert.equal(checkout.body.code, "ORDER_DATABASE_UNAVAILABLE");
  assert.match(checkout.body.error, /^Ordering is temporarily unavailable/);
  assert.match(checkout.body.error, /keep your receipt/);
  const validation = response();
  present(validation, new OrderCheckoutError("Payment proof is missing.", 409, "ORDER_PAYMENT_PROOF_MISSING"), { action: "Payment review", isStaff: true });
  assert.equal(validation.statusCode, 409);
  assert.equal(validation.body.error, "Payment proof is missing.");
  assert.equal(validation.body.code, "ORDER_PAYMENT_PROOF_MISSING");
});
