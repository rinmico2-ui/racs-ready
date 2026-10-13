"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { recoverLegacyExpenseReceipt } = require("../utils/legacyExpenseReceiptRecovery");
const storage = require("../utils/financialReceiptStorage");
const legacyRoutes = require("../routes/legacyExpenseReceiptRoutes");
const filename = "expense-1791720667223-710232883.jpg";
const legacyPath = `/uploads/expense-receipts/${filename}`;
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "racs-receipt-recovery-"));
  t.after(async () => { for (const file of await fs.readdir(root)) await fs.unlink(path.join(root, file)); await fs.rmdir(root); });
  return root;
}

test("missing originals and invalid files are reported without creating substitute receipts", async t => {
  const root = await directory(t);
  const bucket = { find: () => ({ next: async () => null }), openUploadStream() { throw new Error("Unexpected write"); } };
  const options = { legacyPath, directory: root, bucket, apply: true };
  assert.equal((await recoverLegacyExpenseReceipt(options)).status, "missing_original");
  await fs.writeFile(path.join(root, filename), "<html>This is not a receipt</html>");
  assert.equal((await recoverLegacyExpenseReceipt(options)).status, "invalid_file");
  assert.equal((await recoverLegacyExpenseReceipt({ ...options, legacyPath: "/uploads/expense-receipts/../../.env" })).status, "unsupported_path");
});

test("dry-run reads real receipt bytes but does not upload or modify records", async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, filename), bytes);
  const bucket = { find: () => ({ next: async () => null }), openUploadStream() { throw new Error("Unexpected write"); } };
  assert.deepEqual(await recoverLegacyExpenseReceipt({ legacyPath, directory: root, bucket }), { status: "ready", bytes: bytes.length });
});

test("recovery keeps the exact original bytes, owner and legacy link and skips files already recovered", async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, filename), bytes);
  let saved, chunks = [], uploads = 0;
  const bucket = {
    find: () => ({ next: async () => saved }),
    openUploadStream(name, options) {
      uploads++;
      assert.equal(name, filename);
      saved = { _id: "recovered", ...options };
      const stream = new PassThrough(); stream.id = saved._id;
      stream.on("data", chunk => chunks.push(chunk));
      return stream;
    },
  };
  const options = { legacyPath, directory: root, uploadedBy: "original-user", bucket, apply: true };
  assert.equal((await recoverLegacyExpenseReceipt(options)).status, "saved");
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(saved.contentType, "image/jpeg");
  assert.equal(saved.metadata.uploadedBy, "original-user");
  assert.equal(saved.metadata.legacyPath, legacyPath);
  assert.match(saved.metadata.sha256, /^[a-f\d]{64}$/);
  assert.equal((await recoverLegacyExpenseReceipt(options)).status, "already_saved");
  assert.equal(uploads, 1);
});

test("legacy receipt links redirect privately for staff and owner, reject other technicians, and keep disk fallback", async () => {
  const original = storage.findLegacyFinancialReceipt;
  const handler = legacyRoutes.stack.find(layer => layer.route?.path === "/:filename").route.stack.at(-1).handle;
  storage.findLegacyFinancialReceipt = async () => ({ _id: "saved", metadata: { uploadedBy: "owner" } });
  try {
    for (const user of [{ role: "admin", _id: "admin" }, { role: "secretary", _id: "secretary" }, { role: "technician", _id: "owner" }, { role: "technician", _id: "other" }]) {
      const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(value) { this.code = value; return this; }, json(body) { this.body = body; }, redirect(code, location) { this.code = code; this.location = location; } };
      await handler({ params: { filename }, user }, response, error => { throw error || new Error("Unexpected fallback"); });
      if (user._id === "other") assert.equal(response.code, 403);
      else { assert.equal(response.code, 307); assert.equal(response.location, "/api/receipts/saved"); assert.equal(response.headers["Cache-Control"], "private, no-store"); }
    }
    storage.findLegacyFinancialReceipt = async () => null;
    let next = false;
    await handler({ params: { filename } }, {}, error => { assert.equal(error, undefined); next = true; });
    assert.equal(next, true);
  } finally { storage.findLegacyFinancialReceipt = original; }
});
