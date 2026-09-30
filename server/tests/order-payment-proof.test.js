"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable, PassThrough } = require("node:stream");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const storage = require("../utils/paymentProofStorage");
const orders = require("../routes/orderRoutes");
const route = orders.stack.find(layer => layer.route?.path === "/:id/payment-proof").route;
const handler = route.stack.at(-1).handle;
const id = "507f1f77bcf86cd799439011";
function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, set(headers) { Object.assign(this.headers, headers); return this; } };
}
function mockOrder(t, value) {
  t.mock.method(Order, "findById", requestedId => {
    assert.equal(requestedId, id);
    return { select(fields) { assert.equal(fields, "_id gcashProofFileId"); return this; },
      maxTimeMS() { return this; }, lean: async () => value };
  });
}

test("persistent order receipts are streamed privately with their original image MIME", async t => {
  const fileId = new mongoose.Types.ObjectId();
  mockOrder(t, { _id: id, gcashProofFileId: fileId });
  t.mock.method(storage, "findPaymentProof", async requested => {
    assert.equal(requested, fileId); return { contentType: "image/png", length: 123 };
  });
  const stream = new PassThrough();
  let destination;
  stream.pipe = res => { destination = res; return res; };
  t.mock.method(storage, "openPaymentProofDownload", requested => { assert.equal(requested, fileId); return stream; });
  const res = response();
  await handler({ params: { id } }, res, error => { throw error; });
  assert.equal(destination, res);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.equal(res.headers["Content-Length"], "123");
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("order receipt reads reject malformed IDs before querying storage", async t => {
  t.mock.method(Order, "findById", () => { throw new Error("Must not query"); });
  const res = response();
  await handler({ params: { id: "invalid" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
});

test("missing orders, legacy local receipts and missing stored bytes return 404", async t => {
  for (const value of [null, { _id: id }, { _id: id, gcashProofFileId: new mongoose.Types.ObjectId() }]) {
    mockOrder(t, value);
    t.mock.method(storage, "findPaymentProof", async () => null);
    const res = response();
    await handler({ params: { id } }, res, error => { throw error; });
    assert.equal(res.statusCode, 404);
    t.mock.restoreAll();
  }
});

test("order receipt role guard allows staff and denies customers and technicians", () => {
  const guard = route.stack[1].handle;
  for (const role of ["admin", "secretary", "customer", "technician"]) {
    const res = response(); let allowed = false;
    guard({ user: { role } }, res, () => { allowed = true; });
    assert.equal(allowed, ["admin", "secretary"].includes(role));
    if (!allowed) assert.equal(res.statusCode, 403);
  }
});

test("receipt upload stores bytes and order metadata before removing its temporary file", async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "racs-order-proof-test-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "receipt.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  fs.writeFileSync(filePath, bytes);
  const uploadedId = new mongoose.Types.ObjectId();
  const chunks = [];
  let savedOptions;
  const originalDatabase = mongoose.connection.db;
  mongoose.connection.db = {};
  t.after(() => { mongoose.connection.db = originalDatabase; });
  t.mock.getter(mongoose.mongo, "GridFSBucket", () => function () {
    return { openUploadStream(filename, options) {
      savedOptions = options;
      const upload = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
      upload.id = uploadedId;
      return upload;
    } };
  });
  const result = await storage.storePaymentProof({ path: filePath, mimetype: "image/png", originalname: "receipt.png" }, { orderId: id, uploadedBy: "customer" });
  assert.equal(result.fileId, uploadedId);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(savedOptions.metadata.orderId, id);
  assert.equal(savedOptions.metadata.uploadedBy, "customer");
  assert.equal(fs.existsSync(filePath), false);
});
