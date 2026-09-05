const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");
const mongoose = require("mongoose");
const audit = require("../utils/audit");
const BookingService = require("../models/BookingService");
const User = require("../models/User");
const Service = require("../models/Service");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const ServiceCategory = require("../models/ServiceCategory");
const axios = require("axios");
const googleCalendarSync = require("../utils/googleCalendarSync");
const {
  sendBookingConfirmationEmail,
  sendTechnicianNotificationEmail,
  sendWalkInBookingAccountEmail,
  sendTechArrivalNotificationEmail,
} = require("../utils/mailer");
const { provisionWalkInCustomer } = require("../utils/customerAccountInvitation");
const Payment = require("../models/Payment");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { getMinAdvanceMinutes, getBufferMinutes, checkAdvanceNotice, assertCompanyCapacity, parseTimeValue, isBookingPast } = require("../utils/bookingPolicy");
const { BookingStatus } = require("../models/BookingStatus");
const { capacityMinutes, aggregateBookingType, summarizeChanges } = require("../utils/bookingServiceItems");
const { createNotification } = require("../utils/notify");
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require("../utils/paymentPolicy");
const { imageExtensionFor, isAllowedImage } = require("../utils/uploadSecurity");
const { buildCalendarBookingDateRange } = require("../utils/calendarDateRange");

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const walkInRepairPhotoDir = path.join(__dirname, "../public/uploads/repairs");
if (!fs.existsSync(walkInRepairPhotoDir)) fs.mkdirSync(walkInRepairPhotoDir, { recursive: true });
const walkInRepairPhotos = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, walkInRepairPhotoDir), filename: (_req, file, cb) => cb(null, `walkin-${Date.now()}-${crypto.randomBytes(5).toString("hex")}${imageExtensionFor(file)}`) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(null, isAllowedImage(file)),
});

router.post("/walk-in/upload-repair-photos", auth.authenticate, auth.requireRole(["admin", "secretary"]), walkInRepairPhotos.array("photos", 5), (req, res) => {
  res.json({ urls: (req.files || []).map(file => `/uploads/repairs/${file.filename}`) });
});

// rating endpoint (customer feedback after completion)
router.post("/:id/rate", auth.authenticate, auth.requireRole("customer"), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const techModel = require("../models/Technician");
    const { score, comment } = req.body || {};
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid booking id" });
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "not found" });
    if (String(booking.customerId || "") !== String(req.user._id)) {
      return res.status(403).json({ error: "You can only rate your own booking" });
    }
    if (!["completed", "repair_completed", "closed"].includes(booking.status)) {
      return res.status(409).json({ error: "Only completed bookings can be rated" });
    }
    if (!Number.isFinite(Number(score)) || score < 1 || score > 5) {
      return res.status(400).json({ error: "score must be 1-5" });
    }
    booking.customerRating = Number(score);
    booking.customerRatingComment = comment || null;
    await booking.save();

    await audit.logEvent({
      actor: req.user && req.user._id,
      target: booking._id,
      action: "booking.rate",
      module: "appointments",
      req,
      details: { bookingId: id, score: Number(score), comment: comment || "" },
    });

    // recalc technician average rating
    if (booking.technicianId) {
      const stats = await BookingService.aggregate([
        { $match: { technicianId: booking.technicianId, customerRating: { $exists: true, $ne: null } } },
        { $group: { _id: "$technicianId", avg: { $avg: "$customerRating" }, count: { $sum: 1 } } },
      ]);
      if (stats && stats.length) {
        await techModel.findByIdAndUpdate(booking.technicianId, {
          rating: stats[0].avg,
          ratingCount: stats[0].count,
        });
      }
    }
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

// ─── Helper ────────────────────────────────────────────────────────────────
function generateBookingReference() {
  const now = new Date();
  const d = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let rand = "";
  for (let i = 0; i < 4; i++)
    rand += chars[Math.floor(Math.random() * chars.length)];
  return `RACS-${d}-${rand}`;
}

