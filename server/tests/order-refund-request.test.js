"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const { requestOrderRefund } = require("../utils/orderRefundRequest");

const id = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const paymentId = "507f1f77bcf86cd799439013";
const user = { _id: userId, role: "customer", name: "A Customer" };
const reason = "Cancelled order after paying the downpayment";

function fixture(options = {}) {
  const order = options.order === undefined ? { _id: id, status: "cancelled", refundStatus: "none", refundAmount: 0,
    async save({ session }) { assert.ok(session); fixtureState.savedOrders++; } } : options.order;
  const payments = options.payments === undefined ? [{ _id: paymentId, amount: 300, status: "verified", refundStatus: "none", refundAmount: 0 }] : options.payments;
  const fixtureState = { order, payments, savedOrders: 0, updates: [], orderFilters: [], paymentFilters: [], returnFilters: [], starts: 0, ends: 0 };
  const session = { async withTransaction(callback) { return callback(); }, async endSession() { fixtureState.ends++; } };
  const models = {
    mongoose: { async startSession() { fixtureState.starts++; return session; } },
    Order: { findOne(filter) { fixtureState.orderFilters.push(filter); return { session: async value => { assert.equal(value, session); return order; } }; } },
    Payment: {
      find(filter) { fixtureState.paymentFilters.push(filter); return {
        select() { return this; }, session(value) { assert.equal(value, session); return this; },
        maxTimeMS: async () => payments.filter(payment => filter.status.$in.includes(payment.status)),
      }; },
      exists(filter) { return { session: async value => { assert.equal(value, session);
        assert.equal(filter.proofUrl.$exists, true);
        return payments.some(payment => payment.status === filter.status && Boolean(payment.proofUrl)); } }; },
      async updateOne(filter, update, config) {
        fixtureState.updates.push({ filter, update, config });
        assert.equal(config.session, session);
        return { modifiedCount: options.modifiedCount === undefined ? 1 : options.modifiedCount };
      },
    },
    ProductRefund: { exists(filter) { fixtureState.returnFilters.push(filter); return {
      session: async value => { assert.equal(value, session); return Boolean(options.productReturn); },
    }; } },
  };
  return { models, state: fixtureState };
}
const run = testCase => requestOrderRefund({ orderId: id, user, reason }, testCase.models);

test("customer refund request queues only recorded received money and preserves the payment", async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.refundStatus, "pending");
  assert.equal(result.refundAmount, 300);
  assert.equal(result.alreadyRequested, false);
  assert.deepEqual(f.state.orderFilters, [{ _id: id, userId }]);
  assert.equal(f.state.savedOrders, 1);
  assert.equal(f.state.updates.length, 1);
  const { filter, update } = f.state.updates[0];
  assert.equal(filter._id, paymentId);
  assert.deepEqual(filter.refundStatus.$in, ["none", null]);
  assert.equal(update.$set.refundAmount, 300);
  assert.equal(update.$set.refundStatus, "pending");
  assert.equal(update.$push.events.status, "refund_pending");
  assert.equal(update.$push.events.actorRole, "customer");
  assert.equal(update.$inc.rmaRefundVersion, 1);
  assert.equal(update.$set.status, undefined);
  assert.equal(f.state.ends, 1);
});

test("invalid input, non-owned orders and active orders cannot queue a request", async () => {
  const f = fixture();
  await assert.rejects(requestOrderRefund({ orderId: "invalid", user, reason }, f.models), error => error.status === 400);
  await assert.rejects(requestOrderRefund({ orderId: id, user, reason: "short" }, f.models), error => error.status === 400);
  assert.equal(f.state.starts, 0);
  for (const order of [null, { status: "preparing_unit" }]) {
    const x = fixture({ order });
    await assert.rejects(run(x), error => error.status === (order ? 409 : 404));
    assert.equal(x.state.updates.length, 0);
    assert.equal(x.state.ends, 1);
  }
});

