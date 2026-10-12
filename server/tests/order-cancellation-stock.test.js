"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Inventory = require("../models/Inventory");
const HVACProduct = require("../models/HVACProduct");
const audit = require("../utils/audit");
const notify = require("../utils/notify");
const { restoreCancelledOrderStock } = require("../utils/orderCancellationStock");
const routes = require("../routes/orderRoutes");
const handler = routes.stack.find(layer => layer.route?.path === "/:id/cancel" && layer.route.methods.post).route.stack.at(-1).handle;

const id = "6a8f82eeba453bf5644d5e1a";
const userId = "507f191e810c19729de860eb";
const staffId = "507f191e810c19729de860ec";
const inventoryId = "6a6db36df755713eba4365e6";
const parentHvacId = "6a280956c3e1ac35ac7ccef4";
const line = { inventoryId, parentHvacId, isHvac: true, modelLine: "Carrier Nexus Inverter", capacity: "1.0", quantity: 1, unitPrice: 27930, totalPrice: 27930 };
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, options = {}) {
  const state = {
    order: { _id: id, userId, orderReference: "ORD-20260827-REGG", status: "preparing_unit",
      fulfillmentType: "delivery_installation", paymentStatus: "partial", paymentMethod: "cod",
      statusHistory: [], total: 27930, items: [line], ...options.order },
    payment: { _id: "507f191e810c19729de860ed", orderId: id, amount: 2793, status: "partial", method: "gcash", events: [], refundStatus: "none", ...options.payment },
    queries: [], stockAdded: 0, pendingStock: 0, commits: 0, aborts: 0, ends: 0,
    audit: [], notifications: [], events: [],
  };
  let pendingOrder, pendingPayment;
  const session = {
    startTransaction() {},
    async commitTransaction() { state.commits++; state.order = pendingOrder; if (pendingPayment) state.payment = pendingPayment; state.stockAdded += state.pendingStock; },
    async abortTransaction() { state.aborts++; state.pendingStock = 0; },
    async endSession() { state.ends++; },
  };
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Order, "findById", async () => Order.hydrate(clone(state.order)));
  t.mock.method(Order, "findOne", filter => ({ session: async value => {
    assert.equal(value, session);
    assert.equal(filter.status.$nin.includes("cancelled"), true);
    return ["cancelled", "completed"].includes(state.order.status) ? null : Order.hydrate(clone(state.order));
  } }));
  t.mock.method(Order.prototype, "save", async function (config) {
    assert.equal(config.session, session);
    await this.validate();
    if (options.failOrderSave) throw new Error("Database write failed");
    pendingOrder = clone(this.toObject());
    return this;
  });
  t.mock.method(Payment, "find", filter => ({ session: async value => {
    assert.equal(value, session);
    return filter.status.$in.includes(state.payment.status) ? [Payment.hydrate(clone(state.payment))] : [];
  } }));
  t.mock.method(Payment.prototype, "save", async function (config) {
    assert.equal(config.session, session);
    await this.validate();
    pendingPayment = clone(this.toObject());
    return this;
  });
  t.mock.method(HVACProduct, "findOneAndUpdate", async (filter, update, config) => {
    assert.equal(config.session, session);
    state.queries.push({ filter, update });
    if (options.failStock) throw new Error("Stock write failed");
    if (!options.stockExists) return null;
    state.pendingStock += update.$inc["variants.$.quantity"];
    return { _id: parentHvacId };
  });
  t.mock.method(Inventory, "findByIdAndUpdate", async (stockId, update, config) => {
    assert.equal(config.session, session);
    state.queries.push({ stockId, update });
    if (!options.stockExists) return null;
    state.pendingStock += update.$inc.quantity;
    return { _id: stockId };
  });
  t.mock.method(audit, "logEvent", async entry => { assert.equal(state.commits, 1); state.audit.push(entry); });
  t.mock.method(notify, "createNotification", async entry => { assert.equal(state.commits, 1); state.notifications.push(entry); });
  t.mock.method(console, "error", () => {});
  const io = { to: room => ({ emit: (event, payload) => state.events.push({ room, event, payload }) }) };
  const role = options.role || "admin";
  const req = { params: { id }, body: { reason: "Customer requested cancellation" },
    user: { _id: role === "customer" ? userId : staffId, role, name: "Test account" }, app: { get: () => io } };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  return { state, req, response, session };
}

