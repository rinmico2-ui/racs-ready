"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { Readable } = require("node:stream");
const express = require("express");
const mongoose = require("mongoose");
const paymentPolicy = require("../utils/paymentPolicy");
const checkoutPolicy = require("../utils/orderCheckoutPolicy");

// A real multipart HTTP upload and real order route, with isolated records
// and storage. No production credentials, DB writes, emails, or stock changes.
test("customer delivery receipt upload survives temporary-file removal and reaches the admin image endpoint byte-for-byte", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "racs-receipt-flow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = new Map();
  const payments = [];
  const storedFiles = new Map();
  const cart = { _id: '507f1f77bcf86cd799439051', items: [
    { _id: '507f1f77bcf86cd799439041', inventoryId: '507f1f77bcf86cd799439021', quantity: 1 },
    { _id: '507f1f77bcf86cd799439042', inventoryId: '507f1f77bcf86cd799439022', quantity: 2 },
  ] };
  let pendingCartItems = cart.items;
  let stockRace = false;
  const uploadedBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=", "base64");
  let temporaryPath, committed = false;
  class Order {
    constructor(data) { Object.assign(this, data); this._id ||= new mongoose.Types.ObjectId(); }
    async save() {
      this.total = this.items.reduce((sum, item) => sum + item.totalPrice, 0) + this.transportationFee;
      this.orderReference = "ORD-TEST-RECEIPT";
      records.set(String(this._id), this);
    }
    toObject() { return { ...this }; }
    static async findOne(filter) { return Array.from(records.values()).find(order => order.checkoutRequestId === filter.checkoutRequestId && String(order.userId) === String(filter.userId)) || null; }
    static findById(id) {
      return { select() { return this; }, maxTimeMS() { return this; }, lean: async () => records.get(String(id)) || null };
    }
  }
  class Payment {
    constructor(data) { Object.assign(this, data); this._id = new mongoose.Types.ObjectId(); }
    async save() { payments.push(this); }
  }
  const inventory = {
    findById: id => ({ populate() { return this; }, lean: async () => ({ _id: id, active: true,
      quantity: 10, status: "in_stock", modelLine: "Test aircon", sellingPrice: 1000, brand: { name: "Test" } }) }),
    findOneAndUpdate: async () => stockRace ? null : ({ quantity: 9 }),
  };
  const storage = {
    async storePaymentProof(file, metadata) {
      temporaryPath = file.path;
      assert.equal(file.mimetype, "image/png");
      const bytes = fs.readFileSync(file.path);
      assert.deepEqual(bytes, uploadedBytes);
      assert.ok(metadata.orderId);
      const fileId = new mongoose.Types.ObjectId();
      storedFiles.set(String(fileId), { bytes, contentType: file.mimetype });
      fs.unlinkSync(file.path);
      return { fileId };
    },
    deletePaymentProof: async id => storedFiles.delete(String(id)),
    findPaymentProof: async id => {
      const file = storedFiles.get(String(id));
      return file ? { contentType: file.contentType, length: file.bytes.length } : null;
    },
    openPaymentProofDownload: id => Readable.from([storedFiles.get(String(id)).bytes]),
  };
  const session = { startTransaction() { pendingCartItems = cart.items.slice(); }, async commitTransaction() { committed = true; cart.items = pendingCartItems; }, async abortTransaction() { pendingCartItems = cart.items; }, async endSession() {} };
  const cartModel = {
    findOne(filter) {
      assert.equal(String(filter.userId), '507f1f77bcf86cd799439031');
      return { select() { return this; }, session(transaction) { assert.equal(transaction, session); return this; }, lean: async () => cart };
    },
    async updateOne(filter, update, options) {
      assert.equal(filter._id, cart._id);
      assert.equal(String(filter.userId), '507f1f77bcf86cd799439031');
      assert.equal(options.session, session);
      const ids = update.$pull.items._id.$in.map(String);
      pendingCartItems = pendingCartItems.filter(item => !ids.includes(item._id));
      return { modifiedCount: 1 };
    },
  };
  const overrides = {
    mongoose: new Proxy(mongoose, { get(target, key) { return key === "startSession" ? async () => session : Reflect.get(target, key); } }),
    path: { ...path, join(...parts) { return parts[1] === "../public/uploads/gcash-receipts" ? directory : path.join(...parts); } },
    "../models/Order": Order, "../models/Payment": Payment, "../models/Inventory": inventory,
    "../models/AirconCart": cartModel,
    "../utils/paymentProofStorage": storage,
    "../middleware/authenticate": {
      authenticate(req, res, next) {
        req.user = { _id: "507f1f77bcf86cd799439031", role: req.headers["x-test-role"] || "customer" };
        next();
      },
      requireRole: require("../middleware/authenticate").requireRole,
    },
    "../utils/paymentPolicy": { ...paymentPolicy, getDownpaymentPercentage: async () => 30,
      getGcashRecipientNumber: async () => "09171234567", getPaymentMethods: async () => ({ gcash: { available: true } }) },
    "../utils/orderCheckoutSettings": { getOrderCheckoutSettings: async () => ({ farePerKm: 10,
      companyLocation: { lat: 15, lng: 120 }, storeHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, open: true, startMinutes: 480, endMinutes: 1080 })) }) },
    "../utils/orderCheckoutPolicy": { ...checkoutPolicy, authoritativeDeliveryQuote: async () => ({ distanceKm: 2, durationMin: 5, transportationFee: 20 }) },
    "../utils/enterpriseSchedulingEngine": { isLargeProject: async () => false },
    "../utils/operationLock": { bookingCapacityLockKey: date => `booking-capacity:${String(date).slice(0, 10)}`, withOperationLock: async (_key, work) => work() },
    "./scheduleRoutes": { getTimeSlotsForQuery: async () => ({ statusCode: 200, payload: { timeSlots: [{ startTime: "09:00 AM" }] } }) },
  };
  const routePath = path.join(__dirname, "../routes/orderRoutes.js");
  const nativeRequire = createRequire(routePath);
  const routeModule = { exports: {} };
  const wrapper = vm.runInThisContext("(function(require,module,exports,__dirname){" + fs.readFileSync(routePath, "utf8") + "\n})", { filename: routePath });
  wrapper(name => overrides[name] || nativeRequire(name), routeModule, routeModule.exports, path.dirname(routePath));
  const app = express(); app.use("/api/orders", routeModule.exports);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const body = new FormData();
  body.append("items", JSON.stringify([{ inventoryId: "507f1f77bcf86cd799439021", quantity: 1 }]));
  body.append("cartItemIds", JSON.stringify(['507f1f77bcf86cd799439041']));
  body.append("fulfillmentType", "delivery_installation");
  body.append("paymentMethod", "cod");
  body.append("paymentChannel", "gcash");
  body.append("paymentReference", "09171234567");
  body.append("gcashNumber", "09171234567");
  body.append("checkoutRequestId", "receipt-flow-test-0001");
  body.append("timeSlot", "09:00 AM");
  body.append("delivery", JSON.stringify({ address: "Test delivery address", contactNumber: "09171234567", preferredDate: tomorrow, coordinates: { lat: 15, lng: 120 } }));
  body.append("gcashProof", new Blob([uploadedBytes], { type: "image/png" }), "receipt.png");
  const created = await fetch(base + "/api/orders", { method: "POST", body });
  const data = await created.json();
  assert.equal(created.status, 201, JSON.stringify(data));
  assert.equal(committed, true);
  assert.deepEqual(cart.items.map(item => item._id), ['507f1f77bcf86cd799439042'], 'unselected cart line must remain after successful checkout');
  assert.equal(fs.existsSync(temporaryPath), false);
  const order = data.order;
  assert.equal(order.gcashProofUrl, "/api/orders/" + order._id + "/payment-proof");
  assert.equal(payments[0].proofUrl, order.gcashProofUrl);
  assert.equal(String(payments[0].orderId), order._id);
  const photos = await fetch(base + "/api/orders/" + order._id + "/photos", { headers: { "x-test-role": "admin" } });
  const gallery = await photos.json();
  assert.equal(photos.status, 200);
  assert.deepEqual(gallery.photos, [{ label: "Payment receipt", src: order.gcashProofUrl }]);
  const photo = await fetch(base + gallery.photos[0].src, { headers: { "x-test-role": "admin" } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.match(photo.headers.get("cache-control"), /private/);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), uploadedBytes);
  // Retrying a successful request must not remove new or remaining items.
  const duplicate = await fetch(base + '/api/orders', { method: 'POST', body });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(cart.items.length, 1);
  assert.equal(storedFiles.size, 1);
  // A failure after the selected lines are pulled must roll the cart back.
  stockRace = true;
  committed = false;
  const failedBody = new FormData();
  for (const [key, value] of body.entries()) failedBody.append(key, value);
  failedBody.set('items', JSON.stringify([{ inventoryId: '507f1f77bcf86cd799439022', quantity: 2 }]));
  failedBody.set('cartItemIds', JSON.stringify(['507f1f77bcf86cd799439042']));
  failedBody.set('checkoutRequestId', 'receipt-flow-test-0002');
  t.mock.method(console, 'error', () => {});
  const failed = await fetch(base + '/api/orders', { method: 'POST', body: failedBody });
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).code, 'ORDER_STOCK_RACE_LOST');
  assert.equal(committed, false);
  assert.equal(cart.items.length, 1, 'failed order must not empty the cart');
  assert.equal(records.size, 1);
  assert.equal(storedFiles.size, 1);
});
