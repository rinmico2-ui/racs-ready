const crypto = require("crypto");
const fs = require("fs");
const mongoose = require("mongoose");
const { hasValidStoredImageSignature, imageExtensionFor } = require("./uploadSecurity");

const BUCKET_NAME = "paymentProofs";

function paymentProofBucket() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB is not connected; payment proof storage is unavailable.");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}

async function storePaymentProof(file, metadata = {}) {
  if (!file?.path || !(await hasValidStoredImageSignature(file))) {
    throw Object.assign(new Error("Upload a valid JPG, PNG, or WEBP payment receipt."), { status: 400 });
  }

  const filename = `payment-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${imageExtensionFor(file)}`;
  const upload = paymentProofBucket().openUploadStream(filename, {
    contentType: String(file.mimetype).toLowerCase(),
    metadata: {
      bookingId: metadata.bookingId ? String(metadata.bookingId) : null,
      uploadedBy: metadata.uploadedBy ? String(metadata.uploadedBy) : null,
      originalName: String(file.originalname || "payment-proof").slice(0, 255),
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(file.path);
      input.once("error", reject);
      upload.once("error", reject);
      upload.once("finish", resolve);
      input.pipe(upload);
    });
    return { fileId: upload.id, filename };
  } finally {
    await fs.promises.unlink(file.path).catch(() => {});
  }
}

async function discardTemporaryPaymentProof(file) {
  if (file?.path) await fs.promises.unlink(file.path).catch(() => {});
}

async function deletePaymentProof(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return;
  await paymentProofBucket().delete(new mongoose.Types.ObjectId(fileId));
}

async function findPaymentProof(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return null;
  return paymentProofBucket().find({ _id: new mongoose.Types.ObjectId(fileId) }).next();
}

function openPaymentProofDownload(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) {
    throw Object.assign(new Error("Invalid payment proof id."), { status: 400 });
  }
  return paymentProofBucket().openDownloadStream(new mongoose.Types.ObjectId(fileId));
}

module.exports = {
  BUCKET_NAME,
  deletePaymentProof,
  discardTemporaryPaymentProof,
  findPaymentProof,
  openPaymentProofDownload,
  storePaymentProof,
};
