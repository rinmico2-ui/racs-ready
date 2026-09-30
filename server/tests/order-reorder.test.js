"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const mongoose = require("mongoose");
const { reorderItems, reorderCartUpdate, reorderCancelledOrder } = require("../utils/orderReorder");

const id = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const a = "507f1f77bcf86cd799439021";
const b = "507f1f77bcf86cd799439022";
const c = "507f1f77bcf86cd799439023";
const objectId = value => new mongoose.Types.ObjectId(value);
const cancelled = (items = [{ inventoryId: a, quantity: 2 }]) => ({ status: "cancelled", items });
const query = value => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
const stock = (_id = a, overrides = {}) => ({ _id, quantity: 10, status: "in_stock", active: true, sellingPrice: 12000, ...overrides });

function models(order = cancelled(), inventory = [stock()], products = []) {
  const writes = [];
  const reads = [];
  return {
    reads, writes,
    Order: { findOne(filter) { reads.push(["order", filter]); return query(order); } },
    Inventory: { find(filter) { reads.push(["inventory", filter]); return query(inventory); } },
    HVACProduct: { find(filter) { reads.push(["hvac", filter]); return query(products); } },
    AirconCart: { collection: { async updateOne(...args) { writes.push(args); return { matchedCount: 1 }; } } },
  };
}
const run = model => reorderCancelledOrder({ orderId: id, userId }, model);

test("reorder accepts only cancelled orders and combines duplicate product quantities", () => {
  const result = reorderItems(cancelled([{ inventoryId: a, quantity: 2 }, { inventoryId: a, quantity: 1 }]));
  assert.equal(result.length, 1);
  assert.equal(String(result[0].inventoryId), a);
  assert.equal(result[0].quantity, 3);
  for (const status of ["pending_payment", "completed", "preparing_unit"]) {
    assert.throws(() => reorderItems({ ...cancelled(), status }), error => error.status === 409);
  }
});

test("malformed historical items cannot be restored", () => {
  for (const items of [[], Array(51).fill({ inventoryId: a, quantity: 1 }), [{ inventoryId: "bad", quantity: 1 }],
    ...[0, -1, 1.5, NaN, Infinity].map(quantity => [{ inventoryId: a, quantity }])]) {
    assert.throws(() => reorderItems(cancelled(items)), error => error.status === 409);
  }
});

test("invalid IDs and missing/other-owner orders do not read stock or write carts", async () => {
  const model = models(null);
  await assert.rejects(reorderCancelledOrder({ orderId: "invalid", userId }, model), error => error.status === 400);
  assert.equal(model.reads.length, 0);
  await assert.rejects(run(model), error => error.status === 404);
  assert.deepEqual(model.reads, [["order", { _id: id, userId }]]);
  assert.equal(model.writes.length, 0);
});

test("active orders are rejected before stock queries or cart writes", async () => {
  const model = models({ ...cancelled(), status: "completed" });
  await assert.rejects(run(model), error => error.code === "REORDER_STATUS");
  assert.equal(model.reads.length, 1);
  assert.equal(model.writes.length, 0);
});

test("availability is checked in two batched catalog queries, not from old order prices", async () => {
  const model = models(cancelled([{ inventoryId: a, quantity: 2, unitPrice: 100 }, { inventoryId: b, quantity: 3 }]),
    [stock()], [{ modelLine: "New model", variants: [stock(b)] }]);
  const result = await run(model);
  assert.match(result.message, /current prices/);
  assert.equal(model.reads.length, 3);
  assert.deepEqual(model.reads[2][1].active, { $ne: false });
  assert.deepEqual(model.reads[1][1]._id.$in.map(String), [a, b]);
  assert.equal(model.writes.length, 1);
  const [filter, pipeline, options] = model.writes[0];
  assert.equal(String(filter.userId), userId);
  assert.equal(options.upsert, true);
  for (const line of pipeline[0].$set.items.$reduce.input.$literal) {
    assert.equal(line.unitPrice, undefined);
    assert.equal(line.paymentStatus, undefined);
    assert.ok(line._id instanceof mongoose.Types.ObjectId);
  }
});

test("missing, inactive, blocked, understocked and unpriced products leave the whole cart unchanged", async () => {
  const cases = [null, stock(b, { active: false }), stock(b, { quantity: 1 }), stock(b, { sellingPrice: null }),
    stock(b, { sellingPrice: -1 }), ...["out_of_stock", "discontinued", "coming_soon"].map(status => stock(b, { status }))];
  for (const unavailable of cases) {
    const model = models(cancelled([{ inventoryId: a, quantity: 1 }, { inventoryId: b, quantity: 2 }]),
      [stock(), ...(unavailable ? [unavailable] : [])]);
    await assert.rejects(run(model), error => error.status === 409 && error.code === "REORDER_UNAVAILABLE");
    assert.equal(model.writes.length, 0);
  }
});

