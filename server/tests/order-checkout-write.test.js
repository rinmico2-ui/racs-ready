"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { persistOrderCheckout } = require("../utils/orderCheckoutWrite");

const userId = new mongoose.Types.ObjectId();
const inventoryId = new mongoose.Types.ObjectId();
const cartLineId = new mongoose.Types.ObjectId();
const cartId = new mongoose.Types.ObjectId();

function checkoutFixture({ paymentFails = false, cartChanged = false, unknownTopology = false } = {}) {
  const state = { stock: 5, orders: [], payments: [], cart: [{ _id: cartLineId, inventoryId, quantity: 2 }], sessionCalls: 0 };
  class Order {
    constructor(data) {
      Object.assign(this, data);
      this.total = 2000;
      this.downpaymentAmount = 200;
      this.downpaymentPercentage = 10;
    }
    async save() { if (!state.orders.includes(this)) state.orders.push(this); }
    static async deleteOne(filter) { state.orders = state.orders.filter(order => String(order._id) !== String(filter._id)); }
    static async findOne(filter) { return state.orders.find(order => String(order.userId) === String(filter.userId) && order.checkoutRequestId === filter.checkoutRequestId) || null; }
  }
  class Payment {
    constructor(data) { Object.assign(this, data); this._id = new mongoose.Types.ObjectId(); }
    async save() {
      if (paymentFails) throw new Error("payment write failed");
      state.payments.push(this);
    }
    static async deleteMany(filter) { state.payments = state.payments.filter(payment => String(payment.orderId) !== String(filter.orderId)); }
    static async exists(filter) { return state.payments.some(payment => String(payment._id) === String(filter._id)); }
  }
  const Inventory = {
    async findOneAndUpdate(filter, update) {
      if (state.stock < filter.quantity.$gte) return null;
      state.stock += update.$inc.quantity;
      return { _id: inventoryId };
    },
    async updateOne(_filter, update) { state.stock += update.$inc.quantity; return { matchedCount: 1 }; },
  };
  const AirconCart = {
    findOne() {
      return { select() { return this; }, session() { return this; }, async lean() { return { _id: cartId, items: [...state.cart] }; } };
    },
    async updateOne(filter) {
      if (cartChanged || !filter.$and.every(condition => state.cart.some(item =>
        String(item._id) === String(condition.items.$elemMatch._id)
        && item.quantity === condition.items.$elemMatch.quantity))) return { modifiedCount: 0 };
      state.cart = [];
      return { modifiedCount: 1 };
    },
  };
  const connection = { getClient: () => ({ topology: { description: { servers: new Map([["server", { type: unknownTopology ? "Unknown" : "Standalone" }]]) } } }) };
  const database = {
    Types: mongoose.Types, connection,
    async startSession() {
      state.sessionCalls++;
      return { startTransaction() { throw new Error("Transaction numbers are only allowed on a replica set member or mongos"); }, async abortTransaction() {}, async endSession() {} };
    },
  };
  const args = {
    mongoose: database, Order, Payment, Inventory, HVACProduct: {}, AirconCart,
    orderData: { userId, checkoutRequestId: "checkout-request-123456789", paymentMethod: "cod", paymentChannel: "gcash", gcashProofUrl: "/proof" },
    enrichedItems: [{ inventoryId, quantity: 2, modelLine: "Aircon" }],
    requestedItems: [{ inventoryId, quantity: 2 }], cartItemIds: [String(cartLineId)],
    user: { _id: userId, name: "Customer" }, receiptPresent: true,
  };
  return { state, args };
}

test("standalone checkout creates an order and payment, reserves stock, and removes only selected cart lines", async () => {
  const { state, args } = checkoutFixture();
  const order = await persistOrderCheckout(args);
  assert.equal(state.sessionCalls, 0);
  assert.equal(state.stock, 3);
  assert.equal(state.cart.length, 0);
  assert.equal(state.orders.length, 1);
  assert.equal(state.payments.length, 1);
  assert.equal(order.paymentId.toString(), state.payments[0]._id.toString());
});

test("standalone checkout restores stock and retains cart when payment or cart write fails", async () => {
  for (const failure of [{ paymentFails: true }, { cartChanged: true }]) {
    const { state, args } = checkoutFixture(failure);
    await assert.rejects(persistOrderCheckout(args));
    assert.equal(state.stock, 5);
    assert.equal(state.cart.length, 1);
    assert.equal(state.orders.length, 0);
    assert.equal(state.payments.length, 0);
  }
});

test("standalone checkout leaves the cart and payment untouched when stock is taken first", async () => {
  const { state, args } = checkoutFixture();
  state.stock = 1;
  await assert.rejects(persistOrderCheckout(args), error => error.code === "ORDER_STOCK_RACE_LOST");
  assert.equal(state.stock, 1);
  assert.equal(state.cart.length, 1);
  assert.equal(state.orders.length, 0);
  assert.equal(state.payments.length, 0);
});

test("unknown MongoDB topology falls back after an unsupported transaction without duplicate writes", async () => {
  const { state, args } = checkoutFixture({ unknownTopology: true });
  await persistOrderCheckout(args);
  assert.equal(state.sessionCalls, 1);
  assert.equal(state.orders.length, 1);
  assert.equal(state.payments.length, 1);
  assert.equal(state.stock, 3);
});
