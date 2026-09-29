const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { imageExtensionFor, isAllowedImage } = require("../utils/uploadSecurity");

const uploadDirectory = path.join(os.tmpdir(), "racs-booking-payment-proofs");
fs.mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => callback(
      null,
      `pending-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${imageExtensionFor(file) || ""}`,
    ),
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 2,
    fieldSize: 12 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => callback(null, isAllowedImage(file)),
}).single("paymentProof");

function removeUploadedFile(req) {
  if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
}

function bookingSubmissionUpload(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  return upload(req, res, error => {
    if (error) {
      removeUploadedFile(req);
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        error: tooLarge
          ? "The payment receipt must be 5 MB or smaller."
          : "The booking upload could not be processed.",
      });
    }

    try {
      const payload = JSON.parse(String(req.body?.payload || ""));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid payload");
      req.body = payload;
      // Covers validation responses that return before the handler stores the
      // file. If it was already streamed, unlink simply becomes a no-op.
      res.once("finish", () => removeUploadedFile(req));
      res.once("close", () => removeUploadedFile(req));
      return next();
    } catch (_) {
      removeUploadedFile(req);
      return res.status(400).json({ error: "The booking form is invalid. Refresh the page and try again." });
    }
  });
}

module.exports = bookingSubmissionUpload;