function minutesTo12h(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${String(h12).padStart(2, "0")}:${String(min).padStart(2, "0")} ${ampm}`;
}

function parseMinuteValue(value) {
  if (value === null || value === undefined) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let hh = Number(ampm[1]) % 12;
    if (ampm[3].toUpperCase() === "PM") hh += 12;
    return hh * 60 + Number(ampm[2]);
  }
  return NaN;
}

function calculateTechnicianAcceptanceDeadline(bookingDate, assignedAt = new Date()) {
  const now = new Date(assignedAt);
  const bookingDay = new Date(bookingDate);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  bookingDay.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((bookingDay - today) / 86400000);

  if (daysUntil <= 0) return new Date(now.getTime() + 30 * 60 * 1000);
  if (daysUntil === 1) {
    const todayAtSix = new Date(now);
    todayAtSix.setHours(18, 0, 0, 0);
    return todayAtSix > now
      ? todayAtSix
      : new Date(now.getTime() + 30 * 60 * 1000);
  }
  return new Date(now.getTime() + 12 * 60 * 60 * 1000);
}

function normalizeEmailAddress(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!email) return "";
  // allow common valid email forms (dots, plus, subdomains, hyphens, underscores)
  // keep a permissive but reasonable check to avoid obviously invalid values
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function normalizePhoneForUser(value) {
  return String(value || "")
    .replace(/\D+/g, "")
    .slice(0, 32);
}

function splitCustomerName(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { firstName: "Walkin", lastName: "Customer" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "Customer" };
  return {
    firstName: parts.shift(),
    lastName: parts.join(" "),
  };
}

async function generateUniqueAutoCustomerEmail(seed) {
  const safeSeed = String(seed || "")
    .replace(/\D+/g, "")
    .slice(-8);

  for (let i = 0; i < 6; i++) {
    const suffix = safeSeed || `${Date.now()}`.slice(-8);
    const token = crypto
      .randomBytes(3)
      .toString("hex")
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 6);
    const candidate = `walkin${suffix}${token}@calidrolocal.com`;
    const exists = await User.findOne({ email: candidate })
      .select("_id")
      .lean();
    if (!exists) return candidate;
  }

  return `walkin${Date.now()}@calidrolocal.com`;
}

function generateAutoCustomerPassword() {
  const tail = crypto
    .randomBytes(12)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 11);
  return `A${tail}`;
}

async function findOrCreateCustomerAccount({
  firstName,
  lastName,
  customerName,
  customerEmail,
  customerPhone,
  address,
  customerAddress,
}) {
  if (!firstName || !lastName) {
    const parsedName = splitCustomerName(customerName);
    firstName = firstName || parsedName.firstName;
    lastName = lastName || parsedName.lastName;
  }
  address = address || customerAddress || {};
  const normalizedEmail = normalizeEmailAddress(customerEmail);
  const normalizedPhone = normalizePhoneForUser(customerPhone);
  const existingCustomer = normalizedEmail
    ? await User.findOne({
        email: normalizedEmail,
        $or: [
          { role: "customer" },
          { role: { $regex: /^customer$/i } },
          { role: { $exists: false } },
          { role: null },
        ],
      })
    : null;
  if (existingCustomer) {
    return {
      user: existingCustomer,
      created: false,
      generatedPassword: null,
      resetToken: null,
    };
  }
  const conflictingAccount = normalizedEmail
    ? await User.findOne({ email: normalizedEmail }).select("_id role")
    : null;
  if (conflictingAccount) {
    const conflict = new Error("This email is already used by a non-customer account.");
    conflict.status = 409;
    throw conflict;
  }
  const accountEmail = normalizedEmail || await generateUniqueAutoCustomerEmail(normalizedPhone);
  
  const generatedPassword = generateAutoCustomerPassword();
  const saltRounds = 12;
  const hashedPassword = await bcrypt.hash(generatedPassword, saltRounds);

  const newUser = new User({
    email: accountEmail,
    passwordHash: hashedPassword,
    firstName: firstName || "",
    lastName: lastName || "",
    phone: normalizedPhone || "",
    address: address || {},
    role: "customer",
    isActive: true,
  });

  // Use the User model's built-in reset token method
  const resetToken = newUser.createPasswordResetToken();

  try {
    const savedUser = await newUser.save();
    return {
      user: savedUser,
      created: true,
      generatedPassword,
      resetToken,
    };
  } catch (saveErr) {
    // If save fails due to duplicate email, try to find existing user
    if (saveErr.code === 11000 && saveErr.keyPattern?.email) {
      const existingUser = await User.findOne({ email: accountEmail, role: "customer" });
      if (existingUser) {
        return {
          user: existingUser,
          created: false,
          generatedPassword: null,
          resetToken: null,
        };
      }
    }
    throw saveErr;
  }
}

/**
 * Derive the capacity end point of a booking for overlap checks.
 *
 * This is NOT a guaranteed completion time — it represents the point at which
 * the capacity slot ends (service duration + travel time + operational buffer).
 * The buffer absorbs minor overruns so consecutive bookings don't cascade.
 */
function deriveBookingEndMinutes(booking, defaultServiceDuration = 60, bufferMinutes = 30) {
  const bStart = parseMinuteValue(booking.startTime);
  const explicitEnd = parseMinuteValue(booking.endTime);
  if (Number.isFinite(explicitEnd) && explicitEnd > bStart) return explicitEnd;
  const serviceDuration =
    Number(booking.serviceDurationMinutes) || defaultServiceDuration;
  const travelDuration = Math.max(0, Number(booking.travelTime) || 0);
  if (!Number.isFinite(bStart)) return NaN;
  return bStart + serviceDuration + travelDuration + bufferMinutes;
}

function isCoordinateLikeText(value) {
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!raw) return false;
  return /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(raw);
}

async function reverseGeocodeAddress(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const { data } = await axios.get(url, {
      timeout: 7000,
      headers: {
        "User-Agent": "RACS-Booking/1.0",
      },
    });
    return data && (data.display_name || data.name)
      ? String(data.display_name || data.name).trim()
      : "";
  } catch (err) {
    return "";
  }
}

async function getTechnicianIdsToMatch(candidateId) {
  const ids = new Set();
  if (!candidateId) return [];
  ids.add(String(candidateId));
  try {
    const Technician = require("../models/Technician");
    const byTechId = await Technician.findById(candidateId)
      .select("_id user")
      .lean();
    if (byTechId) {
      if (byTechId._id) ids.add(String(byTechId._id));
      if (byTechId.user) ids.add(String(byTechId.user));
    } else {
      const byUserId = await Technician.findOne({ user: candidateId })
        .select("_id user")
        .lean();
      if (byUserId) {
        if (byUserId._id) ids.add(String(byUserId._id));
        if (byUserId.user) ids.add(String(byUserId.user));
      }
    }
  } catch (err) {
    console.warn("getTechnicianIdsToMatch failed", err && err.message);
  }
  return Array.from(ids);
}

async function canAccessBooking(user, booking) {
  if (!user || !booking) return false;
  if (["admin", "secretary"].includes(user.role)) return true;
  if (user.role === "customer") {
    return String(booking.customerId || "") === String(user._id);
  }
  if (user.role === "technician") {
    const technicianIds = await getTechnicianIdsToMatch(user._id);
    return technicianIds.includes(String(booking.technicianId || ""));
  }
  return false;
}

// Enforce object ownership once for every appointment-id route. Static paths
// such as /today and /create are ignored and retain their own policies.
router.use("/:id", auth.authenticate, async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();
  try {
    const booking = await BookingService.findById(req.params.id)
      .select("customerId technicianId")
      .lean();
    if (!booking) return res.status(404).json({ error: "Appointment not found" });
    if (!(await canAccessBooking(req.user, booking))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  } catch (err) {
    return next(err);
  }
});

/**
 * Assert that a proposed time slot does not overlap existing bookings for a technician.
 *
 * Uses deriveBookingEndMinutes() which includes the operational buffer, so
 * consecutive bookings have padding that absorbs minor service overruns.
 */
async function assertNoTechnicianOverlap({
  technicianId,
  bookingDate,
  startMin,
  endMin,
  excludeAppointmentId,
}) {
  if (
    !technicianId ||
    !Number.isFinite(startMin) ||
    !Number.isFinite(endMin) ||
    endMin <= startMin
  )
    return;

  const bufferMinutes = await getBufferMinutes();

  const dayStart = new Date(bookingDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(bookingDate);
  dayEnd.setHours(23, 59, 59, 999);
  const technicianIds = await getTechnicianIdsToMatch(technicianId);

  const query = {
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: {
      $in: [
        "pending",
        "payment_verified",
        "awaiting_assignment",
        "assigned",
        "pending_reassignment",
        "confirmed",
        "scheduled",
        "on-the-way",
        "arrived",
        "in-progress",
        "ongoing",
      ],
    },
    technicianId: technicianIds.length ? { $in: technicianIds } : technicianId,
  };
  if (excludeAppointmentId) {
    query._id = { $ne: excludeAppointmentId };
  }

  const existing = await BookingService.find(query).lean();
  for (const b of existing) {
    const bStart = parseMinuteValue(b.startTime);
    if (!Number.isFinite(bStart)) continue;
    const bEnd = deriveBookingEndMinutes(b, 60, bufferMinutes);
    if (!Number.isFinite(bEnd) || bEnd <= bStart) continue;
    if (startMin < bEnd && endMin > bStart) {
      throw new Error(
        `That time slot overlaps an existing booking (${minutesTo12h(bStart)}–${minutesTo12h(bEnd)}). Please choose a different time.`,
      );
    }
  }
}

async function resolveTechnicianRefId(candidateId) {
  if (!candidateId) return candidateId;
  try {
    const Technician = require("../models/Technician");
    const byTechId = await Technician.findById(candidateId)
      .select("_id")
      .lean();
    if (byTechId && byTechId._id) return byTechId._id;

    const byUserId = await Technician.findOne({ user: candidateId })
      .select("_id")
      .lean();
    if (byUserId && byUserId._id) return byUserId._id;
  } catch (err) {
    console.warn("resolveTechnicianRefId failed", err && err.message);
  }
  return candidateId;
}

// ─── List bookings for the logged-in user (used by book-history.js) ─────────
router.get("/", auth.authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
    const query = {};

    // customers see only their own bookings; admin/secretary see all
    if (req.user.role === "customer") {
      query.customerId = req.user._id;
    } else if (req.user.role === "technician") {
      const technicianIds = await getTechnicianIdsToMatch(req.user._id);
      query.technicianId = { $in: technicianIds };
    } else if (!["admin", "secretary"].includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Filter by status if provided
    if (req.query.status) {
      const statusList = req.query.status.split(',').map(s => s.trim()).filter(Boolean);
      if (statusList.length === 1) {
        query.status = statusList[0];
      } else if (statusList.length > 1) {
        query.status = { $in: statusList };
      }
    }

    // Filter by reschedule request status
    if (req.query.rescheduleRequestStatus) {
      query["rescheduleRequest.status"] = req.query.rescheduleRequestStatus;
    }

    // Calendar consumers request only the visible range. Applying it in MongoDB
    // prevents older records from consuming the result limit and hiding current work.
    try {
      const bookingDateRange = buildCalendarBookingDateRange({
        start: req.query.start,
        end: req.query.end,
      });
      if (bookingDateRange) query.bookingDate = bookingDateRange;
    } catch (rangeError) {
      return res.status(400).json({ error: rangeError.message });
    }

    const items = await BookingService.find(query)
      .sort({ bookingDate: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    // enrich each booking with a friendly serviceType string from the snapshot
    for (const b of items) {
      if (!b.serviceType && b.service && b.service.name) {
        b.serviceType = b.service.name;
      }
      // derive technicianName from stored technician snapshot if available
      if (!b.technicianName && b.technician && b.technician.name) {
        b.technicianName = b.technician.name;
      }
    }

    return res.json({ items });
  } catch (err) {
    console.error("GET /api/appointments failed", err && err.message);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

// lightweight public booking endpoint used by front-end
// require login so only authenticated customers can create a booking
router.post("/create", auth.authenticate, auth.requireRole("customer"), async (req, res) => {
  let {
    serviceId,
    services, // Array of services for multi-service bookings
    totalPrice, // Total price for multi-service bookings
    repairIssues, // Repair issues for multi-service bookings
    isMultiService, // Flag to indicate multi-service booking
    date,
    timeStart,
    selectedTimeLabel,
    technicianId,
    customerLocation,
    paymentMethod,
    gcashNumber,
    paymentReference,
    paymentProof,
    downpaymentAmount,
    travelFare,
    travelTime,
    estimatedFee,
    issueDescription,
    cashNotes,
    hp,
    hpDescription,
  } = req.body;
  // normalize client-side "cash" into database value "cod"
  if (paymentMethod === "cash") paymentMethod = "cod";

  // ── Payment validation ────────────────────────────────────────────────
  if (paymentMethod === "gcash") {
    const phone = String(gcashNumber || "").trim();
    const reference = String(paymentReference || "").trim();
    const proof = String(paymentProof || "").trim();
    if (!phone || !reference || !proof) {
      return res.status(400).json({
        error:
          "GCash number, reference number, and receipt screenshot are required.",
      });
    }
  }
  if (paymentMethod === "cod") {
    // enforce downpayment (and a reference) for cash bookings
    const down = Number(req.body.downpaymentAmount || 0);
    if (!down || down <= 0) {
      return res
        .status(400)
        .json({ error: "A downpayment amount is required for cash bookings." });
    }
    const cref = String(paymentReference || "").trim();
    if (!cref) {
      return res
        .status(400)
        .json({ error: "A reference number is required for cash bookings." });
    }
    req.body.downpaymentAmount = down;
  }

  const startMin = parseMinuteValue(timeStart);
  if (isNaN(startMin))
    return res.status(400).json({ error: "Invalid time slot." });

  const bookingDate = date ? new Date(date + "T00:00:00") : new Date();
  bookingDate.setHours(0, 0, 0, 0);

  // ── Minimum advance booking notice validation ────────────────────────
  const minAdvanceMinutes = await getMinAdvanceMinutes();
  const bookingDateTime = new Date(bookingDate);
  bookingDateTime.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  const advanceCheck = checkAdvanceNotice(bookingDateTime, minAdvanceMinutes);
  if (!advanceCheck.allowed) {
    return res.status(400).json({ error: advanceCheck.message });
  }

  try {
    if (technicianId) {
      technicianId = await resolveTechnicianRefId(technicianId);
    }

    // ── 1. Resolve service(s) duration and pricing ───────────────────────
    let serviceDuration = 60;
    let serviceName = "";
    let servicePrice = 0;
    let serviceModelName = "CoreService";
    let serviceSnap = null;
    let servicesSnap = []; // For multi-service bookings
    
    if (isMultiService && services && Array.isArray(services)) {
      // Multi-service booking
      let totalDuration = 0;
      let totalPrice = 0;
      
      for (const serviceItem of services) {
        try {
          let svc;
          if (serviceItem.type === 'core') {
            svc = await CoreService.findById(serviceItem.serviceId).lean();
            serviceModelName = "CoreService";
          } else {
            svc = await RepairService.findById(serviceItem.serviceId).lean();
            serviceModelName = "RepairService";
          }
          
          if (svc) {
            const itemDuration = svc.durationMinutes || svc.duration || svc.estimatedDurationMinutes || 60;
            const itemPrice = serviceItem.unitPrice || svc.basePrice || 0;
            const itemQuantity = Math.max(1, Number(serviceItem.quantity) || 1);
            
            totalDuration += itemDuration * itemQuantity;
            totalPrice += serviceItem.totalPrice || (itemPrice * itemQuantity);
            
            servicesSnap.push({
              serviceId: serviceItem.serviceId,
              name: serviceItem.name || svc.name,
              type: serviceItem.type,
              quantity: itemQuantity,
              unitPrice: itemPrice,
              totalPrice: serviceItem.totalPrice || (itemPrice * itemQuantity),
              hp: serviceItem.hp,
              hpDescription: serviceItem.hpDescription,
              airconType: serviceItem.airconType,
              airconTypeName: serviceItem.airconTypeName,
              applianceType: serviceItem.applianceType,
              applianceTypeName: serviceItem.applianceTypeName,
              brand: serviceItem.brand,
              model: serviceItem.model,
              problemDescription: serviceItem.problemDescription || serviceItem.repairIssue,
              repairIssue: serviceItem.repairIssue || serviceItem.problemDescription,
              unitCategory: serviceItem.unitCategory,
              symptoms: Array.isArray(serviceItem.symptoms) ? serviceItem.symptoms.slice(0, 8) : [],
              photos: Array.isArray(serviceItem.photos) ? serviceItem.photos.slice(0, 5) : [],
              duration: itemDuration * itemQuantity,
              isAirconService: serviceItem.isAirconService || false
            });
          }
        } catch (e) {
          console.warn("booking: service lookup failed for multi-service", e.message);
        }
      }
      
      serviceDuration = Math.max(totalDuration, 60); // Minimum 1 hour
      servicePrice = totalPrice || Number(totalPrice) || 0;
      serviceName = `${services.length} services`;
      
    } else if (serviceId) {
      // Single service booking (legacy)
      try {
        let svc = await CoreService.findById(serviceId).lean();
        if (svc) {
          serviceModelName = "CoreService";
          serviceDuration = svc.durationMinutes || svc.duration || 60;
          serviceName = svc.name || "";
          servicePrice = svc.basePrice || 0;
          serviceSnap = {
            _id: svc._id,
            name: svc.name,
            description: svc.description,
            basePrice: svc.basePrice,
          };
        } else {
          svc = await RepairService.findById(serviceId).lean();
          if (svc) {
            serviceModelName = "RepairService";
            serviceDuration =
              svc.estimatedDurationMinutes || svc.duration || 60;
            serviceName = svc.name || "";
            servicePrice = svc.basePrice || 0;
            serviceSnap = {
              _id: svc._id,
              name: svc.name,
              description: (svc.commonFaults || []).join(", "),
              basePrice: svc.basePrice,
            };
          }
        }
      } catch (e) {
        console.warn("booking: service lookup failed", e.message);
      }
    }
    const travelMins = Number(travelTime) || 0;
    const bufferMins = await getBufferMinutes();
    // Capacity end = service duration + travel + buffer (used for overlap checks)
    const capacityEnd = startMin + serviceDuration + travelMins + bufferMins;

    // ── 2. Overlap-aware conflict check ──────────────────────────────────
    if (technicianId) {
      try {
        await assertNoTechnicianOverlap({
          technicianId,
          bookingDate,
          startMin,
          endMin: capacityEnd,
        });
      } catch (overlapErr) {
        return res.status(409).json({ error: overlapErr.message });
      }
    }

    // ── 2b. Company-wide capacity check ──────────────────────────────────
    // Ensures total concurrent bookings don't exceed active technician count.
    // This runs regardless of whether a technician was selected.
    try {
      await assertCompanyCapacity(bookingDate, startMin, capacityEnd);
    } catch (capacityErr) {
      return res.status(409).json({ error: capacityErr.message });
    }

    // ── 3. Generate unique booking reference (retry up to 5 times) ────────
    let bookingReference = null;
    for (let i = 0; i < 5; i++) {
      const ref = generateBookingReference();
      const exists = await BookingService.findOne({
        bookingReference: ref,
      }).lean();
      if (!exists) {
        bookingReference = ref;
        break;
      }
    }
    if (!bookingReference) bookingReference = generateBookingReference(); // last resort

    // ── 4. Build booking document ─────────────────────────────────────────
    const fare = Number(travelFare) || 0;
    const fee = Number(estimatedFee) || servicePrice + fare || 0;

    const appointmentData = {
      bookingReference,
      serviceId,
      serviceModel: serviceModelName,
      serviceType: servicesSnap.length
        ? (servicesSnap.some(item => item.type === "core") && servicesSnap.some(item => item.type === "repair")
            ? "mixed"
            : servicesSnap[0].type === "repair" ? "repair" : "core")
        : (serviceModelName === "RepairService" ? "repair" : "core"),
      service: serviceSnap,
      servicePrice,
      serviceDurationMinutes: serviceDuration,
      bookingDate,
      // startTime = customer's requested service start time
      startTime: String(startMin),
      // endTime = capacity end point (service + travel + buffer) — used for
      // overlap checks on future bookings, NOT a guaranteed completion time
      endTime: String(capacityEnd),
      selectedTimeLabel:
        (selectedTimeLabel && String(selectedTimeLabel).trim()) ||
        minutesTo12h(startMin),
      technicianId: technicianId || undefined,
      status: "pending",
      paymentMethod: paymentMethod || "cod",
      gcashNumber: gcashNumber || undefined,
      paymentReference: paymentReference || undefined,
      paymentProof: paymentProof || undefined,
      downpaymentAmount: req.body.downpaymentAmount || undefined,
      paymentNotes: cashNotes || undefined,
      travelFare: fare || undefined,
      travelTime: Number.isFinite(travelMins) ? travelMins : undefined,
      estimatedFee: fee || undefined,
      issueDescription: issueDescription || undefined,
      hp: hp ? Number(hp) : undefined,
      hpDescription: hpDescription || undefined,
    };

    // Add multi-service information if applicable
    if (isMultiService && servicesSnap.length > 0) {
      appointmentData.isMultiService = true;
      appointmentData.services = servicesSnap;
      appointmentData.totalPrice = Number(totalPrice) || servicePrice;
      appointmentData.repairIssues = repairIssues || "";
    }

    // attach customer location
    if (customerLocation && typeof customerLocation === "object") {
      const loc = {};
      let addressText =
        typeof customerLocation.address === "string"
          ? customerLocation.address.trim()
          : "";
      if (isCoordinateLikeText(addressText)) {
        addressText = "";
      }
      const lat = parseFloat(customerLocation.lat || customerLocation.latitude);
      const lng = parseFloat(
        customerLocation.lng || customerLocation.longitude,
      );
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        loc.coordinates = { type: "Point", coordinates: [lng, lat] };
        if (!addressText) {
          addressText = await reverseGeocodeAddress(lat, lng);
        }
      }
      if (addressText) loc.address = addressText;
      if (loc.address || loc.coordinates) appointmentData.location = loc;
    }

    // attach customer snapshot – build name from firstName+lastName (virtuals may not serialize)
    if (req.user) {
      appointmentData.customerId = req.user._id;
      const custFirst = req.user.firstName || "";
      const custLast  = req.user.lastName  || "";
      const custName  = `${custFirst} ${custLast}`.trim() || req.user.name || req.user.fullName || "";
      appointmentData.customer = {
        _id:     req.user._id,
        name:    custName,
        email:   req.user.email || "",
        phone:   req.user.phone || req.user.mobile || "",
        address: typeof req.user.address === "string"
          ? req.user.address
          : (customerLocation?.address || ""),
      };
      console.log("📋 Customer snapshot:", appointmentData.customer.name, appointmentData.customer.email);
    }

    // attach technician snapshot – fetch real data from Technician collection
    if (technicianId) {
      try {
        const Technician = require("../models/Technician");
        const techDoc = await Technician.findById(technicianId);
        if (techDoc) {
          appointmentData.technician = {
            _id:   techDoc._id,
            name:  techDoc.name || "",
            email: techDoc.userEmail || techDoc.email || "",
            phone: techDoc.phone || techDoc.mobile || "",
          };
          console.log("📋 Technician snapshot:", appointmentData.technician.name, appointmentData.technician.email);
        }
      } catch (techErr) {
        console.warn("booking: technician snapshot failed", techErr.message);
      }
    }

    // ── 5. Save ───────────────────────────────────────────────────────────
    const appointment = new BookingService(appointmentData);
    await appointment.save();

    // ── 5a. Large Project Detection ──────────────────────────────────────
    try {
      const { isLargeProject, calculateTotalEstimatedDuration } = require("../utils/enterpriseSchedulingEngine");
      const Project = require("../models/Project");

      const totalQty = isMultiService && Array.isArray(servicesSnap)
        ? servicesSnap.reduce((sum, s) => sum + (Number(s.quantity) || 1), 0)
        : Math.max(1, Number(appointment.quantity || appointmentData.quantity || 1));
      if (totalQty > 40) throw new Error("A booking can contain at most 40 units");

      let estimatedTotalMinutes = 0;
      if (isMultiService && Array.isArray(servicesSnap)) {
        estimatedTotalMinutes = servicesSnap.reduce((sum, s) => sum + ((Number(s.duration) || 60) * (Number(s.quantity) || 1)), 0);
      } else {
        estimatedTotalMinutes = (serviceDuration || 60) * totalQty;
      }

      const isLarge = await isLargeProject({ totalUnits: totalQty, totalEstimatedMinutes: estimatedTotalMinutes });

      if (isLarge) {
        appointment.status = BookingStatus.PENDING_PROJECT_SCHEDULING;
        appointment.selectedTimeLabel = undefined;
        appointment.startTime = undefined;
        appointment.endTime = undefined;
        await appointment.save();

        const custFirst = req.user?.firstName || "";
        const custLast = req.user?.lastName || "";
        const custName = `${custFirst} ${custLast}`.trim() || req.user?.name || req.user?.fullName || "";

        await Project.create({
          bookingId: appointment._id,
          customerId: req.user?._id,
          customer: {
            _id: req.user?._id,
            name: custName,
            email: req.user?.email || "",
            phone: req.user?.phone || "",
            address: typeof req.user?.address === "string" ? req.user.address : (customerLocation?.address || ""),
          },
          service: {
            name: serviceSnap?.name || serviceName || "",
            description: serviceSnap?.description || "",
            category: serviceSnap?.category || "",
          },
          status: "pending_project_scheduling",
          isLargeScale: isLarge,
          projectPhase: appointment.serviceType === "repair" ? "assessment" : "execution",
          estimatedTotalHours: estimatedTotalMinutes / 60,
          totalUnits: totalQty,
          estimatedDurationPerUnit: serviceDuration ? parseFloat((serviceDuration / 60).toFixed(1)) : undefined,
          location: appointmentData.location || undefined,
          // Populate repair data if this is a repair service
          ...(appointment.serviceType === 'repair' ? { repair: buildRepairData(appointment) } : {}),
        });
      }
    } catch (projectErr) {
      console.warn("Large project detection failed:", projectErr && projectErr.message);
    }

    // ── 5b. Auto-set technician availability → Assigned ───────────────────
    if (technicianId) {
      try {
        const Technician = require("../models/Technician");
        const { resolveAvailabilityStatus } = require("../utils/availability");
        const assignedTech = await Technician.findById(technicianId);
        if (assignedTech) {
          // Use centralized resolver to determine if tech can accept assignment
          const currentAvail = await resolveAvailabilityStatus(assignedTech, null, null, { syncDb: false });
          if (currentAvail === "Available") {
            assignedTech.availabilityStatus = "Assigned";
            await assignedTech.save();
          }
        }
      } catch (e) {
        console.warn("availability → Assigned on booking create failed", e && e.message);
      }
    }

    // ── 6. Audit log ──────────────────────────────────────────────────────
    try {
      await audit.log({
        action: "BOOKING_CREATED",
        userId: req.user?._id,
        targetId: appointment._id,
        targetModel: "BookingService",
        details: {
          reference: bookingReference,
          date,
          startMin,
          capacityEnd,
          technicianId,
          serviceName,
        },
      });
    } catch (e) {
      /* non-fatal */
    }

    // ── 7. Post-booking notifications (fire-and-forget) ───────────────────
    const dateLabel = bookingDate.toLocaleDateString("en-PH", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    // Customer sees only the requested start time — not a guaranteed completion window
    const timeLabel = minutesTo12h(startMin);
    const totalLabel = timeLabel;

    (async () => {
      try {
        // In-app notification: new booking for admins
        const { createNotification } = require("../utils/notify");
        const io = req.app.get("io");
        await createNotification({
          type: "booking_created",
          title: "New Booking",
          message: `New ${serviceName} booking from ${customerName || "a customer"} on ${dateLabel}.`,
          role: "admin",
          referenceId: appointment._id,
          referenceModel: "BookingService",
          link: "/admin/appointments/pending",
          priority: "normal",
          io,
        });

        // Customer confirmation email
        const customerEmail = req.user?.email;
        const _fn = req.user?.firstName || "";
        const _ln = req.user?.lastName || "";
        const customerName =
          `${_fn} ${_ln}`.trim() || req.user?.name || req.user?.fullName || "Valued Customer";
        if (customerEmail) {
          try {
            await sendBookingConfirmationEmail({
              to: customerEmail,
              customerName,
              bookingReference,
              serviceName,
              dateLabel,
              timeLabel,
              totalLabel,
              paymentMethod: paymentMethod || "cod",
              estimatedFee: fee || 0,
              locationAddress: customerLocation?.address || "",
              issueDescription: issueDescription || "",
              travelMins: travelMins || 0,
              serviceDuration,
            });
          } catch (mailErr) {
            console.warn(
              "customer booking confirmation email failed",
              mailErr && mailErr.message,
            );
          }
        }

        // Technician notification (if tech assigned). only send when the
        // booking is in the "scheduled" state – ordinary confirmations do not
        // constitute a job assignment.
        if (technicianId && appointment.status === "scheduled") {
          try {
            const Technician = require("../models/Technician");
            let tech = await Technician.findById(technicianId).populate("user", "email name fullName firstName lastName").lean();
            if (!tech) {
              tech = await Technician.findOne({ user: technicianId }).populate("user", "email name fullName firstName lastName").lean();
            }
            const techEmail = tech?.userEmail || tech?.user?.email;
            const techName = tech?.name || (tech?.user && ((tech.user.firstName || "") + " " + (tech.user.lastName || "")).trim()) || "Technician";
            if (techEmail) {
              await sendTechnicianNotificationEmail({
                to: techEmail,
                technicianName: techName,
                customerName,
                bookingReference,
                serviceName,
                dateLabel,
                timeLabel,
                totalLabel,
                locationAddress: customerLocation?.address || "",
                issueDescription: issueDescription || "",
              });
            }
          } catch (e) {
            console.warn("technician email failed", e.message);
          }
        }
      } catch (e) {
        // guard against any unexpected errors in notifications
        console.warn("post-booking notifications error", e && e.message);
      }
    })();

    // ── 8. Create payment transaction record(s) ───────────────────────────
    if (paymentMethod === "cod") {
      try {
        await Payment.create({
          bookingId: appointment._id,
          amount: Number(req.body.downpaymentAmount || downpaymentAmount || 0),
          method: "cod",
          gateway: "cod",
          type: "downpayment",
          status: "pending",
          notes: cashNotes || undefined,
        });
      } catch (paymentErr) {
        console.warn(
          "cash payment record creation failed",
          paymentErr && paymentErr.message,
        );
      }
    }

    // ── 9. Create manual GCash payment record ────────────────────────────
    if (paymentMethod === "gcash") {
      try {
        const gcashAmt = fee || Number(req.body.downpaymentAmount) || 0;
        await Payment.create({
          bookingId: appointment._id,
          amount: gcashAmt,
          method: "gcash",
          gateway: "other",
          type: "downpayment",
          status: "pending",
          reference: paymentReference || undefined,
          proofUrl: paymentProof || undefined,
        });
      } catch (paymentErr) {
        console.warn(
          "gcash payment record creation failed",
          paymentErr && paymentErr.message,
        );
      }
    }

    // ── 10. Respond ───────────────────────────────────────────────────────
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: appointment.customerId || appointment.customer,
      action: "booking.create",
      module: "appointments",
      req,
      details: {
        bookingId: appointment._id,
        bookingReference,
        serviceType: isMultiService ? "multi" : (services && services.length ? "repair" : "core"),
        totalPrice: fee,
        paymentMethod: paymentMethod || "cod",
      },
    });

    const respObj = {
      success: true,
      bookingId: appointment._id,
      bookingReference,
      date: dateLabel,
      time: timeLabel,
      serviceName,
      estimatedFee: fee,
      // Additional fields for confirmation modal
      customerEmail: appointment.customer?.email || req.user?.email || "",
      customerName: appointment.customer?.name || "",
      technicianName: appointment.technician?.name || "",
      technicianEmail: appointment.technician?.email || "",
      locationAddress: appointment.location?.address || customerLocation?.address || "",
      paymentMethod: appointment.paymentMethod || paymentMethod || "cod",
      dateLabel,
      timeLabel,
    };
    return res.json(respObj);
  } catch (err) {
    console.error("booking create error", err);
    return res.status(500).json({ error: err.message || "could not create" });
  }
});

// GET / - list appointments with optional filters
// ?upcoming=1  => bookings from today onward
// ?requests=1  => booking requests (status=pending)
// supports ?limit and ?page
router.get("/", auth.authenticate, async (req, res) => {
  try {
    const q = req.query || {};
    const limit = Math.min(Math.max(1, Number(q.limit) || 100), 1000);
    const page = Math.max(0, Number(q.page) || 0);

    const filter = {};
    const toDayStart = (value) => {
      const d = new Date(String(value) + "T00:00:00");
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const toDayEnd = (value) => {
      const d = toDayStart(value);
      if (!d) return null;
      d.setHours(23, 59, 59, 999);
      return d;
    };

    if (q.date) {
      const ds = toDayStart(q.date);
      const de = toDayEnd(q.date);
      if (ds && de) filter.bookingDate = { $gte: ds, $lte: de };
    }

    if (q.start || q.end) {
      const existing = filter.bookingDate || {};
      const ds = q.start ? toDayStart(q.start) : null;
      const de = q.end ? toDayEnd(q.end) : null;
      if (ds) existing.$gte = ds;
      if (de) existing.$lte = de;
      if (existing.$gte || existing.$lte) filter.bookingDate = existing;
    }

    if (q.upcoming) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const existing = filter.bookingDate || {};
      existing.$gte = existing.$gte
        ? new Date(Math.max(existing.$gte.getTime(), today.getTime()))
        : today;
      filter.bookingDate = existing;
    }
    if (q.requests) {
      filter.status = "pending";
    } else if (q.status && q.status !== "all") {
      // Support comma-separated status values (e.g. "repair_requested,inspection_scheduled")
      const statuses = String(q.status).split(',').map(s => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    } else {
      // default listing for main appointments view: exclude pending requests
      filter.status = { $ne: "pending" };
    }
    if (q.technicianId && q.technicianId !== "all") {
      const techIds = await getTechnicianIdsToMatch(q.technicianId);
      filter.technicianId = techIds.length ? { $in: techIds } : q.technicianId;
    }

    // basic text search (customer name/service)
    if (q.search) {
      const re = new RegExp(
        q.search.replace(/[.*+?^${}()|\\[\\]\\\\]/g, ""),
        "i",
      );
      filter.$or = [
        { bookingReference: re },
        { serviceType: re },
        // look in embedded customer snapshot fields – the older code
        // also handled `customer` string for backwards compatibility
        { "customer.name": re },
        { "customer.email": re },
        { "customer.phone": re },
        { "service.name": re },
        { customer: re },
      ];
    }

    const sortNewest =
      String(q.sort || "").toLowerCase() === "newest" ||
      String(q.order || "").toLowerCase() === "desc" ||
      String(q.newest || "").toLowerCase() === "1";
    const sortOrder = sortNewest
      ? { createdAt: -1, bookingDate: -1, startTime: -1 }
      : { bookingDate: 1, startTime: 1 };

    let items = [];
    try {
      items = await BookingService.find(filter)
        .sort(sortOrder)
        .skip(page * limit)
        .limit(limit)
        .populate("serviceId") // may fail for legacy docs missing refPath values
        .populate("technicianId")
        .lean();
    } catch (populateErr) {
      // Fallback for legacy/partial records: return raw docs instead of 500
      console.warn(
        "GET /appointments populate fallback:",
        populateErr && populateErr.message,
      );
      items = await BookingService.find(filter)
        .sort(sortOrder)
        .skip(page * limit)
        .limit(limit)
        .lean();
    }
    // insert technicianName for each item so client code can rely on it
    items = items.map((b) => {
      if (!b.technicianName) {
        if (b.technician && b.technician.name) {
          b.technicianName = b.technician.name;
        } else if (b.technicianId && typeof b.technicianId === "object") {
          b.technicianName =
            b.technicianId.name ||
            b.technicianId.fullName ||
            (
              (b.technicianId.firstName || "") +
              " " +
              (b.technicianId.lastName || "")
            ).trim();
        }
      }
      return b;
    });
    return res.json({ items, count: items.length });
  } catch (err) {
    console.error("GET /appointments error", err);
    return res.status(500).json({ error: "Failed to list appointments" });
  }
});

// GET /today - helper used by dashboard; return bookings with today's date
router.get("/today", auth.authenticate, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const query = {
      bookingDate: { $gte: today, $lt: tomorrow },
    };
    if (req.user.role === "customer") {
      query.customerId = req.user._id;
    } else if (req.user.role === "technician") {
      query.technicianId = { $in: await getTechnicianIdsToMatch(req.user._id) };
    } else if (!["admin", "secretary"].includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const items = await BookingService.find(query)
      .sort({ startTime: 1 })
      .lean();

    if (req.user.role === "customer" && items.length) {
      const CustomerAsset = require("../models/CustomerAsset");
      const MaintenanceSchedule = require("../models/MaintenanceSchedule");
      const assets = await CustomerAsset.find({
        customerId: req.user._id,
        originType: "booking",
        originId: { $in: items.map((booking) => booking._id) },
      }).lean();
      const schedules = await MaintenanceSchedule.find({ assetId: { $in: assets.map((asset) => asset._id) } })
        .sort({ cycleNumber: -1 })
        .lean();
      const scheduleByAsset = new Map();
      schedules.forEach((schedule) => {
        const key = String(schedule.assetId);
        if (!scheduleByAsset.has(key)) scheduleByAsset.set(key, schedule);
      });
      const summaryByBooking = new Map();
      assets.forEach((asset) => {
        const key = String(asset.originId);
        const schedule = scheduleByAsset.get(String(asset._id));
        const current = summaryByBooking.get(key);
        if (!current || (schedule && new Date(schedule.dueDate) < new Date(current.dueDate || 8640000000000000))) {
          summaryByBooking.set(key, {
            assetCount: (current?.assetCount || 0) + 1,
            status: schedule?.status || asset.status,
            dueDate: schedule?.dueDate || null,
          });
        } else {
          current.assetCount += 1;
        }
      });
      items.forEach((booking) => { booking.maintenanceSummary = summaryByBooking.get(String(booking._id)) || null; });
    }
    return res.json({ items });
  } catch (err) {
    console.error("GET /appointments/today error", err);
    return res.status(500);
  }
});

// helper endpoint for delivering proof images or paths stored in appointment docs
router.get("/proof/:token", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const raw = decodeURIComponent(req.params.token || "");
    // data URI? convert and send binary
    if (/^data:/i.test(raw)) {
      const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
      if (m) {
        const mime = m[1];
        const dataBuf = Buffer.from(m[2], "base64");
        return res.type(mime).send(dataBuf);
      }
      return res.status(400).send("Invalid data URI");
    }

    // http(s) -> only allow same-origin redirects (prevent open redirect)
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const allowedHosts = [
          process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null,
          process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).hostname : null,
          "localhost",
        ].filter(Boolean);
        if (!allowedHosts.includes(url.hostname)) {
          return res.status(400).send("Invalid proof URL");
        }
        return res.redirect(raw);
      } catch (e) {
        return res.status(400).send("Invalid proof URL");
      }
    }

    // server-relative path (starts with /) -> serve from public folder
    if (raw.startsWith("/")) {
      const publicDir = path.join(__dirname, "..", "public");
      const filePath = path.resolve(publicDir, raw.replace(/^\//, ""));
      // Prevent path traversal: resolved path must be within public dir
      if (!isPathWithin(publicDir, filePath)) {
        return res.status(400).send("Invalid path");
      }
      return res.sendFile(filePath, (err) => {
        if (err) res.status(404).send("Not found");
      });
    }

    // look for file under uploads/payment_proofs (custom folder)
    const uploadDir = path.join(__dirname, "..", "uploads", "payment_proofs");
    const safeName = path.normalize(raw).replace(/^\.\.(\/|\\)/, "");
    const fp = path.resolve(uploadDir, safeName);
    // Prevent path traversal: resolved path must be within uploadDir
    if (!isPathWithin(uploadDir, fp)) {
      return res.status(400).send("Invalid path");
    }
    if (fs.existsSync(fp)) {
      return res.sendFile(fp);
    }

    // maybe raw is bare base64 string; guess jpeg
    if (/^[A-Za-z0-9+/]+=*$/.test(raw)) {
      const dataBuf = Buffer.from(raw, "base64");
      return res.type("image/jpeg").send(dataBuf);
    }

    res.status(404).send("Proof not found");
  } catch (err) {
    console.error("proof route error", err);
    res.status(500).send("Server error");
  }
});

// GET /walk-in-options - lightweight data for walk-in appointment form
router.get(
  "/walk-in-options",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      const Technician = require("../models/Technician");
      const [coreServices, repairServices, serviceCategories, technicians] = await Promise.all([
        CoreService.find({ active: true })
          .select("_id name description basePrice durationMinutes unit isAirconService hpPricing airconTypes brands applianceTypes")
          .sort({ name: 1 })
          .lean(),
        RepairService.find({ active: true })
          .select("_id name description initialPrice basePrice pricingNote estimatedDurationMinutes applianceType applianceTypes commonFaults")
          .sort({ name: 1 })
          .lean(),
        ServiceCategory.find({ active: true })
          .select("name slug icon iconColor unitTypes isCustom order")
          .sort({ order: 1, name: 1 })
          .lean(),
        Technician.find({ active: true, user: { $ne: null } })
          .select("_id user name userEmail phone")
          .populate("user", "email role active blocked")
          .sort({ name: 1 })
          .lean(),
      ]);

      // The technician assignment API identifies a technician through its
      // linked User account. Do not offer orphaned technician profiles: jobs
      // assigned to them can never be retrieved by a logged-in technician.
      const assignableTechnicians = technicians
        .filter(tech => tech.user
          && String(tech.user.role || "").toLowerCase() === "technician"
          && tech.user.active !== false
          && tech.user.blocked !== true)
        .map(tech => ({
          _id: tech._id,
          name: tech.name,
          phone: tech.phone || "",
          email: tech.userEmail || tech.user.email || "",
        }));

      return res.json({
        coreServices,
        repairServices,
        serviceCategories,
        technicians: assignableTechnicians,
      });
    } catch (err) {
      console.error("walk-in options error", err);
      return res.status(500).json({ error: "Failed to load walk-in options" });
    }
  },
);

// POST /walk-in - create an on-site walk-in appointment (admin/secretary)
router.post(
  "/walk-in",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      let {
        firstName,
        lastName,
        customerPhone,
        customerEmail,
        isNewCustomer = false,
        accountConsent = false,
        address,
        customerLocation,
        serviceId,
        services,
        technicianId,
        date,
        startTime,
        issueDescription,
        paymentMethod,
        cashPaymentMode,
        paymentReference,
        downpaymentAmount,
        travelFare,
        travelTime,
        estimatedFee,
        projectScheduling,
      } = req.body || {};

      services = Array.isArray(services) ? services.slice(0, 40) : [];

      // coerce isNewCustomer to a strict boolean (handles string "true"/"false" from clients)
      isNewCustomer = isNewCustomer === true || isNewCustomer === "true";
      accountConsent = accountConsent === true || accountConsent === "true";

      firstName = String(firstName || "").trim();
      lastName = String(lastName || "").trim();
      customerPhone = String(customerPhone || "").trim();
      customerEmail = String(customerEmail || "").trim();
      issueDescription = String(issueDescription || "").trim();
      // address assumed to be object; ensure properties are strings
      address = address || {};
      address.province = String(address.province || "").trim();
      address.city = String(address.city || "").trim();
      address.barangay = String(address.barangay || "").trim();
      address.postalCode = String(address.postalCode || "").trim();
      paymentMethod = String(paymentMethod || "cod")
        .trim()
        .toLowerCase();
      const normalizedCashMode =
        String(cashPaymentMode || "downpayment")
          .trim()
          .toLowerCase() === "full"
          ? "full"
          : "downpayment";
      let normalizedReference = String(paymentReference || "").trim();
      if (!normalizedReference) {
        normalizedReference = `OR-${Date.now()}`;
      }
      const parsedTravelFare = Math.max(0, Number(travelFare) || 0);
      const parsedTravelTime = Math.max(0, Number(travelTime) || 0);
      const parsedEstimatedFee = Number(estimatedFee);
      const parsedDownpaymentAmount = Number(downpaymentAmount);

      if (!customerEmail || !normalizeEmailAddress(customerEmail)) {
        return res
          .status(400)
          .json({ error: "Valid customer email is required" });
      }
      if (!accountConsent) {
        return res.status(422).json({
          error: "Confirm the customer's consent to link this appointment to an online account and send account messages.",
          code: "CUSTOMER_ACCOUNT_CONSENT_REQUIRED",
        });
      }
      // The database is authoritative: an existing email always reuses the
      // customer account, while an unknown email creates one after validation.
      const normalizedCustomerEmail = normalizeEmailAddress(customerEmail);
      const existingCustomer = await User.findOne({
        email: normalizedCustomerEmail,
        $or: [
          { role: "customer" },
          { role: { $regex: /^customer$/i } },
          { role: { $exists: false } },
          { role: null },
        ],
      });
      const conflictingAccount = existingCustomer
        ? null
        : await User.findOne({ email: normalizedCustomerEmail }).select("_id role");
      if (conflictingAccount) {
        return res.status(409).json({ error: "This email is already used by a non-customer account." });
      }
      isNewCustomer = !existingCustomer;
      if (existingCustomer) {
        firstName = firstName || String(existingCustomer.firstName || "").trim();
        lastName = lastName || String(existingCustomer.lastName || "").trim();
        customerPhone = customerPhone || String(existingCustomer.phone || "").trim();
        const savedAddress = existingCustomer.address || {};
        address = {
          province: address.province || String(savedAddress.province || "").trim(),
          city: address.city || String(savedAddress.city || "").trim(),
          barangay: address.barangay || String(savedAddress.barangay || "").trim(),
          postalCode: address.postalCode || String(savedAddress.postalCode || "").trim(),
        };
      }
      if (!firstName || !lastName) {
        return res.status(400).json({ error: "Customer first and last name are required" });
      }
      if (!customerPhone) {
        return res.status(400).json({ error: "Customer phone is required" });
      }
      if (!address.city) {
        return res.status(400).json({ error: "Customer city is required" });
      }
      if (!serviceId && !services.length) {
        return res.status(400).json({ error: "Service is required" });
      }
      if (!date) {
        return res.status(400).json({ error: "Booking date is required" });
      }

      const startMin = parseMinuteValue(startTime);
      if (!Number.isFinite(startMin) || startMin < 0 || startMin > 1439) {
        return res.status(400).json({ error: "Invalid start time" });
      }

      const bookingDate = new Date(String(date) + "T00:00:00");
      if (Number.isNaN(bookingDate.getTime())) {
        return res.status(400).json({ error: "Invalid booking date" });
      }
      bookingDate.setHours(0, 0, 0, 0);

      // Resolve every configured service item server-side. Never trust names,
      // prices, types, or durations supplied by the browser.
      const requestedItems = services.length ? services : [{ serviceId, quantity: 1 }];
      const totalUnits = requestedItems.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
      if (totalUnits > 40) return res.status(400).json({ error: "A booking can contain a maximum of 40 units." });
      const resolvedItems = [];
      for (const requested of requestedItems) {
        const requestedId = requested.serviceId || requested._id;
        let doc = await CoreService.findOne({ _id: requestedId, active: true }).lean();
        let type = "core";
        if (!doc) { doc = await RepairService.findOne({ _id: requestedId, active: true }).lean(); type = "repair"; }
        if (!doc) return res.status(404).json({ error: "One of the selected services is unavailable." });
        const quantity = Math.max(1, Math.min(40, Number(requested.quantity) || 1));
        let unitPrice = Math.max(0, Number(type === "repair" ? (doc.initialPrice ?? doc.basePrice) : doc.basePrice) || 0);
        let durationPerUnit = Math.max(15, Number(doc.durationMinutes || doc.estimatedDurationMinutes) || 60);
        if (type === "core" && doc.isAirconService && requested.hp) {
          const airconType = (doc.airconTypes || []).find(row => row.type === requested.airconType || row.name === requested.airconTypeName);
          const pricing = airconType?.hpPricing?.length ? airconType.hpPricing : doc.hpPricing;
          const hpOption = (pricing || []).find(row => Number(row.hp) === Number(requested.hp));
          if (!hpOption) return res.status(400).json({ error: `The selected HP pricing for ${doc.name} is unavailable.` });
          unitPrice = Math.max(0, Number(hpOption.price) || 0);
          durationPerUnit = Math.max(15, Number(hpOption.durationMinutes || hpOption.duration) || durationPerUnit);
        }
        const duration = durationPerUnit * quantity;
        const problemDescription = String(requested.problemDescription || requested.repairIssue || "").trim().slice(0, 1000);
        if (type === "repair" && problemDescription.length < 10) return res.status(400).json({ error: `Describe the problem for ${doc.name} using at least 10 characters.` });
        const itemName = type === "repair" && requested.applianceType ? `${String(requested.applianceType).slice(0, 100)} Repair` : doc.name;
        resolvedItems.push({ serviceId: doc._id, name: itemName, type, quantity, unitPrice, totalPrice: unitPrice * quantity, duration,
          hp: Number(requested.hp) || undefined, hpDescription: String(requested.hpDescription || "").slice(0, 100), airconType: String(requested.airconType || "").slice(0, 100), airconTypeName: String(requested.airconTypeName || "").slice(0, 100),
          applianceType: String(requested.applianceType || doc.applianceType || "").slice(0, 100), applianceTypeName: String(requested.applianceTypeName || "").slice(0, 100),
          brand: String(requested.brand || "").slice(0, 100), model: String(requested.model || "").slice(0, 100), problemDescription,
          unitCategory: String(requested.unitCategory || "").slice(0, 50), symptoms: Array.isArray(requested.symptoms) ? requested.symptoms.slice(0, 8).map(value => String(value).slice(0, 50)) : [],
          photos: Array.isArray(requested.photos) ? requested.photos.slice(0, 5).filter(url => /^\/uploads\/repairs\/[\w.-]+$/.test(String(url))) : [],
          repairIssue: problemDescription, isAirconService: Boolean(doc.isAirconService), phase: type === "repair" ? "repair_phase_1" : "core" });
      }
      const primaryItem = resolvedItems[0];
      const serviceDoc = primaryItem;
      const serviceModelName = primaryItem.type === "repair" ? "RepairService" : "CoreService";
      const serviceDuration = resolvedItems.reduce((sum, item) => sum + item.duration, 0);
      const servicePrice = resolvedItems.reduce((sum, item) => sum + item.totalPrice, 0);
      serviceId = primaryItem.serviceId;
      const serviceEndMin = startMin + serviceDuration;
      const capacityTravelMinutes = parsedTravelTime > 0 ? parsedTravelTime : 30;
      const bookingBufferMinutes = await getBufferMinutes();
      const endMin = serviceEndMin + capacityTravelMinutes + bookingBufferMinutes;

      const schedulingEngine = require("../utils/enterpriseSchedulingEngine");
      const isLargeScale = await schedulingEngine.isLargeProject({
        totalUnits,
        totalEstimatedMinutes: serviceDuration,
      });

      const projectPrefs = projectScheduling && typeof projectScheduling === "object"
        ? (projectScheduling.preferences || {})
        : {};
      const preferredHours = {
        morning: { start: "08:00", end: "12:00" },
        afternoon: { start: "13:00", end: "17:00" },
        evening: { start: "17:00", end: "19:00" },
      }[String(projectPrefs.preferredWorkingHours || "").toLowerCase()] || undefined;
      let normalizedProjectScheduling;
      if (isLargeScale) {
        const projectStartRaw = projectScheduling?.preferredStartDate || projectScheduling?.startDate || date;
        const projectEndRaw = projectScheduling?.preferredCompletionDeadline
          || projectScheduling?.endDate
          || projectPrefs.completionDeadline;
        if (!projectEndRaw) {
          return res.status(400).json({ error: "Please select both a start date and an end date for the large-scale project." });
        }
        const projectStartDate = new Date(projectStartRaw);
        const projectEndDate = new Date(projectEndRaw);
        if (Number.isNaN(projectStartDate.getTime()) || Number.isNaN(projectEndDate.getTime()) || projectEndDate < projectStartDate) {
          return res.status(400).json({ error: "The large-scale project end date cannot be before its start date." });
        }
        const projectStartKey = /^\d{4}-\d{2}-\d{2}/.exec(String(projectStartRaw))?.[0]
          || projectStartDate.toISOString().slice(0, 10);
        const projectEndKey = /^\d{4}-\d{2}-\d{2}/.exec(String(projectEndRaw))?.[0]
          || projectEndDate.toISOString().slice(0, 10);

        const requiredHours = Math.max(1, Math.round((serviceDuration / 60) * 10) / 10);
        const windowCheck = await schedulingEngine.getProjectWindowAvailability({
          startDate: projectStartKey,
          endDate: projectEndKey,
          requiredHours,
          totalUnits,
        });
        if (!windowCheck.sufficient) {
          let message = `The selected project window does not provide enough capacity. Required: ${requiredHours} technician-hours; available: ${windowCheck.totals?.totalAvailableHours || 0} technician-hours.`;
          if (windowCheck.earliestCompletionDate) message += ` Earliest estimated completion: ${windowCheck.earliestCompletionDate}.`;
          return res.status(409).json({ error: message, validationResult: windowCheck });
        }
        normalizedProjectScheduling = {
          preferredStartDate: new Date(projectStartKey),
          preferredCompletionDeadline: new Date(projectEndKey),
          preferredWorkingDays: Array.isArray(projectPrefs.workingDays) ? projectPrefs.workingDays.slice(0, 7).map(String) : [],
          preferredWorkingHours: preferredHours,
          estimatedTotalHours: requiredHours,
        };
      }

      // Standard appointments require one technician; project requests are
      // intentionally left unassigned for Operations to build a team.
      let technicianRefId;
      let selectedTechnician = null;
      let selectedTechnicianUser = null;
      if (!isLargeScale) {
        if (!technicianId) return res.status(400).json({ error: "Technician is required" });
        technicianRefId = await resolveTechnicianRefId(technicianId);
        const Technician = require("../models/Technician");
        selectedTechnician = await Technician.findOne({
          _id: technicianRefId,
          active: { $ne: false },
          user: { $ne: null },
        }).select("_id user userEmail name phone").lean();
        selectedTechnicianUser = selectedTechnician?.user
          ? await User.findOne({
              _id: selectedTechnician.user,
              role: { $regex: /^technician$/i },
              active: { $ne: false },
              blocked: { $ne: true },
            }).select("_id email").lean()
          : null;
        if (!selectedTechnician || !selectedTechnicianUser) {
          return res.status(400).json({
            error: "The selected technician does not have an active technician account. Refresh and select another technician.",
          });
        }
        const scheduleRoutes = require("./scheduleRoutes");
        const slotCheck = await scheduleRoutes.getTimeSlotsForQuery({
          date: String(date),
          serviceId: String(serviceId),
          technicianId: String(technicianRefId),
          duration: String(serviceDuration / Math.max(1, totalUnits)),
          quantity: String(totalUnits),
          travelTime: String(capacityTravelMinutes),
        });
        const selectedSlotIsAvailable = slotCheck.statusCode < 400
          && Array.isArray(slotCheck.payload?.timeSlots)
          && slotCheck.payload.timeSlots.some(slot => parseMinuteValue(slot.startTime) === startMin);
        if (!selectedSlotIsAvailable) {
          return res.status(409).json({
            error: slotCheck.payload?.message
              || "This preferred time is no longer available for the selected technician. Please choose another date or time.",
          });
        }
        await assertNoTechnicianOverlap({
          technicianId: technicianRefId,
          bookingDate,
          startMin,
          endMin,
        });
        try {
          await assertCompanyCapacity(bookingDate, startMin, endMin);
        } catch (capacityError) {
          return res.status(409).json({ error: capacityError.message });
        }
      }

      // unique booking reference
      let bookingReference = null;
      for (let i = 0; i < 5; i++) {
        const ref = generateBookingReference();
        const exists = await BookingService.findOne({
          bookingReference: ref,
        }).lean();
        if (!exists) {
          bookingReference = ref;
          break;
        }
      }
      if (!bookingReference) bookingReference = generateBookingReference();

      const selectedTimeLabel = isLargeScale
        ? `${normalizedProjectScheduling.preferredStartDate.toLocaleDateString("en-CA")} to ${normalizedProjectScheduling.preferredCompletionDeadline.toLocaleDateString("en-CA")}`
        : `${minutesTo12h(startMin)} – ${minutesTo12h(serviceEndMin)}`;

      let locationPayload = undefined;
      // prepare a simple address string from the address object for display/snapshots
      const customerAddressStr = address
        ? [address.province, address.city, address.barangay, address.postalCode]
            .filter((v) => v && String(v).trim())
            .join(", ")
        : "";

      if (customerLocation && typeof customerLocation === "object") {
        const lat = Number(customerLocation.lat);
        const lng = Number(customerLocation.lng);
        const locAddress = String(
          customerLocation.address || customerAddressStr || "",
        ).trim();
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          locationPayload = {
            address: locAddress,
            coordinates: {
              type: "Point",
              coordinates: [lng, lat],
            },
          };
        } else if (locAddress) {
          locationPayload = { address: locAddress };
        }
      } else if (customerAddressStr) {
        locationPayload = { address: customerAddressStr };
      }

      // Price is rebuilt from server-resolved services. Do not accept a client
      // supplied estimated total that can drift from the fee breakdown.
      const computedEstimatedFee = servicePrice + parsedTravelFare;

      const effectiveTotalFee = Math.max(0, Number(computedEstimatedFee) || 0);
      let effectiveDownpayment =
        normalizedCashMode === "full"
          ? effectiveTotalFee
          : Number.isFinite(parsedDownpaymentAmount)
            ? parsedDownpaymentAmount
            : 0;

      if (!Number.isFinite(effectiveDownpayment) || effectiveDownpayment <= 0) {
        return res
          .status(400)
          .json({ error: "Downpayment amount is required for cash bookings" });
      }
      if (
        normalizedCashMode === "downpayment" &&
        effectiveTotalFee > 0 &&
        effectiveDownpayment > effectiveTotalFee
      ) {
        return res
          .status(400)
          .json({ error: "Downpayment cannot exceed estimated total fee" });
      }

      // Account type is authoritative server state. Unknown addresses create a
      // consented invitation; existing customer addresses are reused.
      const customerResult = await provisionWalkInCustomer({
        customer: {
          firstName,
          lastName,
          email: normalizedCustomerEmail,
          phone: customerPhone,
          address,
        },
        consent: accountConsent,
        invitedBy: req.user._id,
        origin: "walk_in_service",
      });
      isNewCustomer = customerResult.created;
      const customerUser =
        customerResult && customerResult.user ? customerResult.user : null;
      
      const customerSnapshotName = customerUser
        ? `${customerUser.firstName || ""} ${customerUser.lastName || ""}`.trim() ||
          customerUser.email ||
          `${firstName} ${lastName}`.trim() ||
          "Customer"
        : `${firstName} ${lastName}`.trim() || customerEmail || "Customer";
      const customerSnapshotEmail = customerUser
        ? String(customerUser.email || "").trim()
        : customerEmail;
        
      const customerSnapshotPhone = customerUser
        ? String(customerUser.phone || "").trim()
        : customerPhone;

      const appointment = new BookingService({
        bookingReference,
        customerId: customerUser ? customerUser._id : undefined,
        serviceId: primaryItem.serviceId,
        serviceModel: serviceModelName,
        service: {
          _id: primaryItem.serviceId,
          name: serviceDoc.name || "",
          description: primaryItem.problemDescription || "",
          basePrice: primaryItem.unitPrice,
        },
        servicePrice,
        serviceDurationMinutes: serviceDuration,
        serviceType: resolvedItems.some(item => item.type === "core") && resolvedItems.some(item => item.type === "repair") ? "mixed" : primaryItem.type,
        isMultiService: resolvedItems.length > 1 || totalUnits > 1,
        services: resolvedItems,
        quantity: totalUnits,
        isProject: isLargeScale,
        projectScheduling: normalizedProjectScheduling,
        unitInfo: primaryItem.type === "repair" ? { unitType: primaryItem.applianceType, brand: primaryItem.brand, model: primaryItem.model, problemDescription: primaryItem.problemDescription, photos: primaryItem.photos } : undefined,
        totalPrice: servicePrice + parsedTravelFare,
        totalInitialCost: resolvedItems.filter(item => item.type === "repair").reduce((sum, item) => sum + item.totalPrice, 0),
        bookingDate,
        startTime: isLargeScale ? undefined : String(startMin),
        endTime: isLargeScale ? undefined : String(endMin),
        selectedTimeLabel: isLargeScale ? undefined : selectedTimeLabel,
        technicianId: isLargeScale ? undefined : technicianRefId,
        customer: {
          _id: customerUser ? customerUser._id : undefined,
          name: customerSnapshotName || customerSnapshotEmail || "Customer",
          email: customerSnapshotEmail,
          phone: customerSnapshotPhone,
          address: customerAddressStr,
        },
        customerAccountAccess: {
          consentedAt: new Date(),
          capturedBy: req.user._id,
          stateAtCheckout: customerResult.state,
          invitationDelivery: customerResult.state === "pending_verification"
            ? "pending_registration"
            : "not_sent",
        },
        location: locationPayload,
        issueDescription: issueDescription || undefined,
        // A standard walk-in is not confirmed merely because the admin chose
        // a technician. Confirmation happens only in the technician accept API.
        // Keep a recoverable queue state until the Assignment itself has been
        // persisted. This prevents an "assigned" booking with no technician
        // job if assignment creation fails midway.
        status: isLargeScale ? BookingStatus.PENDING_PROJECT_SCHEDULING : BookingStatus.AWAITING_ASSIGNMENT,
        paymentMethod: "cod",
        paymentReference: normalizedReference,
        downpaymentAmount: effectiveDownpayment,
        paymentStatus: normalizedCashMode === "full" ? "paid" : "partial",
        travelFare: parsedTravelFare,
        travelTime: capacityTravelMinutes,
        estimatedFee: computedEstimatedFee,
      });

      await appointment.save();

      // Standard walk-ins follow the same acceptance pipeline as customer
      // bookings: create the technician assignment, show the booking in the
      // admin waiting tab, and notify the technician. Large-scale bookings
      // stay in project planning because they require a technician team.
      let assignment = null;
      if (!isLargeScale) {
        const Assignment = require("../models/Assignment");
        const assignedAt = new Date();
        const coordinateValues = locationPayload?.coordinates?.coordinates;
        const assignmentServiceName = resolvedItems
          .map(item => item.quantity > 1 ? `${item.name} (${item.quantity})` : item.name)
          .join(", ");

        assignment = new Assignment({
          bookingId: appointment._id,
          technicianId: selectedTechnician._id,
          customerName: customerSnapshotName,
          customerPhone: customerSnapshotPhone,
          customerEmail: customerSnapshotEmail,
          serviceName: assignmentServiceName,
          serviceType: appointment.serviceType,
          servicePrice,
          quantity: totalUnits,
          bookingDate,
          startTime: String(startMin),
          endTime: String(endMin),
          address: locationPayload?.address || customerAddressStr,
          coordinates: Array.isArray(coordinateValues) && coordinateValues.length >= 2
            ? { lat: Number(coordinateValues[1]), lng: Number(coordinateValues[0]) }
            : undefined,
          status: "pending_acceptance",
          priority: "normal",
          assignedAt,
          acceptanceDeadline: calculateTechnicianAcceptanceDeadline(bookingDate, assignedAt),
          slaDeadline: new Date(assignedAt.getTime() + 2 * 60 * 60 * 1000),
          responseSLAMinutes: 30,
          estimatedFee: effectiveTotalFee,
          travelFare: parsedTravelFare,
          travelTime: capacityTravelMinutes,
          notes: [{
            text: "Walk-in booking assigned by admin/secretary",
            by: req.user?._id,
            byName: req.user?.name || req.user?.email || "Admin/Secretary",
          }],
        });
        await assignment.save();

        // Selection by an admin is only an assignment offer. The booking must
        // stay here until the technician explicitly accepts it.
        appointment.status = BookingStatus.ASSIGNED;
        appointment.assignmentId = assignment._id;
        appointment.assignedAt = assignedAt;
        appointment.assignedBy = req.user?._id;
        for (const item of appointment.services || []) {
          item.status = "assigned";
          item.technicianId = selectedTechnician._id;
          item.technicianName = selectedTechnician.name;
          item.assignmentId = assignment._id;
          item.schedule = {
            date: bookingDate,
            startTime: String(startMin),
            endTime: String(endMin),
            durationMinutes: Number(item.duration) || serviceDuration,
            kind: item.type === "repair" ? "inspection" : "service",
          };
          item.statusHistory.push({
            status: "assigned",
            changedAt: assignedAt,
            changedBy: req.user?._id,
            changedByName: req.user?.name || req.user?.email || "Admin/Secretary",
            reason: "Walk-in assignment awaiting technician acceptance",
          });
        }
        await appointment.save();

        const io = req.app.get("io");
        if (io) {
          io.to(`tech:${selectedTechnician._id}`).emit("assignment:new", {
            assignmentId: assignment._id,
            bookingId: appointment._id,
            bookingReference,
            serviceName: assignmentServiceName,
            customerName: customerSnapshotName,
            bookingDate,
            acceptanceDeadline: assignment.acceptanceDeadline,
            priority: "normal",
          });
        }

        await createNotification({
          type: "assignment_new",
          title: "New Walk-in Assignment",
          message: `A walk-in ${assignmentServiceName} booking for ${customerSnapshotName} is waiting for your acceptance.`,
          userId: selectedTechnicianUser._id,
          role: "technician",
          referenceId: assignment._id,
          referenceModel: "Assignment",
          link: "/technician/assignments",
          priority: "high",
          io,
        }).catch(err => console.warn("walk-in technician notification failed", err?.message));

        const technicianEmail = selectedTechnician.userEmail || selectedTechnicianUser.email || "";
        if (technicianEmail) {
          sendTechnicianNotificationEmail({
            to: technicianEmail,
            technicianName: selectedTechnician.name || "Technician",
            customerName: customerSnapshotName,
            bookingReference,
            serviceName: assignmentServiceName,
            dateLabel: bookingDate.toLocaleDateString("en-PH", {
              weekday: "long", year: "numeric", month: "long", day: "numeric",
            }),
            timeLabel: selectedTimeLabel,
            totalLabel: `₱${effectiveTotalFee.toLocaleString()}`,
            locationAddress: locationPayload?.address || customerAddressStr,
            issueDescription,
          }).catch(err => console.warn("walk-in technician email failed", err?.message));
        }
      }

      // Large unit counts or workloads beyond one working day enter project
      // planning. Operations owns the final multi-day technician team.
      if (isLargeScale) {
        const Project = require("../models/Project");
        await Project.findOneAndUpdate(
          { bookingId: appointment._id },
          { $setOnInsert: {
            bookingId: appointment._id, customerId: customerUser._id,
            customer: { _id: customerUser._id, name: customerSnapshotName, email: customerSnapshotEmail, phone: customerSnapshotPhone, address: customerAddressStr },
            service: { name: resolvedItems.map(item => item.name).join(", "), description: issueDescription || "Walk-in large-scale service project", category: appointment.serviceType },
            status: "pending_project_scheduling", isLargeScale: true, projectPhase: appointment.serviceType === "repair" ? "assessment" : "execution",
            estimatedTotalHours: serviceDuration / 60, totalUnits, quantity: totalUnits,
            estimatedDurationPerUnit: serviceDuration / 60 / totalUnits,
            preferredStartDate: normalizedProjectScheduling.preferredStartDate,
            preferredCompletionDeadline: normalizedProjectScheduling.preferredCompletionDeadline,
            preferredWorkingDays: normalizedProjectScheduling.preferredWorkingDays,
            preferredWorkingHours: normalizedProjectScheduling.preferredWorkingHours,
            location: locationPayload,
            assignedTechnicians: [], totalAssignedTechnicians: 0, reservedTechnicians: 1,
          } },
          { upsert: true, returnDocument: "after" }
        );
        try {
          await schedulingEngine.reserveProjectCapacity({
            bookingId: appointment._id,
            startDate: normalizedProjectScheduling.preferredStartDate,
            endDate: normalizedProjectScheduling.preferredCompletionDeadline,
            reservedTechnicians: 1,
          });
        } catch (reserveError) {
          console.warn("walk-in project capacity reservation failed", reserveError?.message);
        }
      }

      let accountMessageDelivery = customerResult.state === "pending_verification"
        ? "pending_registration"
        : "not_sent";
      if (customerSnapshotEmail) {
        try {
          const baseUrl = String(
            process.env.APP_BASE_URL ||
            process.env.APP_URL ||
            `${req.protocol}://${req.get("host")}`,
          ).replace(/\/$/, "");
          const activationUrl = customerResult.activationToken
            ? `${baseUrl}/activate-account?token=${encodeURIComponent(customerResult.activationToken)}`
            : null;
          const mailAccepted = await sendWalkInBookingAccountEmail({
            to: customerSnapshotEmail,
            customerName: customerSnapshotName,
            bookingReference,
            activationUrl,
            trackingUrl: `${baseUrl}/book-history`,
            serviceName: resolvedItems.map((item) => item.name).join(", "),
            scheduleLabel: isLargeScale
              ? `${date} (project scheduling request)`
              : `${date} ${selectedTimeLabel}`,
          });
          accountMessageDelivery = mailAccepted ? "accepted" : "failed";
        } catch (mailErr) {
          accountMessageDelivery = "failed";
          console.warn(
            "walk-in account email failed",
            mailErr && mailErr.message,
          );
        }
      }
      appointment.customerAccountAccess.invitationDelivery = accountMessageDelivery;
      appointment.customerAccountAccess.invitationSentAt =
        accountMessageDelivery === "accepted" ? new Date() : null;
      await appointment.save();

      // create payment row aligned with cash mode (status auto-calculated)
      try {
        const paymentType =
          normalizedCashMode === "full" ? "final" : "downpayment";
        const status = normalizedCashMode === "full" ? "paid" : "partial";

        await Payment.create({
          bookingId: appointment._id,
          amount: effectiveDownpayment,
          method: "cod",
          gateway: "cod",
          type: paymentType,
          status,
          paidAt: new Date(),
          completedAt: new Date(),
          reference: normalizedReference,
          notes:
            normalizedCashMode === "full"
              ? "Walk-in cash full payment recorded by admin/secretary."
              : "Walk-in cash downpayment recorded by admin/secretary.",
        });
      } catch (paymentErr) {
        console.warn(
          "walk-in payment create failed",
          paymentErr && paymentErr.message,
        );
      }

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appointment._id,
        action: "appointment.walkin.create",
        module: "appointments",
        req,
        details: {
          bookingReference,
          customerName: customerSnapshotName,
          customerEmail: customerSnapshotEmail,
          customerPhone: customerSnapshotPhone,
          serviceId: primaryItem.serviceId,
          technicianId: technicianRefId,
          date,
          startTime,
          cashPaymentMode: normalizedCashMode,
          downpaymentAmount: effectiveDownpayment,
          customerAccountState: customerResult.state,
          customerAccountCreated: customerResult.created,
          accountConsentCaptured: true,
          accountMessageDelivery,
        },
      });

      return res.status(201).json({
        message: "Walk-in appointment created successfully",
        customerAccountCreated: Boolean(
          customerResult && customerResult.created,
        ),
        customerAccount: {
          state: customerResult.state,
          invitationDelivery: accountMessageDelivery,
        },
        appointment,
        assignment,
        customer:
          customerResult && customerResult.user
            ? {
                id: customerResult.user._id,
                email: customerResult.user.email,
                firstName: customerResult.user.firstName,
                lastName: customerResult.user.lastName,
                phone: customerResult.user.phone,
              }
            : null,
      });
    } catch (err) {
      console.error("walk-in create error", err);
      return res.status(Number(err && err.status) || 500).json({
        error:
          err && err.message
            ? err.message
            : "Failed to create walk-in appointment",
        ...(err && err.code ? { code: err.code } : {}),
      });
    }
  });

