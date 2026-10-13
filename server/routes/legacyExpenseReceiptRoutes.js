"use strict";
const express = require("express");
const auth = require("../middleware/authenticate");
const storage = require("../utils/financialReceiptStorage");
const router = express.Router();

// Preserve existing expense/repair references after the original photo is
// recovered into GridFS. Never rewrite financial records or replace a photo.
router.get("/:filename", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res, next) => {
  try {
    const file = await storage.findLegacyFinancialReceipt(req.params.filename);
    if (!file) return next(); // Existing local files still use static delivery.
    if (!["admin", "secretary"].includes(req.user.role) && String(file.metadata?.uploadedBy || "") !== String(req.user._id)) {
      return res.status(403).json({ error: "You cannot view this receipt." });
    }
    res.setHeader("Cache-Control", "private, no-store");
    return res.redirect(307, `/api/receipts/${file._id}`);
  } catch (error) { next(error); }
});
module.exports = router;