test("an inactive HVAC variant is rejected, and missing/archived parents cannot restore a variant", async () => {
  for (const products of [[], [{ modelLine: "Hidden variant", variants: [stock(a, { active: false })] }]]) {
    const model = models(cancelled(), [], products);
    await assert.rejects(run(model), error => error.status === 409);
    assert.equal(model.writes.length, 0);
  }
});

// Evaluate only the aggregation operators used by this pipeline, using ObjectId
// equality. This is a unit-level semantics check, not a live MongoDB test.
function field(value, parts) {
  if (!parts.length) return value;
  if (Array.isArray(value)) return value.map(item => field(item, parts));
  return field(value?.[parts[0]], parts.slice(1));
}
const equal = (x, y) => x instanceof mongoose.Types.ObjectId ? String(x) === String(y) : x === y;
function evaluate(expression, document, variables = {}) {
  if (typeof expression === "string" && expression.startsWith("$")) {
    const variable = expression.startsWith("$$");
    const parts = expression.slice(variable ? 2 : 1).split(".");
    return variable ? field(variables[parts.shift()], parts) : field(document, parts);
  }
  if (Array.isArray(expression)) return expression.map(item => evaluate(item, document, variables));
  if (!expression || typeof expression !== "object" || expression instanceof Date || expression instanceof mongoose.Types.ObjectId) return expression;
  const ev = value => evaluate(value, document, variables);
  if ("$literal" in expression) return expression.$literal;
  if (expression.$ifNull) return ev(expression.$ifNull[0]) ?? ev(expression.$ifNull[1]);
  if (expression.$reduce) {
    const { input, initialValue, in: body } = expression.$reduce;
    return ev(input).reduce((value, item) => evaluate(body, document, { ...variables, value, this: item }), ev(initialValue));
  }
  if (expression.$cond) return ev(expression.$cond[0]) ? ev(expression.$cond[1]) : ev(expression.$cond[2]);
  if (expression.$in) { const [value, array] = ev(expression.$in); return array.some(item => equal(value, item)); }
  if (expression.$eq) { const [x, y] = ev(expression.$eq); return equal(x, y); }
  if (expression.$map) {
    const { input, as, in: body } = expression.$map;
    return ev(input).map(item => evaluate(body, document, { ...variables, [as]: item }));
  }
  if (expression.$mergeObjects) return Object.assign({}, ...ev(expression.$mergeObjects));
  if (expression.$max) return Math.max(...ev(expression.$max));
  if (expression.$concatArrays) return ev(expression.$concatArrays).flat();
  return Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, ev(value)]));
}

test("atomic merge preserves other products, line IDs and selections; retries do not add quantities", async () => {
  const existingId = objectId();
  const original = { items: [{ _id: existingId, inventoryId: objectId(a), quantity: 1 },
    { _id: objectId(), inventoryId: objectId(c), quantity: 4 }], createdAt: new Date("2026-09-01"), __v: 3 };
  const update = reorderCartUpdate(userId, reorderItems(cancelled([{ inventoryId: a, quantity: 2 }, { inventoryId: b, quantity: 3 }])));
  const first = evaluate(update[0].$set, original);
  assert.deepEqual(first.items.map(item => [String(item.inventoryId), item.quantity]), [[a, 2], [c, 4], [b, 3]]);
  assert.equal(first.items[0]._id, existingId);
  assert.equal(first.createdAt, original.createdAt);
  assert.equal(first.__v, 3);
  assert.deepEqual(evaluate(update[0].$set, first).items, first.items);
  first.items[0].quantity = 5;
  assert.equal(evaluate(update[0].$set, first).items[0].quantity, 5);
  const fresh = evaluate(update[0].$set, {});
  assert.deepEqual(fresh.items.map(item => item.quantity), [2, 3]);
  assert.equal(fresh.__v, 0);
  const cart = new (require("../models/AirconCart"))(fresh);
  await cart.validate();
});

test("a concurrent first cart insert retries without upsert; other database errors propagate", async () => {
  const model = models();
  let calls = 0;
  model.AirconCart.collection.updateOne = async (_filter, _update, options) => {
    if (++calls === 1) { assert.equal(options.upsert, true); throw Object.assign(new Error("duplicate"), { code: 11000 }); }
    assert.equal(options, undefined); return { matchedCount: 1 };
  };
  await run(model);
  assert.equal(calls, 2);
  model.AirconCart.collection.updateOne = async () => { throw new Error("database unavailable"); };
  await assert.rejects(run(model), /database unavailable/);
});