test("existing pending, completed and partial refunds are idempotent without payment writes", async () => {
  for (const refundStatus of ["pending", "processing", "completed", "partial"]) {
    const f = fixture({ order: { status: "cancelled", refundStatus, refundAmount: 300 } });
    const result = await run(f);
    assert.equal(result.alreadyRequested, true);
    assert.equal(result.refundStatus, refundStatus);
    assert.equal(f.state.paymentFilters.length, 0);
    assert.equal(f.state.updates.length, 0);
  }
});

test("unrecorded payments and pending payments without a receipt cannot create refund review", async () => {
  for (const payments of [[], [{ _id: paymentId, status: "pending", amount: 300, refundStatus: "none" }]]) {
    const f = fixture({ payments });
    await assert.rejects(run(f), error => error.status === 409 && error.code === "REFUND_PAYMENT_NOT_CONFIRMED");
    assert.equal(f.state.updates.length, 0);
    assert.equal(f.state.savedOrders, 0);
  }
});

test("an unverified uploaded receipt creates one review claim without marking money refundable", async () => {
  const pending = { _id: paymentId, status: "pending", amount: 300, refundStatus: "none", proofUrl: "/api/orders/proof" };
  const f = fixture({ payments: [pending] });
  const result = await run(f);
  assert.equal(result.refundReviewStatus, "pending_verification");
  assert.equal(result.refundStatus, "none");
  assert.equal(result.refundAmount, 0);
  assert.ok(f.state.order.refundReviewRequestedAt instanceof Date);
  assert.equal(f.state.order.refundReviewReason, reason);
  assert.equal(f.state.updates.length, 0);
  const repeat = await run(f);
  assert.equal(repeat.alreadyRequested, true);
  assert.equal(f.state.savedOrders, 1);
});

test("staff can promote an existing claim only after payment verification and preserves the original reason", async () => {
  const pending = { _id: paymentId, status: "pending", amount: 300, refundStatus: "none", proofUrl: "/api/orders/proof" };
  const f = fixture({ payments: [pending] });
  await run(f);
  await assert.rejects(requestOrderRefund({ orderId: id, user, reason, actor: { _id: userId, role: "admin" }, promoteReview: true }, f.models),
    error => error.code === "REFUND_PAYMENT_NOT_CONFIRMED");
  assert.equal(f.state.updates.length, 0);
  pending.status = "paid";
  const result = await requestOrderRefund({ orderId: id, user, reason, actor: { _id: userId, role: "admin", name: "Staff" }, promoteReview: true }, f.models);
  assert.equal(result.refundStatus, "pending");
  assert.equal(result.refundAmount, 300);
  assert.equal(f.state.updates[0].update.$push.events.actorRole, "admin");
});

test("item-level return conflicts are blocked before any whole-order refund write", async () => {
  const f = fixture({ productReturn: true });
  await assert.rejects(run(f), error => error.code === "REFUND_PRODUCT_RETURN");
  assert.equal(f.state.returnFilters[0].sourceId, id);
  assert.equal(f.state.updates.length, 0);
});

test("changed payment state aborts the request instead of overwriting another refund", async () => {
  const f = fixture({ modifiedCount: 0 });
  await assert.rejects(run(f), error => error.code === "REFUND_PAYMENT_CHANGED");
  assert.equal(f.state.savedOrders, 0);
});

test("older payment requests are reconciled, not duplicated, and invalid prior amounts require review", async () => {
  const pending = { _id: paymentId, amount: 300, status: "verified", refundStatus: "pending", refundAmount: 300 };
  const f = fixture({ payments: [pending] });
  const result = await run(f);
  assert.equal(result.alreadyRequested, true);
  assert.equal(result.refundStatus, "pending");
  assert.equal(f.state.updates.length, 0);
  const invalid = fixture({ payments: [{ ...pending, refundAmount: 500 }] });
  await assert.rejects(run(invalid), error => error.code === "REFUND_REVIEW_REQUIRED");
  assert.equal(invalid.state.updates.length, 0);
});

