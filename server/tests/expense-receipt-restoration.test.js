"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const { PassThrough } = require("node:stream");
const Expense = require("../models/Expense");
const Technician = require("../models/Technician");
const storage = require("../utils/financialReceiptStorage");
const recovery = require("../utils/expenseReceiptRecovery");
const receipts = require("../routes/receiptRoutes");
const legacy = require("../routes/legacyExpenseReceiptRoutes");
const admin = { role: "admin", _id: "670000000000000000000001", active: true };
const id = "670000000000000000000002";
const oldUrl = "/uploads/expense-receipts/expense-9999999999999-123456789.jpg";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lD8AAAAASUVORK5CYII=", "base64");
const upload = { buffer: png, mimetype: "image/png", originalname: "original.png" };
function chain(value) { return { select() { return this; }, lean: async () => value }; }
function fixture(t, { url = oldUrl, expenseMissing = false } = {}) {
  const expense = { _id: id, receiptImage: url, technicianId: "technician", amount: 1200, status: "approved" };
  const original = structuredClone(expense); let file, writes = 0;
  t.mock.method(Expense, "findById", () => chain(expenseMissing ? null : expense));
  t.mock.method(Expense, "updateOne", async () => { throw Error("must not rewrite expense"); });
  t.mock.method(Technician, "findById", () => chain({ user: "original-technician-user" }));
  const pending = new Map();
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (key, work) => {
    const job = (pending.get(key) || Promise.resolve()).then(work); pending.set(key, job.catch(() => {})); return job;
  });
  t.mock.method(storage, "findLegacyFinancialReceipt", async () => file || null);
  t.mock.method(storage, "findFinancialReceipt", async () => file || null);
  t.mock.method(storage, "storeFinancialReceipt", async (value, owner, options) => {
    writes++; assert.deepEqual(value.buffer, png);
    file = { _id: "670000000000000000000003", length: png.length, metadata: { ...options.metadata, contentType: "image/png", uploadedBy: owner } };
    return { fileId: file._id, url: `/api/receipts/${file._id}` };
  });
  return { expense, original, input: { expenseId: id, file: upload, confirmOriginal: "true", user: admin }, file: () => file, writes: () => writes };
}
test("restoring a missing original keeps the expense and saved URL intact and retains owner/audit metadata", async t => {
  const f = fixture(t); const result = await recovery.recoverExpenseReceipt(f.input);
  assert.equal(result.url, oldUrl); assert.equal(result.repeated, false); assert.deepEqual(f.expense, f.original);
  assert.equal(f.file().metadata.legacyPath, oldUrl);
  assert.equal(f.file().metadata.uploadedBy, "original-technician-user");
  assert.equal(f.file().metadata.restoredBy, admin._id); assert.equal(f.file().metadata.originalConfirmed, true);
  assert.match(f.file().metadata.sha256, /^[a-f0-9]{64}$/); assert.ok(f.file().metadata.restoredAt instanceof Date);
});
test("concurrent restoration retries reuse the existing recovered file", async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => recovery.recoverExpenseReceipt(f.input)));
  assert.equal(f.writes(), 1); assert.equal(results.filter(row => !row.repeated).length, 1);
  assert.deepEqual(f.expense, f.original);
});
test("a missing GridFS receipt can be restored through its original ID without overwriting financial records", async t => {
  const originalId = "670000000000000000000004";
  const f = fixture(t, { url: `/api/receipts/${originalId}` });
  const result = await recovery.recoverExpenseReceipt(f.input);
  assert.equal(result.url, `/api/receipts/${originalId}`); assert.equal(f.file().metadata.recoveredFrom, result.url);
  assert.equal(f.file().metadata.legacyPath, undefined); assert.deepEqual(f.expense, f.original);
});
test("company expense recovery preserves the administrator's original receipt ownership", async t => {
  const f = fixture(t); f.expense.recordedBy = "original-admin";
  await recovery.recoverExpenseReceipt(f.input); assert.equal(f.file().metadata.uploadedBy, "original-admin");
});
for (const role of ["secretary", "technician", "customer"]) {
  test(`${role} cannot restore or replace a receipt`, async t => {
    const f = fixture(t);
    await assert.rejects(recovery.recoverExpenseReceipt({ ...f.input, user: { ...admin, role } }), error => error.status === 403);
    assert.equal(f.writes(), 0);
  });
}
test("restoration requires an existing expense, a valid file and original-file confirmation", async t => {
  const f = fixture(t);
  for (const patch of [{ confirmOriginal: false }, { expenseId: "invalid" }, { file: null }, { file: { ...upload, buffer: Buffer.from("<html>fake</html>") } }]) {
    await assert.rejects(recovery.recoverExpenseReceipt({ ...f.input, ...patch }), error => error.status === 400);
  }
  assert.equal(f.writes(), 0);
});
test("unknown expenses and unsupported references cannot create recovery files", async t => {
  const f = fixture(t, { expenseMissing: true });
  await assert.rejects(recovery.recoverExpenseReceipt(f.input), error => error.status === 404);
  assert.equal(f.writes(), 0);
});
test("restoration refuses a receipt reference that changed while waiting for its lock", async t => {
  const f = fixture(t);
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => {
    f.expense.receiptImage = "/api/receipts/670000000000000000000004";
    return work();
  });
  await assert.rejects(recovery.recoverExpenseReceipt(f.input), error => error.status === 409);
  assert.equal(f.writes(), 0);
});
test("a restored legacy URL redirects to the private file and does not become public", async t => {
  const f = fixture(t); await recovery.recoverExpenseReceipt(f.input);
  const handler = legacy.stack.find(layer => layer.route?.path === "/:filename").route.stack.at(-1).handle;
  const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; }, setHeader() {}, redirect(code, location) { this.code = code; this.location = location; } });
  const owner = response(); await handler({ params: { filename: path.basename(oldUrl) }, user: { role: "technician", _id: "original-technician-user" } }, owner, error => { throw error; });
  assert.equal(owner.code, 307); assert.equal(owner.location, `/api/receipts/${f.file()._id}`);
  const other = response(); await handler({ params: { filename: path.basename(oldUrl) }, user: { role: "technician", _id: "other-user" } }, other, error => { throw error; });
  assert.equal(other.code, 403);
});
test("receipt aliases download the resolved file rather than the missing original ID", async t => {
  const f = fixture(t, { url: "/api/receipts/670000000000000000000004" }); await recovery.recoverExpenseReceipt(f.input);
  const handler = receipts.stack.find(layer => layer.route?.path === "/:id").route.stack.at(-1).handle;
  let downloaded; const stream = new PassThrough(); stream.pipe = response => { stream.destination = response; };
  t.mock.method(storage, "downloadFinancialReceipt", requested => { downloaded = requested; return stream; });
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, on() {} };
  await handler({ params: { id: "670000000000000000000004" }, user: { role: "admin" } }, res, error => { throw error; });
  assert.equal(downloaded, f.file()._id); assert.equal(res.headers["Content-Type"], "image/png"); assert.equal(res.headers["Cache-Control"], "private, no-store");
});
test("the restoration HTTP route rejects non-admins before consuming an upload", async t => {
  fixture(t);
  t.mock.method(require("../utils/audit"), "logEvent", async () => {});
  const app = express(); app.use((req, _res, next) => { req.user = { ...admin, role: req.headers["x-role"] }; next(); });
  app.use("/expenses", require("../routes/adminExpenseRoutes"));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/expenses/${id}/receipt/recover`;
  const refused = await fetch(url, { method: "POST", headers: { "x-role": "technician", "Content-Type": "application/octet-stream" }, body: "invalid" });
  assert.equal(refused.status, 403);
  const form = new FormData(); form.append("receipt", new Blob([png], { type: "image/png" }), "original.png"); form.append("confirmOriginal", "true");
  const restored = await fetch(url, { method: "POST", headers: { "x-role": "admin" }, body: form });
  assert.equal(restored.status, 201); assert.equal((await restored.json()).success, true);
});
test("receipt preview times out and offers restoration only for a confirmed 404", async () => {
  class Element { constructor() { this.children = []; this.style = {}; } replaceChildren() { this.children = []; } appendChild(child) { this.children.push(child); } append(...children) { this.children.push(...children); } setAttribute() {} addEventListener() {} }
  for (const status of [404, 403, 500, "timeout"]) {
    let timeout, missing = 0;
    const window = { location: { href: "https://racs.example/admin/appointments/expenses", origin: "https://racs.example" } };
    const sandbox = { window, URL, AbortController, setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {}, document: { createElement: () => new Element() },
      fetch: async (_url, options) => {
        if (status !== "timeout") return { ok: false, status };
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("aborted"))));
      } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/evidence-viewer.js"), "utf8"), sandbox);
    const container = new Element(); const task = window.evidenceViewer.show(container, oldUrl, { onMissing() { missing++; } });
    if (status === "timeout") timeout(); await task;
    assert.equal(missing, status === 404 ? 1 : 0);
    if (status === "timeout") assert.match(container.children[0].textContent, /taking too long/);
  }
});
test("the recovery page compiles for both privileged and read-only staff", () => {
  const file = path.join(__dirname, "../views/pages/admin/Appointments/ExpenseApproval.ejs");
  const ejs = require("ejs");
  for (const role of ["admin", "secretary"]) {
    const html = ejs.render(fs.readFileSync(file, "utf8"), { user: { role }, expensesCanApprove: false, expensesCanCreate: false }, { filename: file });
    assert.match(html, new RegExp(`EXPENSES_CAN_RECOVER = ${role === "admin"}`));
  }
});