router.get("/:id", auth.authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    const appt = await BookingService.findById(id)
      .populate("serviceId")
      .populate("customerId", "firstName lastName email phone mobile address")
      .populate("technicianId", "firstName lastName phone location availabilityStatus")
      .lean();
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    if (!(await canAccessBooking(req.user, appt))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Attach related payment records and compute amountPaid for convenience
    try {
      const payments = await Payment.find({ bookingId: appt._id }).lean();
      appt.payments = payments || [];
      const amountPaid = (payments || []).reduce((s, p) => {
        const amt = Number((p && (p.amount || p.paidAmount)) || 0);
        const st = String(p && p.status || "").toLowerCase();
        // count only payments that are marked paid/paid-like
        if (!isNaN(amt) && amt > 0 && (st === "paid" || st === "succeeded" || st === "completed" || st === "verified")) return s + amt;
        // also include payments with no explicit status (legacy)
        if (!st && !isNaN(amt) && amt > 0) return s + amt;
        return s;
      }, 0);
      appt.amountPaid = amountPaid;
    } catch (payErr) {
      // don't fail the whole request for payment lookup errors
      console.warn('Failed to fetch payments for appointment', id, payErr && payErr.message);
      appt.payments = appt.payments || [];
      appt.amountPaid = appt.amountPaid || 0;
    }

    // Merge large-scale project data so customer tracking shows correct totals,
    // units, assigned team, and progress.
    // Look up a linked project even when legacy BookingService.isProject was
    // not backfilled. The detail refresh must preserve the same project data
    // supplied by the initial /tracking page render.
    {
      try {
        const Project = require("../models/Project");
        const WorkOrder = require("../models/WorkOrder");
        const DailyAssignment = require("../models/DailyAssignment");
        const { calculateProjectCustomerPricing } = require("../utils/projectPricing");
        const project = await Project.findOne({ bookingId: appt._id })
          .select("customer service status projectPhase totalUnits completedUnits payment quotationReview location assignedTechnicians leadTechnicianId plannedStartDate plannedCompletionDate preferredStartDate preferredCompletionDeadline dailyAcceptance")
          .lean();
        if (project) {
          const [workOrders, dailyRows] = await Promise.all([
            WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } })
              .select("unitCount completedUnitCount status scheduledDate scheduledEndDate")
              .lean(),
            DailyAssignment.find({ projectId: project._id, status: { $ne: "skipped" } })
              .select("date startTime endTime targetUnits completedUnits")
              .sort({ date: 1, startTime: 1 })
              .lean(),
          ]);
          const trackedTotal = workOrders.reduce((sum, order) => sum + Number(order.unitCount || 0), 0);
          const trackedDone = workOrders.reduce((sum, order) => sum + Number(order.completedUnitCount || 0), 0);
          const totalUnits = trackedTotal || Number(project.totalUnits || appt.quantity || 0);
          const completedUnits = workOrders.length ? trackedDone : Number(project.completedUnits || 0);
          const pricing = calculateProjectCustomerPricing({ project, booking: appt, workOrders, dailyRows });
          const lead = (project.assignedTechnicians || []).find(member => String(member._id) === String(project.leadTechnicianId))
            || (project.assignedTechnicians || [])[0];
          const scheduleStart = project.plannedStartDate || project.preferredStartDate || dailyRows[0]?.date || appt.bookingDate;
          const scheduleEnd = project.plannedCompletionDate || project.preferredCompletionDeadline || dailyRows[dailyRows.length - 1]?.date || scheduleStart;
          const projectStatusMap = {
            pending_project_scheduling: "pending",
            accepted: "confirmed",
            planning: "confirmed",
            ready: "confirmed",
            in_progress: "in-progress",
            completed: "completed",
            closed: "completed",
            cancelled: "cancelled",
            on_hold: "scheduled",
          };
          appt.isProject = true;
          appt.projectId = String(project._id);
          appt.project = {
            status: project.status,
            phase: project.projectPhase || "execution",
            totalUnits,
            completedUnits,
            remainingUnits: Math.max(0, totalUnits - completedUnits),
            completionPct: totalUnits ? Math.round((completedUnits / totalUnits) * 100) : 0,
            scheduleStart,
            scheduleEnd,
            team: (project.assignedTechnicians || []).map(member => ({ _id: member._id, name: member.name, phone: member.phone })),
            leadTechnicianId: project.leadTechnicianId || lead?._id || null,
            dailyAcceptanceRequired: Boolean(project.dailyAcceptance?.required),
            workOrders: workOrders.map(order => ({
              _id: order._id,
              status: order.status,
              unitCount: Number(order.unitCount || 0),
              completedUnitCount: Number(order.completedUnitCount || 0),
              scheduledDate: order.scheduledDate,
              scheduledEndDate: order.scheduledEndDate,
            })),
            pricing,
          };
          appt.status = projectStatusMap[project.status] || appt.status;
          if (scheduleStart) appt.bookingDate = scheduleStart;
          appt.projectEndDate = scheduleEnd;
          if (project.customer && project.customer.name) appt.customer = project.customer;
          if (project.service && project.service.name) {
            if (!appt.service) appt.service = {};
            appt.service.name = project.service.name;
          }
          if (project.location && (project.location.lat || project.location.lng || project.location.address)) {
            appt.location = {
              address: project.location.address || appt.location?.address,
              lat: project.location.lat,
              lng: project.location.lng,
              coordinates: { type: "Point", coordinates: [project.location.lng, project.location.lat] },
            };
          }
          if (lead) {
            appt.technicianId = String(lead._id);
            appt.technicianName = lead.name;
            appt.technicianPhone = lead.phone;
            appt.technician = { name: lead.name, phone: lead.phone };
          }
          if (totalUnits) appt.quantity = totalUnits;
          appt.completedUnits = completedUnits;

          const projectMethod = project.payment?.paymentMethod || "";
          appt.totalPrice = pricing.total;
          appt.travelFare = pricing.travelFare;
          appt.amountPaid = pricing.alreadyPaid;
          appt.balanceAmount = pricing.balance;
          if (projectMethod) appt.paymentMethod = projectMethod;

          // Re-calculate amount paid from project payment records when available
          try {
            const projectPayments = await Payment.find({
              $or: [{ bookingId: appt._id }, { projectId: project._id }],
              status: { $in: ["paid", "succeeded", "completed", "verified"] },
            }).lean();
            const totalPaid = (projectPayments || []).reduce((s, p) => s + Number((p && (p.amount || p.paidAmount)) || 0), 0);
            if (totalPaid > 0) appt.amountPaid = totalPaid;
          } catch (_) {}
        }
      } catch (projErr) {
        console.warn('Failed to merge project data for appointment', id, projErr && projErr.message);
      }
    }

    return res.json({ appointment: appt });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load appointment" });
  }
});

