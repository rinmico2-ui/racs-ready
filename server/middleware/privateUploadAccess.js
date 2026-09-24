"use strict";

const BookingService = require("../models/BookingService");
const Assignment = require("../models/Assignment");
const Technician = require("../models/Technician");

const BOOKING_EVIDENCE_PREFIXES = [
  "/uploads/repairs/",
  "/uploads/repair-photos/",
  "/uploads/proofs/",
  "/uploads/completion-proofs/",
];
const PENDING_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_GRANTS = 30;

function requestPath(req) {
  try {
    return decodeURIComponent(new URL(req.originalUrl, "http://local").pathname);
  } catch (_error) {
    return "";
  }
}

function isBookingEvidencePath(value) {
  const pathname = String(value || "");
  return BOOKING_EVIDENCE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    && !pathname.includes("..")
    && /^\/uploads\/[a-z-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(pathname);
}

function grantPrivateUploads(req, urls) {
  if (!req?.session) return;
  const now = Date.now();
  const active = Array.isArray(req.session.privateUploadGrants)
    ? req.session.privateUploadGrants.filter((grant) => Number(grant?.expiresAt) > now)
    : [];
  for (const url of Array.isArray(urls) ? urls : [urls]) {
    if (!isBookingEvidencePath(url)) continue;
    active.push({ url, expiresAt: now + PENDING_GRANT_TTL_MS });
  }
  req.session.privateUploadGrants = active.slice(-MAX_PENDING_GRANTS);
}

function hasPendingGrant(req, url) {
  if (!req?.session || !Array.isArray(req.session.privateUploadGrants)) return false;
  const now = Date.now();
  req.session.privateUploadGrants = req.session.privateUploadGrants
    .filter((grant) => Number(grant?.expiresAt) > now)
    .slice(-MAX_PENDING_GRANTS);
  return req.session.privateUploadGrants.some((grant) => grant.url === url);
}

async function technicianCanAccess(userId, booking) {
  const technician = await Technician.findOne({ user: userId }).select("_id user").lean();
  if (!technician) return false;
  const ids = [technician._id, technician.user, userId].filter(Boolean).map(String);
  const direct = ids.includes(String(booking.technicianId || ""))
    || (booking.services || []).some((service) => ids.includes(String(service.technicianId || "")));
  const activeAssignment = await Assignment.exists({
    bookingId: booking._id,
    technicianId: technician._id,
    status: { $nin: ["declined", "cancelled", "expired"] },
  });
  if (activeAssignment) return true;
  if (!direct) return false;
  const staleAssignment = await Assignment.exists({
    bookingId: booking._id,
    technicianId: technician._id,
    status: { $in: ["declined", "cancelled", "expired"] },
  });
  return !staleAssignment;
}

async function requireBookingEvidenceAccess(req, res, next) {
  try {
    const url = requestPath(req);
    if (!isBookingEvidencePath(url)) return res.status(404).end();
    if (["admin", "secretary"].includes(req.user?.role)) return next();
    if (hasPendingGrant(req, url)) return next();

    const booking = await BookingService.findOne({
      $or: [
        { imageUrl: url },
        { proofPhoto: url },
        { "unitInfo.photos": url },
        { "services.photos": url },
        { "services.units.inspection.photos": url },
        { "inspection.photos": url },
        { "noShowReport.arrivalProofUrl": url },
        { repairPaymentProof: url },
      ],
    }).select("customerId technicianId services.technicianId").lean();

    if (!booking) return res.status(404).json({ error: "Evidence file not found" });
    if (req.user?.role === "customer" && String(booking.customerId || "") === String(req.user._id)) {
      return next();
    }
    if (req.user?.role === "technician" && await technicianCanAccess(req.user._id, booking)) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  BOOKING_EVIDENCE_PREFIXES,
  grantPrivateUploads,
  isBookingEvidencePath,
  requireBookingEvidenceAccess,
};
