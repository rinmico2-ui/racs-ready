"use strict";
const crypto = require("crypto");
const mongoose = require("mongoose");
const { imageMimeFromSignature } = require("./uploadSecurity");
const BUCKET_NAME = "financialReceipts";

function receiptType(file) {
  if (!file?.buffer?.length || !Buffer.isBuffer(file.buffer) || file.buffer.length > 5 * 1024 * 1024) throw Object.assign(new Error("Choose a receipt no larger than 5 MB."), { status: 400 });
  const detected = imageMimeFromSignature(file.buffer) || (file.buffer.toString("ascii", 0, 5) === "%PDF-" ? "application/pdf" : null);
  if (!detected || detected !== String(file.mimetype || "").toLowerCase()) throw Object.assign(new Error("The receipt must be a valid JPG, PNG, WEBP or PDF file."), { status: 400 });
  return detected;
}
function bucket() {
  if (!mongoose.connection.db) throw new Error("Receipt storage is unavailable.");
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}
async function storeFinancialReceipt(file, uploadedBy, options = {}) {
  if (!uploadedBy) throw new Error("A receipt owner is required.");
  const contentType = receiptType(file);
  const stream = (options.bucket || bucket()).openUploadStream(`receipt-${crypto.randomBytes(12).toString("hex")}`, { contentType, metadata: { ...options.metadata, contentType, uploadedBy: String(uploadedBy), originalName: String(file.originalname || "receipt").slice(0, 200) } });
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", () => resolve({ fileId: stream.id, url: `/api/receipts/${stream.id}` }));
    stream.end(file.buffer);
  });
}
async function findFinancialReceipt(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const receipts = bucket();
  const original = await receipts.find({ _id: new mongoose.Types.ObjectId(id) }).next();
  return original || receipts.find({ "metadata.recoveredFrom": `/api/receipts/${String(id).toLowerCase()}` }).next();
}
async function findLegacyFinancialReceipt(filename) {
  if (!/^expense-\d+-\d+\.(?:jpe?g|png|webp|pdf)$/i.test(String(filename || ""))) return null;
  return bucket().find({ "metadata.legacyPath": `/uploads/expense-receipts/${filename}` }).next();
}
function downloadFinancialReceipt(id, options) {
  return bucket().openDownloadStream(new mongoose.Types.ObjectId(id), options);
}
function deleteFinancialReceipt(id) { return bucket().delete(new mongoose.Types.ObjectId(id)); }
module.exports = { BUCKET_NAME, receiptType, storeFinancialReceipt, findFinancialReceipt, findLegacyFinancialReceipt, downloadFinancialReceipt, deleteFinancialReceipt };