// GET /:id - single appointment (basic)
router.get("/:id", auth.authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    const appt = await BookingService.findById(id).populate("serviceId").lean();
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    if (!(await canAccessBooking(req.user, appt))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.json({ appointment: appt });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load appointment" });
  }
});

// Approve appointment (admin/secretary)
router.post(
  "/:id/approve",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // Reject confirmation of past bookings — require reschedule instead
      if (isBookingPast(appt)) {
        return res.status(400).json({
          error: "Cannot confirm an appointment whose scheduled time has passed. Please reschedule this booking to a future date/time before confirming.",
        });
      }

      // normalize technician reference so downstream schedule/calendar queries
      // (which use Technician._id) can pick up this confirmed booking.
      if (appt.technicianId) {
        appt.technicianId = await resolveTechnicianRefId(appt.technicianId);
      }

      appt.status = "confirmed";
      // if there is a related payment record, mark it paid as part of confirmation
      try {
        const Payment = require("../models/Payment");
        const pay = await Payment.findOne({ bookingId: appt._id }).sort({
          submittedAt: -1,
        });
        if (pay && String(pay.status || "").toLowerCase() !== "paid") {
          pay.status = "paid";
          if (!pay.paidAt) pay.paidAt = new Date();
          if (!pay.completedAt) pay.completedAt = new Date();
          // add note indicating admin approved via booking
          pay.notes = pay.notes
            ? pay.notes + "\nAuto-marked paid when booking approved."
            : "Auto-marked paid when booking approved.";
          await pay.save();
          // sync booking paymentStatus
          appt.paymentStatus = "paid";
        }
      } catch (payErr) {
        console.warn(
          "approve handler: failed to sync payment",
          payErr && payErr.message,
        );
      }
      await appt.save();

      // send confirmation email to customer (similar to original booking flow)
      try {
        const {
          sendBookingConfirmationEmail,
          sendTechnicianNotificationEmail,
        } = require("../utils/mailer");
        let customerEmail = null;
        let customerName = "Valued Customer";
        if (appt.customer && appt.customer.email) {
          customerEmail = appt.customer.email;
          customerName =
            appt.customer.name || appt.customer.fullName || customerName;
        } else if (appt.customerEmail) {
          customerEmail = appt.customerEmail;
        }
        // compute common labels for email outside the condition so they can be used
        // for technician notification as well
        const bookingReference = appt.bookingReference || String(appt._id);
        const serviceName =
          (appt.service && (appt.service.name || appt.service.title)) ||
          appt.serviceType ||
          "Service";
        const bookingDate = appt.bookingDate || new Date();
        const startMin = parseMinuteValue(appt.startTime);
        const duration = Number(appt.serviceDurationMinutes) || 0;
        const travelMins = Number(appt.travelTime) || 0;
        const dateLabel = bookingDate.toLocaleDateString("en-PH", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
        // reuse helper defined earlier in this file
        const timeLabel =
          !isNaN(startMin) && duration
            ? `${minutesTo12h(startMin)} – ${minutesTo12h(startMin + duration)}`
            : appt.startTime || "";
        const totalLabel = travelMins
          ? `${minutesTo12h(startMin)} – ${minutesTo12h(startMin + duration + travelMins)} (incl. ${travelMins}m travel)`
          : timeLabel;
        if (customerEmail) {
          await sendBookingConfirmationEmail({
            to: customerEmail,
            customerName,
            bookingReference,
            serviceName,
            dateLabel,
            timeLabel,
            totalLabel,
            paymentMethod: appt.paymentMethod,
            estimatedFee: appt.estimatedFee,
            locationAddress: (appt.location && appt.location.address) || "",
            issueDescription: appt.issueDescription || "",
            travelMins,
            serviceDuration: duration,
            isConfirmed: true,
          }).catch((e) =>
            console.warn("confirmation email failed", e && e.message),
          );
        }
        // also notify technician if associated *and* the booking has been
        // elevated to scheduled. confirmation alone is not enough.
        if (appt.technicianId && appt.status === "scheduled") {
          try {
            const Technician = require("../models/Technician");
            const tech = await Technician.findById(appt.technicianId).lean();
            const techEmail = tech?.email || tech?.user?.email;
            const techName = tech?.name || tech?.fullName || "Technician";
            if (techEmail) {
              await sendTechnicianNotificationEmail({
                to: techEmail,
                technicianName: techName,
                customerName: customerName,
                bookingReference: bookingReference,
                serviceName: serviceName,
                dateLabel,
                timeLabel,
                totalLabel,
                locationAddress: (appt.location && appt.location.address) || "",
                issueDescription: appt.issueDescription || "",
              });
            }
          } catch (e) {
            console.warn("technician email (confirm) failed", e && e.message);
          }
        }
      } catch (e) {
        console.warn("approve handler: mailing error", e && e.message);
      }

      // Server-side: create Google Calendar event when appointment is confirmed
      if (googleCalendarSync.isConfigured() && !appt.googleCalendarEventId) {
        try {
          // determine duration (best‑effort) from whatever service document is linked
          let duration = 60;
          if (appt.serviceId) {
            // serviceId may already be populated; fall back to raw ObjectId properties
            const svc = appt.serviceId;
            if (svc.durationMinutes) duration = svc.durationMinutes;
            else if (svc.duration) duration = svc.duration;
            else if (svc.estimatedDurationMinutes)
              duration = svc.estimatedDurationMinutes;
          }

          const created = await googleCalendarSync.createEventForBooking({
            booking: appt,
            durationMinutes: duration,
          });
          if (created && created.eventId) {
            appt.googleCalendarEventId = created.eventId;
            appt.googleCalendarId = created.calendarId || appt.googleCalendarId;
            appt.googleCalendarHtmlLink =
              created.raw?.htmlLink ||
              created.htmlLink ||
              appt.googleCalendarHtmlLink;
            await appt.save();
          }
        } catch (err) {
          console.warn(
            "Failed to sync approved appointment to Google Calendar",
            err && (err.message || err),
          );
        }
      }

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.approve",
        module: "appointments",
        req,
        details: { appointmentId: id },
      });
      return res.json({ message: "Appointment approved", appointment: appt });
    } catch (err) {
      console.error("approve error", err);
      return res.status(500).json({ error: "Failed to approve appointment" });
    }
  },
);