test("the API is customer-only, rejects invalid IDs and hides unexpected database errors", async t => {
  const router = require("../routes/orderRoutes");
  const route = router.stack.find(layer => layer.route?.path === "/:id/reorder").route;
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  for (const role of ["customer", "admin", "secretary", "technician"]) {
    let allowed = false; const res = response();
    route.stack[1].handle({ user: { role } }, res, () => { allowed = true; });
    assert.equal(allowed, role === "customer");
  }
  const handler = route.stack.at(-1).handle;
  const res = response();
  await handler({ params: { id: "bad" }, user: { _id: userId } }, res);
  assert.equal(res.statusCode, 400);
  t.mock.method(require("../models/Order"), "findOne", () => { throw new Error("secret connection string"); });
  const failure = response();
  await handler({ params: { id }, user: { _id: userId } }, failure);
  assert.equal(failure.statusCode, 500);
  assert.doesNotMatch(failure.body.error, /secret/);
});

test("the mounted reorder API requires login, scopes ownership and merges only after valid stock checks", async t => {
  const express = require("express");
  const Order = require("../models/Order");
  const Inventory = require("../models/Inventory");
  const HVACProduct = require("../models/HVACProduct");
  const AirconCart = require("../models/AirconCart");
  let authenticated = false;
  let owned = false;
  let writes = 0;
  const app = express();
  app.use((req, _res, next) => {
    // Isolated test session; no real users or authentication tokens are used.
    req.authResolved = true;
    req.user = authenticated ? { _id: objectId(userId), role: "customer" } : null;
    next();
  });
  app.use("/api/orders", require("../routes/orderRoutes"));
  t.mock.method(Order, "findOne", filter => {
    assert.equal(String(filter.userId), userId);
    assert.equal(String(filter._id), id);
    return query(owned ? cancelled() : null);
  });
  t.mock.method(Inventory, "find", () => query([stock()]));
  t.mock.method(HVACProduct, "find", () => query([]));
  t.mock.method(AirconCart.collection, "updateOne", async () => { writes++; return { matchedCount: 1 }; });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/orders/${id}/reorder`;
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal(writes, 0);
  authenticated = true;
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
  assert.equal(writes, 0);
  owned = true;
  const response = await fetch(url, { method: "POST" });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /Review current prices/);
  assert.equal(writes, 1);
});

test("history and detail pages show Reorder only for cancelled orders with products", async () => {
  for (const template of ["my-orders", "order-details"]) {
    for (const status of ["cancelled", "completed", "pending_payment"]) {
      const order = { _id: id, orderReference: "ORD-TEST", status, createdAt: new Date(), items: [{ inventoryId: a, quantity: 2 }],
        fulfillmentType: "customer_pickup", customer: {}, delivery: {}, statusHistory: [], total: 0 };
      const html = await ejs.renderFile(path.join(__dirname, `../views/pages/${template}.ejs`), { order, orders: [order] });
      assert.equal(html.includes(`data-order-reorder="${id}"`), status === "cancelled");
      assert.match(html, /customer-order-reorder\.js\?v=/);
      for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    }
  }
});

function browserFixture({ confirmed = true, response = { ok: true, body: {} }, reject } = {}) {
  const button = { innerHTML: "Reorder", disabled: false, dataset: { orderReorder: id }, addEventListener(_event, handler) { this.click = handler; } };
  const requests = [], redirects = [], alerts = [];
  let ready;
  const window = { confirm: () => confirmed, alert: message => alerts.push(message), location: { assign: value => redirects.push(value) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/customer-order-reorder.js"), "utf8"), {
    document: { addEventListener(_event, handler) { ready = handler; }, querySelectorAll: () => [button] }, window,
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push([url, options]); if (reject) throw reject; return { ok: response.ok, json: async () => response.body }; },
  });
  ready();
  return { button, requests, redirects, alerts, window };
}

test("reorder UI requires confirmation, blocks duplicate clicks and redirects only after success", async () => {
  const cancelledClick = browserFixture({ confirmed: false });
  await cancelledClick.button.click();
  assert.equal(cancelledClick.requests.length, 0);
  assert.equal(cancelledClick.button.disabled, false);
  const f = browserFixture();
  const pending = f.button.click();
  await f.button.click();
  await pending;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][0], `/api/orders/${id}/reorder`);
  assert.equal(f.requests[0][1].method, "POST");
  assert.equal(f.requests[0][1].credentials, "same-origin");
  assert.deepEqual(f.redirects, ["/aircon-cart"]);
});

test("reorder errors stay on history, display safe text and allow retry", async () => {
  for (const options of [{ response: { ok: false, body: { error: "Stock unavailable <img>" } } },
    { reject: Object.assign(new Error("timeout"), { name: "AbortError" }) }]) {
    const f = browserFixture(options);
    await f.button.click();
    assert.equal(f.redirects.length, 0);
    assert.equal(f.alerts.length, 1);
    assert.equal(f.button.innerHTML, "Reorder");
    assert.equal(f.button.disabled, false);
    await f.button.click();
    assert.equal(f.requests.length, 2);
  }
});