test("history and details show Request Refund on cancelled orders without an existing request", async () => {
  for (const template of ["my-orders", "order-details"]) {
    for (const refundStatus of ["none", "pending", "completed"]) {
      const order = { _id: id, orderReference: "ORD-TEST", status: "cancelled", refundStatus,
        paymentStatus: "partial", createdAt: new Date(), items: [], customer: {}, delivery: {}, statusHistory: [], total: 0 };
      const html = await ejs.renderFile(path.join(__dirname, `../views/pages/${template}.ejs`), { order, orders: [order] });
      assert.equal(html.includes(`data-order-refund="${id}"`), refundStatus === "none");
      assert.match(html, /customer-order-refund\.js\?v=/);
      for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    }
  }
});

test("a review claim is visible in order history and details without offering a second request", async () => {
  for (const template of ["my-orders", "order-details"]) {
    const order = { _id: id, orderReference: "ORD-TEST", status: "cancelled", refundStatus: "none",
      refundReviewRequestedAt: new Date(), paymentStatus: "pending", createdAt: new Date(), items: [], customer: {},
      delivery: {}, statusHistory: [], total: 0 };
    const html = await ejs.renderFile(path.join(__dirname, `../views/pages/${template}.ejs`), { order, orders: [order] });
    assert.match(html, /Payment review requested/);
    assert.doesNotMatch(html, /data-order-refund=/);
  }
});

function browser({ confirmed = true, ok = true, body = { message: "Queued" } } = {}) {
  const button = { dataset: { orderRefund: id }, innerHTML: "Request Refund", disabled: false,
    addEventListener(_event, handler) { this.click = handler; } };
  const requests = [], alerts = [];
  let reloads = 0, ready;
  const window = { prompt: () => confirmed ? reason : null, alert: message => alerts.push(message), location: { reload() { reloads++; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/customer-order-refund.js"), "utf8"), {
    document: { addEventListener(_event, handler) { ready = handler; }, querySelectorAll: () => [button] },
    window, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push([url, options]); return { ok, json: async () => body }; },
  });
  ready();
  return { button, requests, alerts, reloads: () => reloads };
}

test("refund UI confirms before posting, uses same-origin credentials and stays on failures", async () => {
  const stopped = browser({ confirmed: false });
  await stopped.button.click();
  assert.equal(stopped.requests.length, 0);
  const success = browser();
  const pending = success.button.click();
  await success.button.click();
  await pending;
  assert.equal(success.requests.length, 1);
  assert.equal(success.requests[0][0], `/api/orders/${id}/refund-request`);
  assert.equal(success.requests[0][1].credentials, "same-origin");
  assert.equal(JSON.parse(success.requests[0][1].body).reason, reason);
  assert.equal(success.reloads(), 1);
  const fail = browser({ ok: false, body: { error: "Payment verification required" } });
  await fail.button.click();
  assert.equal(fail.reloads(), 0);
  assert.deepEqual(fail.alerts, ["Payment verification required"]);
  assert.equal(fail.button.disabled, false);
});

test("customer refund API is customer-only and validates IDs without a database request", async () => {
  const router = require("../routes/orderRoutes");
  const route = router.stack.find(layer => layer.route?.path === "/:id/refund-request").route;
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  for (const role of ["customer", "admin", "secretary", "technician"]) {
    let allowed = false;
    const res = response();
    route.stack[1].handle({ user: { role } }, res, () => { allowed = true; });
    assert.equal(allowed, role === "customer");
  }
  const res = response();
  await route.stack.at(-1).handle({ params: { id: "invalid" }, body: { reason }, user }, res);
  assert.equal(res.statusCode, 400);
});