// Cancel appointment (admin/secretary/customer for own pending appointments)
router.post(
  "/:id/cancel",
  auth.authenticate,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { reason } = req.body;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // Check if user is admin or secretary
      const isAdmin = req.user && req.user.role === "admin";
      const isSecretary = req.user && req.user.role === "secretary";

      // Check if user is the customer
      const isCustomer = req.user && (
        String(appt.customerId) === String(req.user._id) ||
        String(appt.customer) === String(req.user.email)
      );

      // Only allow cancellation if:
      // 1. User is admin or secretary, OR
      // 2. User is the customer AND appointment is pending
      if (!isAdmin && !isSecretary) {
        if (!isCustomer) {
          return res.status(403).json({ error: "You can only cancel your own appointments" });
        }
        if (appt.status !== "pending") {
          return res.status(400).json({ error: "Only pending appointments can be cancelled" });
        }
      }

      appt.status = "cancelled";
      // Store cancellation reason
      if (reason && reason.trim()) {
        appt.cancellationReason = reason.trim();
        // Also add to notes if notes field exists
        if (!appt.notes) {
          appt.notes = `Cancellation reason: ${reason.trim()}`;
        } else {
          appt.notes += `\n\nCancellation reason: ${reason.trim()}`;
        }
      }
      await appt.save();

      // server-side: remove calendar event if present
      if (googleCalendarSync.isConfigured() && appt.googleCalendarEventId) {
        try {
          await googleCalendarSync.deleteEvent({
            eventId: appt.googleCalendarEventId,
            calendarIdOverride: appt.googleCalendarId,
          });
          appt.googleCalendarEventId = undefined;
          appt.googleCalendarId = undefined;
          appt.googleCalendarHtmlLink = undefined;
          await appt.save();
        } catch (e) {
          console.warn(
            "Failed to delete calendar event on cancel",
            e && e.message,
          );
        }
      }

      // TimeSlot model removed; no timeslot release to perform

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.cancel",
        module: "appointments",
        req,
        details: { appointmentId: id, reason: reason },
      });
      return res.json({ message: "Appointment cancelled", appointment: appt });
    } catch (err) {
      console.error("cancel error", err);
      return res.status(500).json({ error: "Failed to cancel appointment" });
    }
  },
);

// Submit reschedule request (customer for own pending appointments)
router.post(
  "/:id/reschedule-request",
  auth.authenticate,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { requestedDate, requestedTime, newDate, newTime, reason } = req.body;
      const finalDate = newDate || requestedDate;
      const finalTime = newTime || requestedTime;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // Check if user is the customer
      const isCustomer = req.user && (
        String(appt.customerId) === String(req.user._id) ||
        String(appt.customer) === String(req.user.email)
      );

      if (!isCustomer) {
        return res.status(403).json({ error: "You can only request reschedule for your own appointments" });
      }

      // Only allow reschedule requests for confirmed/scheduled/pending/inspection appointments
      const eligibleStatuses = ["confirmed", "scheduled", "pending", "inspection_scheduled", "awaiting_approval"];
      if (!eligibleStatuses.includes(appt.status)) {
        return res.status(400).json({ error: "Only confirmed or scheduled appointments can be rescheduled" });
      }

      // Validate required fields
      if (!finalDate || !finalTime || !reason) {
        return res.status(400).json({ error: "New date, time, and reason are required" });
      }

      // Check for scheduling conflicts
      const requestedStart = finalTime;
      const hasConflict = await BookingService.findOne({
        _id: { $ne: appt._id },
        bookingDate: finalDate,
        startTime: requestedStart,
        status: { $in: ["confirmed", "scheduled", "in-progress", "en-route", "on-the-way"] },
      });
      if (hasConflict) {
        return res.status(409).json({ error: "The selected time slot is already booked. Please choose a different time." });
      }

      // Store reschedule request
      appt.rescheduleRequest = {
        requested: true,
        requestedDate: finalDate,
        requestedTime: finalTime,
        reason: reason,
        requestedBy: req.user._id,
        requestedAt: new Date(),
        status: "pending" // pending, approved, rejected
      };

      await appt.save();

      // -- Socket notification to admin room -------------------------------------
      try {
        const io = req.app.get("io");
        if (io) {
          io.to("admin-room").emit("booking:reschedule-requested", {
            bookingId: appt._id,
            bookingRef: appt.bookingReference,
            customerName: appt.customer?.name || "Customer",
            serviceName: appt.serviceName || appt.service?.name || "Service",
            currentDate: appt.bookingDate,
            currentTime: appt.startTime,
            requestedDate: finalDate,
            requestedTime: finalTime,
            reason,
            message: `Customer requested reschedule for ${appt.bookingReference || "booking"}`,
            timestamp: Date.now(),
          });
        }
      } catch (sockErr) {
        console.warn("[socket] reschedule-requested emit failed", sockErr?.message);
      }

      // -- Email admin: reschedule request received ------------------------------
      try {
        const { sendRescheduleRequestedEmail } = require("../utils/mailer");
        const Admin = require("../models/User");
        const adminUsers = await Admin.find({ role: "admin" }).lean();
        const dateLabel = appt.bookingDate
          ? new Date(appt.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        for (const admin of adminUsers) {
          if (admin.email) {
            sendRescheduleRequestedEmail({
              to: admin.email,
              adminName: admin.firstName || admin.name || "Admin",
              customerName: appt.customer?.name || "Customer",
              bookingReference: appt.bookingReference || `#${String(appt._id).slice(-6).toUpperCase()}`,
              serviceName: appt.serviceName || appt.service?.name || "Service",
              currentDate: dateLabel,
              currentTime: appt.startTime || "TBD",
              requestedDate: finalDate,
              requestedTime: finalTime,
              reason,
            }).catch(err => console.error("[MAILER] Failed to send reschedule request email:", err.message));
          }
        }
      } catch (mailErr) {
        console.error("[MAILER] Reschedule request email error:", mailErr.message);
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.reschedule_request",
        module: "appointments",
        req,
        details: {
          appointmentId: id,
          requestedDate: finalDate,
          requestedTime: finalTime,
          reason
        },
      });

      return res.json({
        success: true,
        message: "Reschedule request submitted successfully",
        appointment: appt
      });
    } catch (err) {
      console.error("reschedule request error", err);
      return res.status(500).json({ error: "Failed to submit reschedule request" });
    }
  },
);

// Approve reschedule request (admin/secretary)
router.post(
  "/:id/reschedule-approve",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // Check if there's a pending reschedule request
      if (!appt.rescheduleRequest || appt.rescheduleRequest.status !== "pending") {
        return res.status(400).json({ error: "No pending reschedule request found" });
      }

      const newDate = appt.rescheduleRequest.requestedDate;
      const newTime = appt.rescheduleRequest.requestedTime;

      // Guard against double-booking before committing the requested slot.
      const rwStartMin = parseTimeValue(newTime);
      if (!Number.isFinite(rwStartMin)) {
        return res.status(400).json({ error: 'Invalid requested time format' });
      }
      const rwEndMin = rwStartMin + (Number(appt.serviceDurationMinutes) || 90);
      try {
        await assertCompanyCapacity(new Date(newDate), rwStartMin, rwEndMin, appt._id);
      } catch (capErr) {
        return res.status(409).json({ error: capErr.message });
      }

      // Update appointment with new date/time
      appt.bookingDate = new Date(newDate);
      appt.startTime = newTime;

      // Update reschedule request status
      appt.rescheduleRequest.status = "approved";
      appt.rescheduleRequest.processedBy = req.user._id;
      appt.rescheduleRequest.processedAt = new Date();

      // Move to assignment queue so admin can assign a technician
      appt.status = "awaiting_assignment";
      appt.rescheduleReason = appt.rescheduleRequest.reason;

      // Push status history
      if (!appt.statusHistory) appt.statusHistory = [];
      appt.statusHistory.push({
        status: "awaiting_assignment",
        message: `Rescheduled to ${newDate} at ${newTime}`,
        date: new Date(),
        by: req.user.firstName || req.user.name || "Admin",
      });

      await appt.save();

      // -- Update linked Assignment(s) -------------------------------------------
      const Assignment = require("../models/Assignment");
      try {
        const activeAssignment = await Assignment.findOne({
          bookingId: appt._id,
          status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site"] },
        });

        if (activeAssignment) {
          // Cancel old assignment so a new one can be created
          activeAssignment.status = "cancelled";
          activeAssignment.cancelledAt = new Date();
          activeAssignment.notes.push({
            text: `Booking rescheduled to ${newDate} at ${newTime}. Assignment cancelled for re-assignment.`,
            by: req.user._id,
            byName: req.user.firstName || req.user.name || "Admin",
            createdAt: new Date(),
          });
          await activeAssignment.save();

          // Create new assignment in pending_acceptance for the new date
          await Assignment.create({
            bookingId: appt._id,
            customerName: appt.customer?.name || "Customer",
            customerPhone: appt.customer?.phone || "",
            customerEmail: appt.customer?.email || "",
            serviceType: appt.serviceType || "core",
            serviceName: appt.serviceName || appt.service?.name || "Service",
            servicePrice: appt.totalPrice || appt.estimatedFee || 0,
            bookingDate: appt.bookingDate,
            startTime: appt.startTime,
            endTime: appt.endTime || "",
            address: appt.location?.address || "",
            coordinates: appt.location || {},
            estimatedFee: appt.estimatedFee || 0,
            travelTime: appt.travelDurationMinutes || 0,
            status: "pending_acceptance",
            priority: "normal",
          });
        }
      } catch (assignErr) {
        console.error("[RESCHEDULE] Failed to update assignment:", assignErr.message);
      }

      // -- Socket notification to customer ---------------------------------------
      try {
        const io = req.app.get("io");
        if (io) {
          const customerId = appt.customerId?._id || appt.customerId;
          if (customerId) {
            io.to("customer:" + customerId).emit("booking:reschedule-approved", {
              bookingId: appt._id,
              bookingRef: appt.bookingReference,
              newDate: newDate,
              newTime: newTime,
              message: `Your reschedule request has been approved. New date: ${newDate} at ${newTime}`,
              timestamp: Date.now(),
            });
          }
          // Notify admin room
          io.to("admin-room").emit("booking:reschedule-approved", {
            bookingId: appt._id,
            bookingRef: appt.bookingReference,
            newDate: newDate,
            newTime: newTime,
            timestamp: Date.now(),
          });
        }
      } catch (sockErr) {
        console.warn("[socket] reschedule-approved emit failed", sockErr?.message);
      }

      // -- Email customer: approved ----------------------------------------------
      try {
        const { sendRescheduleApprovedEmail } = require("../utils/mailer");
        let customerEmail = appt.customer?.email || null;
        let customerName = appt.customer?.name || "Customer";
        if (!customerEmail && appt.customerId) {
          const User = require("../models/User");
          const custUser = await User.findById(appt.customerId).lean();
          if (custUser) {
            customerEmail = custUser.email;
            customerName = custUser.firstName && custUser.lastName
              ? `${custUser.firstName} ${custUser.lastName}`
              : custUser.name || customerName;
          }
        }
        if (customerEmail) {
          // Format date for email
          const dateLabel = new Date(appt.bookingDate).toLocaleDateString("en-PH", {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
          });
          sendRescheduleApprovedEmail({
            to: customerEmail,
            customerName,
            bookingReference: appt.bookingReference || `#${String(appt._id).slice(-6).toUpperCase()}`,
            serviceName: appt.serviceName || appt.service?.name || "Service",
            newDate: dateLabel,
            newTime: newTime,
          }).catch(err => console.error("[MAILER] Failed to send reschedule approved email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Reschedule approved email error:", mailErr.message);
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.reschedule_approve",
        module: "appointments",
        req,
        details: {
          appointmentId: id,
          newDate: newDate,
          newTime: newTime,
        },
      });

      return res.json({
        message: "Reschedule request approved",
        appointment: appt,
      });
    } catch (err) {
      console.error("reschedule approve error", err);
      return res.status(500).json({ error: "Failed to approve reschedule request" });
    }
  },
);

// Reject reschedule request (admin/secretary)
router.post(
  "/:id/reschedule-reject",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const { reason } = req.body;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // Check if there's a pending reschedule request
      if (!appt.rescheduleRequest || appt.rescheduleRequest.status !== "pending") {
        return res.status(400).json({ error: "No pending reschedule request found" });
      }

      const requestedDate = appt.rescheduleRequest.requestedDate;
      const requestedTime = appt.rescheduleRequest.requestedTime;

      // Update reschedule request status
      appt.rescheduleRequest.status = "rejected";
      appt.rescheduleRequest.processedBy = req.user._id;
      appt.rescheduleRequest.processedAt = new Date();
      appt.rescheduleRequest.rejectionReason = reason || "Request rejected by administrator";

      await appt.save();

      // -- Socket notification to customer ---------------------------------------
      try {
        const io = req.app.get("io");
        if (io) {
          const customerId = appt.customerId?._id || appt.customerId;
          if (customerId) {
            io.to("customer:" + customerId).emit("booking:reschedule-rejected", {
              bookingId: appt._id,
              bookingRef: appt.bookingReference,
              reason: reason || "Request rejected by administrator",
              message: `Your reschedule request has been declined. Your original appointment remains unchanged.`,
              timestamp: Date.now(),
            });
          }
        }
      } catch (sockErr) {
        console.warn("[socket] reschedule-rejected emit failed", sockErr?.message);
      }

      // -- Email customer: rejected ----------------------------------------------
      try {
        const { sendRescheduleRejectedEmail } = require("../utils/mailer");
        let customerEmail = appt.customer?.email || null;
        let customerName = appt.customer?.name || "Customer";
        if (!customerEmail && appt.customerId) {
          const User = require("../models/User");
          const custUser = await User.findById(appt.customerId).lean();
          if (custUser) {
            customerEmail = custUser.email;
            customerName = custUser.firstName && custUser.lastName
              ? `${custUser.firstName} ${custUser.lastName}`
              : custUser.name || customerName;
          }
        }
        if (customerEmail) {
          sendRescheduleRejectedEmail({
            to: customerEmail,
            customerName,
            bookingReference: appt.bookingReference || `#${String(appt._id).slice(-6).toUpperCase()}`,
            serviceName: appt.serviceName || appt.service?.name || "Service",
            requestedDate,
            requestedTime,
            rejectionReason: reason || "Request rejected by administrator",
          }).catch(err => console.error("[MAILER] Failed to send reschedule rejected email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Reschedule rejected email error:", mailErr.message);
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.reschedule_reject",
        module: "appointments",
        req,
        details: {
          appointmentId: id,
          rejectionReason: reason,
        },
      });

      return res.json({
        message: "Reschedule request rejected",
        appointment: appt,
      });
    } catch (err) {
      console.error("reschedule reject error", err);
      return res.status(500).json({ error: "Failed to reject reschedule request" });
    }
  },
);

// Mark appointment as completed (admin/secretary/technician)
router.post(
  "/:id/on-the-way",
  auth.authenticate,
  auth.requireRole(["admin", "secretary", "technician"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      // cannot set on-the-way if already completed or cancelled
      if (appt.status === "cancelled") {
        return res
          .status(400)
          .json({ error: "Cannot update a cancelled appointment" });
      }
      if (appt.status === "completed") {
        return res.status(400).json({ error: "Appointment already finished" });
      }
      if (appt.status !== "scheduled" && appt.status !== "confirmed") {
        return res
          .status(400)
          .json({ error: "Only scheduled/confirmed appointments may be marked on-the-way" });
      }
      if (isBookingPast(appt)) {
        return res
          .status(400)
          .json({ error: "Cannot mark as on-the-way — the scheduled time has passed. Please reschedule." });
      }
      appt.status = "on-the-way";
      await appt.save();

      // Set technician availability → On The Way
      if (appt.technicianId) {
        try {
          const Technician = require("../models/Technician");
          const { resolveAvailabilityStatus } = require("../utils/availability");
          const tech = await Technician.findById(appt.technicianId);
          if (tech) {
            const newStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: false });
            // Only allow On The Way if tech is checked in
            tech.availabilityStatus = newStatus === "Offline" ? "Offline" : "On The Way";
            await tech.save();
          }
        } catch (e) {
          console.warn("availability → On The Way failed", e && e.message);
        }
      }

      // ── Email: Notify Customer that Technician is On The Way ──────────
      try {
        const customerEmail = appt.customer?.email;
        if (customerEmail) {
          const Technician = require("../models/Technician");
          const tech = await Technician.findById(appt.technicianId).lean();
          const techFullName = tech?.name || appt.technician?.name || "Your technician";
          const dateLabel = appt.bookingDate
            ? new Date(appt.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = appt.startTime || "TBD";
          sendTechArrivalNotificationEmail({
            to: customerEmail,
            customerName: appt.customer?.name || "Customer",
            bookingReference: appt.bookingReference || `#${String(appt._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: appt.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: appt.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send on-the-way email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] On-the-way email error:", mailErr.message);
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.on_the_way",
        module: "appointments",
        req,
        details: { appointmentId: id },
      });
      return res.json({ message: "Appointment status updated", appointment: appt });
    } catch (err) {
      console.error("on-the-way error", err);
      return res.status(500).json({ error: "Failed to update appointment" });
    }
  },
);

// Mark appointment as in-progress — technician has arrived and started service
router.post(
  "/:id/in-progress",
  auth.authenticate,
  auth.requireRole(["admin", "secretary", "technician"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      if (appt.status === "cancelled") {
        return res.status(400).json({ error: "Cannot update a cancelled appointment" });
      }
      if (appt.status === "completed") {
        return res.status(400).json({ error: "Appointment already finished" });
      }
      if (appt.status !== "on-the-way" && appt.status !== "scheduled" && appt.status !== "confirmed") {
        return res
          .status(400)
          .json({ error: "Appointment must be on-the-way, scheduled, or confirmed to start service" });
      }
      if (isBookingPast(appt)) {
        return res
          .status(400)
          .json({ error: "Cannot start service — the scheduled time has passed. Please reschedule." });
      }
      appt.status = "in-progress";
      await appt.save();

      // Set technician availability → In Progress
      if (appt.technicianId) {
        try {
          const Technician = require("../models/Technician");
          const { resolveAvailabilityStatus } = require("../utils/availability");
          const tech = await Technician.findById(appt.technicianId);
          if (tech) {
            const newStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: false });
            tech.availabilityStatus = newStatus === "Offline" ? "Offline" : "In Progress";
            await tech.save();
          }
        } catch (e) {
          console.warn("availability → In Progress failed", e && e.message);
        }
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.in_progress",
        module: "appointments",
        req,
        details: { appointmentId: id },
      });
      return res.json({ message: "Service started", appointment: appt });
    } catch (err) {
      console.error("in-progress error", err);
      return res.status(500).json({ error: "Failed to start service" });
    }
  },
);

// Mark appointment as completed (admin/secretary/technician)
router.post(
  "/:id/complete",
  auth.authenticate,
  auth.requireRole(["admin", "secretary", "technician"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      // only allow completion once and only for non-cancelled bookings
      if (appt.status === "cancelled") {
        return res
          .status(400)
          .json({ error: "Cannot complete a cancelled appointment" });
      }
      if (appt.status === "completed") {
        return res
          .status(400)
          .json({ error: "Appointment is already completed" });
      }
      appt.status = "completed";
      await appt.save();

      // Set technician availability → Available after service completion
      if (appt.technicianId) {
        try {
          const Technician = require("../models/Technician");
          const { resolveAvailabilityStatus } = require("../utils/availability");
          const tech = await Technician.findById(appt.technicianId);
          if (tech && ["Assigned", "On The Way", "In Progress"].includes(tech.availabilityStatus)) {
            // Use centralized resolver to determine correct post-completion status
            const newStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
            tech.availabilityStatus = newStatus;
            await tech.save();
          }
        } catch (e) {
          console.warn("availability → Available on complete failed", e && e.message);
        }
      }

      // audit log
      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.complete",
        module: "appointments",
        req,
        details: { appointmentId: id },
      });

      // Send completion email to customer (safe — non-blocking)
      try {
        const { sendBookingCompletedEmail } = require("../utils/mailer");
        const BookingService = require("../models/BookingService");
        const freshAppt = await BookingService.findById(id).populate("customerId", "name email").populate("technicianId", "name firstName lastName").lean();
        const customerEmail = freshAppt?.customerId?.email;
        if (customerEmail) {
          const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
          const techName = freshAppt?.technicianId?.name || ((freshAppt?.technicianId?.firstName || "") + " " + (freshAppt?.technicianId?.lastName || "")).trim() || "Your technician";
          sendBookingCompletedEmail({
            to: customerEmail,
            customerName: freshAppt?.customerId?.name || "Customer",
            bookingReference: freshAppt?.bookingReference || `#${String(freshAppt._id).slice(-6).toUpperCase()}`,
            serviceName: freshAppt?.serviceName || "Service",
            technicianName: techName,
            dateLabel,
          }).catch(err => console.error("[MAILER] Failed to send completion email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Completion email error:", mailErr.message);
      }

      return res.json({
        message: "Appointment marked completed",
        appointment: appt,
      });
    } catch (err) {
      console.error("complete error", err);
      return res
        .status(500)
        .json({ error: "Failed to mark appointment completed" });
    }
  },
);

// Mark COD payment as collected by technician (paid/completed update)
// Supports body: { markComplete: true } to simultaneously flip the booking to completed
router.post(
  "/:id/mark-paid",
  auth.authenticate,
  auth.requireRole(["admin", "secretary", "technician"]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      if (appt.status === "cancelled") {
        return res
          .status(400)
          .json({ error: "Cannot update a cancelled appointment" });
      }

      const markComplete =
        req.body.markComplete === true || req.body.markComplete === "true";

      appt.paymentStatus = "paid";
      if (!markComplete && appt.status === "confirmed") {
        // full payment collected after prior confirmation → scheduled
        appt.status = "scheduled";
      }
      if (markComplete && appt.status !== "completed") {
        appt.status = "completed";
      }
      await appt.save();

      // Set technician availability → Available when service is completed via mark-paid
      if (markComplete && appt.technicianId) {
        try {
          const Technician = require("../models/Technician");
          const { resolveAvailabilityStatus } = require("../utils/availability");
          const tech = await Technician.findById(appt.technicianId);
          if (tech && ["Assigned", "On The Way", "In Progress"].includes(tech.availabilityStatus)) {
            const newStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
            tech.availabilityStatus = newStatus;
            await tech.save();
          }
        } catch (e) {
          console.warn("availability → Available on mark-paid+complete failed", e && e.message);
        }
      }

      // Keep associated Payment record in sync
      try {
        const pay = await Payment.findOne({ bookingId: appt._id }).sort({
          createdAt: -1,
        });
        if (pay && String(pay.status || "").toLowerCase() !== "paid") {
          pay.status = "paid";
          pay.paidAt = pay.paidAt || new Date();
          pay.completedAt = pay.completedAt || new Date();
          pay.notes = pay.notes
            ? pay.notes + "\nMarked paid by technician/staff."
            : "Marked paid by technician/staff.";
          await pay.save();
        }
      } catch (payErr) {
        console.warn(
          "mark-paid: payment record sync failed",
          payErr && payErr.message,
        );
      }

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: appt.customerId || appt.customer,
        action: "appointment.mark_paid",
        module: "appointments",
        req,
        details: { appointmentId: id, markComplete },
      });

      // Send completion email if markComplete (safe — non-blocking)
      if (markComplete) {
        try {
          const { sendBookingCompletedEmail } = require("../utils/mailer");
          const freshAppt = await BookingService.findById(id).populate("customerId", "name email").populate("technicianId", "name firstName lastName").lean();
          const customerEmail = freshAppt?.customerId?.email;
          if (customerEmail) {
            const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
            const techName = freshAppt?.technicianId?.name || ((freshAppt?.technicianId?.firstName || "") + " " + (freshAppt?.technicianId?.lastName || "")).trim() || "Your technician";
            sendBookingCompletedEmail({
              to: customerEmail,
              customerName: freshAppt?.customerId?.name || "Customer",
              bookingReference: freshAppt?.bookingReference || `#${String(freshAppt._id).slice(-6).toUpperCase()}`,
              serviceName: freshAppt?.serviceName || "Service",
              technicianName: techName,
              dateLabel,
            }).catch(err => console.error("[MAILER] Failed to send completion email:", err.message));
          }
        } catch (mailErr) {
          console.error("[MAILER] Completion email error:", mailErr.message);
        }
      }

      return res.json({
        message: markComplete
          ? "Payment collected and appointment completed"
          : "Payment marked as collected",
        appointment: appt,
      });
    } catch (err) {
      console.error("mark-paid error", err);
      return res.status(500).json({ error: "Failed to mark payment" });
    }
  },
);