test("removed aircon variant no longer prevents staff cancellation or the verified payment refund queue", async t => {
  for (const role of ["admin", "secretary"]) await t.test(role, async t => {
    const f = fixture(t, { role });
    const res = f.response();
    await handler(f.req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(f.state.order.status, "cancelled");
    assert.equal(f.state.order.refundStatus, "pending");
    assert.equal(f.state.order.refundAmount, 2793);
    assert.equal(f.state.payment.refundStatus, "pending");
    assert.equal(f.state.payment.refundAmount, 2793);
    assert.equal(f.state.payment.status, "partial");
    assert.equal(f.state.order.cancellationStockReview.status, "pending_review");
    assert.equal(f.state.order.cancellationStockReview.items[0].inventoryId, inventoryId);
    assert.equal(f.state.order.cancellationStockReview.items[0].quantity, 1);
    assert.equal(f.state.stockAdded, 0);
    assert.match(res.body.warning, /no stock was added/);
    assert.equal(f.state.notifications[0].role, "admin");
    assert.equal(f.state.notifications[0].type, "resource_issue");
    assert.equal(f.state.notifications[0].link, `/admin/appointments/orders?order=${id}`);
    assert.equal(f.state.audit.length, 1);
    assert.equal(f.state.audit[0].action, "order.status_change");
    assert.equal(f.state.audit[0].details.toStatus, "cancelled");
    assert.equal(f.state.aborts, 0);
    assert.equal(f.state.ends, 1);
    assert.equal(f.state.order.preparation.installation.status, "cancelled");
    assert.ok(f.state.events.some(entry => entry.room === `customer:${userId}` && entry.payload.status === "cancelled"));
    await handler(f.req, f.response());
    assert.equal(f.state.commits, 1);
    assert.equal(f.state.queries.length, 1);
    assert.equal(f.state.payment.events.length, 1);
  });
});

test("existing stock is restored to its exact variant once, with no stock warning", async t => {
  const f = fixture(t, { stockExists: true });
  const res = f.response();
  await handler(f.req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.state.stockAdded, 1);
  assert.equal(String(f.state.queries[0].filter._id), parentHvacId);
  assert.equal(String(f.state.queries[0].filter["variants._id"]), inventoryId);
  assert.equal(f.state.order.cancellationStockReview.status, "completed");
  assert.equal(f.state.order.cancellationStockReview.items.length, 0);
  assert.equal(res.body.warning, undefined);
  assert.equal(f.state.notifications.length, 0);
  const again = f.response();
  await handler(f.req, again);
  assert.equal(again.statusCode, 409);
  assert.equal(f.state.stockAdded, 1);
});

test("missing legacy inventory items are recorded and existing legacy inventory is restored", async t => {
  for (const stockExists of [true, false]) await t.test(String(stockExists), async t => {
    const f = fixture(t, { stockExists, order: { items: [{ ...line, isHvac: false, parentHvacId: null }] } });
    const res = f.response();
    await handler(f.req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(f.state.order.cancellationStockReview.status, stockExists ? "completed" : "pending_review");
    assert.equal(f.state.stockAdded, stockExists ? 1 : 0);
  });
});

test("stock and order database errors still abort the entire cancellation without success notices", async t => {
  for (const option of ["failStock", "failOrderSave"]) await t.test(option, async t => {
    const f = fixture(t, { stockExists: true, [option]: true });
    const res = f.response();
    await handler(f.req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.aborts, 1);
    assert.equal(f.state.ends, 1);
    assert.equal(f.state.order.status, "preparing_unit");
    assert.equal(f.state.payment.refundStatus, "none");
    assert.equal(f.state.stockAdded, 0);
    assert.equal(f.state.audit.length, 0);
    assert.equal(f.state.notifications.length, 0);
  });
});

test("customer cancellation keeps internal stock review details private", async t => {
  const f = fixture(t, { role: "customer" });
  const res = f.response();
  await handler(f.req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refundRequested, true);
  assert.equal(res.body.warning, undefined);
  assert.equal(res.body.order.cancellationStockReview, undefined);
  assert.equal(f.state.order.cancellationStockReview.status, "pending_review");
  assert.equal(Order.schema.path("cancellationStockReview").options.select, false);
});

test("unverified receipts do not become payable refunds when the stock entry is missing", async t => {
  const f = fixture(t, { payment: { status: "pending" }, order: { paymentStatus: "pending" } });
  const res = f.response();
  await handler(f.req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.refundRequested, false);
  assert.equal(f.state.order.refundAmount, 0);
  assert.equal(f.state.payment.refundStatus, "none");
});

test("invalid quantity never adds stock and does not cancel the order", async t => {
  const f = fixture(t, { order: { items: [{ ...line, quantity: -1 }] } });
  const res = f.response();
  await handler(f.req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "ORDER_STOCK_QUANTITY_INVALID");
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.queries.length, 0);
});

test("a missing parent ID records review without guessing another SKU", async () => {
  const fail = async () => assert.fail("No stock query without the original IDs");
  const result = await restoreCancelledOrderStock([{ ...line, parentHvacId: null }],
    { HVACProduct: { findOneAndUpdate: fail }, Inventory: { findByIdAndUpdate: fail } }, {});
  assert.equal(result.status, "pending_review");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].inventoryId, inventoryId);
});

test("mixed orders restore only existing stock lines and record each missing line", async () => {
  const calls = [];
  const result = await restoreCancelledOrderStock([
    line, { ...line, inventoryId: "507f191e810c19729de860ef", isHvac: false, quantity: 2 },
  ], {
    HVACProduct: { async findOneAndUpdate(...args) { calls.push(args); return null; } },
    Inventory: { async findByIdAndUpdate(...args) { calls.push(args); return {}; } },
  }, { testSession: true });
  assert.equal(result.status, "pending_review");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].inventoryId, inventoryId);
  assert.equal(calls[1][1].$inc.quantity, 2);
  assert.equal(calls[1][2].session.testSession, true);
});

test("staff details retain the stock check warning and cancellation acknowledges it", () => {
  const queue = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Appointments/AttentionQueue.ejs"), "utf8");
  const orders = fs.readFileSync(path.join(__dirname, "../public/js/admin-aircon-orders.js"), "utf8");
  assert.match(queue, /result\.value\?\.warning/);
  assert.match(queue, /Stock needs checking/);
  assert.match(orders, /Stock needs checking/);
  assert.match(queue, /escapeHtml\(item\.name\)/);
  assert.match(orders, /esc\(item\.name\)/);
});
