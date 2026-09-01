const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../middleware/authenticate");
const { imageExtensionFor, isAllowedImage, hasValidStoredImageSignature } = require("../utils/uploadSecurity");
const { resolveWarrantyCoverages, bookingCompletionDate } = require("../utils/warrantyLifecycle");
const { claimPriority, cleanText, isActiveClaimStatus } = require("../utils/warrantyClaimPolicy");
const { createNotification } = require("../utils/notify");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const Technician = require("../models/Technician");
const WarrantyClaim = require("../models/WarrantyClaim");

const router = express.Router();
const evidenceDir = path.join(__dirname, "../private/warranty-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, evidenceDir),
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${imageExtensionFor(file) || ""}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => callback(null, isAllowedImage(file)),
}).array("evidence", 5);

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many warranty claim attempts. Please try again later." },
});

router.use(authenticate);

function receiveEvidence(req, res, next) {
  upload(req, res, error => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: tooLarge ? "Each evidence image must be 5 MB or smaller." : "Upload up to five JPG, PNG, or WEBP evidence images.",
      code: "WARRANTY_EVIDENCE_INVALID",
    });
  });
}

async function removeUploadedFiles(files = []) {
  await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
}

function sourceItems(sourceType, source) {
  if (sourceType === "order") {
    return (source.items || []).map((item, index) => ({
      itemKey: String(item.inventoryId || index),
      name: [item.brand, item.modelLine, item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || `Order item ${index + 1}`,
      serialNumbers: (item.serialNumbers || []).map(String),
    }));
  }
  if (Array.isArray(source.services) && source.services.length) {
    return source.services.map((item, index) => ({
      itemKey: String(item.serviceId || item._id || index),
      name: item.name || `Service ${index + 1}`,
      serialNumbers: [item.model].filter(Boolean).map(String),
    }));
  }
  return [{
    itemKey: String(source.serviceId || source.service?._id || "service"),
    name: source.service?.name || source.serviceName || "Completed service",
    serialNumbers: [source.unitInfo?.model].filter(Boolean).map(String),
  }];
}

async function customerSource(sourceType, sourceId, customerId) {
  if (!mongoose.Types.ObjectId.isValid(sourceId)) return null;
  if (sourceType === "booking") {
    return BookingService.findOne({ _id: sourceId, customerId }).lean();
  }
  if (sourceType === "order") {
    return Order.findOne({ _id: sourceId, userId: customerId }).lean();
  }
  return null;
}

function sourceCompletion(sourceType, source) {
  return sourceType === "booking"
    ? bookingCompletionDate(source)
    : (source.completedAt || [...(source.statusHistory || [])].reverse().find(entry => entry.status === "completed")?.timestamp);
}

function sourceIsCompleted(sourceType, source) {
  return sourceType === "order"
    ? source.status === "completed"
    : ["completed", "repair_completed", "under_warranty", "warranty_claim", "closed"].includes(source.status);
}

function allowedClaimTypes(sourceType, source, coverage) {
  if (sourceType === "order") {
    const types = ["product_defect", "replacement_part", "safety_defect"];
    if (source.fulfillmentType === "delivery_installation" || coverage.coverageType === "installation") {
      types.push("installation_workmanship");
    }
    return types;
  }
  if (coverage.coverageType === "installation") return ["installation_workmanship", "replacement_part", "safety_defect"];
  if (coverage.coverageType === "diagnostic") return ["diagnostic_accuracy", "repair_workmanship", "replacement_part", "safety_defect"];
  return ["repair_workmanship", "replacement_part", "safety_defect"];
}

async function nextClaimReference() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = `WC-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    if (!await WarrantyClaim.exists({ claimReference: candidate })) return candidate;
  }
  return `WC-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function serializeClaim(claim) {
  const value = claim?.toObject ? claim.toObject() : claim;
  return {
    ...value,
    claimantEvidenceUrls: (value?.claimantEvidenceUrls || []).map(url => String(url)),
  };
}

router.get("/eligibility/:sourceType/:sourceId", requireRole("customer"), async (req, res, next) => {
  try {
    const source = await customerSource(req.params.sourceType, req.params.sourceId, req.user._id);
    if (!source) return res.status(404).json({ error: "Completed booking or order not found." });
    if (!sourceIsCompleted(req.params.sourceType, source)) return res.status(409).json({ error: "Warranty claims are available only after service or order completion." });
    const completion = sourceCompletion(req.params.sourceType, source);
    const coverages = resolveWarrantyCoverages(source.warranty, completion).filter(coverage => coverage.status === "active");
    const items = sourceItems(req.params.sourceType, source);
    const activeClaims = await WarrantyClaim.find({
      customerId: req.user._id,
      sourceType: req.params.sourceType,
      sourceId: source._id,
      active: true,
    }).select("coverageId claimReference status").lean();
    return res.json({
      eligible: coverages.length > 0,
      reference: source.bookingReference || source.orderReference || String(source._id),
      coverages: coverages.map(coverage => ({ ...coverage, allowedClaimTypes: allowedClaimTypes(req.params.sourceType, source, coverage) })),
      items,
      activeClaims,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", requireRole("customer"), submitLimiter, receiveEvidence, async (req, res, next) => {
  try {
    const sourceType = cleanText(req.body.sourceType, 20);
    const source = await customerSource(sourceType, req.body.sourceId, req.user._id);
    if (!source) {
      await removeUploadedFiles(req.files);
      return res.status(404).json({ error: "Completed booking or order not found." });
    }
    if (!sourceIsCompleted(sourceType, source)) {
      await removeUploadedFiles(req.files);
      return res.status(409).json({ error: "Warranty claims are available only after service or order completion." });
    }
    const completion = sourceCompletion(sourceType, source);
    const coverages = resolveWarrantyCoverages(source.warranty, completion);
    const coverage = coverages.find(item => item.coverageId === cleanText(req.body.coverageId, 120));
    if (!coverage || coverage.status !== "active") {
      await removeUploadedFiles(req.files);
      return res.status(409).json({ error: "That warranty coverage is expired or unavailable.", code: "WARRANTY_NOT_ACTIVE" });
    }

    const claimType = cleanText(req.body.claimType, 50);
    if (!allowedClaimTypes(sourceType, source, coverage).includes(claimType)) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "The selected claim type is not covered by this warranty." });
    }
    const items = sourceItems(sourceType, source);
    const requestedItemKey = cleanText(req.body.itemKey, 120);
    const affected = items.find(item => item.itemKey === requestedItemKey) || (items.length === 1 ? items[0] : null);
    if (!affected) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "Select a product or service included in this record." });
    }
    const coverageItemKey = String(coverage.itemKey || coverage.serviceId || "");
    if (coverageItemKey && coverageItemKey !== affected.itemKey) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "The selected item does not belong to that warranty coverage." });
    }
    const serialNumber = cleanText(req.body.serialNumber, 120);
    if (serialNumber && affected.serialNumbers.length && !affected.serialNumbers.includes(serialNumber)) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "The serial number does not match the selected product." });
    }
    const description = cleanText(req.body.description, 3000);
    if (description.length < 10) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "Describe the defect in at least 10 characters." });
    }
    const discoveredAt = new Date(req.body.discoveredAt || Date.now());
    if (Number.isNaN(discoveredAt.getTime()) || discoveredAt > new Date()) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "Enter a valid defect discovery date." });
    }
    const completionDay = completion ? new Date(completion) : null;
    if (completionDay) completionDay.setHours(0, 0, 0, 0);
    if (completionDay && discoveredAt < completionDay) {
      await removeUploadedFiles(req.files);
      return res.status(400).json({ error: "The discovery date cannot be before the job was completed." });
    }
    if (await WarrantyClaim.exists({ customerId: req.user._id, sourceType, sourceId: source._id, coverageId: coverage.coverageId, active: true })) {
      await removeUploadedFiles(req.files);
      return res.status(409).json({ error: "An active claim already exists for this coverage." });
    }
    if (await WarrantyClaim.exists({ customerId: req.user._id, sourceType, sourceId: source._id, "affectedItem.itemKey": affected.itemKey, claimType, active: true })) {
      await removeUploadedFiles(req.files);
      return res.status(409).json({ error: "An active claim already exists for this item and issue type." });
    }

    for (const file of req.files || []) {
      if (!await hasValidStoredImageSignature(file)) {
        await removeUploadedFiles(req.files);
        return res.status(400).json({ error: "One or more evidence files are not valid images." });
      }
    }
    const safetyRisk = String(req.body.safetyRisk) === "true" || claimType === "safety_defect";
    const requestedRemedy = ["inspection", "repair", "replacement", "refund", "manufacturer_referral"].includes(req.body.requestedRemedy)
      ? req.body.requestedRemedy : "inspection";
    const claim = await WarrantyClaim.create({
      claimReference: await nextClaimReference(),
      customerId: req.user._id,
      sourceType,
      sourceId: source._id,
      sourceReference: source.bookingReference || source.orderReference || String(source._id),
      serviceAddress: sourceType === "order" ? (source.delivery?.address || source.pickupLocation || "") : (source.customer?.address || source.location?.address || source.address || ""),
      coverageId: coverage.coverageId,
      coverageSnapshot: coverage,
      claimType,
      affectedItem: { itemKey: affected.itemKey, name: affected.name, serialNumber },
      description,
      discoveredAt,
      safetyRisk,
      requestedRemedy,
      priority: claimPriority({ safetyRisk, claimType, discoveredAt }),
      claimantEvidenceUrls: (req.files || []).map(file => `/api/warranty-claims/${file.filename}/evidence`),
      history: [{ status: "submitted", actorId: req.user._id, actorRole: "customer", actorName: req.user.name || req.user.email || "Customer", note: "Warranty claim submitted" }],
    });

    await (sourceType === "booking" ? BookingService : Order).findByIdAndUpdate(source._id, {
      "warranty.status": "claimed",
      "warranty.claimIssue": description,
      "warranty.claimedAt": new Date(),
    });
    await createNotification({
      type: "warranty_claim_submitted",
      title: safetyRisk ? "Critical warranty claim" : "New warranty claim",
      message: `${claim.claimReference} was filed for ${claim.sourceReference}.`,
      role: "admin",
      referenceId: claim._id,
      referenceModel: "WarrantyClaim",
      link: `/admin/warranty?claim=${claim._id}`,
      priority: safetyRisk ? "urgent" : "high",
      io: req.app.get("io"),
    });
    const customerEmail = source.customer?.email || req.user.email;
    if (customerEmail) {
      const { sendEmail } = require("../utils/mailer");
      sendEmail(customerEmail, `Warranty claim received - ${claim.claimReference}`, [
        `We received your warranty claim for ${claim.sourceReference}.`,
        `Claim reference: ${claim.claimReference}`,
        `Priority: ${claim.priority}`,
        `Coverage: ${coverage.serviceName || coverage.coverageType || "Warranty coverage"}`,
        `Our target acknowledgement is within ${coverage.claimResponseDays || 2} business day(s). You will receive updates as the claim progresses.`,
      ].join("\n")).catch(() => {});
    }
    return res.status(201).json({ success: true, claim: serializeClaim(claim) });
  } catch (error) {
    await removeUploadedFiles(req.files);
    if (error?.code === 11000) return res.status(409).json({ error: "An active claim already exists for this coverage." });
    return next(error);
  }
});

