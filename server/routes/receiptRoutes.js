"use strict";
const express = require("express");
const auth = require("../middleware/authenticate");
const storage = require("../utils/financialReceiptStorage");
const { resolveStoredReceiptType } = require('../utils/storedReceiptType');
const router = express.Router();

router.get("/:id", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res, next) => {
  try {
    const file = await storage.findFinancialReceipt(req.params.id);
    if (!file) return res.status(404).json({ error: "Receipt not found." });
    if (!["admin", "secretary"].includes(req.user.role) && String(file.metadata?.uploadedBy) !== String(req.user._id)) return res.status(403).json({ error: "You cannot view this receipt." });
    const downloadId = file._id || req.params.id;
    const type = await resolveStoredReceiptType(file, options => storage.downloadFinancialReceipt(downloadId, options));
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(type)) return res.status(415).json({ error: "Unsupported receipt file." });
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", file.length);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const extension = type === "application/pdf" ? "pdf" : type.split("/")[1];
    res.setHeader("Content-Disposition", `inline; filename="receipt.${extension}"`);
    const stream = storage.downloadFinancialReceipt(downloadId);
    stream.on("error", error => { if (res.headersSent) res.destroy(); else next(error); });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) { next(error); }
});
module.exports = router;