test("admin refund page opens requests in a payment modal and keeps manual-refund disclosure", () => {
  const admin = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Payments/Refunds.ejs"), "utf8");
  assert.match(admin, /data-tab="requests"/);
  assert.match(admin, /refundStatus=open/);
  assert.match(admin, /refundStatus=completed/);
  assert.match(admin, /href="\/admin\/payments"/);
  assert.match(admin, /does not transfer funds/);
  assert.match(admin, /id="refundDetailModal"/);
  assert.match(admin, /data-refund-detail=/);
  assert.match(admin, /complete-refund/);
  assert.match(admin, /queueVerifiedRefund/);
  assert.match(admin, /Payment verification required|Verify payment first/);
  for (const match of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const adminRoute = fs.readFileSync(path.join(__dirname, "../routes/adminApi.js"), "utf8");
  assert.match(adminRoute, /refundStatus: refundFilter/);
});

test("refund details keep actions in the modal and complete pending requests through the refund endpoint", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Payments/Refunds.ejs"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const requests = [];
  const element = name => {
    if (name.startsWith("refundSpark")) return null;
    if (!elements.has(name)) elements.set(name, {
      innerHTML: "", textContent: "", value: "", disabled: false, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, querySelectorAll() { return []; }, reset() {}, reportValidity() { return true; },
    });
    return elements.get(name);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    fetch: async (url, options) => { requests.push({ url, options });
      return { ok: true, json: async () => ({ payments: [], total: 0, success: true }) }; },
    bootstrap: { Modal: { getInstance: () => ({ hide() {} }), getOrCreateInstance: () => ({ show() {} }) } },
    window: { devicePixelRatio: 1 },
  });
  vm.runInContext(script, context);
  const payment = { _id: paymentId, orderId: id, status: "paid", refundStatus: "pending", amount: 300,
    refundAmount: 300, refundReason: reason, submittedAt: new Date().toISOString(), events: [] };
  const row = { ...payment, orderId: { _id: id, orderReference: "ORD-TEST", customer: { name: "A Customer" } } };
  context.renderRefundDetail(row, payment, []);
  assert.match(element("refundDetailActions").innerHTML, /Complete refund/);
  assert.doesNotMatch(element("refundDetailActions").innerHTML, /href="\/admin\/payments"/);
  element("refundRecordReason").value = "Refund sent to the customer's bank account.";
  vm.runInContext("refundSelected={row:globalRow,payment:globalPayment}", Object.assign(context, { globalRow: row, globalPayment: payment }));
  await context.issueRefund();
  const action = requests.find(request => request.url.endsWith("/complete-refund"));
  assert.ok(action);
  assert.equal(action.options.method, "POST");
  assert.equal(JSON.parse(action.options.body).notes, element("refundRecordReason").value);
  const reviewRow = { _id: id, refundReview: true, refundReason: reason, submittedAt: new Date().toISOString(),
    orderId: { _id: id, orderReference: "ORD-TEST", customer: { name: "A Customer" } } };
  const reviewPayments = [{ _id: paymentId, amount: 300, status: "paid", method: "gcash" }];
  context.renderRefundDetail(reviewRow, reviewRow, reviewPayments);
  assert.match(element("refundDetailActions").innerHTML, /Queue verified refund/);
  vm.runInContext("refundSelected={row:globalReview,payment:globalReview,reviewPayments:globalReviewPayments}",
    Object.assign(context, { globalReview: reviewRow, globalReviewPayments: reviewPayments }));
  await context.queueVerifiedRefund();
  assert.ok(requests.some(request => request.url.endsWith("/order-refund-reviews/" + id + "/queue") && request.options.method === "POST"));
  context.renderRefundDetail(row, { ...payment, status: "verified", refundStatus: "none" }, []);
  assert.match(element("refundDetailActions").innerHTML, /refund request before a refund/);
  assert.doesNotMatch(element("refundDetailActions").innerHTML, /Record refund/);
});

test("administrators can record verified manual order payments marked paid without broadening booking refunds", () => {
  const { assertAdminTransition } = require("../utils/remittancePolicy");
  const body = { reason: "Cancelled order payment returned to the customer" };
  assert.equal(assertAdminTransition({ status: "paid", orderId: id }, "refund", body).action, "refund");
  assert.throws(() => assertAdminTransition({ status: "paid", bookingId: id }, "refund", body), error => error.code === "REMITTANCE_STATE_CONFLICT");
  assert.throws(() => assertAdminTransition({ status: "pending", orderId: id }, "refund", body), error => error.code === "REMITTANCE_STATE_CONFLICT");
});