// Create appointment / booking request
router.post("/", auth.authenticate, auth.requireRole(["admin", "secretary", "customer"]), async (req, res) => {
  try {
    let {
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      service,
      serviceId,
      date,
      time,
      technicianId,
      notes,
      issueDescription,
      paymentMethod,
      gcashNumber,
      paymentReference,
      paymentProof,
      downpaymentAmount,
      estimatedFee,
    } = req.body;

    if (paymentMethod === "cash") paymentMethod = "cod";

    downpaymentAmount = Number(downpaymentAmount);
    if (!Number.isFinite(downpaymentAmount)) downpaymentAmount = 0;

    // validate payment info
    if (paymentMethod === "gcash") {
      if (!gcashNumber?.toString().trim())
        return res.status(400).json({ error: "GCash number is required." });
      if (!paymentReference?.toString().trim())
        return res
          .status(400)
          .json({ error: "Payment reference is required." });
      if (!paymentProof?.toString().trim())
        return res.status(400).json({ error: "Proof of payment is required." });
    }
    if (paymentMethod === "cod") {
      // for COD we now collect phone, reference and proof as well
      if (!gcashNumber?.toString().trim())
        return res
          .status(400)
          .json({ error: "Mobile number is required for cash bookings." });
      if (!paymentReference?.toString().trim())
        return res
          .status(400)
          .json({ error: "Payment reference is required for cash bookings." });
      if (!paymentProof?.toString().trim())
        return res
          .status(400)
          .json({ error: "Proof of payment is required for cash bookings." });
      const percentage = await getDownpaymentPercentage();
      const breakdown = calculatePaymentBreakdown(Number(estimatedFee) || 0, percentage);
      downpaymentAmount = breakdown.downpaymentAmount;
      req.body.downpaymentAmount = downpaymentAmount;
      req.body.downpaymentPercentage = breakdown.downpaymentPercentage;
    }
    if (paymentMethod === "cash") paymentMethod = "cod";

    // normalize any bare base64 strings
    if (paymentProof && typeof paymentProof === "string") {
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(paymentProof)) {
        paymentProof = "data:image/jpeg;base64," + paymentProof;
      }
    }

    if (technicianId) {
      technicianId = await resolveTechnicianRefId(technicianId);
    }

    // Compute capacity end for overlap check
    const startMin2 = parseMinuteValue(time);
    const bookingDateObj2 = date ? new Date(date + "T00:00:00") : new Date();
    bookingDateObj2.setHours(0, 0, 0, 0);
    if (Number.isFinite(startMin2) && bookingDateObj2.getTime()) {
      try {
        const serviceDuration2 = 60;
        const travelMins2 = 0;
        const bufferMins2 = await getBufferMinutes();
        const capacityEnd2 = startMin2 + serviceDuration2 + travelMins2 + bufferMins2;
        await assertCompanyCapacity(bookingDateObj2, startMin2, capacityEnd2);
      } catch (capacityErr) {
        return res.status(409).json({ error: capacityErr.message });
      }
    }

    let customerId = null;
    const reqUserRole = String(
      req.user && req.user.role ? req.user.role : "",
    ).toLowerCase();
    if (req.user && req.user._id && reqUserRole === "customer") {
      customerId = req.user._id;
      customerName = `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() || req.user.name || customerName;
      customerEmail = req.user.email || customerEmail;
      customerPhone = req.user.phone || customerPhone;
      customerAddress = req.user.address || customerAddress;
    }

    if (reqUserRole !== "customer" && customerEmail) {
      const user = await User.findOne({
        email: String(customerEmail).toLowerCase().trim(),
      });
      if (user && user.role === "customer") customerId = user._id;
    }

    if (
      reqUserRole !== "customer" &&
      !customerId &&
      (customerEmail || customerName || customerPhone || gcashNumber)
    ) {
      const customerResult = await findOrCreateCustomerAccount({
        customerName:
          customerName ||
          (req.user
            ? `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
              req.user.name ||
              "Customer"
            : "Customer"),
        customerEmail,
        customerPhone: customerPhone || gcashNumber,
        customerAddress,
      });
      if (customerResult && customerResult.user && customerResult.user._id) {
        customerId = customerResult.user._id;
        if (!customerName) {
          customerName =
            `${customerResult.user.firstName || ""} ${customerResult.user.lastName || ""}`.trim();
        }
        if (!customerEmail) {
          customerEmail = customerResult.user.email || customerEmail;
        }
      }
    }

    const bookingDate = date ? new Date(date + "T00:00:00") : new Date();
    const doc = new BookingService({
      customerId: customerId || undefined,
      customer: customerId ? undefined : customerName || "",
      serviceId: serviceId || undefined,
      serviceType: service || "core",
      bookingDate,
      startTime: time || undefined,
      technicianId: technicianId || undefined,
      status: "pending",
      notes: notes || "",
      issueDescription: issueDescription || undefined,
      // copy payment info from request
      paymentMethod: paymentMethod || undefined,
      gcashNumber: gcashNumber || undefined,
      paymentReference: paymentReference || undefined,
      downpaymentPercentage: req.body.downpaymentPercentage || undefined,
      downpaymentAmount: downpaymentAmount || undefined,
      balanceAmount: paymentMethod === "cod" ? Math.max(0, (Number(estimatedFee) || 0) - downpaymentAmount) : 0,
      estimatedFee: Number(estimatedFee) || undefined,
      paymentProof: paymentProof || undefined,
    });

    await doc.save();

    // after saving, record payment transaction(s)
    try {
      const Payment = require("../models/Payment");
      if (paymentMethod === "cash" || paymentMethod === "cod") {
        const p = new Payment({
          bookingId: doc._id,
          amount: downpaymentAmount || 0,
          method: "cod",
          type: "downpayment",
          status: "pending",
          reference: paymentReference || undefined,
        });
        await p.save();
      } else if (paymentMethod === "gcash") {
        const p = new Payment({
          bookingId: doc._id,
          amount: downpaymentAmount || 0, // treat as whatever the customer submitted
          method: "gcash",
          type: "downpayment",
          reference: paymentReference || undefined,
          proofUrl: paymentProof || undefined,
          status: "pending",
        });
        await p.save();
      } else if (paymentMethod === "bank") {
        const p = new Payment({
          bookingId: doc._id,
          amount: downpaymentAmount || 0,
          method: "bank",
          type: "downpayment",
          reference: paymentReference || undefined,
          status: "pending",
        });
        await p.save();
      } else if (paymentMethod === "other") {
        const p = new Payment({
          bookingId: doc._id,
          amount: downpaymentAmount || 0,
          method: "other",
          type: "downpayment",
          notes: req.body.notes || undefined,
          status: "pending",
        });
        await p.save();
      } else if (paymentMethod === "paymongo") {
        // create payment record and start PayMongo intent
        const p = new Payment({
          bookingId: doc._id,
          amount: downpaymentAmount || 0,
          method: "paymongo",
          gateway: "paymongo",
          type: "downpayment",
          status: "pending",
        });
        await p.save();

        // create PayMongo intent
        try {
          const paymongo = require("../utils/paymongo");
          const intentData = await paymongo.createPaymentIntent({
            amount: Math.round((downpaymentAmount || 0) * 100),
            currency: "PHP",
            description: `Downpayment for booking ${doc._id}`,
            metadata: { bookingId: String(doc._id), paymentId: String(p._id) },
          });
          if (intentData && intentData.data) {
            p.gatewayId = intentData.data.id;
            p.gatewayType = intentData.data.type;
            p.gatewayStatus = intentData.data.attributes_status;
            await p.save();
            // record gateway info on booking too for quick lookup
            doc.gateway = "paymongo";
            doc.gatewayId = intentData.data.id;
            doc.gatewayStatus = intentData.data.attributes.status;
            await doc.save();
            // send client details back to front-end via response outer scope
            // (we'll attach to respObj later)
            res.locals.paymongo = {
              clientSecret: intentData.data.attributes.client_secret,
              redirect: intentData.data.attributes.next_action?.redirect?.url,
            };
          }
        } catch (err) {
          console.warn("PayMongo intent creation failed", err && err.message);
        }
      }
    } catch (e) {
      console.warn(
        "failed to create payment record for booking",
        e && e.message,
      );
    }

    // If the booking is already confirmed at creation time, attempt server-side calendar sync
    if (doc.status === "confirmed" && googleCalendarSync.isConfigured()) {
      (async () => {
        try {
          // best-effort: attempt to create calendar event and persist event id
          const result = await googleCalendarSync.createEventForBooking({
            booking: doc,
          });
          if (result && result.eventId) {
            doc.googleCalendarEventId = result.eventId;
            doc.googleCalendarId = result.calendarId || doc.googleCalendarId;
            doc.googleCalendarHtmlLink =
              result.raw?.htmlLink ||
              result.htmlLink ||
              doc.googleCalendarHtmlLink;
            await doc.save();
          }
        } catch (err) {
          console.warn(
            "google calendar create failed (create)",
            err && (err.message || err),
          );
        }
      })();
    }

    // TimeSlot model removed; skipping timeslot sync for new bookings

    await audit.logEvent({
      actor: req.user && req.user._id,
      target: customerId || doc.customer,
      action: "appointment.create",
      module: "appointments",
      req,
      details: { bookingId: doc._id },
    });
    return res
      .status(201)
      .json({ message: "Booking request created", appointment: doc });
  } catch (err) {
    console.error("create appointment error", err);
    return res.status(500).json({ error: "Failed to create appointment" });
  }
});

// Update appointment (reschedule / edit)
router.put("/:id", auth.authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    const appt = await BookingService.findById(id);
    if (!appt) return res.status(404).json({ error: "Appointment not found" });

    // Ownership/role check: admin/secretary can edit any; others only their own
    const role = req.user.role;
    if (role === "technician") {
      if (String(appt.technicianId) !== String(req.user._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (role === "customer") {
      if (String(appt.customerId) !== String(req.user._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      // Customers can only reschedule, not change status/technician
      const up = req.body || {};
      if (up.status || up.technicianId) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (role !== "admin" && role !== "secretary") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // keep previous date/time to sync timeslots if changed
    const prevDate = appt.bookingDate ? new Date(appt.bookingDate) : null;
    const prevTime = appt.startTime || null;

    const up = req.body || {};
    // only scheduled appointments may have their date/time changed via reschedule
    if (
      (up.bookingDate || up.startTime || up.endTime) &&
      appt.status !== "scheduled"
    ) {
      return res.status(400).json({
        error: "Only scheduled bookings may be rescheduled.",
      });
    }
    let changedTiming = false;
    if (up.bookingDate) {
      appt.bookingDate = new Date(up.bookingDate + "T00:00:00");
      changedTiming = true;
    }
    if (up.startTime) {
      appt.startTime = up.startTime;
      changedTiming = true;
    }
    if (up.endTime) {
      appt.endTime = up.endTime;
      changedTiming = true;
    }
    // if timing changed mark as re-scheduled and save reason
    if (changedTiming) {
      // If no technician assigned, go to awaiting_assignment so admin can assign one
      const hasTech = appt.technicianId || (up.technicianId);
      appt.status = hasTech ? "re-scheduled" : "awaiting_assignment";
      if (up.reason) appt.rescheduleReason = up.reason;
    }
    if (up.status) {
      // Statuses that move a booking forward into active work are blocked
      // for past bookings — only cancel/reschedule should be permitted.
      const forwardStatuses = ["confirmed", "scheduled", "on-the-way", "in-progress", "arrived"];
      if (forwardStatuses.includes(up.status) && isBookingPast(appt)) {
        return res.status(400).json({
          error: "Cannot move this appointment forward — its scheduled time has passed. Please reschedule or cancel instead.",
        });
      }
      // allow arriving status explicitly
      if (["arrived", "completed", "cancelled", "in-progress", "on-the-way", "scheduled", "confirmed", "pending", "re-scheduled"].includes(up.status)) {
        appt.status = up.status;
      }
    }
    if (up.technicianId) {
      appt.technicianId = await resolveTechnicianRefId(up.technicianId);
      // grab technician snapshot immediately so we can show it without extra query
      try {
        const Technician = require("../models/Technician");
        const tech = await Technician.findById(appt.technicianId);
        if (tech) {
          appt.technician = {
            _id: tech._id,
            name: tech.name || tech.fullName || "",
            email: tech.email || "",
            phone: tech.phone || tech.mobile || "",
          };
          // Auto-set availability to Assigned when technician is (re)assigned
          const { resolveAvailabilityStatus } = require("../utils/availability");
          const currentAvail = await resolveAvailabilityStatus(tech, null, null, { syncDb: false });
          if (currentAvail === "Available") {
            tech.availabilityStatus = "Assigned";
            await tech.save();
          }
        }
      } catch (e) {
        console.warn("availability → Assigned on booking update failed", e && e.message);
      }
    }
    if (up.serviceType) appt.serviceType = up.serviceType;
    // if the serviceId changed, refresh snapshot
    if (up.serviceId && String(up.serviceId) !== String(appt.serviceId)) {
      appt.serviceId = up.serviceId;
      try {
        const CoreService = require("../models/CoreService");
        const RepairService = require("../models/RepairService");
        let svc = await CoreService.findById(up.serviceId).lean();
        if (svc) {
          appt.serviceModel = "CoreService";
          appt.service = {
            _id: svc._id,
            name: svc.name,
            description: svc.description,
            basePrice: svc.basePrice,
          };
        } else {
          svc = await RepairService.findById(up.serviceId).lean();
          if (svc) {
            appt.serviceModel = "RepairService";
            appt.service = {
              _id: svc._id,
              name: svc.name,
              description: svc.commonFaults ? svc.commonFaults.join(", ") : "",
              basePrice: svc.basePrice,
            };
          }
        }
      } catch (e) {
        console.warn("service lookup failed", e);
      }
    }
    if (up.paymentMethod) appt.paymentMethod = up.paymentMethod;
    if (up.travelFare !== undefined)
      appt.travelFare = Number(up.travelFare) || 0;
    if (up.travelTime !== undefined)
      appt.travelTime = Math.max(0, Number(up.travelTime) || 0);
    if (up.gcashNumber) appt.gcashNumber = up.gcashNumber;
    if (up.paymentReference) appt.paymentReference = up.paymentReference;
    if (up.paymentProof) {
      let pf = up.paymentProof;
      if (typeof pf === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(pf)) {
        pf = "data:image/jpeg;base64," + pf;
      }
      appt.paymentProof = pf;
    }

    if (up.location && typeof up.location === "object") {
      // normalize same as creation logic
      const loc = {};
      let addressText =
        typeof up.location.address === "string"
          ? up.location.address.trim()
          : "";
      if (isCoordinateLikeText(addressText)) {
        addressText = "";
      }
      const lat = parseFloat(
        up.location.lat || up.location.latitude || up.location.coords?.lat,
      );
      const lng = parseFloat(
        up.location.lng || up.location.longitude || up.location.coords?.lng,
      );
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        loc.coordinates = { type: "Point", coordinates: [lng, lat] };
        if (!addressText) {
          addressText = await reverseGeocodeAddress(lat, lng);
        }
      }
      if (addressText) loc.address = addressText;
      if (loc.address || loc.coordinates) appt.location = loc;
    }
    if (up.issueDescription !== undefined)
      appt.issueDescription = up.issueDescription;

    // overlap protection for reschedules/edits (same standards as create)
    const nextStart = parseMinuteValue(appt.startTime);
    const nextEndRaw = parseMinuteValue(appt.endTime);
    const nextEnd =
      Number.isFinite(nextEndRaw) && nextEndRaw > nextStart
        ? nextEndRaw
        : deriveBookingEndMinutes(appt);
    if (
      !Number.isFinite(nextStart) ||
      !Number.isFinite(nextEnd) ||
      nextEnd <= nextStart
    ) {
      return res.status(400).json({ error: "Invalid appointment time range." });
    }

    // keep endTime normalized for future slot blocking
    appt.endTime = String(nextEnd);

    try {
      await assertNoTechnicianOverlap({
        technicianId: appt.technicianId,
        bookingDate: appt.bookingDate,
        startMin: nextStart,
        endMin: nextEnd,
        excludeAppointmentId: appt._id,
      });
    } catch (overlapErr) {
      return res.status(409).json({ error: overlapErr.message });
    }

    // Company-wide capacity check for rescheduled time slot
    try {
      await assertCompanyCapacity(appt.bookingDate, nextStart, nextEnd, appt._id);
    } catch (capacityErr) {
      return res.status(409).json({ error: capacityErr.message });
    }

    await appt.save();

    // Send arrival notification if status changed to "arrived"
    if (up.status === "arrived" && appt.customer && appt.customer.email) {
      (async () => {
        try {
          const { sendTechArrivalNotificationEmail } = require("../utils/mailer");
          const customerName = appt.customer.name || 
            (appt.customer.firstName && appt.customer.lastName ? 
              `${appt.customer.firstName} ${appt.customer.lastName}` : "Customer");
          const technicianName = appt.technician?.name || 
            (appt.technicianId ? "Your Technician" : "Technician");
          const bookingReference = appt.bookingReference || appt._id;
          const arrivalTime = appt.arrivedAt ? 
            new Date(appt.arrivedAt).toLocaleTimeString('en-US', { 
              hour: '2-digit', 
              minute: '2-digit',
              hour12: true 
            }) : "now";
          
          await sendTechArrivalNotificationEmail({
            to: appt.customer.email,
            customerName,
            bookingReference,
            techName: technicianName,
            estimatedArrival: arrivalTime
          });
          
          console.log("✅ Arrival notification sent to customer:", appt.customer.email);
        } catch (emailError) {
          console.error("❌ Failed to send arrival notification:", emailError.message);
        }
      })();
    }

    // Server-side calendar sync for updated appointments (best-effort)
    (async () => {
      try {
        if (googleCalendarSync.isConfigured()) {
          // if there is an existing event, update it
          if (appt.googleCalendarEventId) {
            try {
              await googleCalendarSync.updateEventForBooking({
                booking: appt,
                eventId: appt.googleCalendarEventId,
              });
            } catch (e) {
              console.warn(
                "Failed to update Google Calendar event for appointment",
                e && e.message,
              );
            }
          } else if (appt.status === "confirmed") {
            // create event if appointment became confirmed and no calendar event exists
            try {
              const created = await googleCalendarSync.createEventForBooking({
                booking: appt,
              });
              if (created && created.eventId) {
                appt.googleCalendarEventId = created.eventId;
                appt.googleCalendarId =
                  created.calendarId || appt.googleCalendarId;
                appt.googleCalendarHtmlLink =
                  created.raw?.htmlLink ||
                  created.htmlLink ||
                  appt.googleCalendarHtmlLink;
                await appt.save();
              }
            } catch (e) {
              console.warn(
                "Failed to create Google Calendar event for updated appointment",
                e && e.message,
              );
            }
          }
          // if appointment was cancelled, remove associated event
          if (appt.status === "cancelled" && appt.googleCalendarEventId) {
            try {
              await googleCalendarSync.deleteEvent({
                eventId: appt.googleCalendarEventId,
                calendarIdOverride: appt.googleCalendarId,
              });
              appt.googleCalendarEventId = undefined;
              appt.googleCalendarId = undefined;
              appt.googleCalendarHtmlLink = undefined;
              await appt.save();
            } catch (e) {
              console.warn(
                "Failed to delete Google Calendar event after cancellation",
                e && e.message,
              );
            }
          }
        }
      } catch (e) {
        /* ignore background sync errors */
      }
    })();

    // TimeSlot model removed; skipping timeslot sync on appointment update

    await audit.logEvent({
      actor: req.user && req.user._id,
      target: appt.customerId || appt.customer,
      action: "appointment.update",
      module: "appointments",
      req,
      details: { appointmentId: id },
    });
    return res.json({ message: "Appointment updated", appointment: appt });
  } catch (err) {
    console.error("update appointment error", err);
    return res.status(500).json({ error: "Failed to update appointment" });
  }
});

// Manual server-side Google Calendar sync (admin)
router.post(
  "/:id/google-sync",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      if (!googleCalendarSync.isConfigured())
        return res
          .status(400)
          .json({ error: "Google Calendar sync not configured on server" });
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });

      // determine duration (best‑effort)
      let duration = 60;
      if (appt.serviceId) {
        const svc = appt.serviceId;
        if (svc && svc.durationMinutes) duration = svc.durationMinutes;
        else if (svc && svc.duration) duration = svc.duration;
        else if (svc && svc.estimatedDurationMinutes)
          duration = svc.estimatedDurationMinutes;
      }

      let result;
      if (appt.googleCalendarEventId) {
        // update existing
        result = await googleCalendarSync.updateEventForBooking({
          booking: appt,
          eventId: appt.googleCalendarEventId,
          durationMinutes: duration,
        });
        if (result && result.htmlLink)
          appt.googleCalendarHtmlLink = result.htmlLink;
        await appt.save();
        return res.json({
          message: "Calendar event updated",
          event: result,
          appointment: appt,
        });
      }

      // create new
      const created = await googleCalendarSync.createEventForBooking({
        booking: appt,
        durationMinutes: duration,
      });
      if (created && created.eventId) {
        appt.googleCalendarEventId = created.eventId;
        appt.googleCalendarId = created.calendarId || appt.googleCalendarId;
        appt.googleCalendarHtmlLink =
          created.raw?.htmlLink ||
          created.htmlLink ||
          appt.googleCalendarHtmlLink;
        await appt.save();
      }
      return res.json({
        message: "Calendar event created",
        created,
        appointment: appt,
      });
    } catch (err) {
      console.error("google-sync error", err);
      return res
        .status(500)
        .json({ error: "Failed to sync to Google Calendar" });
    }
  },
);

