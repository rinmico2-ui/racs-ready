"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Tool = require("../models/Tool");
const WalkInSale = require("../models/WalkInSale");
const ProductReturn = require("../models/ProductReturn");
const audit = require("../utils/audit");
const routes = require("../routes/posRoutes");

const toolId = new mongoose.Types.ObjectId("670000000000000000000001");
const staffId = new mongoose.Types.ObjectId("670000000000000000000002");
const handler = path => routes.stack.find(layer => layer.route?.path === path
  && layer.route.methods.post).route.stack.at(-1).handle;
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const stockRecord = overrides => ({
  _id: toolId, itemName: "Copper pipe", type: "part", inventoryClass: "merchandise",
  active: true, quantity: 5, reservedQuantity: 1, minStockLevel: 3,
  sellingPrice: 100, costPrice: 60, barcode: "POS-REGRESSION", serialNumber: "POS-SERIAL",
  createdAt: {}, updatedAt: {}, ...overrides,
});

function fixture(t, { role = "admin", stock = {}, failSale = false } = {}) {
  const state = { stock: stockRecord(stock), sale: null, commits: 0, aborts: 0, ends: 0, writes: [] };
  let pendingStock;
  let pendingSale;
  const session = new class {
    startTransaction() {}
    inTransaction() { return true; }
    async commitTransaction() {
      state.commits++;
      if (pendingStock) state.stock = pendingStock;
      if (pendingSale) state.sale = pendingSale;
      pendingStock = null;
      pendingSale = null;
    }
    async abortTransaction() { state.aborts++; pendingStock = null; pendingSale = null; }
    async endSession() { state.ends++; }
  }();
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(Tool, "findById", id => ({ session: async value => {
    assert.equal(value, session);
    return String(id) === String(toolId) ? Tool.hydrate({ ...(pendingStock || state.stock) }) : null;
  } }));
  // Use real Mongoose save/validation/hooks; replace only the database write.
  t.mock.method(Tool.collection, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, session);
    state.writes.push(update);
    pendingStock = { ...(pendingStock || state.stock), ...update.$set };
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(WalkInSale, "findOne", () => ({ sort: () => ({ lean: async () => null }) }));
  t.mock.method(WalkInSale.collection, "insertOne", async (record, options) => {
    assert.equal(options.session, session);
    if (failSale) throw new Error("Sale write failed");
    pendingSale = record;
    return { acknowledged: true, insertedId: record._id };
  });
  t.mock.method(WalkInSale, "findById", () => ({
    lean: async () => state.sale,
    session: async value => { assert.equal(value, session); return WalkInSale.hydrate(state.sale); },
  }));
  t.mock.method(WalkInSale.collection, "updateOne", async (_filter, update, options) => {
    assert.equal(options.session, session);
    pendingSale = { ...state.sale, ...update.$set };
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(ProductReturn, "exists", () => ({ session: async () => null }));
  t.mock.method(audit, "logEvent", async () => {});
  t.mock.method(console, "error", () => {});
  const req = {
    user: { _id: staffId, role, name: "POS staff" },
    body: { items: [{ toolId: String(toolId), quantity: 2, source: "tool" }], paymentMethod: "cash", amountPaid: 200 },
  };
  return { state, req };
}

test("admin and secretary checkout repairs legacy dates and commits stock with the receipt", async t => {
  for (const role of ["admin", "secretary"]) await t.test(role, async t => {
    const { state, req } = fixture(t, { role });
    const res = response();
    await handler("/checkout")(req, res);
    assert.equal(res.statusCode, 200, res.body?.error);
    assert.equal(res.body.success, true);
    assert.deepEqual(state.stock.createdAt, toolId.getTimestamp());
    assert.equal(state.writes[0].$set.createdAt instanceof Date, true);
    assert.equal(state.stock.updatedAt instanceof Date, true);
    assert.equal(Number.isFinite(state.stock.updatedAt.getTime()), true);
    assert.equal(state.stock.quantity, 3);
    assert.equal(state.stock.reservedQuantity, 1);
    assert.equal(state.stock.status, "low_stock");
    assert.equal(state.sale.totalAmount, 200);
    assert.equal(state.sale.items[0].quantity, 2);
    assert.equal(String(state.sale.processedBy), String(staffId));
    assert.equal(state.commits, 1);
    assert.equal(state.aborts, 0);
    assert.equal(state.ends, 1);
  });
});

test("checkout preserves valid historical creation dates", async t => {
  const createdAt = new Date("2020-01-02T03:04:05Z");
  const { state, req } = fixture(t, { stock: { createdAt } });
  const res = response();
  await handler("/checkout")(req, res);
  assert.equal(res.statusCode, 200, res.body?.error);
  assert.deepEqual(state.stock.createdAt, createdAt);
  assert.equal(Object.hasOwn(state.writes[0].$set, "createdAt"), false);
});

test("failed receipt writes roll back both stock and legacy timestamp repairs", async t => {
  const { state, req } = fixture(t, { failSale: true });
  const res = response();
  await handler("/checkout")(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Sale write failed");
  assert.equal(state.stock.quantity, 5);
  assert.deepEqual(state.stock.createdAt, {});
  assert.deepEqual(state.stock.updatedAt, {});
  assert.equal(state.sale, null);
  assert.equal(state.commits, 0);
  assert.equal(state.aborts, 1);
  assert.equal(state.ends, 1);
});

test("reserved inventory and operational assets still cannot be sold", async t => {
  for (const stock of [{ reservedQuantity: 4 }, { inventoryClass: "operational_asset" }]) {
    await t.test(JSON.stringify(stock), async t => {
      const { state, req } = fixture(t, { stock });
      const res = response();
      await handler("/checkout")(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /Insufficient stock|operational asset/);
      assert.equal(state.writes.length, 0);
      assert.equal(state.commits, 0);
      assert.equal(state.aborts, 1);
    });
  }
});

test("voiding a receipt repairs legacy dates while restoring stock for either staff role", async t => {
  for (const role of ["admin", "secretary"]) await t.test(role, async t => {
    const { state, req } = fixture(t, { role });
    const checkout = response();
    await handler("/checkout")(req, checkout);
    assert.equal(checkout.statusCode, 200, checkout.body?.error);
    state.stock.createdAt = {};
    state.stock.updatedAt = {};
    req.params = { id: String(state.sale._id) };
    req.body = { reason: "Customer cancelled" };
    const res = response();
    await handler("/sales/:id/void")(req, res);
    assert.equal(res.statusCode, 200, res.body?.error);
    assert.equal(state.stock.quantity, 5);
    assert.deepEqual(state.stock.createdAt, toolId.getTimestamp());
    assert.equal(state.stock.updatedAt instanceof Date, true);
    assert.equal(state.stock.status, "in_stock");
    assert.equal(state.sale.status, "voided");
    assert.equal(state.commits, 2);
    assert.equal(state.aborts, 0);
  });
});

test("legacy date recovery does not bypass new-record or quantity validation", async () => {
  await assert.rejects(new Tool(stockRecord()).validate(), error => Boolean(error.errors.createdAt && error.errors.updatedAt));
  const existing = Tool.hydrate(stockRecord());
  existing.quantity = -1;
  await assert.rejects(existing.validate(), error => Boolean(error.errors.quantity));
});

test("validation preserves valid timestamps and repairs each malformed legacy timestamp independently", async () => {
  const createdAt = new Date("2020-01-02T03:04:05Z"), updatedAt = new Date("2025-06-07T08:09:10Z");
  const valid = Tool.hydrate(stockRecord({ createdAt, updatedAt }));
  await valid.validate();
  assert.deepEqual(valid.createdAt, createdAt); assert.deepEqual(valid.updatedAt, updatedAt);
  assert.equal(valid.isModified('createdAt'), false); assert.equal(valid.isModified('updatedAt'), false);
  for (const fields of [{ createdAt:{}, updatedAt }, { createdAt, updatedAt:{} }, { createdAt:{}, updatedAt:{} }]) {
    const before = Date.now(), legacy = Tool.hydrate(stockRecord(fields));
    await legacy.validate();
    assert.deepEqual(legacy.createdAt, fields.createdAt instanceof Date ? createdAt : toolId.getTimestamp());
    if (fields.updatedAt instanceof Date) assert.deepEqual(legacy.updatedAt, updatedAt);
    else assert.ok(legacy.updatedAt instanceof Date && legacy.updatedAt.getTime() >= before && legacy.updatedAt.getTime() <= Date.now());
  }
});
