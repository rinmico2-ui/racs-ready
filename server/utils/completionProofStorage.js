const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  imageExtensionFor,
  imageMimeFromSignature,
  isAllowedImage,
} = require("./uploadSecurity");

const BUCKET_NAME = "completionProofs";

function completionProofBucket() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB is not connected; completion proof storage is unavailable.");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: BUCKET_NAME,
  });
}

function validateCompletionProof(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    throw Object.assign(new Error("Completion proof image is required."), { status: 400 });
  }
  if (!isAllowedImage(file)) {
    throw Object.assign(new Error("Upload a JPG, PNG, or WEBP completion photo."), { status: 400 });
  }
  const detectedMime = imageMimeFromSignature(file.buffer);
  if (!detectedMime || detectedMime !== String(file.mimetype || "").toLowerCase()) {
    throw Object.assign(new Error("The completion photo content is not a valid image."), { status: 400 });
  }
  return detectedMime;
}

async function storeCompletionProof(file, metadata = {}) {
  const contentType = validateCompletionProof(file);
  const extension = imageExtensionFor(file);
  const filename = `proof-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
  const uploadStream = completionProofBucket().openUploadStream(filename, {
    contentType,
    metadata: {
      bookingId: metadata.bookingId ? String(metadata.bookingId) : null,
      assignmentId: metadata.assignmentId ? String(metadata.assignmentId) : null,
      uploadedBy: metadata.uploadedBy ? String(metadata.uploadedBy) : null,
      originalName: String(file.originalname || "completion-proof").slice(0, 255),
    },
  });

  return new Promise((resolve, reject) => {
    uploadStream.once("error", reject);
    uploadStream.once("finish", () => {
      resolve({
        fileId: uploadStream.id,
        filename,
        contentType,
        length: file.buffer.length,
      });
    });
    uploadStream.end(file.buffer);
  });
}

async function findCompletionProof(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return null;
  return completionProofBucket()
    .find({ _id: new mongoose.Types.ObjectId(fileId) })
    .next();
}

function openCompletionProofDownload(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) {
    throw Object.assign(new Error("Invalid completion proof id."), { status: 400 });
  }
  return completionProofBucket().openDownloadStream(
    new mongoose.Types.ObjectId(fileId),
  );
}

async function deleteCompletionProof(fileId) {
  if (!mongoose.Types.ObjectId.isValid(fileId)) return;
  await completionProofBucket().delete(new mongoose.Types.ObjectId(fileId));
}

module.exports = {
  BUCKET_NAME,
  deleteCompletionProof,
  findCompletionProof,
  openCompletionProofDownload,
  storeCompletionProof,
  validateCompletionProof,
};