// Manual remove calendar event (admin)
router.post(
  "/:id/google-remove",
  auth.authenticate,
  auth.requireRole(["admin", "secretary"]),
  async (req, res) => {
    try {
      if (!googleCalendarSync.isConfigured())
        return res
          .status(400)
          .json({ error: "Google Calendar sync not configured on server" });
      const id = req.params.id;
      const appt = await BookingService.findById(id);
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      if (!appt.googleCalendarEventId)
        return res.status(400).json({
          error: "No calendar event associated with this appointment",
        });

      try {
        await googleCalendarSync.deleteEvent({
          eventId: appt.googleCalendarEventId,
          calendarIdOverride: appt.googleCalendarId,
        });
      } catch (e) {
        console.warn(
          "Failed to delete calendar event (manual)",
          e && e.message,
        );
      }

      appt.googleCalendarEventId = undefined;
      appt.googleCalendarId = undefined;
      await appt.save();
      return res.json({ message: "Calendar event removed", appointment: appt });
    } catch (err) {
      console.error("google-remove error", err);
      return res.status(500).json({ error: "Failed to remove calendar event" });
    }
  },
);

// Delete appointment (admin/secretary only)
router.delete("/:id", auth.authenticate, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "secretary") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const id = req.params.id;
    const appt = await BookingService.findByIdAndDelete(id);
    if (!appt) return res.status(404).json({ error: "Appointment not found" });

    // server-side: remove calendar event if present
    if (googleCalendarSync.isConfigured() && appt.googleCalendarEventId) {
      try {
        await googleCalendarSync.deleteEvent({
          eventId: appt.googleCalendarEventId,
          calendarIdOverride: appt.googleCalendarId,
        });
      } catch (e) {
        console.warn(
          "Failed to delete calendar event on appointment delete",
          e && e.message,
        );
      }
    }

    // TimeSlot model removed; no timeslot release to perform

    await audit.logEvent({
      actor: req.user && req.user._id,
      target: appt.customerId || appt.customer,
      action: "appointment.delete",
      module: "appointments",
      req,
      details: { appointmentId: id },
    });
    return res.json({ message: "Appointment deleted" });
  } catch (err) {
    console.error("delete appointment error", err);
    return res.status(500).json({ error: "Failed to delete appointment" });
  }
});

/**
 * POST /api/appointments/:id/add-service
 * Add a new service to an existing booking (multi-service support).
 * Body: { serviceId, type: "core"|"repair", quantity }
 */
router.post("/:id/add-service", auth.authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { serviceId, type = "core", quantity = 1 } = req.body;
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const isStaff = ["admin", "secretary"].includes(req.user.role);
    const isOwner = req.user.role === "customer" && String(booking.customerId || "") === String(req.user._id);
    if (!isStaff && !isOwner) return res.status(403).json({ error: "Forbidden" });

    // Only allow on mutable statuses
    const mutableStatuses = ["pending", "payment_verified", "awaiting_assignment", "assigned", "pending_reassignment"];
    if (!mutableStatuses.includes(booking.status)) {
      return res.status(400).json({ error: "Cannot add services to a booking in its current status" });
    }

    // Look up the service
    let serviceDoc = null;
    if (type === "repair") {
      serviceDoc = await RepairService.findById(serviceId);
    } else {
      serviceDoc = await CoreService.findById(serviceId);
    }
    if (!serviceDoc) return res.status(404).json({ error: "Service not found" });

    const serviceDuration = serviceDoc.durationMinutes || serviceDoc.estimatedDurationMinutes || serviceDoc.duration || 60;
    const servicePrice = serviceDoc.price || serviceDoc.basePrice || serviceDoc.diagnosticFee || 0;

    // If the booking is not yet multi-service, convert it
    if (!booking.isMultiService) {
      booking.isMultiService = true;
      booking.services = [];
      // Push the original single service into the array
      booking.services.push({
        serviceId: booking.serviceId,
        name: booking.service?.name || "Service",
        type: booking.serviceModel === "RepairService" ? "repair" : "core",
        quantity: 1,
        unitPrice: booking.servicePrice || 0,
        totalPrice: booking.servicePrice || 0,
        duration: booking.serviceDurationMinutes || 60,
        initialCost: booking.initialCost || booking.servicePrice || 0,
      });
    }

    // Add the new service
    booking.services.push({
      serviceId: serviceDoc._id,
      name: serviceDoc.name || serviceDoc.title || "Service",
      type,
      quantity: Number(quantity),
      unitPrice: servicePrice,
      totalPrice: servicePrice * Number(quantity),
      duration: serviceDuration,
      initialCost: servicePrice,
    });

    // Recalculate totals
    const totals = booking.calculateTotalCosts();
    booking.totalInitialCost = totals.totalInitialCost;
    booking.totalFinalCost = totals.totalFinalCost;
    booking.totalPrice = totals.totalPrice;

    // Recalculate endTime from updated total duration if startTime exists
    if (booking.startTime) {
      const totalDuration = booking.services.reduce((sum, s) => sum + (s.duration || 60) * (s.quantity || 1), 0);
      const travelTime = booking.travelTime || 30;
      const bufferTime = 15;
      const capacityMinutes = totalDuration + travelTime + bufferTime;
      const startMinutes = parseTimeValue(booking.startTime);
      if (Number.isFinite(startMinutes)) {
        const endH = Math.floor((startMinutes + capacityMinutes) / 60);
        const endM = (startMinutes + capacityMinutes) % 60;
        booking.endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
      }
    }

    await booking.save();

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "service_added",
      title: "Service added to booking",
      message: `"${serviceDoc.name || serviceDoc.title || "New service"}" added to booking #${booking.bookingReference || booking._id}`,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: `/admin/appointments/${booking._id}`,
      role: "admin",
      priority: "normal",
      io: req.app?.get("io"),
    });

    return res.json({ success: true, booking });
  } catch (err) {
    next(err);
  }
});

// Admin queue for governed customer service-item changes.
router.get("/service-change-requests/pending", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const bookings = await BookingService.find({ "serviceChangeRequests.status": { $in: ["pending", "schedule_proposed"] } })
      .select("bookingReference customer bookingDate startTime endTime technician rescheduleRequest serviceChangeRequests")
      .sort({ "serviceChangeRequests.requestedAt": 1 }).lean();
    const requests = bookings.flatMap(booking => (booking.serviceChangeRequests || [])
      .filter(row => ["pending", "schedule_proposed"].includes(row.status))
      .map(row => {
        const legacyRequestedSchedule = booking.rescheduleRequest?.requested
          && booking.rescheduleRequest?.status === "pending"
          && booking.rescheduleRequest?.requestedDate
          && booking.rescheduleRequest?.requestedTime
          ? {
              date: booking.rescheduleRequest.requestedDate,
              startTime: booking.rescheduleRequest.requestedTime,
              notes: booking.rescheduleRequest.reason || "",
              legacyLinkedRequest: true,
            }
          : null;
        return {
          ...row,
          summary: summarizeChanges(row.beforeServices || [], row.proposedServices || []),
          requestedSchedule: row.requestedSchedule?.date ? row.requestedSchedule : legacyRequestedSchedule,
          bookingId: booking._id,
          bookingReference: booking.bookingReference,
          customer: booking.customer,
          technician: booking.technician,
          bookingDate: booking.bookingDate,
          startTime: booking.startTime,
          endTime: booking.endTime,
        };
      }));
    return res.json({ success: true, requests });
  } catch (err) { next(err); }
});

router.post("/:id/service-change-requests/:requestId/decision", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const change = booking.serviceChangeRequests.id(req.params.requestId);
    if (!change) return res.status(404).json({ error: "Change request not found" });
    if (!["pending", "schedule_proposed"].includes(change.status)) return res.status(409).json({ error: "This change request has already been decided." });

    const action = String(req.body.action || "");
    const reason = String(req.body.reason || "").trim();
    const customerRequestedSchedule = change.requestedSchedule?.date
      ? change.requestedSchedule
      : (booking.rescheduleRequest?.requested
          && booking.rescheduleRequest?.status === "pending"
          && booking.rescheduleRequest?.requestedDate
          && booking.rescheduleRequest?.requestedTime
        ? {
            date: new Date(`${booking.rescheduleRequest.requestedDate}T00:00:00`),
            startTime: booking.rescheduleRequest.requestedTime,
            notes: booking.rescheduleRequest.reason || "",
          }
        : null);
    if (action === "propose_schedule") {
      const date = req.body.date ? new Date(`${req.body.date}T00:00:00`) : null;
      const start = parseTimeValue(req.body.startTime);
      if (!date || Number.isNaN(date.getTime()) || !Number.isFinite(start)) return res.status(400).json({ error: "A valid proposed date and start time are required." });
      const inspectionDuration = await require("../utils/bookingPolicy").getInspectionDurationMinutes();
      const buffer = await getBufferMinutes();
      const end = start + capacityMinutes(change.proposedServices, inspectionDuration) + Number(booking.travelTime || 0) + buffer;
      await assertCompanyCapacity(date, start, end, booking._id);
      change.status = "schedule_proposed";
      change.proposedSchedule = { date, startTime: req.body.startTime, endTime: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`, notes: reason };
      if (customerRequestedSchedule && booking.rescheduleRequest?.status === "pending") {
        booking.rescheduleRequest.status = "superseded";
        booking.rescheduleRequest.processedBy = req.user._id;
        booking.rescheduleRequest.processedAt = new Date();
      }
      await booking.save();
      await createNotification({ type: "booking_schedule_proposed", title: "New schedule proposed", message: `A new schedule was proposed for ${booking.bookingReference || booking._id}.`, userId: booking.customerId, referenceId: booking._id, referenceModel: "BookingService", link: "/book-history", priority: "high", io: req.app.get("io") });
      return res.json({ success: true, changeRequest: change });
    }

    if (action === "reject") {
      change.status = "rejected";
      change.adminDecision = { decidedBy: req.user._id, decidedByName: req.user.fullName || req.user.email, decidedAt: new Date(), reason: reason || "Unable to accommodate the requested change." };
      if (customerRequestedSchedule && booking.rescheduleRequest?.status === "pending") {
        booking.rescheduleRequest.status = "rejected";
        booking.rescheduleRequest.processedBy = req.user._id;
        booking.rescheduleRequest.processedAt = new Date();
        booking.rescheduleRequest.rejectionReason = change.adminDecision.reason;
      }
      await booking.save();
      await createNotification({ type: "booking_change_rejected", title: "Service change declined", message: `${booking.bookingReference || booking._id}: ${change.adminDecision.reason}`, userId: booking.customerId, referenceId: booking._id, referenceModel: "BookingService", link: "/book-history", priority: "normal", io: req.app.get("io") });
      return res.json({ success: true, changeRequest: change });
    }

    if (action !== "approve") return res.status(400).json({ error: "Action must be approve, reject, or propose_schedule." });
    const inspectionDuration = await require("../utils/bookingPolicy").getInspectionDurationMinutes();
    const buffer = await getBufferMinutes();
    const approvedDate = customerRequestedSchedule?.date
      ? new Date(customerRequestedSchedule.date)
      : booking.bookingDate;
    const approvedStartTime = customerRequestedSchedule?.startTime || booking.startTime;
    const start = parseTimeValue(approvedStartTime);
    const end = start + capacityMinutes(change.proposedServices, inspectionDuration) + Number(booking.travelTime || 0) + buffer;
    if (approvedDate && Number.isFinite(start)) await assertCompanyCapacity(approvedDate, start, end, booking._id);
    booking.services = change.proposedServices;
    booking.isMultiService = booking.services.length > 1;
    booking.serviceType = aggregateBookingType(booking.services);
    if (customerRequestedSchedule) {
      booking.bookingDate = approvedDate;
      booking.startTime = approvedStartTime;
      booking.selectedTimeLabel = approvedStartTime;
    }
    if (Number.isFinite(end)) booking.endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    booking.services.forEach(item => {
      item.schedule = {
        ...(item.schedule?.toObject?.() || item.schedule || {}),
        date: booking.bookingDate,
        startTime: booking.startTime,
        endTime: booking.endTime,
        kind: item.type === "repair" ? "inspection" : "service",
      };
    });
    const totals = booking.calculateTotalCosts();
    booking.totalInitialCost = totals.totalInitialCost; booking.totalFinalCost = totals.totalFinalCost; booking.totalPrice = totals.totalPrice;
    change.status = "approved";
    change.adminDecision = { decidedBy: req.user._id, decidedByName: req.user.fullName || req.user.email, decidedAt: new Date(), reason: reason || "Approved after capacity review." };
    if (customerRequestedSchedule && booking.rescheduleRequest?.status === "pending") {
      booking.rescheduleRequest.status = "approved";
      booking.rescheduleRequest.processedBy = req.user._id;
      booking.rescheduleRequest.processedAt = new Date();
    }
    await booking.save();
    await Promise.all([
      createNotification({ type: "booking_change_approved", title: "Service change approved", message: `${booking.bookingReference || booking._id} has been updated.`, userId: booking.customerId, referenceId: booking._id, referenceModel: "BookingService", link: "/book-history", priority: "normal", io: req.app.get("io") }),
      booking.technicianId ? createNotification({ type: "booking_update_acknowledgement", title: "Assigned booking updated", message: `Services changed for ${booking.bookingReference || booking._id}. Please review and acknowledge.`, userId: booking.technicianId, role: "technician", referenceId: booking._id, referenceModel: "BookingService", link: "/technician/assignments", priority: "high", io: req.app.get("io") }) : Promise.resolve(),
    ]);
    return res.json({ success: true, booking, changeRequest: change });
  } catch (err) { next(err); }
});

router.post("/:id/service-items/:itemId/assign", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const Technician = require("../models/Technician");
    const booking = await BookingService.findById(req.params.id);
    const technician = await Technician.findOne({ _id: req.body.technicianId, active: { $ne: false } });
    if (!booking || !technician) return res.status(404).json({ error: "Booking or technician not found" });
    const item = booking.services.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Service item not found" });
    const date = req.body.date ? new Date(`${req.body.date}T00:00:00`) : new Date(item.schedule?.date || booking.bookingDate);
    const startTime = req.body.startTime || item.schedule?.startTime || booking.startTime;
    const start = parseTimeValue(startTime);
    const duration = item.type === "repair" && item.phase !== "repair_phase_2" ? await require("../utils/bookingPolicy").getInspectionDurationMinutes() : Number(item.schedule?.durationMinutes || item.duration || 60) * Math.max(1, Number(item.quantity) || 1);
    const end = req.body.endTime ? parseTimeValue(req.body.endTime) : start + duration;
    if (Number.isNaN(date.getTime()) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return res.status(400).json({ error: "A valid service-item schedule is required." });
    const dayStart = new Date(date); dayStart.setHours(0,0,0,0); const dayEnd = new Date(date); dayEnd.setHours(23,59,59,999);
    const active = await Assignment.find({ technicianId: technician._id, bookingDate: { $gte: dayStart, $lte: dayEnd }, status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] }, _id: { $ne: item.assignmentId } }).select("startTime endTime serviceName").lean();
    const conflict = active.find(row => { const rowStart = parseTimeValue(row.startTime), rowEnd = parseTimeValue(row.endTime); return Number.isFinite(rowStart) && Number.isFinite(rowEnd) && start < rowEnd && end > rowStart; });
    if (conflict) return res.status(409).json({ error: `Technician schedule conflict with ${conflict.serviceName || "another assignment"}.` });
    const endTime = `${String(Math.floor(end/60)).padStart(2,"0")}:${String(end%60).padStart(2,"0")}`;
    const assignment = item.assignmentId ? await Assignment.findById(item.assignmentId) : new Assignment({ bookingId: booking._id, serviceItemId: item._id });
    Object.assign(assignment, { technicianId: technician._id, customerName: booking.customer?.name || "", customerPhone: booking.customer?.phone || "", customerEmail: booking.customer?.email || "", serviceType: item.type, serviceName: item.name, servicePrice: item.totalPrice || 0, quantity: item.quantity || 1, bookingDate: date, startTime, endTime, address: booking.location?.address || booking.address || "", coordinates: { lat: booking.location?.lat, lng: booking.location?.lng }, status: "pending_acceptance", assignedAt: new Date(), estimatedFee: item.totalPrice || 0, travelFare: booking.travelFare || 0, travelTime: booking.travelTime || 0 });
    await assignment.save();
    item.technicianId = technician._id; item.technicianName = technician.name; item.assignmentId = assignment._id; item.status = "assigned"; item.schedule = { date, startTime, endTime, durationMinutes: duration, kind: item.type === "repair" && item.phase !== "repair_phase_2" ? "inspection" : item.type === "repair" ? "repair" : "service" }; item.statusHistory.push({ status: "assigned", changedAt: new Date(), changedBy: req.user._id, changedByName: req.user.fullName || req.user.email, reason: "Service item assigned" });
    if (!booking.technicianId) { booking.technicianId = technician._id; booking.technician = { _id: technician._id, name: technician.name, email: technician.userEmail || technician.email, phone: technician.phone || technician.mobile }; }
    await booking.save();
    await createNotification({ type: "assignment_new", title: "New service item assigned", message: `${item.name} in ${booking.bookingReference || booking._id} requires your acceptance.`, userId: technician._id, role: "technician", referenceId: assignment._id, referenceModel: "Assignment", link: "/technician/assignments", priority: "high", io: req.app.get("io") });
    return res.json({ success: true, assignment, serviceItem: item });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// REPAIR WORK ORDER MANAGEMENT (Enterprise)
// ═════════════════════════════════════════════════════════════════════════════

// POST /:id/schedule-inspection
// Admin triages repair request: assigns technician + date/time for inspection
router.post("/:id/schedule-inspection", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "repair_requested") {
      return res.status(400).json({ error: `Cannot schedule inspection from status: ${booking.status}` });
    }

    const { technicianId, scheduledDate, scheduledTime, priorityOverride, triageNotes } = req.body;
    if (!technicianId || !scheduledDate) {
      return res.status(400).json({ error: "Technician and scheduled date are required" });
    }

    const Technician = require("../models/Technician");
    const tech = await Technician.findById(technicianId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const Assignment = require("../models/Assignment");

    // Enterprise: Allow priority override during triage
    if (priorityOverride && ['low', 'medium', 'high', 'critical'].includes(priorityOverride)) {
      booking.priority = priorityOverride;
    }

    booking.inspection = {
      scheduledDate: new Date(scheduledDate),
      scheduledTime: scheduledTime || "",
      technicianId: tech._id,
    };

    // Enterprise: Record triage decision
    booking.triage = {
      assignedBy: req.user._id,
      assignedAt: new Date(),
      technicianSkillMatch: true,
      technicianAvailabilityConfirmed: true,
      customerPreferredDateHonored: booking.preferredDate
        ? new Date(scheduledDate).toDateString() === new Date(booking.preferredDate).toDateString()
        : true,
      notes: triageNotes || ''
    };

    // Enterprise: Record status transition with audit trail
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: 'repair_requested',
      toStatus: 'inspection_scheduled',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || 'Admin',
      reason: 'Inspection scheduled during triage',
      notes: triageNotes || '',
      timestamp: new Date(),
      metadata: {
        technicianId: tech._id,
        technicianName: tech.name,
        scheduledDate,
        scheduledTime,
        priority: booking.priority,
        customerPreferredDateHonored: booking.triage.customerPreferredDateHonored
      }
    });

    booking.status = "inspection_scheduled";

    // Create assignment for the technician
    const assignment = new Assignment({
      bookingId: booking._id,
      technicianId: tech._id,
      bookingDate: new Date(scheduledDate),
      startTime: scheduledTime || "",
      status: "pending_acceptance",
      priority: booking.priority === 'critical' ? 'urgent' : booking.priority === 'high' ? 'high' : 'normal',
      customerName: booking.customer?.name || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      address: booking.location?.address || "",
      serviceName: `Inspection: ${booking.unitInfo?.unitType || "Repair"}`,
      serviceType: "repair",
      estimatedFee: booking.initialCost || 0,
      notes: [{ text: `Repair inspection scheduled by admin. Priority: ${booking.priority}`, byName: "Admin" }],
    });
    await assignment.save();
    booking.assignmentId = assignment._id;
    booking.technicianId = tech._id;

    await booking.save();

    // Notify technician with full context
    if (global.io) {
      global.io.to(`tech:${tech._id}`).emit("booking:assigned", {
        assignmentId: assignment._id,
        bookingId: booking._id,
        priority: booking.priority,
        message: `Inspection scheduled for ${booking.workOrderNumber || booking._id}`,
        unitInfo: booking.unitInfo,
        aiDiagnosis: booking.technicianAssistant?.summary || null,
        slaTarget: booking.slaTracking?.responseTarget
      });
    }

    // Email: Notify Technician of Assignment
    try {
      const User = require("../models/User");
      const { sendTechnicianNotificationEmail } = require("../utils/mailer");
      const techUser = tech.user ? await User.findById(tech.user).lean() : null;
      const techEmail = techUser?.email;
      const techFullName = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Technician';

      if (techEmail) {
        const dateLabel = scheduledDate ? new Date(scheduledDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = scheduledTime || 'TBD';
        sendTechnicianNotificationEmail({
          to: techEmail,
          technicianName: techFullName,
          customerName: booking.customer?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: `Inspection: ${booking.unitInfo?.unitType || 'Repair'}`,
          dateLabel,
          timeLabel,
          totalLabel: `₱${Number(booking.initialCost || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || '',
          issueDescription: booking.issueDescription || '',
        }).catch(err => console.error('[MAILER] Failed to send inspection assignment email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Inspection assignment email error:', mailErr.message);
    }

    // Notify customer
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        const dateStr = new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        const priorityNote = booking.priority === 'critical' || booking.priority === 'high'
          ? `\n\nPriority: ${booking.priority.toUpperCase()} - Your request is being handled with urgency.`
          : '';

        await sendEmail(booking.customer.email, "Inspection Scheduled",
          `Your repair work order ${booking.workOrderNumber || ""} inspection has been scheduled.

Date: ${dateStr}
Time: ${scheduledTime || "To be confirmed"}
Technician: ${tech.name || "Assigned technician"}
Priority: ${booking.priority?.toUpperCase() || 'MEDIUM'}${priorityNote}

Please ensure someone is available at the location during the scheduled time.`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, booking, assignment, priority: booking.priority });
  } catch (err) {
    next(err);
  }
});