router.get("/my", requireRole("customer"), async (req, res, next) => {
  try {
    const claims = await WarrantyClaim.find({ customerId: req.user._id }).sort({ createdAt: -1 }).lean();
    return res.json({ claims });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/withdraw", requireRole("customer"), async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid claim id." });
    const claim = await WarrantyClaim.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (!["submitted", "triage"].includes(claim.status)) return res.status(409).json({ error: "This claim can no longer be withdrawn online." });
    claim.status = "withdrawn";
    claim.active = false;
    claim.closedAt = new Date();
    claim.history.push({ status: "withdrawn", actorId: req.user._id, actorRole: "customer", actorName: req.user.name || "Customer", note: cleanText(req.body.reason, 500) || "Withdrawn by customer" });
    await claim.save();
    await require("../utils/warrantyClaimService").reconcileWarrantySource(claim);
    return res.json({ success: true, claim: serializeClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/confirm-resolution", requireRole("customer"), async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid claim id." });
    const claim = await WarrantyClaim.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (claim.status !== "resolved") return res.status(409).json({ error: "The remedy is not yet marked resolved." });
    claim.customerConfirmedAt = new Date();
    claim.status = "closed";
    claim.active = false;
    claim.closedAt = new Date();
    claim.history.push({ status: "closed", actorId: req.user._id, actorRole: "customer", actorName: req.user.name || "Customer", note: "Customer confirmed the resolution" });
    await claim.save();
    await require("../utils/warrantyClaimService").reconcileWarrantySource(claim);
    return res.json({ success: true, claim: serializeClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.get("/:fileName/evidence", async (req, res, next) => {
  try {
    const fileName = path.basename(req.params.fileName);
    if (fileName !== req.params.fileName) return res.status(400).json({ error: "Invalid evidence file." });
    const evidenceUrl = `/api/warranty-claims/${fileName}/evidence`;
    const claim = await WarrantyClaim.findOne({ $or: [{ claimantEvidenceUrls: evidenceUrl }, { "inspection.evidenceUrls": evidenceUrl }] }).lean();
    if (!claim) return res.status(404).json({ error: "Evidence not found." });
    let allowed = ["admin", "secretary"].includes(req.user.role) || String(claim.customerId) === String(req.user._id);
    if (!allowed && req.user.role === "technician") {
      const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      allowed = technician && String(claim.assignedTechnicianId || "") === String(technician._id);
    }
    if (!allowed) return res.status(403).json({ error: "Forbidden" });
    return res.sendFile(path.join(evidenceDir, fileName));
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid claim id." });
    const claim = await WarrantyClaim.findById(req.params.id).lean();
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    let allowed = ["admin", "secretary"].includes(req.user.role) || String(claim.customerId) === String(req.user._id);
    if (!allowed && req.user.role === "technician") {
      const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      allowed = technician && String(claim.assignedTechnicianId || "") === String(technician._id);
    }
    if (!allowed) return res.status(403).json({ error: "Forbidden" });
    return res.json({ claim: { ...claim, active: isActiveClaimStatus(claim.status) } });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
