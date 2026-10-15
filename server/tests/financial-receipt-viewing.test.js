"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough, Readable } = require("node:stream");
const storage = require("../utils/financialReceiptStorage");
const receipts = require("../routes/receiptRoutes");
const { paginateResolutionCases } = require("../utils/resolutionCenter");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("resolution pages are capped at ten even when a larger page size is requested", () => {
  const cases = Array.from({ length: 27 }, (_, id) => ({ id }));
  for (const size of [undefined, "25", "100", "1"]) {
    const result = paginateResolutionCases(cases, "2", size);
    assert.equal(result.cases.length, 10);
    assert.deepEqual(result.cases.map(row => row.id), [10,11,12,13,14,15,16,17,18,19]);
    assert.equal(result.pagination.pages, 3);
  }
});

test("project customer-payment view resolves stored booking proofs, legacy project proofs and payment ledger receipts", () => {
  const source = read("views/pages/admin/Projects/ProjectDetail.ejs");
  const start = source.indexOf("  function customerPayment(data)");
  const end = source.indexOf("\n  function fmtDate", start);
  const payment = vm.runInNewContext(source.slice(start, end) + "\ncustomerPayment;");
  assert.equal(payment({ booking: { _id: "booking", paymentProofFileId: "saved", amountPaid: 100, paymentStatus: "partial" } }).proofUrl, "/api/appointments/booking/payment-proof");
  assert.equal(payment({ project: { payment: { proofUrl: "/uploads/project-payment-proofs/saved.png", amountPaid: 700 } } }).amountPaid, 700);
  assert.equal(payment({ project: { payment: { proofUrl: "/uploads/project-payment-proofs/saved.png" } } }).proofUrl, "/uploads/project-payment-proofs/saved.png");
  assert.equal(payment({ payments: [{ proofUrl: "data:image/png;base64,YQ==" }] }).proofUrl, "data:image/png;base64,YQ==");
  const view = source.slice(source.indexOf("  // Payment viewing never changes"), source.indexOf("  window.verifyProjectSubmittedPayment"));
  assert.doesNotMatch(view, /type="file"|savePayBtn|upload-payment-proof|method:\s*['"](?:PUT|POST)['"]/);
  assert.match(view, /evidenceViewer\.show/);
});

test("legacy project snapshot-edit endpoint refuses writes before reading or saving financial records", async () => {
  const source = read("routes/projectRoutes.js");
  const start = source.indexOf('router.put("/projects/:id/payment"');
  const end = source.indexOf('\n});', start);
  const body = source.slice(start, end + 4);
  let handler;
  vm.runInNewContext(body, { router: { put(_path, _guard, fn) { handler = fn; } }, auth: { requireRole() { return () => {}; } } });
  let status, output;
  handler({ user: { role: "admin" }, body: { proofUrl: "replacement", amountPaid: 9999 } }, { status(value) { status = value; return this; }, json(value) { output = value; } });
  assert.equal(status, 409);
  assert.equal(output.code, "PAYMENT_LEDGER_REQUIRED");
  assert.match(source, /upload-payment-proof", auth\.authenticate, auth\.requireRole\("technician"\)/);
});

test("durable receipts validate image/PDF bytes and keep the owner alongside MongoDB storage", async () => {
  const image = { buffer: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), mimetype: "image/png", originalname: "receipt.png" };
  assert.equal(storage.receiptType(image), "image/png");
  assert.equal(storage.receiptType({ buffer: Buffer.from("%PDF-1.7"), mimetype: "application/pdf" }), "application/pdf");
  assert.throws(() => storage.receiptType({ ...image, mimetype: "image/jpeg" }), /valid JPG/);
  assert.throws(() => storage.receiptType({ buffer: Buffer.from("<html>"), mimetype: "application/pdf" }), /valid JPG/);
  assert.throws(() => storage.receiptType({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: "image/png" }), /5 MB/);
  let metadata, stored = [];
  const bucket = { openUploadStream(_filename, options) {
    metadata = options;
    const stream = new PassThrough(); stream.id = "stored-id";
    stream.on("data", chunk => stored.push(chunk));
    return stream;
  } };
  const result = await storage.storeFinancialReceipt(image, "technician-user", { bucket });
  assert.equal(result.url, "/api/receipts/stored-id");
  assert.equal(metadata.metadata.uploadedBy, "technician-user");
  assert.equal(metadata.metadata.contentType, 'image/png');
  assert.deepEqual(Buffer.concat(stored), image.buffer);
});

test("receipt delivery permits the owner and staff but denies another technician before streaming", async () => {
  const find = storage.findFinancialReceipt, download = storage.downloadFinancialReceipt;
  const handler = receipts.stack.find(layer => layer.route?.path === "/:id").route.stack.at(-1).handle;
  let downloads = 0;
  storage.findFinancialReceipt = async () => ({ metadata: { uploadedBy: "owner" }, contentType: "application/pdf", length: 8 });
  storage.downloadFinancialReceipt = () => { downloads++; return { on() {}, pipe() {}, destroy() {} }; };
  try {
    for (const user of [{ _id: "owner", role: "technician" }, { _id: "other", role: "technician" }, { _id: "admin", role: "admin" }, { _id: "staff", role: "secretary" }]) {
      const res = { code: 200, headers: {}, status(value) { this.code = value; return this; }, json(value) { this.body = value; }, setHeader(name, value) { this.headers[name] = value; }, on() {} };
      await handler({ params: { id: "receipt" }, user }, res, error => { throw error; });
      if (user._id === "other") assert.equal(res.code, 403);
      else { assert.equal(res.code, 200); assert.equal(res.headers["Content-Type"], "application/pdf"); assert.equal(res.headers["Cache-Control"], "private, no-store"); }
    }
    assert.equal(downloads, 3);
  } finally { storage.findFinancialReceipt = find; storage.downloadFinancialReceipt = download; }
});

class Element {
  constructor() { this.children = []; this.events = {}; this.style = {}; this.attributes = {}; }
  appendChild(child) { this.children.push(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
}
function viewer(contentType = "image/png", ok = true, status = ok ? 200 : 404) {
  const requests = [], revoked = [];
  class ViewerUrl extends URL {
    static createObjectURL() { return "blob:receipt"; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  const window = { location: { href: "http://localhost:5000/admin/projects", origin: "http://localhost:5000" } };
  vm.runInNewContext(read("public/js/evidence-viewer.js"), {
    window, URL: ViewerUrl, AbortController, setTimeout, clearTimeout,
    document: { createElement(tag) { const el = new Element(); el.tagName = tag; return el; } },
    async fetch(url, options) { requests.push({ url, options }); return { ok, status, async blob() { return { type: contentType }; } }; },
  });
  return { api: window.evidenceViewer, requests, revoked, container: new Element() };
}

test("receipt viewer renders authenticated photos and PDFs and releases preview files", async () => {
  for (const [type, tag] of [["image/png", "img"], ["application/pdf", "iframe"]]) {
    const feed = viewer(type);
    await feed.api.show(feed.container, "/api/receipts/saved");
    assert.equal(feed.requests[0].options.credentials, "same-origin");
    assert.equal(feed.container.children[1].tagName, tag);
    assert.equal(feed.container.children[1].src, "blob:receipt");
    assert.equal(feed.container.children[2].rel, "noopener noreferrer");
    feed.api.clear(feed.container);
    assert.deepEqual(feed.revoked, ["blob:receipt"]);
  }
});

test("missing receipts show retry guidance and unsafe or unrelated addresses cannot be loaded", async () => {
  const feed = viewer("image/png", false);
  await feed.api.show(feed.container, "/uploads/expense-receipts/missing.png");
  assert.match(feed.container.children[0].textContent, /missing from the server/);
  assert.equal(feed.container.children[1].textContent, "Try again");
  for (const src of ["javascript:alert(1)", "data:text/html;base64,YQ==", "https://untrusted.example/photo.png", "/admin/staff/attendance"]) assert.equal(feed.api.safeSource(src), "");
  assert.equal(feed.api.safeSource("data:application/pdf;base64,YQ=="), "data:application/pdf;base64,YQ==");
});

test('receipt errors distinguish missing files, session expiry, denied access and temporary failures', async () => {
  for (const [status, message] of [[401, /Sign in again/], [403, /permission/], [500, /try again/], [404, /missing from the server/]]) {
    const feed = viewer('image/png', false, status);
    await feed.api.show(feed.container, '/api/receipts/saved');
    assert.match(feed.container.children[0].textContent, message);
    if (status !== 404) assert.doesNotMatch(feed.container.children[0].textContent, /missing from the server/);
  }
  const unsupported = viewer('text/html');
  await unsupported.api.show(unsupported.container, '/api/receipts/saved');
  assert.match(unsupported.container.children[0].textContent, /supported photo or PDF/);
});

test('an older expense PDF with no MIME metadata remains viewable through the private receipt route', async t => {
  t.mock.method(storage, 'findFinancialReceipt', async () => ({ metadata: { uploadedBy: 'owner' }, length: 8 }));
  const full = new PassThrough(); full.pipe = response => { full.target = response; };
  t.mock.method(storage, 'downloadFinancialReceipt', (_id, options) => options ? Readable.from([Buffer.from('%PDF-1.7')]) : full);
  const handler = receipts.stack.find(layer => layer.route?.path === '/:id').route.stack.at(-1).handle;
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, on() {} };
  await handler({ params: { id: 'receipt' }, user: { role: 'technician', _id: 'owner' } }, response, error => { throw error; });
  assert.equal(response.headers['Content-Type'], 'application/pdf'); assert.equal(full.target, response);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
});