// POST /:id/approve-quotation
// Admin approves quotation on behalf of customer
router.post("/:id/approve-quotation", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "awaiting_approval") {
      return res.status(400).json({ error: `Cannot approve quotation from status: ${booking.status}` });
    }

    booking.approval = {
      status: "approved",
      decidedAt: new Date(),
      reason: req.body.reason || "Approved by admin",
    };
    booking.status = "repair_approved";
    await booking.save();

    // Reserve stock for approved quotation parts
    try {
      const StockReservation = require("../models/StockReservation");
      const parts = booking.quotation?.parts || [];
      if (parts.length > 0) {
        const { reservations, insufficientStock } = await StockReservation.reserveForBooking({
          bookingId: booking._id,
          parts,
          reservedBy: req.user._id,
        });
        if (insufficientStock.length > 0) {
          console.warn(`[STOCK] Insufficient stock for booking ${booking._id}:`, insufficientStock);
        }
      }
    } catch (e) { console.error('[STOCK] Reservation error:', e.message); }

    // Notify technician
    if (global.io && booking.technicianId) {
      global.io.to(`tech:${booking.technicianId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Quotation approved for ${booking.workOrderNumber || booking._id}`,
      });
    }

    // Notify customer
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, "Quotation Approved", `Your repair quotation for ${booking.workOrderNumber || ""} has been approved. Parts will be reserved and repair scheduled.`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    next(err);
  }
});

// POST /:id/decline-quotation
// Admin declines quotation on behalf of customer
router.post("/:id/decline-quotation", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "awaiting_approval") {
      return res.status(400).json({ error: `Cannot decline quotation from status: ${booking.status}` });
    }

    booking.approval = {
      status: "declined",
      decidedAt: new Date(),
      reason: req.body.reason || "Declined by admin",
    };
    booking.status = "repair_declined";
    await booking.save();

    // Release any reserved stock
    try {
      const StockReservation = require("../models/StockReservation");
      await StockReservation.releaseForBooking(booking._id);
    } catch (e) { console.error('[STOCK] Release error:', e.message); }

    // Notify technician
    if (global.io && booking.technicianId) {
      global.io.to(`tech:${booking.technicianId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Quotation declined for ${booking.workOrderNumber || booking._id}`,
      });
    }

    // Notify customer
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, "Quotation Declined", `Your repair quotation for ${booking.workOrderNumber || ""} has been declined. Our team will contact you.`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    next(err);
  }
});

// POST /:id/repair-today-choice
// Customer chooses "Repair Today" or "Schedule Later" after approving quotation
router.post("/:id/repair-today-choice", auth.authenticate, auth.requireRole(["customer", "technician"]), async (req, res, next) => {
  try {
    const { choice, preferredDates, preferredTimeWindow } = req.body;
    // choice: "today" | "later"

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "repair_approved") {
      return res.status(400).json({ error: `Cannot make scheduling choice from status: ${booking.status}` });
    }

    if (!(await canAccessBooking(req.user, booking))) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (choice === "today") {
      // Customer wants repair today — check if technician is available
      const Technician = require("../models/Technician");
      const Assignment = require("../models/Assignment");

      const tech = booking.technicianId ? await Technician.findById(booking.technicianId) : null;
      if (!tech) {
        return res.json({
          success: true,
          available: false,
          message: "No technician assigned yet. Our team will contact you to confirm availability.",
          status: booking.status
        });
      }

      // Check if technician has remaining working hours today
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      // Check for existing assignments today
      const todayAssignments = await Assignment.find({
        technicianId: tech._id,
        status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
      }).select("startTime endTime bookingDate serviceDurationMinutes").lean();

      // Simple availability check: if technician has active jobs, not available for immediate
      const activeJobs = todayAssignments.filter(a => {
        const bd = new Date(a.bookingDate);
        return bd >= todayStart && bd <= todayEnd;
      });

      const estimatedDuration = booking.technicianAssistant?.estimatedDurationMinutes || 90;
      const COMPANY_END = 1020; // 5 PM
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const remainingMinutes = COMPANY_END - currentMinutes;

      if (activeJobs.length > 0 || remainingMinutes < estimatedDuration) {
        return res.json({
          success: true,
          available: false,
          message: activeJobs.length > 0
            ? "Technician is currently on another job. Please schedule for another day."
            : "Not enough remaining working hours today. Please schedule for another day.",
          status: booking.status,
          remainingHours: Math.floor(remainingMinutes / 60),
          estimatedDuration
        });
      }

      // Available! Start repair immediately
      booking.repairSchedule = {
        preference: "today",
        decidedAt: new Date(),
      };
      await booking.save();

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: booking._id,
        action: "booking.repair_today_choice",
        module: "appointments",
        req,
        details: { bookingId: booking._id, choice: "today", technicianId: tech._id },
      });

      return res.json({
        success: true,
        available: true,
        message: "Technician is available! Repair will start shortly.",
        status: booking.status,
        technicianName: tech.name || "Technician"
      });
    }

    if (choice === "later") {
      // Customer wants to schedule later — store preferred dates
      if (!preferredDates || !Array.isArray(preferredDates) || preferredDates.length === 0) {
        return res.status(400).json({ error: "Please provide at least one preferred date" });
      }

      booking.preferredSchedule = {
        dates: preferredDates.map(d => new Date(d)),
        timeWindow: preferredTimeWindow || "any",
        submittedAt: new Date(),
        submittedBy: userId,
      };
      booking.repairSchedule = {
        preference: "later",
        decidedAt: new Date(),
      };
      await booking.save();

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: booking._id,
        action: "booking.repair_today_choice",
        module: "appointments",
        req,
        details: { bookingId: booking._id, choice: "later", preferredDates, preferredTimeWindow },
      });

      // Notify admin
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Customer submitted preferred schedule for ${booking.workOrderNumber || booking._id}`,
        });
      }

      // Notify customer
      try {
        const { sendEmail } = require("../utils/mailer");
        if (booking.customer?.email) {
          const dateList = preferredDates.map(d => new Date(d).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })).join(", ");
          const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || 'https://racs.com';
          await sendEmail(booking.customer.email, "Schedule Request Submitted",
            `Dear ${booking.customer.name || 'Customer'},

Your preferred repair dates have been submitted:

📅 Preferred Dates: ${dateList}
⏰ Time Window: ${preferredTimeWindow || 'Any time'}

Our team will confirm the final schedule shortly.

You can view your booking details here:
${baseUrl}/book-history?highlight=${booking._id}

Work Order: ${booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`}

If you have any questions, please contact our support team.

Best regards,
RACS Repair Team`);
        }
      } catch (e) { /* non-critical */ }

      return res.json({
        success: true,
        message: "Your preferred dates have been submitted. Our team will confirm the final schedule.",
        status: booking.status
      });
    }

    return res.status(400).json({ error: "Invalid choice. Must be 'today' or 'later'." });
  } catch (err) {
    console.error("Repair today choice error:", err);
    next(err);
  }
});

// POST /:id/reserve-parts
// Admin marks parts as reserved for approved repair
router.post("/:id/reserve-parts", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!["repair_approved", "waiting_parts"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot reserve parts from status: ${booking.status}` });
    }

    const { parts } = req.body;
    if (parts && Array.isArray(parts)) {
      booking.partsReservation = parts.map(p => ({
        partName: p.name || "",
        partNumber: p.partNumber || "",
        quantity: parseInt(p.quantity) || 1,
        unitCost: parseFloat(p.cost) || 0,
        status: "reserved",
        reservedAt: new Date(),
      }));
    }

    // Enterprise: Record status transition with audit trail
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: booking.status,
      toStatus: 'parts_reserved',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || 'Admin',
      reason: 'Parts reserved for repair',
      notes: '',
      timestamp: new Date(),
      metadata: { partsCount: booking.partsReservation?.length || 0 }
    });

    booking.status = "parts_reserved";
    await booking.save();

    // Notify technician
    if (global.io && booking.technicianId) {
      global.io.to(`tech:${booking.technicianId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Parts reserved for ${booking.workOrderNumber || booking._id}. Ready for repair.`,
      });
    }

    // Notify customer
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, "Parts Reserved",
          `Parts for your repair work order ${booking.workOrderNumber || ""} have been reserved. The repair will be scheduled shortly.`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    next(err);
  }
});

// POST /:id/schedule-repair
// Admin schedules the actual repair work
router.post("/:id/schedule-repair", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!["parts_reserved", "repair_approved"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot schedule repair from status: ${booking.status}` });
    }

    const { scheduledDate, scheduledTime } = req.body;
    if (!scheduledDate) {
      return res.status(400).json({ error: "Scheduled date is required" });
    }

    // Enterprise: Record status transition with audit trail
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: booking.status,
      toStatus: 'ready_for_repair',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || 'Admin',
      reason: 'Repair scheduled and ready for technician',
      notes: '',
      timestamp: new Date(),
      metadata: { scheduledDate, scheduledTime }
    });

    booking.status = "ready_for_repair";
    await booking.save();

    // Notify technician
    if (global.io && booking.technicianId) {
      global.io.to(`tech:${booking.technicianId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Repair scheduled for ${booking.workOrderNumber || booking._id}. You can start when ready.`,
      });
    }

    // Notify customer
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        const dateStr = new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        await sendEmail(booking.customer.email, "Repair Scheduled",
          `Your repair work order ${booking.workOrderNumber || ""} has been scheduled for ${dateStr}${scheduledTime ? ' at ' + scheduledTime : ''}.\n\nOur technician will arrive at your location. Please ensure someone is available.`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    next(err);
  }
});

/**
 * Build repair subdocument for a Project from a repair-type BookingService.
 */
async function buildRepairData(booking) {
  const Tool = require('../models/Tool');
  const quotationParts = (booking.quotation?.parts || []).map(p => ({
    name: p.name,
    cost: p.cost,
    quantity: p.quantity,
    toolId: p.toolId,
    currentStock: 0,
    stockStatus: 'pending_check',
  }));
  for (const part of quotationParts) {
    if (part.toolId) {
      try {
        const tool = await Tool.findById(part.toolId).lean();
        if (tool) {
          part.currentStock = tool.availableQuantity || tool.quantity || 0;
          part.stockStatus = part.currentStock >= part.quantity ? 'in_stock'
            : part.currentStock > 0 ? 'low_stock' : 'out_of_stock';
        }
      } catch (_) {}
    }
  }
  return {
    serviceType: 'repair',
    unitInfo: {
      unitType: booking.unitInfo?.unitType || '',
      brand: booking.unitInfo?.brand || '',
      model: booking.unitInfo?.model || '',
      problemDescription: booking.unitInfo?.problemDescription || '',
      photos: booking.unitInfo?.photos || [],
    },
    inspection: {
      findings: booking.inspection?.findings || '',
      severity: booking.inspection?.severity || '',
      damagedParts: booking.inspection?.damagedParts || [],
      recommendedAction: booking.inspection?.recommendedAction || '',
      technicianName: booking.inspection?.technicianId?.name || '',
      completedAt: booking.inspection?.completedAt,
    },
    diagnosis: {
      summary: booking.diagnosis?.diagnosisSummary || booking.diagnosis?.findings || '',
      confirmedDiagnoses: booking.diagnosis?.confirmedDiagnoses || [],
      laborCategory: booking.diagnosis?.laborCategory || booking.quotation?.laborCategory || 'standard',
      laborDuration: booking.diagnosis?.laborDuration || '',
      technicianName: booking.diagnosis?.technicianId?.name || '',
    },
    aiAssist: {
      summary: booking.technicianAssistant?.summary || '',
      probableCauses: booking.technicianAssistant?.probableCauses || [],
      suggestedTools: booking.technicianAssistant?.suggestedTools || [],
      possibleParts: booking.technicianAssistant?.possibleParts || [],
      repairComplexity: booking.technicianAssistant?.repairComplexity || '',
      estimatedDurationMinutes: booking.technicianAssistant?.estimatedDurationMinutes || 0,
      safetyReminders: booking.technicianAssistant?.safetyReminders || [],
    },
    quotation: {
      parts: quotationParts,
      laborCost: booking.quotation?.laborCost || 0,
      laborCategory: booking.quotation?.laborCategory || 'standard',
      totalCost: booking.quotation?.totalCost || 0,
      notes: booking.quotation?.notes || '',
      approvedAt: booking.approval?.status === 'approved' ? booking.approval.decidedAt : undefined,
    },
    warranty: {
      days: 30,
    },
  };
}

// Customer reschedule confirmation: accept, request new, or cancel
router.post('/:id/reschedule-action', auth.authenticate, async (req, res) => {
  try {
    const BookingService = require('../models/BookingService');
    const Payment = require('../models/Payment');
    const Assignment = require('../models/Assignment');
    const Technician = require('../models/Technician');
    const { BookingStatus } = require('../models/BookingStatus');
    const { createNotification } = require('../utils/notify');

    const { action, requestedDate, requestedTime, reason } = req.body;
    if (!['accept', 'request_new', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be accept, request_new, or cancel.' });
    }

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (String(booking.customerId) !== String(req.user._id) && !['admin', 'secretary'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const io = req.app.get('io');
    const isRepair = booking.serviceModel === 'RepairService' || booking.serviceType === 'repair';
    const proposal = booking.proposedReschedule;

    if (action === 'accept') {
      if (!proposal || proposal.status !== 'pending') {
        return res.status(400).json({ error: 'No pending reschedule proposal to accept' });
      }
      proposal.status = 'accepted';
      booking.proposedReschedule = proposal;

      // Apply the confirmed schedule from the proposal. The booking's active
      // date/time is only committed here (admin-reschedule no longer mutates
      // it early), so once accepted the booking reflects the proposed slot.
      if (proposal.date) booking.bookingDate = new Date(proposal.date);
      booking.startTime = proposal.time || proposal.timeLabel || booking.startTime;
      booking.selectedTimeLabel = booking.startTime;
      booking.autoReschedulePending = false;

      if (proposal.technicianId) {
        const tech = await Technician.findById(proposal.technicianId).select('name _id').lean();
        const customerName = booking.customer?.name || 'Customer';
        const serviceName = booking.service?.name || (isRepair ? 'Repair Service' : 'Service');

        const assignment = new Assignment({
          bookingId: booking._id,
          technicianId: proposal.technicianId,
          customerName,
          serviceName,
          serviceDurationMinutes: booking.serviceDurationMinutes || 60,
          bookingDate: booking.bookingDate,
          startTime: booking.startTime,
          selectedTimeLabel: booking.startTime,
          address: booking.location?.address || '',
          estimatedFee: booking.totalPrice || booking.estimatedFee || 0,
          status: 'pending_acceptance',
          notes: [{ text: `Reschedule proposal accepted by customer. Proposed by ${proposal.proposedByName || 'admin'}`, by: req.user._id, byName: req.user.name || req.user.email, createdAt: new Date() }],
        });
        await assignment.save();

        const previousStatus = booking.status;
        booking.technicianId = proposal.technicianId;
        booking.technician = { _id: proposal.technicianId, name: tech?.name || proposal.technicianName };
        booking.assignmentId = assignment._id;
        booking.assignedAt = new Date();
        booking.assignedBy = req.user._id;
        booking.status = isRepair ? BookingStatus.INSPECTION_SCHEDULED : BookingStatus.ASSIGNED;

        booking.recordStatusHistory({
          fromStatus: previousStatus,
          toStatus: booking.status,
          changedBy: req.user._id,
          changedByModel: 'User',
          changedByName: req.user.name || req.user.email,
          reason: 'Customer accepted reschedule proposal',
        });
      } else {
        const previousStatus = booking.status;
        booking.status = BookingStatus.AWAITING_ASSIGNMENT;
        booking.recordStatusHistory({
          fromStatus: previousStatus,
          toStatus: booking.status,
          changedBy: req.user._id,
          changedByModel: 'User',
          changedByName: req.user.name || req.user.email,
          reason: 'Customer accepted reschedule proposal; technician TBD',
        });
      }

      await booking.save();

      // ── Cleanup: Release reserved equipment from old assignment ──────
      try {
        const EquipmentAssignment = require('../models/EquipmentAssignment');
        const Tool = require('../models/Tool');
        const reserved = await EquipmentAssignment.find({
          bookingId: booking._id,
          status: 'reserved',
        }).lean();
        if (reserved.length) {
          for (const eq of reserved) {
            if (eq.equipmentId) {
              await Tool.findByIdAndUpdate(eq.equipmentId, { $inc: { reservedQuantity: -(eq.quantity || 1) } }).catch(() => {});
            }
          }
          await EquipmentAssignment.deleteMany({
            bookingId: booking._id,
            status: 'reserved',
          });
        }
      } catch (eqErr) {
        console.warn('Equipment cleanup on accept reschedule skipped:', eqErr.message);
      }

      await createNotification({
        type: 'booking_reschedule_accepted',
        title: 'Reschedule Accepted',
        message: `Customer accepted the rescheduled ${booking.service?.name || 'service'} on ${new Date(booking.bookingDate).toLocaleDateString('en-PH')} at ${booking.startTime}.`,
        role: 'admin',
        referenceId: booking._id,
        referenceModel: 'BookingService',
        link: `/admin/appointments?ref=${booking.bookingReference}`,
        io,
      });

      if (booking.customerId) {
        await createNotification({
          type: 'booking_reschedule_confirmed',
          title: 'Reschedule Confirmed',
          message: `Your reschedule for ${booking.service?.name || 'your service'} has been confirmed for ${new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })} at ${booking.startTime}.`,
          userId: booking.customerId,
          role: 'customer',
          referenceId: booking._id,
          referenceModel: 'BookingService',
          link: '/tracking',
          io,
        });
      }

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: booking._id,
        action: 'booking.reschedule_accept',
        module: 'appointments',
        req,
        details: { bookingId: booking._id, newDate: booking.bookingDate, newTime: booking.startTime },
      });

      return res.json({ success: true, message: 'Reschedule accepted. Technician will be notified.', booking });
    }

    if (action === 'request_new') {
      if (!requestedDate || !requestedTime) {
        return res.status(400).json({ error: 'requestedDate and requestedTime are required' });
      }
      // Guard against double-booking: reject a requested slot that is no
      // longer available (conflicts with other active bookings or all
      // technicians are busy) before recording the customer's request.
      const reqStartMin = parseTimeValue(requestedTime);
      if (!Number.isFinite(reqStartMin)) {
        return res.status(400).json({ error: 'Invalid requested time format' });
      }
      const reqEndMin = reqStartMin + (Number(booking.serviceDurationMinutes) || 90);
      try {
        await assertCompanyCapacity(new Date(requestedDate), reqStartMin, reqEndMin, booking._id);
      } catch (capErr) {
        return res.status(409).json({ error: capErr.message });
      }
      if (proposal) {
        proposal.status = 'new_requested';
        booking.proposedReschedule = proposal;
      }
      booking.rescheduleRequest = {
        requested: true,
        requestedDate,
        requestedTime,
        reason: reason || '',
        requestedBy: req.user._id,
        requestedAt: new Date(),
        status: 'pending',
      };
      // Update booking date/time to the customer's requested slot so the
      // assignment planner checks eligibility against the correct date
      booking.bookingDate = new Date(requestedDate);
      booking.startTime = requestedTime;
      const previousStatus = booking.status;
      booking.status = BookingStatus.PENDING_REASSIGNMENT;
      booking.recordStatusHistory({
        fromStatus: previousStatus,
        toStatus: booking.status,
        changedBy: req.user._id,
        changedByModel: 'User',
        changedByName: req.user.name || req.user.email,
        reason: `Customer requested a different schedule: ${requestedDate} at ${requestedTime}`,
      });
      await booking.save();

      await createNotification({
        type: 'booking_reschedule_request',
        title: 'Customer Reschedule Request',
        message: `Customer for ${booking.bookingReference} requested a new schedule: ${requestedDate} at ${requestedTime}.`,
        role: 'admin',
        referenceId: booking._id,
        referenceModel: 'BookingService',
        link: `/admin/appointments/attention`,
        io,
      });

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: booking._id,
        action: 'booking.reschedule_request_new',
        module: 'appointments',
        req,
        details: { bookingId: booking._id, requestedDate, requestedTime, reason: reason || '' },
      });

      return res.json({ success: true, message: 'New schedule request submitted.', booking });
    }

    if (action === 'cancel') {
      const previousStatus = booking.status;
      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = reason || 'Customer cancelled after reschedule proposal';
      if (proposal) {
        proposal.status = 'rejected';
        booking.proposedReschedule = proposal;
      }
      booking.recordStatusHistory({
        fromStatus: previousStatus,
        toStatus: booking.status,
        changedBy: req.user._id,
        changedByModel: 'User',
        changedByName: req.user.name || req.user.email,
        reason: booking.cancellationReason,
      });

      // Refund downpayment if any
      const downpayment = await Payment.findOne({
        bookingId: booking._id,
        type: 'downpayment',
        status: { $in: ['verified', 'paid', 'payment_collected', 'remitted'] },
      }).sort({ submittedAt: -1 });
      if (downpayment) {
        downpayment.status = 'refunded';
        downpayment.refundedAt = new Date();
        downpayment.refundedBy = req.user._id;
        downpayment.refundReason = 'Customer cancelled after reschedule proposal';
        downpayment.events.push({
          status: 'refunded',
          actor: req.user._id,
          actorName: req.user.name || req.user.email,
          actorRole: 'customer',
          note: 'Refunded by customer-initiated cancellation',
          at: new Date(),
        });
        await downpayment.save();

        booking.paymentStatus = 'refunded';
        booking.amountPaid = 0;
        booking.balanceAmount = 0;
      }

      await booking.save();

      await createNotification({
        type: 'booking_cancelled',
        title: 'Booking Cancelled',
        message: `Customer cancelled ${booking.bookingReference} after a reschedule proposal. Downpayment ${downpayment ? 'refunded' : 'not applicable'}.`,
        role: 'admin',
        referenceId: booking._id,
        referenceModel: 'BookingService',
        link: `/admin/appointments?ref=${booking.bookingReference}`,
        io,
      });

      await audit.logEvent({
        actor: req.user && req.user._id,
        target: booking._id,
        action: 'booking.reschedule_cancel',
        module: 'appointments',
        req,
        details: { bookingId: booking._id, reason: reason || 'Customer cancelled after reschedule proposal', downpaymentRefunded: !!downpayment },
      });

      return res.json({ success: true, message: 'Booking cancelled and downpayment refunded if applicable.', booking });
    }
  } catch (error) {
    console.error('Reschedule action error:', error);
    res.status(500).json({ error: error.message || 'Failed to process reschedule action' });
  }
});

module.exports = router;