test("admin order refunds require a cancelled order and an outstanding request", async t => {
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const ProductRefund = require("../models/ProductRefund");
  const api = require("../routes/adminApi");
  const handler = api.stack.find(layer => layer.route?.path === "/remittances/:id/status" && layer.route.methods.patch).route.stack.at(-1).handle;
  let orderStatus = "preparing_unit";
  let refundStatus = "pending";
  let paymentStatus = "paid";
  let requestedAmount = 0;
  let paymentSaved = false;
  t.mock.method(Payment, "findById", async () => ({ _id: paymentId, orderId: id, status: paymentStatus, refundStatus,
    amount: 300, refundAmount: requestedAmount,
    async save() { paymentSaved = true; } }));
  t.mock.method(Order, "findById", () => ({ select() { return this; }, lean: async () => ({ status: orderStatus }) }));
  t.mock.method(ProductRefund, "exists", async () => false);
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const req = { params: { id: paymentId }, body: { action: "refund", reason }, user: { _id: userId, role: "admin" } };
  let res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(paymentSaved, false);
  orderStatus = "cancelled";
  refundStatus = "none";
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(paymentSaved, false);
  paymentStatus = "verified";
  orderStatus = "preparing_unit";
  refundStatus = "pending";
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(paymentSaved, false);
  orderStatus = "cancelled";
  refundStatus = "none";
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(paymentSaved, false);
  refundStatus = "pending";
  requestedAmount = 400;
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(paymentSaved, false);
});

test("completing a requested refund validates the amount and order before recording it once", async t => {
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const ProductRefund = require("../models/ProductRefund");
  const audit = require("../utils/audit");
  const api = require("../routes/adminApi");
  const handler = api.stack.find(layer => layer.route?.path === "/payments/:id/complete-refund" && layer.route.methods.post).route.stack.at(-1).handle;
  let orderStatus = "cancelled";
  let saves = 0;
  let orderUpdate;
  const payment = { _id: paymentId, orderId: id, amount: 300, refundAmount: 400,
    status: "paid", refundStatus: "pending", events: [], async save() { saves++; } };
  t.mock.method(Payment, "findById", async () => payment);
  t.mock.method(Order, "findById", () => ({ select() { return this; }, lean: async () => ({ status: orderStatus }) }));
  t.mock.method(ProductRefund, "exists", async () => false);
  t.mock.method(Payment, "find", () => ({ select() { return this; }, lean: async () => [payment] }));
  t.mock.method(Order, "findByIdAndUpdate", async (_id, update) => { orderUpdate = update; });
  t.mock.method(audit, "logEvent", async () => {});
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const req = { params: { id: paymentId }, body: { notes: "Refund sent to the customer's bank account." }, user: { _id: userId, role: "admin" } };
  let res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(saves, 0);
  payment.refundAmount = 300;
  orderStatus = "preparing_unit";
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(saves, 0);
  orderStatus = "cancelled";
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(saves, 1);
  assert.equal(payment.status, "refunded");
  assert.equal(payment.refundStatus, "completed");
  assert.equal(payment.refundNotes, req.body.notes);
  assert.match(payment.events[0].note, /Refund sent to the customer's bank account/);
  assert.equal(orderUpdate.refundStatus, "completed");
  res = response();
  await handler(req, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(saves, 1);
});

test("admin refund API includes pending requests even when the payment is not in remittance status", async t => {
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const api = require("../routes/adminApi");
  const handler = api.stack.find(layer => layer.route?.path === "/remittances" && layer.route.methods.get).route.stack.at(-1).handle;
  const payment = { _id: paymentId, status: "paid", refundStatus: "pending", refundAmount: 300,
    orderId: { orderReference: "ORD-TEST", customer: { name: "A Customer" } } };
  const filters = [];
  t.mock.method(Payment, "find", filter => {
    filters.push(filter);
    return { populate() { return this; }, sort() { return this; }, lean: async () => [payment] };
  });
  t.mock.method(Payment, "aggregate", async () => []);
  t.mock.method(Order, "find", () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [] }));
  const response = () => ({ json(value) { this.body = value; return this; }, status(code) { this.statusCode = code; return this; } });
  const res = response();
  await handler({ query: { refundStatus: "pending" } }, res, error => { throw error; });
  assert.deepEqual(filters[0], { refundStatus: "pending" });
  assert.equal(res.body.total, 1);
  assert.equal(res.body.payments[0].status, "paid");
  await handler({ query: { refundStatus: "open" } }, response(), error => { throw error; });
  assert.deepEqual(filters[1], { refundStatus: { $in: ["pending", "processing", "partial"] } });
  const invalid = response();
  await handler({ query: { refundStatus: "unknown" } }, invalid, error => { throw error; });
  assert.equal(invalid.statusCode, 400);
});

