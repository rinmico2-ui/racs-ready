"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { imageMimeFromSignature } = require("./uploadSecurity");
const { receiptType } = require("./financialReceiptStorage");

async function recoverLegacyExpenseReceipt({ legacyPath, uploadedBy, directory, bucket, apply = false }) {
  const match = String(legacyPath || "").match(/^\/uploads\/expense-receipts\/(expense-\d+-\d+\.(?:jpe?g|png|webp|pdf))$/i);
  if (!match) return { status: "unsupported_path" };
  const existing = await bucket.find({ "metadata.legacyPath": legacyPath }).next();
  if (existing) return { status: "already_saved", fileId: String(existing._id) };
  let buffer;
  try {
    const root = await fs.realpath(directory);
    const file = await fs.realpath(path.join(root, match[1]));
    if (path.dirname(file) !== root) return { status: "unsafe_path" };
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return { status: "invalid_file" };
    buffer = await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing_original" };
    throw error;
  }
  const contentType = imageMimeFromSignature(buffer) || (buffer.toString("ascii", 0, 5) === "%PDF-" ? "application/pdf" : "");
  try { receiptType({ buffer, mimetype: contentType }); }
  catch (_) { return { status: "invalid_file" }; }
  if (!apply) return { status: "ready", bytes: buffer.length };
  const stream = bucket.openUploadStream(match[1], { contentType, metadata: {
    contentType,
    uploadedBy: uploadedBy ? String(uploadedBy) : null,
    originalName: match[1], legacyPath,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    recoveredAt: new Date(),
  } });
  await new Promise((resolve, reject) => { stream.once("error", reject); stream.once("finish", resolve); stream.end(buffer); });
  return { status: "saved", fileId: String(stream.id) };
}
module.exports = { recoverLegacyExpenseReceipt };