test("admin queue surfaces unverified receipt reviews and enables queuing only after a received payment", async t => {
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const api = require("../routes/adminApi");
  const handler = api.stack.find(layer => layer.route?.path === "/remittances" && layer.route.methods.get).route.stack.at(-1).handle;
  const review = { _id: id, orderReference: "ORD-TEST", customer: { name: "A Customer" },
    refundReviewReason: reason, refundReviewRequestedAt: new Date() };
  let received = false;
  t.mock.method(Payment, "find", filter => ({ populate() { return this; }, sort() { return this; }, select() { return this; },
    lean: async () => filter.orderId ? (received ? [{ orderId: id, amount: 300 }] : []) : [],
  }));
  t.mock.method(Payment, "aggregate", async () => []);
  t.mock.method(Order, "find", filter => {
    assert.equal(filter.status, "cancelled");
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [review] };
  });
  const response = () => ({ json(value) { this.body = value; return this; } });
  let res = response();
  await handler({ query: { refundStatus: "pending" } }, res, error => { throw error; });
  assert.equal(res.body.total, 1);
  assert.equal(res.body.payments[0].refundReview, true);
  assert.equal(res.body.payments[0].refundAmount, 0);
  assert.equal(res.body.payments[0].reviewReady, false);
  received = true;
  res = response();
  await handler({ query: { refundStatus: "pending" } }, res, error => { throw error; });
  assert.equal(res.body.payments[0].reviewReady, true);
});

test("mounted customer API accepts an uploaded unverified receipt as a review claim without queuing money", async t => {
  const express = require("express");
  const mongoose = require("mongoose");
  const Order = require("../models/Order");
  const Payment = require("../models/Payment");
  const ProductRefund = require("../models/ProductRefund");
  const order = { _id: id, status: "cancelled", refundStatus: "none", refundAmount: 0, async save() { saves++; } };
  let saves = 0;
  const session = { async withTransaction(callback) { return callback(); }, async endSession() {} };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Order, "findOne", filter => {
    assert.equal(String(filter.userId), userId);
    return { session: async () => order };
  });
  t.mock.method(Payment, "find", () => ({ select() { return this; }, session() { return this; }, maxTimeMS: async () => [] }));
  t.mock.method(Payment, "exists", () => ({ session: async () => ({ _id: paymentId }) }));
  t.mock.method(ProductRefund, "exists", () => ({ session: async () => null }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authResolved = true; req.user = { ...user }; next(); });
  app.use("/api/orders", require("../routes/orderRoutes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/orders/${id}/refund-request`;
  const submit = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
  const first = await submit();
  assert.equal(first.status, 200);
  const claim = await first.json();
  assert.equal(claim.refundReviewStatus, "pending_verification");
  assert.equal(claim.refundAmount, 0);
  assert.equal(order.refundStatus, "none");
  assert.equal(saves, 1);
  const second = await submit();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).alreadyRequested, true);
  assert.equal(saves, 1);
});
