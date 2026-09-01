/**
 * Technician-facing REST API
 * Mounted at /api/technician
 * All routes require: authenticated + role === "technician"
 */
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Tool = require("../models/Tool");
const EquipmentUsageLog = require("../models/EquipmentUsageLog");
const { buildServicePreparation } = require('../utils/servicePreparation');
const { dayBounds: dailyKitDayBounds, syncDailyKit, confirmDailyKit } = require('../utils/dailyKitService');
const { canTransitionServiceItem } = require('../utils/bookingServiceItems');
const { getRepairLaborFees, normalizeRepairComplexity } = require('../utils/repairLaborPricing');
const { isBookingPast } = require('../utils/bookingPolicy');
const { imageExtensionFor, isAllowedImage } = require('../utils/uploadSecurity');
const { escapeRegex } = require('../utils/stringSecurity');
const { buildBookingWarrantyCoverage } = require('../utils/aftercarePolicy');

async function configuredBookingWarranty(booking, completedAt) {
  return buildBookingWarrantyCoverage(booking, completedAt);
}

/**
 * A "missed schedule" assignment is one whose scheduled service window has
 * fully elapsed while the job has not been started. Technicians cannot act
 * on these — admin must reschedule first (same policy as appointmentManagement).
 */
function assertNotMissedSchedule(assignment) {
  const started = ['en_route', 'on_site', 'in_progress', 'completed', 'cancelled', 'declined', 'no_show', 'no_show_reported'];
  if (started.includes(assignment.status)) return false;
  return isBookingPast({
    bookingDate: assignment.bookingDate,
    startTime: assignment.startTime,
    endTime: assignment.endTime,
    serviceDurationMinutes: assignment.serviceDurationMinutes,
  });
}

// ── Proof of completion upload config ──────────────────────────────────
const proofUploadDir = path.join(__dirname, "../public/uploads/completion-proofs");
if (!fs.existsSync(proofUploadDir)) fs.mkdirSync(proofUploadDir, { recursive: true });

const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, proofUploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "proof-" + uniqueSuffix + imageExtensionFor(file));
  },
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, isAllowedImage(file));
  },
}).single("proofPhoto");

const expenseReceiptDir = path.join(__dirname, "../public/uploads/expense-receipts");
if (!fs.existsSync(expenseReceiptDir)) fs.mkdirSync(expenseReceiptDir, { recursive: true });
const expenseReceiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, expenseReceiptDir),
    filename: (req, file, cb) => {
      const extension = imageExtensionFor(file) || (file.mimetype === "application/pdf" ? ".pdf" : "");
      cb(null, `expense-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isAllowedImage(file) || file.mimetype === "application/pdf"),
}).single("receipt");

/**
 * Parse a time string to minutes-from-midnight.
 * Handles: "480", "8:00", "8:00 AM", "2:30 PM"
 * Returns NaN on invalid input.
 */
function parseTimeStr(value) {
  if (value === null || value === undefined) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  // Pure digits → minutes from midnight
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  // 24h HH:MM
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  // 12h with AM/PM
  const ap = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ap) { let hh = Number(ap[1]) % 12; if (ap[3].toUpperCase() === 'PM') hh += 12; return hh * 60 + Number(ap[2]); }
  return NaN;
}

function getMixedPhaseOnePayment(booking) {
  const services = Array.isArray(booking?.services) ? booking.services : [];
  const coreItems = services.filter(item => item.type === "core");
  const repairItems = services.filter(item => item.type === "repair");
  const isMixedBooking = booking?.serviceType === "mixed" || (coreItems.length > 0 && repairItems.length > 0);
  const repairInspectionFee = repairItems.reduce((sum, item) => (
    sum + Math.max(0, Number(item.totalPrice || ((item.unitPrice || 0) * (item.quantity || 1))) || 0)
  ), 0);
  const distanceFare = Math.max(0, Number(booking?.travelFare) || 0);
  const inspectionTarget = repairInspectionFee + distanceFare;
  const allCoreCompleted = coreItems.length > 0 && coreItems.every(item => item.status === "completed");
  const initialBookingTotal = Math.max(0, Number(booking?.totalPrice || booking?.estimatedFee) || 0);
  const phaseOneTarget = allCoreCompleted
    ? Math.max(initialBookingTotal, inspectionTarget)
    : inspectionTarget;
  const amountPaid = Math.max(0, Number(booking?.amountPaid) || 0);
  const amountDue = Math.max(0, phaseOneTarget - amountPaid);
  const coreServiceAmount = allCoreCompleted
    ? Math.max(0, phaseOneTarget - inspectionTarget)
    : 0;
  return {
    isMixedBooking,
    allCoreCompleted,
    repairInspectionFee,
    distanceFare,
    inspectionTarget,
    initialBookingTotal,
    phaseOneTarget,
    amountPaid,
    amountDue,
    coreServiceAmount,
  };
}

function parseCalendarDateParam(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = raw.replace(
    /(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) (\d{2}:\d{2})$/,
    "$1+$2"
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadTechnicianContext(userId) {
  const Technician = require("../models/Technician");
  const tech = await Technician.findOne({ user: userId }).lean();
  if (!tech) return { tech: null, technicianIds: [] };
  const technicianIds = [String(tech._id)];
  if (tech.user) technicianIds.push(String(tech.user));
  if (userId) technicianIds.push(String(userId));
  return { tech, technicianIds: Array.from(new Set(technicianIds)) };
}

// ── Auth guards ───────────────────────────────────────────────────────────────
router.use(auth.authenticate);
router.use(auth.requireRole("technician"));

// Warranty inspections mirror the core-service field lifecycle.
router.get("/warranty-claims", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const WarrantyClaim = require("../models/WarrantyClaim");
    const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!technician) return res.status(404).json({ error: "Technician record not found." });
    const filter = { assignedTechnicianId: technician._id };
    if (String(req.query.active || "true") !== "false") filter.active = true;
    const claims = await WarrantyClaim.find(filter)
      .populate("customerId", "name phone email address")
      .sort({ "inspection.scheduledDate": 1, priority: 1, submittedAt: 1 })
      .lean();
    return res.json({ claims });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/status", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { canTransitionClaim, cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const technician = await Technician.findOne({ user: req.user._id }).select("_id name").lean();
    if (!technician) return res.status(404).json({ error: "Technician record not found." });
    const claim = await WarrantyClaim.findOne({ _id: req.params.id, assignedTechnicianId: technician._id });
    if (!claim) return res.status(404).json({ error: "Assigned warranty inspection not found." });
    const nextStatus = cleanText(req.body.status, 40);
    if (!canTransitionClaim(claim.status, nextStatus, "technician")) {
      return res.status(409).json({ error: `Cannot move this inspection from ${claim.status} to ${nextStatus}.` });
    }
    const now = new Date();
    if (nextStatus === "inspection_en_route") claim.inspection.enRouteAt = now;
    if (nextStatus === "inspection_arrived") claim.inspection.arrivedAt = now;
    if (nextStatus === "inspection_in_progress") claim.inspection.startedAt = now;
    if (nextStatus === "inspection_completed") {
      const diagnosis = cleanText(req.body.diagnosis, 3000);
      const allowedRootCauses = ["product_defect", "workmanship", "replacement_part", "customer_damage", "maintenance", "third_party", "inconclusive"];
      if (diagnosis.length < 20 || !allowedRootCauses.includes(req.body.rootCause)) {
        return res.status(400).json({ error: "A detailed diagnosis and root-cause classification are required." });
      }
      claim.inspection.diagnosis = diagnosis;
      claim.inspection.rootCause = req.body.rootCause;
      claim.inspection.completedAt = now;
    }
    claim.status = nextStatus;
    claim.history.push({
      status: nextStatus,
      actorId: req.user._id,
      actorRole: "technician",
      actorName: technician.name || req.user.name || "Technician",
      note: cleanText(req.body.note, 2000) || nextStatus.replace(/_/g, " "),
    });
    await claim.save();
    const { createNotification } = require("../utils/notify");
    const customerVisible = {
      inspection_en_route: "Your warranty technician is en route.",
      inspection_arrived: "Your warranty technician has arrived.",
      inspection_in_progress: "Your warranty inspection has started.",
      inspection_completed: "The technician submitted the inspection findings for admin review.",
    };
    const notifications = [createNotification({ type: "warranty_inspection_update", title: "Warranty inspection update", message: `${claim.claimReference}: ${customerVisible[nextStatus]}`, userId: claim.customerId, referenceId: claim._id, referenceModel: "WarrantyClaim", link: claim.sourceType === "order" ? `/my-orders/${claim.sourceId}` : "/book-history", priority: "high", io: req.app.get("io") })];
    if (nextStatus === "inspection_completed") {
      notifications.push(createNotification({ type: "warranty_inspection_completed", title: "Warranty findings ready", message: `${claim.claimReference} is ready for an admin decision.`, role: "admin", referenceId: claim._id, referenceModel: "WarrantyClaim", link: `/admin/warranty?claim=${claim._id}`, priority: "high", io: req.app.get("io") }));
    }
    await Promise.all(notifications);
    return res.json({ success: true, claim });
  } catch (error) {
    return next(error);
  }
});

router.get("/aftercare-policy", async (_req, res, next) => {
  try {
    const policy = await getAftercarePolicy();
    return res.json({
      maintenance: {
        bookingsEnabled: policy.maintenance.bookingsEnabled,
        bookingIntervalDays: policy.maintenance.bookingIntervalDays,
        allowTechnicianRecommendation: policy.maintenance.allowTechnicianRecommendation,
      },
    });
  } catch (error) { next(error); }
});

// Every appointment-specific technician action must target work assigned to
// that technician, even if an individual handler forgets an ownership check.
router.use("/appointments/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next();
    }
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(403).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id)
      .select("technicianId services.technicianId")
      .lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const directAssignment = technicianIds.includes(String(booking.technicianId || ""));
    const itemAssignment = (booking.services || []).some((item) =>
      technicianIds.includes(String(item.technicianId || "")),
    );
    const assignment = directAssignment || itemAssignment
      ? true
      : await Assignment.exists({
          bookingId: booking._id,
          technicianId: { $in: technicianIds },
          status: { $nin: ["declined", "cancelled"] },
        });
    if (!assignment) {
      return res.status(403).json({ error: "This booking is not assigned to you" });
    }
    req.technician = tech;
    return next();
  } catch (err) {
    return next(err);
  }
});

router.get('/settings/repair-labor-fees', async (req, res, next) => {
  try { return res.json({ fees: await getRepairLaborFees() }); }
  catch (err) { next(err); }
});

// Technician explicitly acknowledges an admin-approved service-item update.
router.post("/appointments/:id/service-change-requests/:requestId/acknowledge", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const technician = await Technician.findOne({ $or: [{ user: req.user._id }, { userEmail: req.user.email }] });
    if (!technician) return res.status(404).json({ error: "Technician profile not found" });
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const ownsAnyItem = booking.services.some(item => String(item.technicianId || "") === String(technician._id));
    if (String(booking.technicianId || "") !== String(technician._id) && !ownsAnyItem) return res.status(403).json({ error: "This booking is not assigned to you." });
    const change = booking.serviceChangeRequests.id(req.params.requestId);
    if (!change || !["approved", "customer_accepted_schedule"].includes(change.status)) return res.status(409).json({ error: "No approved update is awaiting acknowledgement." });
    change.technicianAcknowledgedAt = new Date();
    change.technicianAcknowledgedBy = technician._id;
    await booking.save();
    return res.json({ success: true, acknowledgedAt: change.technicianAcknowledgedAt });
  } catch (err) { next(err); }
});

// Batch update all core service items in a single save (avoids version conflicts)
router.patch("/appointments/:id/core-items/batch", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");
    const technician = await Technician.findOne({ $or: [{ user: req.user._id }, { userEmail: req.user.email }] });
    const booking = await BookingService.findById(req.params.id);
    if (!technician || !booking) return res.status(404).json({ error: "Booking or technician not found" });
    const targetStatus = String(req.body.status || "");
    if (!["in_progress", "completed"].includes(targetStatus)) {
      return res.status(400).json({ error: "Batch status must be in_progress or completed." });
    }
    const isMixedBooking = booking.serviceType === "mixed"
      || (booking.services.some(row => row.type === "core") && booking.services.some(row => row.type === "repair"));
    const hasRepairCompletionEvidence = Boolean(booking.repairCompletion?.completedAt)
      || ["repair_completed", "under_warranty"].includes(booking.status);

    // For starting: only pending-type statuses
    // For completing: only in_progress
    const startableStatuses = ["pending", "awaiting_assignment", "assigned", "accepted", "scheduled", "en_route", "arrived"];
    const eligibleStatuses = targetStatus === "in_progress" ? startableStatuses : ["in_progress"];

    const activeSharedAssignment = await Assignment.exists({
      bookingId: booking._id,
      technicianId: technician._id,
      status: { $in: ["in_progress", "completed"] },
    });

    let updatedCount = 0;
    for (const item of booking.services) {
      if (item.type !== "core") continue;
      if (String(item.status) === targetStatus) continue;
      if (!eligibleStatuses.includes(String(item.status))) continue;
      if (String(item.technicianId || booking.technicianId || "") !== String(technician._id)) continue;

      // Verify transition is allowed (either directly or via mixed-booking recovery)
      let transitionAllowed = canTransitionServiceItem(item, targetStatus);
      if (!transitionAllowed && isMixedBooking) {
        const coreWorkRecovery = targetStatus === "in_progress" && startableStatuses.includes(String(item.status));
        if (coreWorkRecovery) transitionAllowed = Boolean(activeSharedAssignment);
      }
      if (!transitionAllowed) continue;

      item.status = targetStatus;
      item.statusHistory = item.statusHistory || [];
      item.statusHistory.push({
        status: targetStatus,
        changedAt: new Date(),
        changedBy: technician._id,
        changedByName: technician.name,
        reason: String(req.body.reason || `Core service ${targetStatus === 'in_progress' ? 'started' : 'completed'} by technician (batch)`),
      });

      // Reconcile repair items when completing core
      if (targetStatus === "completed" && isMixedBooking && hasRepairCompletionEvidence) {
        for (const repairItem of booking.services.filter(row => row.type === "repair" && row.status !== "completed")) {
          repairItem.status = "completed";
          repairItem.phase = "repair_phase_2";
          repairItem.statusHistory = repairItem.statusHistory || [];
          repairItem.statusHistory.push({
            status: "completed",
            changedAt: new Date(),
            changedBy: technician._id,
            changedByName: technician.name,
            reason: "Reconciled from existing repair completion evidence",
          });
        }
      }
      updatedCount++;
    }

    if (updatedCount === 0) {
      return res.status(409).json({ error: "No Core service items eligible for this batch operation." });
    }

    // Check if all services are now completed
    const allServicesCompleted = targetStatus === "completed" && booking.services.every(row =>
      row.status === "completed" || (isMixedBooking && ["repair_declined", "cancelled"].includes(row.status))
    );
    const hasDeclinedRepair = isMixedBooking
      && booking.services.some(row => row.type === 'repair' && ['repair_declined', 'cancelled'].includes(row.status));

    if (allServicesCompleted) {
      const previousBookingStatus = booking.status;
      const aggregateStatus = booking.serviceType === "repair" ? "repair_completed" : "completed";
      booking.status = aggregateStatus;
      booking.completedAt = booking.completedAt || new Date();
      if (!booking.warranty?.startDate || !booking.warranty?.endDate) {
        const configuredWarranty = await configuredBookingWarranty(booking, booking.completedAt);
        if (configuredWarranty.coverage) booking.warranty = configuredWarranty.coverage;
      }
      if (previousBookingStatus !== aggregateStatus) {
        booking.statusHistory = booking.statusHistory || [];
        booking.statusHistory.push({
          fromStatus: previousBookingStatus,
          toStatus: aggregateStatus,
          changedBy: technician._id,
          changedByModel: "Technician",
          changedByName: technician.name || "Technician",
          reason: "All service items in the shared booking are complete",
          timestamp: booking.completedAt,
        });
      }
    }

    // Check balance requirement before saving
    if (allServicesCompleted) {
      const unpaidBookingBalance = Math.max(0, Number(booking.balanceAmount) || 0);
      if (unpaidBookingBalance > 0 && !booking.balanceCollected) {
        return res.status(409).json({
          error: `Collect the remaining booking balance of ₱${unpaidBookingBalance.toLocaleString()} before completing the final service item.`,
          code: 'BOOKING_BALANCE_REQUIRED',
          balanceAmount: unpaidBookingBalance,
        });
      }
    }

    await booking.save();

    if (allServicesCompleted) {
      const completedAt = booking.completedAt || new Date();
      await Assignment.findOneAndUpdate(
        { bookingId: booking._id, technicianId: technician._id },
        { status: "completed", completedAt }
      );
      try {
        const { syncMaintenanceFromBooking } = require("../utils/maintenanceLifecycle");
        await syncMaintenanceFromBooking(booking);
      } catch (maintenanceError) {
        console.error("Failed to create batch-booking maintenance schedules:", maintenanceError.message);
      }
    }

    res.json({
      success: true,
      updatedCount,
      allServicesCompleted,
      hasDeclinedRepair,
    });
  } catch (err) { next(err); }
});

router.patch("/appointments/:id/service-items/:itemId/status", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");
    const technician = await Technician.findOne({ $or: [{ user: req.user._id }, { userEmail: req.user.email }] });
    const booking = await BookingService.findById(req.params.id);
    if (!technician || !booking) return res.status(404).json({ error: "Booking or technician not found" });
    const item = booking.services.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Service item not found" });
    if (String(item.technicianId || booking.technicianId || "") !== String(technician._id)) return res.status(403).json({ error: "This service item is not assigned to you." });
    const isMixedBooking = booking.serviceType === "mixed"
      || (booking.services.some(row => row.type === "core") && booking.services.some(row => row.type === "repair"));
    const hasRepairCompletionEvidence = Boolean(booking.repairCompletion?.completedAt)
      || ["repair_completed", "under_warranty"].includes(booking.status);
    const nextStatus = String(req.body.status || "");
    const allowed = new Set([
      "accepted", "en_route", "arrived", "in_progress", "completed", "on_hold",
      "inspection_scheduled", "inspection_in_progress", "inspection_completed",
      "diagnosis_completed", "parts_check", "awaiting_quotation",
      "awaiting_customer_decision", "ready_for_repair", "repair_scheduled",
      "repair_in_progress", "payment_pending"
    ]);
    if (!allowed.has(nextStatus)) return res.status(400).json({ error: "Invalid service-item status transition." });
    if (item.type !== "repair" && nextStatus.startsWith("inspection_")) return res.status(400).json({ error: "Inspection lifecycle is only valid for repair items." });
    let transitionAllowed = canTransitionServiceItem(item, nextStatus);
    if (!transitionAllowed && isMixedBooking) {
      const currentStatus = String(item.status || "");
      const repairInspectionRecovery = item.type === "repair"
        && nextStatus === "inspection_in_progress"
        && new Set(["pending", "inspection_pending", "awaiting_assignment", "assigned", "inspection_scheduled", "accepted", "scheduled", "en_route", "arrived"]).has(currentStatus);
      const coreWorkRecovery = item.type === "core"
        && nextStatus === "in_progress"
        && new Set(["pending", "awaiting_assignment", "assigned", "accepted", "scheduled", "en_route", "arrived"]).has(currentStatus);
      if (repairInspectionRecovery || coreWorkRecovery) {
        const activeSharedAssignment = await Assignment.exists({
          bookingId: booking._id,
          technicianId: technician._id,
          status: { $in: ["in_progress", "completed"] },
        });
        transitionAllowed = Boolean(activeSharedAssignment);
      }
    }
    if (!transitionAllowed) return res.status(409).json({ error: `Cannot move this service item from ${item.status} to ${nextStatus}.` });
    const wouldFinishMixedBooking = isMixedBooking && nextStatus === 'completed'
      && booking.services.every(row => String(row._id) === String(item._id)
        || ['completed', 'cancelled', 'repair_declined'].includes(row.status)
        || (row.type === 'repair' && hasRepairCompletionEvidence));
    const unpaidBookingBalance = Math.max(0, Number(booking.balanceAmount) || 0);
    if (wouldFinishMixedBooking && unpaidBookingBalance > 0 && !booking.balanceCollected) {
      return res.status(409).json({
        error: `Collect the remaining booking balance of ₱${unpaidBookingBalance.toLocaleString()} before completing the final service item.`,
        code: 'BOOKING_BALANCE_REQUIRED',
        balanceAmount: unpaidBookingBalance,
      });
    }
    item.status = nextStatus;
    if (["ready_for_repair", "repair_scheduled", "repair_in_progress", "payment_pending", "completed"].includes(nextStatus) && item.type === "repair") item.phase = "repair_phase_2";
    item.statusHistory = item.statusHistory || [];
    item.statusHistory.push({ status: nextStatus, changedAt: new Date(), changedBy: technician._id, changedByName: technician.name, reason: String(req.body.reason || "Technician workflow update") });

    // Reconcile mixed records completed by the older booking-level Repair
    // endpoint, which did not persist completion on each Repair child item.
    if (nextStatus === "completed" && item.type === "core" && isMixedBooking && hasRepairCompletionEvidence) {
      for (const repairItem of booking.services.filter(row => row.type === "repair" && row.status !== "completed")) {
        repairItem.status = "completed";
        repairItem.phase = "repair_phase_2";
        repairItem.statusHistory = repairItem.statusHistory || [];
        repairItem.statusHistory.push({
          status: "completed",
          changedAt: new Date(),
          changedBy: technician._id,
          changedByName: technician.name,
          reason: "Reconciled from existing repair completion evidence",
        });
      }
    }

    const allServicesCompleted = nextStatus === "completed" && booking.services.every(row =>
      row.status === "completed" || (isMixedBooking && ["repair_declined", "cancelled"].includes(row.status))
    );
    const hasDeclinedRepair = isMixedBooking
      && booking.services.some(row => row.type === 'repair' && ['repair_declined', 'cancelled'].includes(row.status));
    if (allServicesCompleted) {
      const previousBookingStatus = booking.status;
      const aggregateStatus = booking.serviceType === "repair" ? "repair_completed" : "completed";
      booking.status = aggregateStatus;
      booking.completedAt = booking.completedAt || new Date();
      if (!booking.warranty?.startDate || !booking.warranty?.endDate) {
        const configuredWarranty = await configuredBookingWarranty(booking, booking.completedAt);
        if (configuredWarranty.coverage) booking.warranty = configuredWarranty.coverage;
      }
      if (previousBookingStatus !== aggregateStatus) {
        booking.statusHistory = booking.statusHistory || [];
        booking.statusHistory.push({
          fromStatus: previousBookingStatus,
          toStatus: aggregateStatus,
          changedBy: technician._id,
          changedByModel: "Technician",
          changedByName: technician.name || "Technician",
          reason: "All service items in the shared booking are complete",
          timestamp: booking.completedAt,
        });
      }
    }
    await booking.save();

    let assignmentCompleted = false;
    if (allServicesCompleted) {
      const completedAt = booking.completedAt || new Date();
      const assignment = await Assignment.findOneAndUpdate(
        { bookingId: booking._id, technicianId: technician._id },
        { $set: { status: "completed", completedAt } },
        { returnDocument: "after" }
      );
      assignmentCompleted = Boolean(assignment);
      const { resolveAvailabilityStatus } = require("../utils/availability");
      await resolveAvailabilityStatus(technician, null, null, { syncDb: true });

      try {
        const { syncMaintenanceFromBooking } = require("../utils/maintenanceLifecycle");
        await syncMaintenanceFromBooking(booking);
      } catch (maintenanceError) {
        console.error("Failed to create service-item maintenance schedules:", maintenanceError.message);
      }

      const io = req.app.get("io");
      if (io) {
        io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `All services completed for ${booking.bookingReference || booking._id}`,
        });
        const customerId = booking.customerId?._id || booking.customerId;
        if (customerId) {
          io.to(`customer:${customerId}`).emit("booking:status-change", {
            bookingId: booking._id,
            status: booking.status,
            technicianName: technician.name,
            timestamp: Date.now(),
          });
        }
      }
    }

    return res.json({
      success: true,
      serviceItem: item,
      bookingStatus: booking.status,
      allServicesCompleted,
      hasDeclinedRepair,
      assignmentCompleted,
    });
  } catch (err) { next(err); }
});

router.post("/appointments/:id/service-items/:itemId/quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const technician = await Technician.findOne({ $or: [{ user: req.user._id }, { userEmail: req.user.email }] });
    const booking = await BookingService.findById(req.params.id);
    if (!technician || !booking) return res.status(404).json({ error: "Booking or technician not found" });
    const item = booking.services.id(req.params.itemId);
    if (!item || item.type !== "repair") return res.status(404).json({ error: "Repair service item not found" });
    if (String(item.technicianId || booking.technicianId || "") !== String(technician._id)) return res.status(403).json({ error: "This service item is not assigned to you." });
    const requestedParts = Array.isArray(req.body.parts) ? req.body.parts.slice(0, 100) : [];
    const toolIds = requestedParts.map(part => part.toolId).filter(id => mongoose.Types.ObjectId.isValid(id));
    const catalogParts = toolIds.length
      ? await Tool.find({ _id: { $in: toolIds }, $and: [Tool.merchandiseFilter()] }).select("itemName sellingPrice costPrice").lean()
      : [];
    const catalogMap = new Map(catalogParts.map(part => [String(part._id), part]));
    const missingCatalogPart = requestedParts.find(part => part.toolId && !catalogMap.has(String(part.toolId)));
    if (missingCatalogPart) return res.status(400).json({ error: "A quotation part is missing from the active inventory catalog." });
    const parts = requestedParts.map(part => {
      const catalogPart = catalogMap.get(String(part.toolId || ""));
      const quantity = Math.max(1, Math.min(999, Number(part.quantity) || 1));
      // Catalog items always use the controlled customer selling price. A
      // manually sourced part may supply a quoted amount, but is identified as external.
      return catalogPart
        ? { name: catalogPart.itemName, cost: Math.max(0, Number(catalogPart.sellingPrice) || Number(catalogPart.costPrice) || 0), quantity, toolId: catalogPart._id }
        : { name: String(part.name || "External part").slice(0, 200), cost: Math.max(0, Number(part.cost) || 0), quantity, toolId: null };
    });
    const laborCategory = normalizeRepairComplexity(req.body.laborCategory);
    const laborCost = (await getRepairLaborFees())[laborCategory];
    const totalCost = parts.reduce((sum, part) => sum + part.cost * part.quantity, 0) + laborCost;
    item.quotation = { parts, laborCost, laborCategory, totalCost, notes: String(req.body.notes || "").slice(0, 2000), status: "submitted", createdAt: new Date() };
    item.status = "awaiting_customer_decision"; item.phase = "repair_phase_1";
    item.statusHistory.push({ status: item.status, changedAt: new Date(), changedBy: technician._id, changedByName: technician.name, reason: "Per-item quotation submitted" });
    await booking.save();
    const { createNotification } = require("../utils/notify");
    await createNotification({ type: "system", title: "Repair quotation ready", message: `${item.name} quotation for ${booking.bookingReference || booking._id} is ready for your decision.`, userId: booking.customerId, referenceId: booking._id, referenceModel: "BookingService", link: "/book-history", priority: "high", io: req.app.get("io") });
    return res.json({ success: true, serviceItem: item });
  } catch (err) { next(err); }
});

router.put("/appointments/:id/service-items/:itemId/report", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const ServiceReport = require("../models/ServiceReport");
    const technician = await Technician.findOne({ $or: [{ user: req.user._id }, { userEmail: req.user.email }] });
    const booking = await BookingService.findById(req.params.id);
    if (!technician || !booking) return res.status(404).json({ error: "Booking or technician not found" });
    const item = booking.services.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Service item not found" });
    if (String(item.technicianId || booking.technicianId || "") !== String(technician._id)) return res.status(403).json({ error: "This service item is not assigned to you." });
    const submit = req.body.submit === true;
    const report = await ServiceReport.findOneAndUpdate(
      { bookingId: booking._id, serviceItemId: item._id },
      { $set: {
        assignmentId: item.assignmentId || booking.assignmentId || null, technicianId: technician._id,
        customerName: booking.customer?.name || "", serviceName: item.name || "Service", serviceType: item.type,
        bookingDate: item.schedule?.date || booking.bookingDate,
        findings: String(req.body.findings || "").slice(0, 2000), recommendations: String(req.body.recommendations || "").slice(0, 2000), actionsTaken: String(req.body.actionsTaken || "").slice(0, 2000),
        laborHours: Math.max(0, Number(req.body.laborHours) || 0), actualLaborCost: Math.max(0, Number(req.body.actualLaborCost) || 0),
        partsReplaced: Array.isArray(req.body.partsReplaced) ? req.body.partsReplaced.slice(0, 100) : [],
        followUpRequired: req.body.followUpRequired === true, followUpNotes: String(req.body.followUpNotes || "").slice(0, 500), followUpDate: req.body.followUpDate || null,
        status: submit ? "submitted" : "draft", submittedAt: submit ? new Date() : null,
      }, $setOnInsert: { bookingId: booking._id, serviceItemId: item._id } },
      { returnDocument: "after", upsert: true, runValidators: true },
    );
    item.serviceReportId = report._id;
    await booking.save();
    return res.json({ success: true, report });
  } catch (err) { next(err); }
});

// Technician-owned remittance queue. A technician can only view and remit
// payments they personally collected; verification remains admin-only.
router.get("/remittances", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const Payment = require("../models/Payment");
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    // Include legacy collection records that predate `collectedBy`. Ownership
    // is safely inferred from the technician assigned to the linked booking.
    const ownedLegacyBookings = await BookingService.find({
      technicianId: tech._id,
      $or: [{ balanceCollected: true }, { repairPaymentCollected: true }, { inspectionFeeCollected: true }],
    }).select("_id").lean();
    const ownedBookingIds = ownedLegacyBookings.map((booking) => booking._id);
    const payments = await Payment.find({
      $or: [
        { collectedBy: tech._id, status: { $in: ["waiting_for_remittance", "remitted", "verified", "rejected", "unaccounted"] } },
        { collectedBy: { $exists: false }, bookingId: { $in: ownedBookingIds }, status: "paid" },
        { collectedBy: null, bookingId: { $in: ownedBookingIds }, status: "paid" },
      ],
    })
      .populate("bookingId", "bookingReference customer status paymentStatus technicianId")
      .populate("orderId", "orderReference customer status paymentStatus")
      .populate("projectId", "projectReference customer status payment")
      .sort({ collectedAt: -1, submittedAt: -1 }).lean();
    payments.forEach((payment) => {
      if (payment.status === "paid" && !payment.collectedBy) {
        payment.status = "waiting_for_remittance";
        payment.legacyCollection = true;
      }
    });
    res.json({ payments });
  } catch (err) { next(err); }
});

router.post("/remittances/:id/submit", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const Payment = require("../models/Payment");
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const Project = require("../models/Project");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    let payment = await Payment.findOne({ _id: req.params.id, collectedBy: tech._id });
    if (!payment) {
      const legacyPayment = await Payment.findOne({ _id: req.params.id, status: "paid" });
      if (legacyPayment?.bookingId && !legacyPayment.collectedBy) {
        const ownsBooking = await BookingService.exists({ _id: legacyPayment.bookingId, technicianId: tech._id });
        if (ownsBooking) payment = legacyPayment;
      }
    }
    if (!payment) return res.status(404).json({ error: "Payment collection not found" });
    if (!["waiting_for_remittance", "paid"].includes(payment.status)) return res.status(409).json({ error: `Payment is already ${String(payment.status).replace(/_/g, " ")}.` });
    const now = new Date();
    payment.status = "remitted";
    if (payment.resolutionType === "recovery") {
      payment.resolutionType = null;
      payment.resolvedBy = undefined;
      payment.resolvedAt = undefined;
      payment.resolutionNotes = undefined;
      payment.recoveryFollowUpDate = undefined;
    }
    payment.collectedBy = payment.collectedBy || tech._id;
    payment.collectedByName = payment.collectedByName || tech.name;
    payment.collectedAt = payment.collectedAt || payment.completedAt || payment.submittedAt || now;
    payment.remittedBy = req.user._id;
    payment.remittedByTechnician = tech._id;
    payment.remittedAt = now;
    payment.remittanceNotes = String(req.body?.notes || "").trim().slice(0, 1000);
    payment.remittanceProofUrl = req.body?.proofUrl || undefined;
    payment.remittanceLocation = req.body?.location || undefined;
    payment.events.push({ status: "remitted", actor: req.user._id, actorName: tech.name, actorRole: "technician", note: payment.remittanceNotes || "Submitted to admin for verification", at: now, metadata: { proofProvided: Boolean(payment.remittanceProofUrl) } });
    await payment.save();
    const update = { paymentStatus: "remitted" };
    if (payment.bookingId) await BookingService.findByIdAndUpdate(payment.bookingId, update);
    if (payment.orderId) await Order.findByIdAndUpdate(payment.orderId, update);
    if (payment.projectId) await Project.findByIdAndUpdate(payment.projectId, { "payment.paymentStatus": "remitted" });
    const { createNotification } = require("../utils/notify");
    await createNotification({ type: "payment_remitted", title: "Payment remitted by technician", message: `${tech.name} submitted a ${payment.method} remittance of ₱${Number(payment.amount).toLocaleString()}.`, role: "admin", referenceId: payment._id, referenceModel: "Payment", link: "/admin/payments/remittance", priority: "high", io: req.app.get("io") }).catch(() => {});
    await audit.logEvent({ actor: req.user._id, target: payment._id, action: "payment.remitted", module: "payment", req, details: { technicianId: tech._id, notes: payment.remittanceNotes } }).catch(() => {});
    res.json({ message: "Remittance submitted to admin for verification.", payment });
  } catch (err) { next(err); }
});

// ── Leave Requests ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/leave-requests
 * Returns the authenticated technician's own leave requests, newest first.
 */
router.get("/leave-requests", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await LeaveRequest.find({ technicianId: tech._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/leave-requests
 * Body: { startDate: "YYYY-MM-DD", endDate?: "YYYY-MM-DD", reason?: string }
 * Creates a new pending leave request. Rejects overlapping pending requests.
 */
router.post("/leave-requests", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { startDate, endDate, reason } = req.body;
    if (!startDate) return res.status(400).json({ error: "Start date is required." });

    const start = new Date(startDate + "T00:00:00");
    const end = endDate ? new Date(endDate + "T00:00:00") : new Date(start);

    if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start date." });
    if (isNaN(end.getTime())) return res.status(400).json({ error: "Invalid end date." });
    if (end < start) return res.status(400).json({ error: "End date cannot be before start date." });

    // Block duplicate pending requests covering the same date range
    const conflict = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "pending",
      startDate: { $lte: end },
      endDate: { $gte: start },
    }).lean();

    if (conflict) {
      return res.status(409).json({
        error: "You already have a pending leave request that overlaps with these dates.",
      });
    }

    const leave = new LeaveRequest({
      technicianId: tech._id,
      technician: {
        name: tech.name || "",
        email: tech.email || "",
        phone: tech.phone || "",
      },
      startDate: start,
      endDate: end,
      reason: String(reason || "").trim().slice(0, 500),
    });
    await leave.save();

    // Notify admins of new leave request
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "leave_requested",
      title: "Leave Request",
      message: `${tech.name} requested leave from ${new Date(start).toLocaleDateString()} to ${new Date(end || start).toLocaleDateString()}.`,
      role: "admin",
      referenceId: leave._id,
      referenceModel: "LeaveRequest",
      link: "/admin/technicians/leaves",
      priority: "normal",
      io,
    });

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "leave.request.create",
      module: "technician",
      req,
      details: { startDate, endDate: endDate || startDate, reason },
    });

    return res.status(201).json({ message: "Leave request submitted successfully.", leave });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/leave-requests/:id
 * Cancel own pending leave request only (cannot cancel approved/rejected).
 */
router.delete("/leave-requests/:id", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const leave = await LeaveRequest.findOne({ _id: id, technicianId: tech._id });
    if (!leave) return res.status(404).json({ error: "Leave request not found" });
    if (leave.status !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be cancelled." });
    }

    await leave.deleteOne();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "leave.request.cancel",
      module: "technician",
      req,
      details: { leaveId: id },
    });

    return res.json({ message: "Leave request cancelled." });
  } catch (err) {
    next(err);
  }
});

// ── Tool Usage Tracking ──────────────────────────────────────────────────────

/**
 * GET /api/technician/tools/catalog
 * Lightweight tool list for tool selection from Tool model.
 */
router.get("/tools/catalog", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const items = await Tool.find({
      active: true, // Only show active tools (no status filter)
      $and: [Tool.merchandiseFilter()],
    })
      .select("itemName quantity unit barcode costPrice sellingPrice status minStockLevel")
      .sort({ itemName: 1 })
      .limit(500)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});


// GET /appointments/available-dates
// Returns available repair dates for the authenticated technician (next 14 days)
router.get("/appointments/available-dates", async (req, res, next) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const estimatedDuration = parseInt(req.query.duration) || 90;

    const dates = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }

    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();

    const leaves = await LeaveRequest.find({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: dates[dates.length - 1] },
      endDate: { $gte: dates[0] },
    }).lean();

    const dayStart = new Date(dates[0]);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dates[dates.length - 1]);
    dayEnd.setHours(23, 59, 59, 999);

    const assignments = await Assignment.find({
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "pending_acceptance"] },
      bookingDate: { $gte: dayStart, $lte: dayEnd },
    }).select("bookingDate serviceDurationMinutes").lean();

    const results = [];
    for (const d of dates) {
      const dayOfWeek = d.getDay();
      const dayStr = d.toISOString().split('T')[0];

      const onLeave = leaves.some(lv => {
        const lvStart = new Date(lv.startDate);
        const lvEnd = new Date(lv.endDate);
        return d >= lvStart && d <= lvEnd;
      });
      if (onLeave) { results.push({ date: dayStr, available: false, reason: "On leave" }); continue; }

      if (schedule) {
        if (schedule.restDates && schedule.restDates.some(rd => new Date(rd).toDateString() === d.toDateString())) {
          results.push({ date: dayStr, available: false, reason: "Rest day" }); continue;
        }
        if (schedule.nonWorkingWeekdays && schedule.nonWorkingWeekdays.includes(dayOfWeek)) {
          results.push({ date: dayStr, available: false, reason: "Non-working day" }); continue;
        }
        const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
        if (!workingDay) { results.push({ date: dayStr, available: false, reason: "Not a working day" }); continue; }

        const dateBookings = assignments.filter(a => new Date(a.bookingDate).toDateString() === d.toDateString());
        let bookedMinutes = 0;
        for (const a of dateBookings) bookedMinutes += a.serviceDurationMinutes || 90;

        const workStartMin = workingDay.startMinutes || 480;
        const workEndMin = workingDay.endMinutes || 1020;
        const totalDayMinutes = workEndMin - workStartMin;
        const availableMinutes = totalDayMinutes - bookedMinutes;

        if (availableMinutes < estimatedDuration) {
          results.push({ date: dayStr, available: false, reason: "Insufficient capacity", slots: dateBookings.length });
          continue;
        }
        results.push({ date: dayStr, available: true, remainingSlots: Math.floor(availableMinutes / estimatedDuration), totalSlots: Math.floor(totalDayMinutes / estimatedDuration), bookedSlots: dateBookings.length });
      } else {
        const dateBookings = assignments.filter(a => new Date(a.bookingDate).toDateString() === d.toDateString());
        let bookedMinutes = 0;
        for (const a of dateBookings) bookedMinutes += a.serviceDurationMinutes || 90;
        const availableMinutes = 540 - bookedMinutes;
        if (availableMinutes < estimatedDuration) {
          results.push({ date: dayStr, available: false, reason: "Fully booked" });
        } else {
          results.push({ date: dayStr, available: true, remainingSlots: Math.floor(availableMinutes / estimatedDuration), totalSlots: Math.floor(540 / estimatedDuration), bookedSlots: dateBookings.length });
        }
      }
    }

    return res.json({ dates: results, estimatedDuration });
  } catch (err) {
    console.error("Available dates error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/technician/appointments/:id
 * Returns booking details including quotation for the assigned technician.
 */
router.get("/appointments/:id", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(id)
      .select("status quotation inspection diagnosis serviceType services workOrderNumber customer technicianId unitInfo technicianAssistant partsRequest preventiveMaintenance previousRepairs warranty repairCompletion paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice totalInitialCost estimatedFee initialCost servicePrice travelFare inspectionFeeCollected inspectionFeeAmount inspectionFeeDistanceFare inspectionFeeTotalCollected downpaymentAppliedToInspection coreServicePaymentCollected coreServicePaymentAmount coreServicePaymentCashCollected coreServicePaymentMethod coreServicePaymentCollectedAt repairPaymentCollected repairPaymentAmount repairPaymentMethod repairPaymentProof customerRating customerRatingComment service serviceId address completedAt")
      .lean();
    if (!booking) return res.status(404).json({ error: "Appointment not found" });
    if (!technicianIds.includes(String(booking.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }

    return res.json({ booking });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/bookings/:id/payments
 * Returns all payment records for a booking (technician-scoped).
 */
router.get("/bookings/:id/payments", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(id).select("technicianId").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!technicianIds.includes(String(booking.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    const payments = await Payment.find({ bookingId: id })
      .sort({ collectedAt: 1, submittedAt: 1 })
      .lean();

    return res.json({ payments });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/appointments/:id/tools
 * List tool usage records for one appointment (technician-scoped).
 */
router.get("/appointments/:id/tools", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const appt = await BookingService.findById(id).lean();
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    if (!technicianIds.includes(String(appt.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }

    const items = await ServiceToolUsage.find({ bookingId: id, technicianId: tech._id })
      .sort({ usedAt: -1 })
      .limit(300)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tools/search?q=capacitor
 * Search the Tool catalog for parts/materials the technician can pick in quotation.
 */
router.get("/tools/search", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ items: [] });

    const regex = new RegExp(escapeRegex(q.trim()), "i");
    const items = await Tool.find({
      active: true,
      $and: [Tool.merchandiseFilter()],
      $or: [
        { itemName: regex },
        { description: regex },
        { specification: regex },
      ],
    })
      .select("itemName unit quantity costPrice sellingPrice status")
      .sort({ itemName: 1 })
      .limit(20)
      .lean();

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/tools/check-inventory
 * Body: { partIds: [string] }
 * Returns inventory status for each part (Available, Low Stock, Out of Stock).
 */
router.post("/tools/check-inventory", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { partIds, bookingId } = req.body;
    if (!partIds || !Array.isArray(partIds) || partIds.length === 0) {
      return res.json({ items: [] });
    }

    const validIds = partIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return res.json({ items: [] });

    let reservedForBooking = new Map();
    if (bookingId) {
      if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
      const BookingService = require('../models/BookingService');
      const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
      if (!tech) return res.status(404).json({ error: 'Technician record not found' });
      const booking = await BookingService.findById(bookingId).select('technicianId services.technicianId').lean();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      const ownsBooking = technicianIds.includes(String(booking.technicianId || ''))
        || (booking.services || []).some(item => technicianIds.includes(String(item.technicianId || '')));
      if (!ownsBooking) return res.status(403).json({ error: 'You are not assigned to this booking' });

      const StockReservation = require('../models/StockReservation');
      const reservations = await StockReservation.find({
        bookingId,
        toolId: { $in: validIds },
        status: { $in: ['reserved', 'checked_out'] },
      }).select('toolId quantity').lean();
      reservedForBooking = reservations.reduce((map, row) => {
        const key = String(row.toolId);
        map.set(key, (map.get(key) || 0) + Math.max(0, Number(row.quantity) || 0));
        return map;
      }, new Map());
    }

    const tools = await Tool.find({ _id: { $in: validIds }, $and: [Tool.merchandiseFilter()] })
      .select("itemName quantity reservedQuantity unit costPrice sellingPrice status minStockLevel")
      .lean();

    const items = tools.map(t => {
      const bookingReservedQuantity = reservedForBooking.get(String(t._id)) || 0;
      const unreservedQuantity = Math.max(0, Number(t.quantity || 0) - Number(t.reservedQuantity || 0));
      const availableToBooking = unreservedQuantity + bookingReservedQuantity;
      return {
        _id: t._id,
        name: t.itemName,
        quantity: t.quantity,
        unreservedQuantity,
        reservedForBooking: bookingReservedQuantity,
        availableToBooking,
        unit: t.unit,
        costPrice: t.costPrice,
        sellingPrice: t.sellingPrice,
        status: bookingReservedQuantity > 0 ? 'reserved_for_booking' : availableToBooking === 0 ? 'out_of_stock' : availableToBooking <= (t.minStockLevel || 3) ? 'low_stock' : 'available',
        statusLabel: bookingReservedQuantity > 0 ? 'Reserved for this booking' : availableToBooking === 0 ? 'Out of Stock' : availableToBooking <= (t.minStockLevel || 3) ? 'Low Stock' : 'Available',
      };
    });

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/tools/match-by-names
 * Body: { names: string[] }
 * Matches part names to inventory items (fuzzy match) and returns tool IDs + stock info.
 */
router.post("/tools/match-by-names", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { names } = req.body;
    if (!names || !Array.isArray(names) || names.length === 0) {
      return res.json({ matches: [] });
    }

    // Build regex patterns for each name to do fuzzy matching
    const patterns = names.map(n => ({
      itemName: { $regex: n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }));

    const tools = await Tool.find({
      active: true,
      $and: [Tool.merchandiseFilter()],
      $or: patterns
    })
      .select("itemName quantity unit costPrice sellingPrice status minStockLevel")
      .lean();

    // Score and rank matches — prefer exact matches, then prefix matches
    const matches = names.map(name => {
      const lowerName = name.toLowerCase().trim();

      // Score matches: exact > startsWith > includes
      const scored = tools.map(t => {
        const lowerItem = t.itemName.toLowerCase().trim();
        let score = 0;
        if (lowerItem === lowerName) score = 100;
        else if (lowerItem.startsWith(lowerName)) score = 80;
        else if (lowerName.startsWith(lowerItem)) score = 70;
        else if (lowerItem.includes(lowerName) || lowerName.includes(lowerItem)) score = 50;
        else score = 0;

        return { tool: t, score };
      }).filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        const t = best.tool;
        return {
          name,
          _id: t._id,
          itemName: t.itemName,
          quantity: t.quantity,
          unit: t.unit,
          costPrice: t.costPrice,
          sellingPrice: t.sellingPrice,
          status: t.quantity === 0 ? 'out_of_stock' : t.quantity <= (t.minStockLevel || 3) ? 'low_stock' : 'available',
          statusLabel: t.quantity === 0 ? 'Out of Stock' : t.quantity <= (t.minStockLevel || 3) ? 'Low Stock' : 'Available',
          score: best.score,
        };
      }
      return { name, _id: null, itemName: null, quantity: 0, status: 'not_found', statusLabel: 'Not in Inventory' };
    });

    return res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/appointments/:id/tools
 * Body: { inventoryItemId, quantityUsed, notes }
 * Atomically deducts stock and creates usage record.
 */
router.post("/appointments/:id/tools", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Inventory = require("../models/Inventory");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const appt = await BookingService.findById(id);
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    const serviceItemId = mongoose.Types.ObjectId.isValid(req.body.serviceItemId) ? req.body.serviceItemId : null;
    const serviceItem = serviceItemId ? appt.services.id(serviceItemId) : null;
    if (serviceItemId && !serviceItem) return res.status(404).json({ error: "Service item not found" });
    const assignedTechnicianId = serviceItem?.technicianId || appt.technicianId;
    if (!technicianIds.includes(String(assignedTechnicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }
    if (String(appt.status || "").toLowerCase() === "cancelled") {
      return res.status(400).json({ error: "Cannot log tools for cancelled appointment" });
    }

    const inventoryItemId = String(req.body.inventoryItemId || "").trim();
    const quantityUsed = Number(req.body.quantityUsed);
    const notes = String(req.body.notes || "").trim();
    const fuelUsed = Number(req.body.fuelUsed);
    const toolCost = Number(req.body.toolCost);

    if (!mongoose.Types.ObjectId.isValid(inventoryItemId)) {
      return res.status(400).json({ error: "Select a valid tool item" });
    }
    if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
      return res.status(400).json({ error: "Quantity used must be greater than zero" });
    }
    if (req.body.fuelUsed != null && (!Number.isFinite(fuelUsed) || fuelUsed < 0)) {
      return res.status(400).json({ error: "Fuel used must be a non-negative number" });
    }
    if (req.body.toolCost != null && (!Number.isFinite(toolCost) || toolCost < 0)) {
      return res.status(400).json({ error: "Tool cost must be a non-negative number" });
    }

    const updatedItem = await Inventory.findOneAndUpdate(
      {
        _id: inventoryItemId,
        active: true,
        isStockItem: true,
        quantity: { $gte: quantityUsed },
      },
      { $inc: { quantity: -quantityUsed } },
      { returnDocument: "after" },
    ).lean();

    if (!updatedItem) {
      return res.status(409).json({ error: "Insufficient stock or invalid tool item" });
    }

    const usageData = {
      bookingId: appt._id,
      serviceItemId: serviceItem?._id,
      technicianId: tech._id,
      inventoryItemId: updatedItem._id,
      itemName: updatedItem.itemName,
      unit: updatedItem.unit || "pcs",
      quantityUsed,
      unitPrice: Number(updatedItem.costPrice) || 0,
      deductedFromInventory: true,
      notes: notes.slice(0, 500),
      recordedBy: req.user._id,
    };
    if (Number.isFinite(fuelUsed)) usageData.fuelUsed = fuelUsed;
    if (Number.isFinite(toolCost)) usageData.toolCost = toolCost;
    if (!Number.isFinite(toolCost)) {
      usageData.toolCost = (Number(updatedItem.costPrice) || 0) * quantityUsed;
    }

    const usage = await ServiceToolUsage.create(usageData);

    // Record stock adjustment for audit trail
    try {
      const StockAdjustment = require("../models/StockAdjustment");
      await StockAdjustment.record({
        toolId: inventoryItemId,
        type: "job_usage",
        delta: -quantityUsed,
        adjustedBy: req.user._id,
        reason: "repair_used",
        notes: `Job ${appt.workOrderNumber || appt._id}`,
        referenceId: appt._id,
      });
    } catch (e) { /* non-critical */ }

    await audit.logEvent({
      actor: req.user._id,
      target: appt._id,
      action: "tool.usage.create",
      module: "technician",
      req,
      details: {
        usageId: usage._id,
        inventoryItemId,
        quantityUsed,
        remainingQty: updatedItem.quantity,
        fuelUsed: usage.fuelUsed || 0,
        toolCost: usage.toolCost || 0,
      },
    });

    return res.status(201).json({
      message: "Tool usage recorded",
      usage,
      inventory: {
        _id: updatedItem._id,
        itemName: updatedItem.itemName,
        unit: updatedItem.unit,
        quantity: updatedItem.quantity,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/tool-usage/:usageId
 * Removes one usage record and restores stock. Only own records.
 */
router.delete("/tool-usage/:usageId", async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const usageId = req.params.usageId;
    if (!mongoose.Types.ObjectId.isValid(usageId)) return res.status(400).json({ error: "Invalid usage id" });

    const usage = await ServiceToolUsage.findOne({ _id: usageId, technicianId: tech._id });
    if (!usage) return res.status(404).json({ error: "Tool usage record not found" });

    await Inventory.findByIdAndUpdate(usage.inventoryItemId, { $inc: { quantity: usage.quantityUsed } });
    await usage.deleteOne();

    // Record stock return for audit trail
    try {
      const StockAdjustment = require("../models/StockAdjustment");
      await StockAdjustment.record({
        toolId: usage.inventoryItemId,
        type: "return",
        delta: usage.quantityUsed,
        adjustedBy: req.user._id,
        reason: "return",
        notes: `Returned from job ${usage.bookingId || ''}`,
        referenceId: usage.bookingId || null,
      });
    } catch (e) { /* non-critical */ }

    await audit.logEvent({
      actor: req.user._id,
      target: usage.bookingId,
      action: "tool.usage.delete",
      module: "technician",
      req,
      details: {
        usageId,
        inventoryItemId: usage.inventoryItemId,
        restoredQty: usage.quantityUsed,
      },
    });

    return res.json({ message: "Tool usage removed and stock restored" });
  } catch (err) {
    next(err);
  }
});

// ── Attendance Scanning ──────────────────────────────────────────────────────
const SiteSetting = require("../models/SiteSetting");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");

/**
 * GET /api/technician/attendance/status
 * Get today's attendance status with leave detection.
 * Returns: { attendanceStatus, availabilityStatus, record, isOnLeave, leaveType }
 */
router.get("/attendance/status", async (req, res, next) => {
  try {
    const { resolveAvailabilityStatus, computeAttendanceStatus } = require("../utils/availability");
    const LeaveRequest = require("../models/LeaveRequest");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Check for approved leave covering today
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();

    const record = await TechnicianAttendance.findOne({
      technicianId: tech._id,
      date: startOfToday,
    }).lean();

    // Compute effective availability from attendance state (single source of truth)
    const availabilityStatus = await resolveAvailabilityStatus(tech, record, activeLeave, { syncDb: true });

    const attendanceStatus = computeAttendanceStatus(record, activeLeave);

    let isOnLeave = false;
    let leaveType = null;
    if (activeLeave) {
      isOnLeave = true;
      const reason = (activeLeave.reason || "").toLowerCase();
      leaveType = reason.includes("sick") ? "Sick Leave" : "On Leave";
    }

    return res.json({
      attendanceStatus,
      availabilityStatus,
      record,
      isOnLeave,
      leaveType,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/checkin
 * Body: { lat?, lng? }
 * Button-based check-in with optional GPS coordinates.
 * Enterprise alternative to QR scanning.
 */
router.post("/attendance/checkin", async (req, res, next) => {
  try {
    const { lat, lng } = req.body;

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Check for approved leave
    const LeaveRequest = require("../models/LeaveRequest");
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();
    if (activeLeave) {
      return res.status(400).json({ error: "You are currently on approved leave." });
    }

    // Check if already checked in
    const existing = await TechnicianAttendance.findOne({ technicianId: tech._id, date: startOfToday });
    if (existing && ["Present", "Late"].includes(existing.status)) {
      return res.status(400).json({ error: "You have already checked in today." });
    }

    // Determine status (Present vs Late). Cutoff: 9:00 AM local server time.
    const now = new Date();
    let status = "Present";
    if (now.getHours() >= 9) {
      status = "Late";
    }

    // Update technician model
    tech.availabilityStatus = "Available";
    if (lat && lng) {
      tech.location = { type: "Point", coordinates: [parseFloat(lng), parseFloat(lat)] };
    }
    await tech.save();

    // Create or update attendance record
    const attendanceRecord = await TechnicianAttendance.findOneAndUpdate(
      { technicianId: tech._id, date: startOfToday },
      {
        userId: req.user._id,
        status,
        checkInTime: now,
        method: "button",
        token: "button_" + now.getTime(),
      },
      { upsert: true, returnDocument: "after" }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.checkin.button",
      module: "technician",
      req,
      details: { status, checkInTime: now, lat, lng }
    }).catch(() => { });

    return res.json({
      message: `Checked in as ${status}.`,
      attendanceStatus: status,
      availabilityStatus: "Available",
      record: attendanceRecord
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/checkout
 * Body: { lat?, lng? }
 * Records check-out time for today with optional GPS.
 */
router.post("/attendance/checkout", async (req, res, next) => {
  try {
    const { lat, lng, noExpensesToday } = req.body;

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const record = await TechnicianAttendance.findOne({
      technicianId: tech._id,
      date: startOfToday,
    });

    if (!record || !["Present", "Late"].includes(record.status)) {
      return res.status(400).json({ error: "You must check in before checking out today." });
    }

    if (record.checkOutTime) {
      return res.status(400).json({ error: "You have already checked out today." });
    }

    // ── Remittance gate (hard block): every peso collected today must be ──
    // submitted for remittance before the technician can check out. Unlike
    // the expense confirmation, this cannot be skipped — unsubmitted cash
    // on hand is an accountability issue.
    const Payment = require("../models/Payment");
    const waitingRemittances = await Payment.find({
      collectedBy: tech._id,
      status: "waiting_for_remittance",
    }).select("amount method").lean();
    if (waitingRemittances.length > 0) {
      const totalAmount = waitingRemittances.reduce((s, p) => s + Number(p.amount || 0), 0);
      return res.status(409).json({
        code: "REMITTANCE_REQUIRED",
        error: `You have ${waitingRemittances.length} unsubmitted collection${waitingRemittances.length > 1 ? "s" : ""} worth ₱${Number(totalAmount).toLocaleString()}. Submit your remittance before checking out.`,
        pendingRemittances: waitingRemittances.length,
        amount: totalAmount,
        link: "/technician/remittances",
      });
    }

    const Expense = require("../models/Expense");
    const Assignment = require("../models/Assignment");
    const endOfToday = new Date(startOfToday); endOfToday.setHours(23, 59, 59, 999);
    const [todayExpenseCount, completedJobsToday] = await Promise.all([
      Expense.countDocuments({ technicianId: tech._id, expenseDate: { $gte: startOfToday, $lte: endOfToday } }),
      Assignment.countDocuments({ technicianId: tech._id, status: "completed", completedAt: { $gte: startOfToday, $lte: endOfToday } }),
    ]);
    if (todayExpenseCount === 0 && noExpensesToday !== true) {
      return res.status(409).json({ code: "EXPENSE_CONFIRMATION_REQUIRED", error: "No expenses have been logged today.", completedJobsToday });
    }
    if (todayExpenseCount === 0 && noExpensesToday === true) {
      record.noExpensesTodayConfirmed = true;
      record.noExpensesTodayConfirmedAt = new Date();
    }

    const now = new Date();
    record.checkOutTime = now;
    await record.save();

    // Set technician availability status to Offline on checkout
    tech.availabilityStatus = "Offline";
    await tech.save();

    // Calculate total hours worked
    const hoursWorked = ((now - new Date(record.checkInTime)) / 3600000).toFixed(2);

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.checkout.success",
      module: "technician",
      req,
      details: { checkOutTime: now, hoursWorked, lat, lng }
    }).catch(() => { });

    return res.json({
      message: "Checked out successfully.",
      hoursWorked: parseFloat(hoursWorked),
      record
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/attendance/history
 * Returns the last 30 attendance records for the authenticated technician.
 */
router.get("/attendance/history", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const records = await TechnicianAttendance.find({ technicianId: tech._id })
      .sort({ date: -1 })
      .limit(30)
      .lean();

    return res.json({ records, count: records.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/scan
 * Body: { token }
 * Marks the technician as present or late depending on scan time.
 */
router.post("/attendance/scan", async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "QR Token is required" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Check for approved leave — block scanning
    const LeaveRequest = require("../models/LeaveRequest");
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();
    if (activeLeave) {
      return res.status(400).json({ error: "You are currently on approved leave. Scanning is disabled." });
    }

    // Validate the token
    const todayStr = new Date().toISOString().split("T")[0];
    const tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" }).lean();

    if (!tokenSetting || !tokenSetting.value || tokenSetting.value.date !== todayStr || tokenSetting.value.token !== token) {
      return res.status(400).json({ error: "Invalid or expired QR code for today." });
    }

    // Check if already checked in today
    const existing = await TechnicianAttendance.findOne({ technicianId: tech._id, date: startOfToday });
    if (existing && ["Present", "Late"].includes(existing.status)) {
      return res.status(400).json({ error: "You have already scanned today's attendance." });
    }

    // Determine status (Present vs Late). Cutoff: 9:00 AM local server time.
    const now = new Date();
    let status = "Present";
    if (now.getHours() >= 9) {
      status = "Late";
    }

    // Update technician model
    // Update technician model availability
    tech.availabilityStatus = "Available"; // Set availability to Available on check-in
    await tech.save();

    // Create or update attendance record
    const attendanceRecord = await TechnicianAttendance.findOneAndUpdate(
      { technicianId: tech._id, date: startOfToday },
      {
        userId: req.user._id,
        status,
        checkInTime: now,
        method: "qr_scan",
        token
      },
      { upsert: true, returnDocument: "after" }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.scan.success",
      module: "technician",
      req,
      details: { status, checkInTime: now }
    }).catch(() => { });

    return res.json({
      message: `Attendance marked as ${status}. Availability status set to Available.`,
      attendanceStatus: status,
      availabilityStatus: "Available",
      record: attendanceRecord
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/availability
 * Body: { status: "Unavailable" | "Available" }
 * Allows a technician to manually toggle their own availability.
 * - Only "Unavailable" and "Available" may be set manually.
 * - Cannot toggle if currently Assigned, On The Way, or In Progress.
 * - Returning from Unavailable restores to "Available".
 */
router.post("/availability", async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ["Unavailable", "Available"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: `Only "${allowedStatuses.join("\" or \"")}" may be set manually.`,
      });
    }

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Block toggling if the system has assigned an active task
    const blockedStatuses = ["Assigned", "On The Way", "In Progress"];
    if (blockedStatuses.includes(tech.availabilityStatus)) {
      return res.status(409).json({
        error: `Cannot change availability while status is "${tech.availabilityStatus}". Complete your current assignment first.`,
      });
    }

    // Block setting Available if technician is Offline (not checked in)
    if (status === "Available" && tech.availabilityStatus === "Offline") {
      return res.status(409).json({
        error: "Cannot set yourself as Available while you are Offline. Please check in first.",
      });
    }

    tech.availabilityStatus = status;
    await tech.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "technician.availability.manual",
      module: "technician",
      req,
      details: { status },
    }).catch(() => { });

    return res.json({
      message: `Availability set to ${status}.`,
      availabilityStatus: status,
    });
  } catch (err) {
    next(err);
  }
});

// ── Notifications ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/notifications
 * Returns in-app notifications for the technician's navbar bell.
 * Uses the unified Notification model (same as admin system).
 */
router.get("/notifications", async (req, res, next) => {
  try {
    const Notification = require("../models/Notification");

    const notifications = await Notification.find({
      $or: [
        { userId: req.user._id },
        { role: "technician" },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // Map to the format the navbar expects
    const iconMap = {
      assignment_new: { icon: "bi-person-plus", iconClass: "text-primary" },
      assignment_accepted: { icon: "bi-person-check", iconClass: "text-success" },
      assignment_declined: { icon: "bi-person-x", iconClass: "text-danger" },
      leave_approved: { icon: "bi-check-circle-fill", iconClass: "text-success" },
      leave_rejected: { icon: "bi-x-circle-fill", iconClass: "text-danger" },
      leave_requested: { icon: "bi-calendar-event", iconClass: "text-info" },
      expense_approved: { icon: "bi-check-circle", iconClass: "text-success" },
      expense_rejected: { icon: "bi-x-circle", iconClass: "text-danger" },
      expense_submitted: { icon: "bi-receipt", iconClass: "text-warning" },
      booking_cancelled: { icon: "bi-x-circle", iconClass: "text-danger" },
      booking_completed: { icon: "bi-check2-circle", iconClass: "text-success" },
      system: { icon: "bi-gear", iconClass: "text-muted" },
    };

    const mapped = notifications.map((n) => {
      const ic = iconMap[n.type] || iconMap.system;
      return {
        id: n._id,
        type: n.type,
        icon: ic.icon,
        iconClass: ic.iconClass,
        title: n.title,
        message: n.message,
        time: n.createdAt,
        link: n.link || "#",
        read: n.read || false,
      };
    });

    const unread = mapped.filter((n) => !n.read).length;

    return res.json({ notifications: mapped, unread });
  } catch (err) {
    next(err);
  }
});

// ── Badge Counts ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/badge-counts
 * Returns sidebar badge counts for the technician.
 * Enterprise-level: single batch query, no N+1.
 */
router.get("/badge-counts", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const Expense = require("../models/Expense");
    const Order = require("../models/Order");
    const Notification = require("../models/Notification");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.json({ pendingAssignments: 0, todayJobs: 0, pendingExpenses: 0, pendingOrders: 0, unreadNotifications: 0 });

    const techId = tech._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [pendingAssignments, todayJobs, pendingExpenses, pendingOrders, unreadNotifications] = await Promise.all([
      Assignment.countDocuments({ technicianId: techId, status: "pending_acceptance" }),
      Assignment.countDocuments({ technicianId: techId, bookingDate: { $gte: today, $lt: tomorrow } }),
      Expense.countDocuments({ technicianId: techId, status: "pending" }),
      Order.countDocuments({ technicianId: techId, status: { $in: ["pending", "confirmed", "processing"] } }),
      Notification.countDocuments({
        $or: [{ userId: req.user._id }, { role: "technician" }],
        read: { $ne: true },
      }),
    ]);

    return res.json({ pendingAssignments, todayJobs, pendingExpenses, pendingOrders, unreadNotifications });
  } catch (err) {
    next(err);
  }
});

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * GET /api/technician/schedule
 * Returns the technician's schedule config, upcoming bookings, and today's jobs.
 * Enterprise-level: batch queries, server-authoritative, no N+1.
 */
router.get("/schedule", async (req, res, next) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const techId = tech._id;
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 30 days ahead for calendar
    const thirtyDaysOut = new Date(today);
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

    // Batch fetch: schedule, today's assignments, upcoming assignments, active leave
    const [schedule, todayAssignments, upcomingAssignments, activeLeave] = await Promise.all([
      TechnicianSchedule.findOne({ technicianId: techId }).lean(),
      Assignment.find({
        technicianId: techId,
        bookingDate: { $gte: today, $lt: tomorrow },
      }).sort({ startTime: 1 }).limit(20).lean(),
      Assignment.find({
        technicianId: techId,
        bookingDate: { $gte: tomorrow, $lte: thirtyDaysOut },
        status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
      }).sort({ bookingDate: 1, startTime: 1 }).limit(50).lean(),
      LeaveRequest.findOne({
        technicianId: techId,
        status: "approved",
        startDate: { $lte: thirtyDaysOut },
        endDate: { $gte: today },
      }).lean(),
    ]);

    // Build working hours summary
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const workingHoursSummary = schedule
      ? (schedule.workingDays || []).map((wd) => ({
        day: dayNames[wd.dayOfWeek] || "",
        start: Math.floor(wd.startMinutes / 60) + ":" + String(wd.startMinutes % 60).padStart(2, "0"),
        end: Math.floor(wd.endMinutes / 60) + ":" + String(wd.endMinutes % 60).padStart(2, "0"),
      }))
      : [];

    return res.json({
      schedule: schedule
        ? {
          workingDays: schedule.workingDays || [],
          nonWorkingWeekdays: (schedule.nonWorkingWeekdays || []).map((nw) => nw.dayOfWeek),
          restDates: schedule.restDates || [],
          workingHoursSummary,
        }
        : null,
      todayAssignments,
      upcomingAssignments,
      activeLeave: activeLeave
        ? {
          startDate: activeLeave.startDate,
          endDate: activeLeave.endDate,
          reason: activeLeave.reason,
        }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE DASHBOARD — Overview
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/dashboard/overview
 * Returns aggregated KPIs, job pipeline, today's jobs, and upcoming jobs.
 */
router.get("/dashboard/overview", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Expense = require("../models/Expense");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const ServiceReport = require("../models/ServiceReport");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const techId = tech._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // ── Job Pipeline Counts ────────────────────────────────────────────────
    const counts = await Assignment.getDashboardCounts(techId);

    // ── Today's Jobs ───────────────────────────────────────────────────────
    const todayJobs = await Assignment.find({
      technicianId: techId,
      bookingDate: { $gte: today, $lt: tomorrow },
    })
      .sort({ startTime: 1 })
      .limit(20)
      .lean();

    // Enrich todayJobs with booking status and price fields
    const todayBookingIds = todayJobs.map(a => a.bookingId).filter(Boolean);
    const todayBookings = await BookingService.find({ _id: { $in: todayBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const todayBookingMap = new Map(todayBookings.map(b => [String(b._id), b]));
    for (const item of todayJobs) {
      const bk = todayBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        // Calculate correct revenue for this booking
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
        item.bookingTotalPrice = bk.totalPrice;
        item.bookingEstimatedFee = bk.estimatedFee;
        item.bookingInitialCost = bk.initialCost;
        item.bookingInspectionFeeCollected = bk.inspectionFeeTotalCollected;
        item.bookingQuotationTotal = bk.quotation && bk.quotation.totalCost;
        item.bookingApprovalStatus = bk.approval && bk.approval.status;
      }
    }

    // ── Active Job (most recently updated active) ────────────────────────────
    const activeJob = await Assignment.findOne({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
    }).sort({ updatedAt: -1 }).lean();

    // Enrich activeJob with booking payment fields and status
    const activeBookingIds = [];
    if (activeJob && activeJob.bookingId) {
      activeBookingIds.push(String(activeJob.bookingId));
    }
    const activeBookingsMap = new Map();
    if (activeBookingIds.length > 0) {
      const activeBookings = await BookingService.find({ _id: { $in: activeBookingIds.map(id => new mongoose.Types.ObjectId(id)) } })
        .select("paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice estimatedFee isMultiService services service status serviceType initialCost travelFare inspectionFeeCollected repairPaymentCollected repairPaymentAmount quotation approval repairSchedule unitInfo technicianId")
        .lean();
      for (const b of activeBookings) activeBookingsMap.set(String(b._id), b);
    }
    if (activeJob && activeJob.bookingId) {
      const bk = activeBookingsMap.get(String(activeJob.bookingId));
      if (bk) {
        activeJob.paymentMethod = bk.paymentMethod;
        activeJob.paymentStatus = bk.paymentStatus;
        activeJob.amountPaid = bk.amountPaid;
        activeJob.balanceAmount = bk.balanceAmount;
        activeJob.balanceCollected = bk.balanceCollected;
        activeJob.downpaymentAmount = bk.downpaymentAmount;
        activeJob.totalPrice = bk.totalPrice;
        activeJob.estimatedFee = bk.estimatedFee;
        activeJob.initialCost = bk.initialCost;
        activeJob.travelFare = bk.travelFare;
        activeJob.bookingStatus = bk.status;
        activeJob.bookingServiceType = bk.serviceType;
        if (!activeJob.serviceType) activeJob.serviceType = bk.serviceType;
        if (!activeJob.serviceName || activeJob.serviceName === "Service" || activeJob.serviceName === "") {
          activeJob.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
        }

        // If this is a repair booking, attach repair-specific info to the active job
        const isRepair = bk.serviceType === "repair" || (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const repairStatuses = [
            "inspection_scheduled", "inspection_completed", "awaiting_approval",
            "repair_approved", "repair_declined", "waiting_parts", "parts_reserved",
            "ready_for_repair", "repair_scheduled", "repair_in_progress", "repair_completed",
            "on-the-way", "arrived"
          ];
          if (repairStatuses.includes(bk.status) || bk.status?.startsWith("repair_")) {
            activeJob.repairInfo = {
              bookingStatus: bk.status,
              bookingId: bk._id,
              quotation: bk.quotation,
              approval: bk.approval,
              repairSchedule: bk.repairSchedule,
              unitInfo: bk.unitInfo,
            };
          }
        }
      }
    }

    // ── Pending Acceptance ─────────────────────────────────────────────────
    const pendingJobs = await Assignment.find({
      technicianId: techId,
      status: "pending_acceptance",
    })
      .sort({ assignedAt: -1 })
      .limit(10)
      .lean();

    // Enrich pendingJobs with booking status and price fields
    const pendingBookingIds = pendingJobs.map(a => a.bookingId).filter(Boolean);
    const pendingBookings = await BookingService.find({ _id: { $in: pendingBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const pendingBookingMap = new Map(pendingBookings.map(b => [String(b._id), b]));
    for (const item of pendingJobs) {
      const bk = pendingBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
      }
    }

    // ── Completed Today ────────────────────────────────────────────────────
    const completedToday = await Assignment.find({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "completed"] },
      completedAt: { $gte: today, $lt: tomorrow },
    })
      .sort({ completedAt: -1 })
      .limit(20)
      .lean();

    // Enrich completedToday with booking status and price fields
    const completedBookingIds = completedToday.map(a => a.bookingId).filter(Boolean);
    const completedBookings = await BookingService.find({ _id: { $in: completedBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const completedBookingMap = new Map(completedBookings.map(b => [String(b._id), b]));
    for (const item of completedToday) {
      const bk = completedBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
      }
    }

    // ── Monthly Expense Summary ────────────────────────────────────────────
    const expenseSummary = await Expense.getMonthlySummary(
      techId,
      today.getFullYear(),
      today.getMonth()
    );

    // ── Per-Job Expense Data ───────────────────────────────────────────────
    // Expenses for the active job
    let activeJobExpenses = [];
    if (activeJob && activeJob.bookingId) {
      activeJobExpenses = await Expense.find({
        technicianId: techId,
        bookingId: activeJob.bookingId,
      })
        .sort({ expenseDate: -1 })
        .lean();
    }

    // Expenses for completed today jobs
    const expenseBookingIds = completedToday
      .map(a => a.bookingId)
      .filter(Boolean);
    let completedTodayExpenses = [];
    if (expenseBookingIds.length > 0) {
      completedTodayExpenses = await Expense.find({
        technicianId: techId,
        bookingId: { $in: expenseBookingIds },
      })
        .sort({ expenseDate: -1 })
        .lean();
    }
    // Group completed expenses by bookingId
    const completedExpensesByBooking = {};
    for (const exp of completedTodayExpenses) {
      const bid = String(exp.bookingId);
      if (!completedExpensesByBooking[bid]) completedExpensesByBooking[bid] = [];
      completedExpensesByBooking[bid].push(exp);
    }

    // Recent unlinked expenses (no booking assigned)
    const unlinkedExpenses = await Expense.find({
      technicianId: techId,
      bookingId: null,
      expenseDate: { $gte: today },
    })
      .sort({ expenseDate: -1 })
      .limit(10)
      .lean();

    // Technician's active & recent assignments for the expense form dropdown
    const recentAssignments = await Assignment.find({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "completed"] },
      bookingDate: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    })
      .sort({ bookingDate: -1 })
      .limit(20)
      .lean();

    // ── Tool Usage This Month ──────────────────────────────────────────────
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const toolUsageCount = await ServiceToolUsage.countDocuments({
      technicianId: techId,
      usedAt: { $gte: monthStart },
    });

    // ── Reports Status ─────────────────────────────────────────────────────
    const pendingReports = await ServiceReport.countDocuments({
      technicianId: techId,
      status: { $in: ["draft", "revision_requested"] },
    });

    // ── Repair Queue (repair bookings assigned to this technician) ──────────
    const repairStatuses = [
      "inspection_scheduled", "inspection_completed", "awaiting_approval",
      "repair_approved", "repair_declined", "waiting_parts", "parts_reserved",
      "ready_for_repair", "repair_scheduled", "repair_in_progress", "repair_completed"
    ];
    const repairBookings = await BookingService.find({
      "technicianId": techId,
      "serviceType": "repair",
      status: { $in: repairStatuses },
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select("status serviceType unitInfo customerId technicianId quotation approval repairSchedule inspection preferredSchedule preferredTimeWindow createdAt updatedAt")
      .populate("customerId", "name email phone")
      .lean();

    // Also get the inspection technician's bookings (if this tech was the original inspector)
    const inspectorBookings = await BookingService.find({
      "inspection.technicianId": techId,
      "serviceType": "repair",
      status: { $in: repairStatuses },
      "technicianId": { $ne: techId },
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select("status serviceType unitInfo customerId technicianId quotation approval repairSchedule inspection preferredSchedule preferredTimeWindow createdAt updatedAt")
      .populate("customerId", "name email phone")
      .lean();

    // Merge and deduplicate
    const repairBookingMap = new Map();
    for (const b of [...repairBookings, ...inspectorBookings]) {
      repairBookingMap.set(String(b._id), b);
    }

    // Find existing assignments for these bookings
    const repairBookingIds = [...repairBookingMap.keys()].map(id => new mongoose.Types.ObjectId(id));
    const repairAssignments = repairBookingIds.length > 0 ? await Assignment.find({
      technicianId: techId,
      bookingId: { $in: repairBookingIds },
    }).select("bookingId status").lean() : [];
    const assignmentMap = new Map(repairAssignments.map(a => [String(a.bookingId), a.status]));

    // Build enriched repair queue
    // pending_acceptance is already a real Assignment and is rendered by the
    // assignments endpoint. Including the same booking in repairQueue creates
    // a second synthetic card with createdAt as its date and blank job fields.
    const activeAssignmentStatuses = ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"];
    const repairQueue = [...repairBookingMap.values()]
      .filter(b => {
        // Exclude bookings that already have an active assignment (shown as Active Job)
        const assignmentStatus = assignmentMap.get(String(b._id));
        if (assignmentStatus && activeAssignmentStatuses.includes(assignmentStatus)) return false;
        return true;
      })
      .map(b => {
        const bookingStatus = b.status;
        const assignmentStatus = assignmentMap.get(String(b._id)) || null;

        // Determine if parts are ready and repair is scheduled
        const hasReservation = b.status === "parts_reserved" || b.status === "ready_for_repair" || b.status === "repair_scheduled";
        const isScheduled = b.repairSchedule?.decidedAt || b.status === "repair_scheduled" || b.status === "ready_for_repair";
        const waitingForParts = b.status === "waiting_parts";
        const waitingForSchedule = b.status === "repair_approved" && !isScheduled;

        let techAction = null;
        if (bookingStatus === "repair_scheduled" || bookingStatus === "ready_for_repair" || bookingStatus === "repair_approved" || bookingStatus === "parts_reserved") {
          techAction = "ready"; // Can go En Route
        } else if (waitingForParts) {
          techAction = "waiting_parts";
        } else if (waitingForSchedule) {
          techAction = "waiting_schedule";
        } else if (bookingStatus === "repair_in_progress") {
          techAction = "in_progress";
        }

        return {
          _id: b._id,
          bookingId: b._id,
          customerName: b.customerId?.name || "Customer",
          customerEmail: b.customerId?.email || "",
          customerPhone: b.customerId?.phone || "",
          serviceName: "Repair Service",
          serviceType: "repair",
          bookingStatus,
          assignmentStatus,
          unitInfo: b.unitInfo,
          quotation: b.quotation,
          repairSchedule: b.repairSchedule,
          inspection: b.inspection,
          preferredDates: b.preferredSchedule?.dates || [],
          preferredTimeWindow: b.preferredSchedule?.timeWindow || "any",
          techAction,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        };
      });

    // Group counts by repair sub-status for KPI
    const repairCounts = {};
    for (const s of repairStatuses) repairCounts[s] = 0;
    for (const a of repairQueue) {
      const s = a.bookingStatus || a.status;
      if (repairCounts[s] !== undefined) repairCounts[s]++;
    }

    // ── End-of-Day Accountability & Workload Extras ────────────────────────
    const Payment = require("../models/Payment");
    const Order = require("../models/Order");
    const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);
    const [waitingRemittances, remittanceTotalAgg, expensesLoggedToday, activeOrders] = await Promise.all([
      Payment.countDocuments({ collectedBy: techId, status: "waiting_for_remittance" }),
      Payment.aggregate([
        { $match: { collectedBy: tech._id, status: "waiting_for_remittance" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Expense.countDocuments({ technicianId: techId, expenseDate: { $gte: today, $lte: todayEnd } }),
      Order.countDocuments({ technicianId: techId, status: { $nin: ["cancelled", "completed", "delivered", "received"] } }),
    ]);

    return res.json({
      counts,
      todayJobs,
      activeJob,
      pendingJobs,
      completedToday,
      expenseSummary,
      toolUsageCount,
      pendingReports,
      activeJobExpenses,
      completedExpensesByBooking,
      unlinkedExpenses,
      recentAssignments,
      repairQueue,
      repairCounts,
      endOfDay: {
        remittancesPending: waitingRemittances,
        remittancesAmount: remittanceTotalAgg[0]?.total || 0,
        expensesLoggedToday,
        completedJobsToday: completedToday.length,
      },
      activeOrders,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// KPI AGGREGATES — Enterprise Dashboard Metrics
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/kpis
 * Returns real-time aggregate KPI counts for the authenticated technician.
 * Uses MongoDB aggregation for accurate totals (not limited to one page).
 */

router.get("/kpis", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const baseFilter = { technicianId: tech._id };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [totalCount, statusCounts, todayCount, revenueResult, availableCount, toolCostResult, expenseResult] = await Promise.all([
      Assignment.countDocuments(baseFilter),
      Assignment.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Assignment.countDocuments({
        ...baseFilter,
        bookingDate: { $gte: todayStart, $lte: todayEnd },
      }),
      Assignment.aggregate([
        { $match: { ...baseFilter, status: "completed" } },
        {
          $lookup: {
            from: "bookingservices",
            localField: "bookingId",
            foreignField: "_id",
            as: "booking",
          }
        },
        { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            _isRepair: {
              $or: [
                { $eq: ["$booking.serviceType", "repair"] },
                { $eq: ["$booking.serviceModel", "RepairService"] },
                {
                  $anyElementTrue: {
                    $map: {
                      input: { $ifNull: ["$booking.services", []] },
                      as: "svc",
                      in: { $eq: ["$$svc.type", "repair"] }
                    }
                  }
                }
              ]
            },
            _repairRevenue: {
              $add: [
                {
                  $cond: [
                    { $gt: [{ $ifNull: ["$booking.inspectionFeeTotalCollected", 0] }, 0] },
                    { $ifNull: ["$booking.inspectionFeeTotalCollected", 0] },
                    { $ifNull: ["$booking.initialCost", 0] }
                  ]
                },
                {
                  $cond: [
                    { $gt: [{ $ifNull: ["$booking.repairPaymentAmount", 0] }, 0] },
                    { $ifNull: ["$booking.repairPaymentAmount", 0] },
                    { $ifNull: ["$booking.quotation.totalCost", 0] }
                  ]
                }
              ]
            },
            _coreRevenue: {
              $let: {
                vars: {
                  tp: { $ifNull: ["$booking.totalPrice", 0] },
                  ef: { $ifNull: ["$booking.estimatedFee", 0] },
                  ap: { $ifNull: ["$booking.amountPaid", 0] }
                },
                in: {
                  $cond: [
                    { $gt: ["$$tp", 0] }, "$$tp",
                    { $cond: [{ $gt: ["$$ef", 0] }, "$$ef", "$$ap"] }
                  ]
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            revenue: {
              $sum: {
                $cond: ["$_isRepair", "$_repairRevenue", "$_coreRevenue"]
              }
            },
          }
        },
      ]),
      BookingService.countDocuments({
        status: "pending_reassignment",
        bookingDate: { $gte: todayStart },
      }),
      ServiceToolUsage.aggregate([
        { $match: { technicianId: tech._id } },
        {
          $lookup: {
            from: "bookingservices",
            localField: "bookingId",
            foreignField: "_id",
            as: "booking"
          }
        },
        { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
        { $match: { "booking.status": "completed" } },
        { $group: { _id: null, totalPartsCost: { $sum: { $ifNull: ["$toolCost", 0] } } } }
      ]),
      Expense.aggregate([
        { $match: { technicianId: tech._id, status: { $ne: "rejected" } } },
        { $group: { _id: null, totalExpenses: { $sum: "$amount" } } }
      ]),
    ]);

    const statusMap = {};
    statusCounts.forEach(s => { statusMap[s._id] = s.count; });

    const completed = statusMap["completed"] || 0;
    const pending = statusMap["pending_acceptance"] || 0;
    const active = (statusMap["accepted"] || 0) + (statusMap["en_route"] || 0) + (statusMap["on_site"] || 0) + (statusMap["in_progress"] || 0);
    const declined = statusMap["declined"] || 0;
    const cancelled = statusMap["cancelled"] || 0;
    const revenue = revenueResult.length > 0 ? revenueResult[0].revenue : 0;
    const partsCost = toolCostResult.length > 0 ? toolCostResult[0].totalPartsCost : 0;
    const expenses = expenseResult.length > 0 ? expenseResult[0].totalExpenses : 0;
    const grossProfit = revenue - partsCost;
    const netProfit = grossProfit - expenses;
    const completionRate = totalCount > 0 ? Math.round((completed / totalCount) * 100) : 0;

    return res.json({
      total: totalCount,
      completed,
      pending,
      active,
      today: todayCount,
      declined,
      cancelled,
      revenue,
      partsCost,
      expenses,
      grossProfit,
      netProfit,
      completionRate,
      available: availableCount,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/calendar
 * Returns paginated calendar events for FullCalendar.
 * Query: ?start=ISO&end=ISO&page=1&limit=5
 */
router.get("/calendar", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { start, end, page = 1, limit = 5 } = req.query;
    const filter = { technicianId: tech._id };

    if (start || end) {
      filter.bookingDate = {};
      if (start) {
        const startDate = parseCalendarDateParam(start);
        if (!startDate) return res.status(400).json({ error: "Invalid start date" });
        filter.bookingDate.$gte = startDate;
      }
      if (end) {
        const endDate = parseCalendarDateParam(end);
        if (!endDate) return res.status(400).json({ error: "Invalid end date" });
        filter.bookingDate.$lte = endDate;
      }
    }

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const pageNum = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const lim = Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, parsedLimit)) : 5;
    const skip = (pageNum - 1) * lim;

    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const [items, total, scheduleDoc] = await Promise.all([
      Assignment.find(filter)
        .sort({ bookingDate: 1, startTime: 1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Assignment.countDocuments(filter),
      TechnicianSchedule.findOne({ technicianId: tech._id }).lean()
    ]);

    const schedule = scheduleDoc ? {
      workingDays: scheduleDoc.workingDays || [],
      nonWorkingWeekdays: (scheduleDoc.nonWorkingWeekdays || []).map(nw => typeof nw === "object" ? nw.dayOfWeek : nw),
      restDates: scheduleDoc.restDates || [],
    } : null;
    return res.json({ items, schedule, total, page: pageNum, pages: Math.ceil(total / lim) });
  } catch (err) {
    next(err);
  }
});
// ═════════════════════════════════════════════════════════════════════════════
// ASSIGNMENTS — CRUD & Status Transitions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/assignments
 * Query: ?status=pending_acceptance|accepted|en_route|...&page=1&limit=20&search=...
 * Returns filtered, paginated assignments for the authenticated technician.
 */
router.get("/assignments", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { status, search, date, sort, page = 1, limit = 20 } = req.query;
    const filter = { technicianId: tech._id };

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      filter.bookingDate = { $gte: start, $lte: end };
    }

    if (status && status !== "all") {
      if (status === "active") {
        filter.status = { $in: ["accepted", "en_route", "on_site", "in_progress"] };
      } else if (status === "today") {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        // Only apply if date is not explicitly set
        if (!date) filter.bookingDate = { $gte: todayStart, $lte: todayEnd };
      } else if (status === "upcoming") {
        filter.status = { $in: ["pending_acceptance", "accepted"] };
        filter.bookingDate = { $gte: new Date() };
      } else {
        filter.status = status;
      }
    } else if (!status || status === "all") {
      // Hide expired assignments from the "all" tab — they are superseded by
      // the reassignment and should not clutter the technician's list.
      filter.status = { $ne: "expired" };
    }

    if (search) {
      filter.$or = [
        { customerName: { $regex: search, $options: "i" } },
        { serviceName: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    // Projects belong in the technician's "Projects" tab, not the standard
    // My Work job list. Exclude assignments whose booking is a project.
    const projectBookingIds = await (require("../models/BookingService"))
      .find({ isProject: true })
      .distinct("_id");
    if (projectBookingIds.length) {
      filter.bookingId = Object.assign({}, filter.bookingId, {
        $nin: projectBookingIds,
      });
    }

    let sortObj = { bookingDate: -1, startTime: -1 };
    if (sort === 'oldest') sortObj = { bookingDate: 1, startTime: 1 };
    else if (sort === 'priority') sortObj = { priority: -1, bookingDate: -1, startTime: -1 };

    const [items, total] = await Promise.all([
      Assignment.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(lim)
        .lean(),
      Assignment.countDocuments(filter),
    ]);

    // Enrich assignments with booking payment fields and status
    const BookingService = require("../models/BookingService");
    const bookingIds = items.map(a => a.bookingId).filter(Boolean);
    const bookings = await BookingService.find({ _id: { $in: bookingIds } })
      .select("bookingReference workOrderNumber paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice estimatedFee isMultiService services service status serviceType initialCost travelFare inspectionFeeCollected repairPaymentCollected repairPaymentAmount quotation airconType airconTypeName hp hpDescription quantity notes address location customerLocation serviceDurationMinutes description features customer unitInfo")
      .lean();
    const bookingMap = new Map(bookings.map(b => [String(b._id), b]));
    for (const item of items) {
      const bk = bookingMap.get(String(item.bookingId));
      if (bk) {
        item.paymentMethod = bk.paymentMethod;
        item.paymentStatus = bk.paymentStatus;
        item.amountPaid = bk.amountPaid;
        item.balanceAmount = bk.balanceAmount;
        item.balanceCollected = bk.balanceCollected;
        item.repairPaymentCollected = bk.repairPaymentCollected;
        item.repairPaymentAmount = bk.repairPaymentAmount;
        item.downpaymentAmount = bk.downpaymentAmount;
        item.totalPrice = bk.totalPrice;
        item.estimatedFee = bk.estimatedFee;
        item.initialCost = bk.initialCost;
        item.travelFare = bk.travelFare;
        item.bookingStatus = bk.status;
        item.quotation = bk.quotation; // Added quotation here
        // Keep one assignment per visit while exposing its child services.
        // The technician UI uses these items to distinguish mixed bookings.
        item.isMultiService = Boolean(bk.isMultiService);
        item.services = Array.isArray(bk.services) ? bk.services : [];
        item.bookingReference = bk.bookingReference || bk.workOrderNumber || '';
        if (!item.serviceType) item.serviceType = bk.serviceType;
        if (!item.serviceName || item.serviceName === "Service" || item.serviceName === "") {
          item.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
        }
        // Enrich with service detail fields for the technician "view details" panel
        if (bk.service) {
          item.serviceDetail = {
            name: bk.service.name,
            description: bk.service.description,
            features: bk.service.features,
            durationMinutes: bk.service.serviceDurationMinutes || bk.service.durationMinutes,
            basePrice: bk.service.basePrice,
          };
        }
        if (bk.airconTypeName != null) item.airconTypeName = bk.airconTypeName;
        if (bk.airconType != null) item.airconType = bk.airconType;
        if (bk.hp != null) item.hp = bk.hp;
        if (bk.hpDescription != null) item.hpDescription = bk.hpDescription;
        if (bk.quantity != null) item.quantity = bk.quantity;
        else if (Array.isArray(bk.services) && bk.services.length > 0) {
          const sum = bk.services.reduce((s, x) => s + (Number(x.quantity) || 1), 0);
          item.quantity = sum || 1;
        } else if (bk.unitInfo && bk.unitInfo.quantity != null) {
          item.quantity = bk.unitInfo.quantity;
        } else {
          item.quantity = 1;
        }
        if (bk.serviceDurationMinutes != null) item.serviceDurationMinutes = bk.serviceDurationMinutes;
        if (bk.description != null) item.serviceDescription = bk.description;
        if (bk.notes != null) item.bookingNotes = bk.notes;
        if (bk.features != null) item.serviceFeatures = bk.features;
        if (bk.address != null) item.address = item.address || bk.address;
        const siteAddress = bk.location?.address || bk.customerLocation?.address || bk.address || bk.customer?.address || item.address || "";
        const geo = Array.isArray(bk.location?.coordinates?.coordinates)
          ? bk.location.coordinates.coordinates
          : (Array.isArray(bk.location?.coordinates) ? bk.location.coordinates : []);
        const siteLat = Number(bk.location?.lat ?? bk.customerLocation?.lat ?? geo[1]);
        const siteLng = Number(bk.location?.lng ?? bk.customerLocation?.lng ?? geo[0]);
        item.address = siteAddress;
        item.customerLocation = {
          address: siteAddress,
          lat: Number.isFinite(siteLat) ? siteLat : null,
          lng: Number.isFinite(siteLng) ? siteLng : null,
        };
        item.location = {
          address: siteAddress,
          lat: Number.isFinite(siteLat) ? siteLat : null,
          lng: Number.isFinite(siteLng) ? siteLng : null,
          coordinates: Number.isFinite(siteLat) && Number.isFinite(siteLng)
            ? { type: "Point", coordinates: [siteLng, siteLat] }
            : undefined,
        };
        if (bk.customer && !item.customerPhone) {
          item.customerPhone = bk.customer.phone || item.customerPhone;
          item.customerEmail = bk.customer.email || item.customerEmail;
        }
      }
    }

    return res.json({
      items,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / lim),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/assignments/:id
 * Returns a single assignment with full details.
 */
router.get("/assignments/:id", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id })
      .populate("bookingId")
      .lean();

    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Enrich with booking payment fields
    if (assignment.bookingId && assignment.bookingId._id) {
      const bk = assignment.bookingId;
      assignment.paymentMethod = bk.paymentMethod;
      assignment.paymentStatus = bk.paymentStatus;
      assignment.amountPaid = bk.amountPaid;
      assignment.balanceAmount = bk.balanceAmount;
      assignment.balanceCollected = bk.balanceCollected;
      assignment.repairPaymentCollected = bk.repairPaymentCollected;
      assignment.repairPaymentAmount = bk.repairPaymentAmount;
      assignment.downpaymentAmount = bk.downpaymentAmount;
      assignment.totalPrice = bk.totalPrice;
      assignment.estimatedFee = bk.estimatedFee;
      assignment.initialCost = bk.initialCost;
      assignment.travelFare = bk.travelFare;
      assignment.bookingStatus = bk.status;
      assignment.quotation = bk.quotation;
      assignment.noShowReport = bk.noShowReport || null;
      assignment.noShowWaitMinutes = await getNoShowWaitMinutes().catch(() => 15);
      if (!assignment.serviceType) assignment.serviceType = bk.serviceType;
      if (!assignment.serviceName || assignment.serviceName === "Service" || assignment.serviceName === "") {
        assignment.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
      }
      // Enrich with service detail fields for the technician "view details" panel
      if (bk.service) {
        assignment.serviceDetail = {
          name: bk.service.name,
          description: bk.service.description,
          features: bk.service.features,
          durationMinutes: bk.service.serviceDurationMinutes || bk.service.durationMinutes,
          basePrice: bk.service.basePrice,
        };
      }
      if (bk.airconTypeName != null) assignment.airconTypeName = bk.airconTypeName;
      if (bk.airconType != null) assignment.airconType = bk.airconType;
      if (bk.hp != null) assignment.hp = bk.hp;
      if (bk.hpDescription != null) assignment.hpDescription = bk.hpDescription;
      if (bk.serviceDurationMinutes != null) assignment.serviceDurationMinutes = bk.serviceDurationMinutes;
      if (bk.description != null) assignment.serviceDescription = bk.description;
      if (bk.notes != null) assignment.bookingNotes = bk.notes;
      if (bk.features != null) assignment.serviceFeatures = bk.features;
      if (bk.address != null) assignment.address = assignment.address || bk.address;
      const siteAddress = bk.location?.address || bk.customerLocation?.address || bk.address || bk.customer?.address || assignment.address || "";
      const geo = Array.isArray(bk.location?.coordinates?.coordinates)
        ? bk.location.coordinates.coordinates
        : (Array.isArray(bk.location?.coordinates) ? bk.location.coordinates : []);
      const siteLat = Number(bk.location?.lat ?? bk.customerLocation?.lat ?? geo[1]);
      const siteLng = Number(bk.location?.lng ?? bk.customerLocation?.lng ?? geo[0]);
      assignment.address = siteAddress;
      assignment.customerLocation = { address: siteAddress, lat: Number.isFinite(siteLat) ? siteLat : null, lng: Number.isFinite(siteLng) ? siteLng : null };
      assignment.location = {
        address: siteAddress,
        lat: Number.isFinite(siteLat) ? siteLat : null,
        lng: Number.isFinite(siteLng) ? siteLng : null,
        coordinates: Number.isFinite(siteLat) && Number.isFinite(siteLng) ? { type: "Point", coordinates: [siteLng, siteLat] } : undefined,
      };
      if (bk.customer && !assignment.customerPhone) {
        assignment.customerPhone = bk.customer.phone || assignment.customerPhone;
        assignment.customerEmail = bk.customer.email || assignment.customerEmail;
      }
      // Quantity — resolve from booking, multi-service, repair unit, or default 1
      if (bk.quantity != null) assignment.quantity = bk.quantity;
      else if (Array.isArray(bk.services) && bk.services.length > 0) {
        const sum = bk.services.reduce((s, x) => s + (Number(x.quantity) || 1), 0);
        assignment.quantity = sum || 1;
      } else if (bk.unitInfo && bk.unitInfo.quantity != null) {
        assignment.quantity = bk.unitInfo.quantity;
      } else {
        assignment.quantity = 1;
      }
    }

    return res.json({ assignment, techLocation: tech.location });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/accept
 * Technician accepts a pending assignment.
 */
router.post("/assignments/:id/accept", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    if (assignment.status !== "pending_acceptance") {
      return res.status(400).json({ error: "Assignment is not pending acceptance." });
    }

    if (assertNotMissedSchedule(assignment)) {
      return res.status(409).json({
        error: "The scheduled time for this assignment has passed. It can no longer be accepted — an administrator will reschedule it.",
        code: "SCHEDULE_MISSED",
      });
    }

    const isRepair = assignment.serviceType === "repair";
    assignment.status = "accepted";
    assignment.acceptedAt = new Date();
    assignment.notes.push({
      text: "Assignment accepted by technician",
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const BookingService = require("../models/BookingService");
    if (!isRepair) {
      const bookingUpdate = await BookingService.findById(assignment.bookingId);
      if (bookingUpdate) {
        bookingUpdate.status = "confirmed";
        bookingUpdate.notes = `[Technician Accepted] ${tech.name} accepted the assignment`;
        for (const item of bookingUpdate.services || []) {
          item.technicianId = tech._id;
          item.technicianName = tech.name;
          item.assignmentId = assignment._id;
          if (["pending", "awaiting_assignment", "assigned"].includes(item.status)) {
            item.status = "accepted";
          }
        }
        await bookingUpdate.save();
      }
    } else {
      // A walk-in repair remains `assigned` until this explicit acceptance.
      // At acceptance it can enter the inspection workflow. Existing repair
      // assignments that are already inspection-scheduled remain unchanged.
      const bookingUpdate = await BookingService.findById(assignment.bookingId);
      if (bookingUpdate) {
        if (bookingUpdate.status === "assigned") {
          bookingUpdate.status = "inspection_scheduled";
        }
        bookingUpdate.notes = `[Technician Accepted] ${tech.name} accepted the repair assignment`;
        for (const item of bookingUpdate.services || []) {
          if (item.type !== "repair") continue;
          item.technicianId = tech._id;
          item.technicianName = tech.name;
          item.assignmentId = assignment._id;
          if (["pending", "accepted"].includes(item.status)) {
            item.status = "inspection_scheduled";
            item.phase = "repair_phase_1";
          }
        }
        await bookingUpdate.save();
        // Socket notify: customer that tech accepted
        try {
          if (global.io) {
            global.io.to(`customer:${bookingUpdate.customerId}`).emit("booking:updated", {
              bookingId: assignment.bookingId,
              status: bookingUpdate.status,
              message: `Technician ${tech.name} has accepted your repair! They will arrive on the scheduled date.`,
            });
          }
        } catch (e) { /* non-critical */ }
      }
    }

    // ── Auto-reserve resources for this booking ─────────────────────────────
    await syncMixedVisitItems(assignment.bookingId, "accepted", tech);

    let reservationResult = { reserved: [], issues: [], preparationStatus: 'pending' };
    // Acceptance only unlocks review. It must not reserve inventory or force a
    // technician away from their current booking to collect resources.
    assignment.resourcesReserved = false;
    assignment.preparationStatus = 'pending';
    assignment.preparationIssue = '';
    await assignment.save();

    // ── Notify admin if reservation has issues ──────────────────────────────
    if (reservationResult && reservationResult.issues && reservationResult.issues.length > 0) {
      try {
        const { createNotification } = require('../utils/notify');
        const io = req.app.get('io');
        const issueList = reservationResult.issues.map(i => `${i.name}: ${i.reason}`).join('\n• ');
        await createNotification({
          type: 'resource_issue',
          title: 'Resource Reservation Issue',
          message: `Technician ${tech.name} accepted ${assignment.serviceType === 'repair' ? 'repair' : 'service'} assignment but some resources could not be reserved:\n• ${issueList}`,
          role: 'admin',
          referenceId: assignment._id,
          referenceModel: 'Assignment',
          link: '/admin/appointments/active',
          io,
        });
      } catch (notifErr) {
        console.warn('[ACCEPT] Admin notification for reservation issue failed:', notifErr.message);
      }
    }

    // Update technician availability
    tech.availabilityStatus = "Assigned";
    await tech.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.accept",
      module: "technician",
      req,
      details: { assignmentId: id, bookingId: assignment.bookingId, serviceType: assignment.serviceType },
    }).catch(() => { });

    // ── Sync Project teamStatus (if this assignment belongs to a project) ────
    // When a technician accepts a project assignment, mark them as
    // "acknowledged" in the project's team roster so the admin sees
    // real-time acceptance progress.
    try {
      const Project = require("../models/Project");
      const project = await Project.findOne({
        "assignedTechnicians._id": tech._id,
      });
      if (project) {
        const ts = project.teamStatus || [];
        let entry = ts.find((t) => t._id && t._id.toString() === tech._id.toString());
        if (!entry) {
          entry = { _id: tech._id, name: tech.name, status: "acknowledged", acknowledgedAt: new Date() };
          ts.push(entry);
        } else {
          entry.status = "acknowledged";
          entry.acknowledgedAt = new Date();
          entry.declinedReason = "";
        }
        project.teamStatus = ts;
        await project.save();

        // Notify admin room in real-time so the project detail page refreshes.
        const ioProject = req.app.get("io");
        if (ioProject) {
          ioProject.to("admin-room").emit("project:team-status", {
            projectId: project._id,
            teamStatus: project.teamStatus,
            techName: tech.name,
            action: "accepted",
          });
        }
      }
    } catch (projErr) {
      // Non-critical — don't block assignment acceptance.
      console.warn("Project teamStatus sync skipped:", projErr.message);
    }

    // Create notification for admins
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    const BookingServiceForNotif = require('../models/BookingService');
    const bookingForNotif = await BookingServiceForNotif.findById(assignment.bookingId).lean();
    const isProjectAssignment = assignment.serviceType === "project";
    await createNotification({
      type: 'assignment_accepted',
      title: isProjectAssignment ? 'Project Assignment Accepted' : 'Repair Assignment Accepted',
      message: `${tech.name} accepted the ${isProjectAssignment ? 'project' : 'repair'} assignment for ${bookingForNotif?.workOrderNumber || bookingForNotif?.bookingReference || 'a service request'}.`,
      role: 'admin',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/admin/appointments/active',
      io,
    });

    // Socket: notify admins in real-time
    if (io) {
      io.to("admin-room").emit("assignment:accepted", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        serviceName: bookingForNotif?.service?.name || "Repair Service",
        customerName: assignment.customerName,
        bookingDate: assignment.bookingDate,
      });
    }

    // ── Email: Notify Customer that Booking was Accepted ─────────────────
    try {
      const { sendBookingAcceptedEmail } = require("../utils/mailer");
      const booking = await BookingService.findById(assignment.bookingId).lean();
      const customerEmail = booking?.customer?.email;
      if (customerEmail) {
        const dateLabel = booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = booking.startTime || 'TBD';
        const techFullName = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Your technician';
        sendBookingAcceptedEmail({
          to: customerEmail,
          customerName: booking.customer?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: isRepair ? "Repair Service" : (booking.service?.name || 'Service'),
          technicianName: techFullName,
          dateLabel,
          timeLabel,
          locationAddress: booking.location?.address || '',
        }).catch(err => console.error('[MAILER] Failed to send acceptance email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Acceptance email error:', mailErr.message);
    }

    // ── Email: Notify admin that technician accepted ─────────────────────
    try {
      const { sendEmail } = require("../utils/mailer");
      const adminEmail = process.env.ADMIN_EMAIL || (await require("../models/User").findOne({ role: "admin" }).select("email").lean())?.email;
      if (adminEmail) {
        const workOrderNum = bookingForNotif?.workOrderNumber || bookingForNotif?.bookingReference || `#${String(assignment.bookingId).slice(-6).toUpperCase()}`;
        sendEmail(
          adminEmail,
          `Technician Accepted Repair – ${workOrderNum} | CALIDRO RACS`,
          `Technician ${tech.name} has accepted the repair assignment for ${workOrderNum}. Scheduled on ${bookingForNotif?.bookingDate ? new Date(bookingForNotif.bookingDate).toLocaleDateString('en-PH') : 'TBD'} at ${bookingForNotif?.startTime || 'TBD'}.`
        ).catch(err => console.error('[MAILER] Failed to send admin acceptance email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Admin acceptance email error:', mailErr.message);
    }

    // ── Preparation review: detect new Daily Kit requirements ─────────────
    // If this booking was accepted after the technician already confirmed
    // their Daily Kit, re-sync the kit for that date and surface any new
    // requirements so the technician can decide per item before En Route.
    let preparationReview = null;
    if (!isProjectAssignment && assignment.bookingDate) {
      try {
        const { syncDailyKit } = require("../utils/dailyKitService");
        const syncedKit = await syncDailyKit(tech._id, assignment.bookingDate);
        const undecidedDelta = (syncedKit.hasDelta && Array.isArray(syncedKit.deltaItems) ? syncedKit.deltaItems : [])
          .filter(i => !i.resolution?.status)
          .map(i => ({
            name: i.name,
            category: i.category,
            quantity: i.quantity,
            unit: i.unit,
            checkoutStatus: i.checkoutStatus,
            conflictMessage: i.conflict?.message || null,
          }));
        if (undecidedDelta.length) {
          preparationReview = { hasDelta: true, deltaItems: undecidedDelta };
        }
      } catch (kitErr) {
        console.warn('[ACCEPT] Daily kit preparation review skipped:', kitErr.message);
      }
    }

    return res.json({ message: "Assignment accepted.", assignment, preparationReview });
  } catch (err) {
    next(err);
  }
});

/**
 * Propagate only the shared visit stages into mixed-booking service items.
 * Once work starts, Core and Repair continue through their own lifecycles.
 */
async function syncMixedVisitItems(bookingId, visitStatus, technician) {
  const BookingService = require("../models/BookingService");
  const booking = await BookingService.findById(bookingId);
  if (!booking || booking.serviceType !== "mixed" || !Array.isArray(booking.services)) return;
  const targetFor = item => {
    if (visitStatus === "accepted") return item.type === "repair" && item.status === "inspection_scheduled" ? null : "accepted";
    if (visitStatus === "en_route") return "en_route";
    if (visitStatus === "on_site") return "arrived";
    // Booking-level Start Work only activates the shared work session. Core
    // work and Repair inspection must be started explicitly from their tabs.
    if (visitStatus === "in_progress") return null;
    return null;
  };
  let changed = false;
  const visitStageRank = {
    pending: 0, inspection_pending: 0, awaiting_assignment: 0,
    assigned: 1, inspection_scheduled: 1, accepted: 1, scheduled: 1,
    en_route: 2, arrived: 3,
  };
  const targetStageRank = { accepted: 1, en_route: 2, arrived: 3 };
  for (const item of booking.services) {
    const target = targetFor(item);
    if (!target || item.status === target) continue;
    const directSharedVisitAdvance = Object.prototype.hasOwnProperty.call(visitStageRank, item.status)
      && targetStageRank[target] >= visitStageRank[item.status];
    if (!canTransitionServiceItem(item, target) && !directSharedVisitAdvance) continue;
    item.status = target;
    item.statusHistory = item.statusHistory || [];
    item.statusHistory.push({
      status: target,
      changedAt: new Date(),
      changedBy: technician?._id,
      changedByName: technician?.name || "Technician",
      reason: "Shared technician visit stage",
    });
    changed = true;
  }
  if (changed) await booking.save();
}

/** Technician-owned preparation for core and repair bookings. */
router.get('/assignments/:id/preparation', async (req, res, next) => {
  try {
    const Assignment = require('../models/Assignment');
    const BookingService = require('../models/BookingService');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician record not found' });
    const assignment = await Assignment.findOne({ _id: req.params.id, technicianId: tech._id }).lean();
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.serviceType === 'project') return res.status(400).json({ error: 'Project inventory is prepared through the project workflow.' });
    if (!['accepted', 'en_route', 'on_site', 'in_progress'].includes(assignment.status)) return res.status(409).json({ error: 'Accept the assignment before preparing inventory.' });
    const booking = await BookingService.findById(assignment.bookingId).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isRepairAssignment = assignment.serviceType === 'repair' || assignment.serviceType === 'mixed';
    if (isRepairAssignment && (!booking.technicianAssistant?.summary || !booking.technicianAssistant?.verifiedByTechnician)) {
      return res.status(409).json({ error: 'Review and confirm the AI diagnosis before preparing Equipment & Consumables.', code: 'AI_REVIEW_REQUIRED' });
    }
    const generated = await buildServicePreparation(booking);

    // Surface the actual repair parts already reserved for this booking
    // (e.g. approved during quotation, or reserved ahead of a Phase 2 visit)
    // so the technician sees exactly what to bring, not just generic
    // equipment/consumable recommendations.
    let reservedParts = [];
    if (isRepairAssignment) {
      const StockReservation = require('../models/StockReservation');
      const reservations = await StockReservation.find({
        bookingId: booking._id,
        status: { $in: ['reserved', 'checked_out'] },
      }).populate('toolId', 'itemName unit').lean();
      reservedParts = reservations.map(row => ({
        name: row.toolId?.itemName || row.itemName || 'Repair part',
        quantity: row.quantity,
        unit: row.toolId?.unit || 'pcs',
        status: row.status,
      }));
    }

    return res.json({
      assignmentId: assignment._id,
      bookingId: booking._id,
      serviceType: assignment.serviceType,
      preparation: booking.servicePreparation || {},
      reservedParts,
      aiReview: {
        reviewed: Boolean(booking.technicianAssistant?.verifiedByTechnician),
        reviewedAt: booking.technicianAssistant?.verifiedAt || null,
        possibleParts: booking.technicianAssistant?.possibleParts || [],
        carriedPossibleParts: booking.technicianAssistant?.carriedPossibleParts || [],
        confirmedContingencyParts: booking.servicePreparation?.aiContingencyParts || [],
      },
      ...generated,
    });
  } catch (err) { next(err); }
});

router.post('/assignments/:id/preparation/confirm', async (req, res, next) => {
  try {
    const Assignment = require('../models/Assignment');
    const BookingService = require('../models/BookingService');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician record not found' });
    const assignment = await Assignment.findOne({ _id: req.params.id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.serviceType === 'project') return res.status(400).json({ error: 'Project inventory is prepared through the project workflow.' });
    if (assignment.status !== 'accepted') return res.status(409).json({ error: 'Preparation can only be confirmed after acceptance and before departure.' });
    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isRepairAssignment = assignment.serviceType === 'repair' || assignment.serviceType === 'mixed';
    if (isRepairAssignment && (!booking.technicianAssistant?.summary || !booking.technicianAssistant?.verifiedByTechnician)) {
      return res.status(409).json({ error: 'Review and confirm the AI diagnosis before preparing Equipment & Consumables.', code: 'AI_REVIEW_REQUIRED' });
    }
    if (booking.servicePreparation?.confirmed) return res.status(409).json({ error: 'Preparation is already confirmed.' });

    const requested = Array.isArray(req.body.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: 'Select at least one equipment or consumable item.' });
    const normalized = [];
    const seen = new Set();
    for (const row of requested) {
      if (!mongoose.Types.ObjectId.isValid(row.inventoryId) || seen.has(String(row.inventoryId))) continue;
      seen.add(String(row.inventoryId));
      const tool = await Tool.findById(row.inventoryId);
      if (!tool || tool.active === false) return res.status(400).json({ error: 'A selected inventory item is no longer available.' });
      const qty = Math.max(1, parseInt(row.quantity, 10) || 1);
      const kind = tool.type === 'consumable' ? 'consumable' : 'equipment';
      if (kind === 'equipment' && (Tool.effectiveInventoryClass(tool) !== 'operational_asset' || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus))) {
        return res.status(400).json({ error: `${tool.itemName} is not an assignable operational asset.` });
      }
      const availableQty = Math.max(0, Number(tool.quantity || 0) - Number(tool.reservedQuantity || 0));
      if (availableQty < qty) return res.status(409).json({ error: `Only ${availableQty} ${tool.unit || 'pcs'} available for ${tool.itemName}.` });
      normalized.push({ tool, quantity: qty, kind, recommended: Boolean(row.recommended) });
    }
    if (!normalized.length) return res.status(400).json({ error: 'No valid preparation items were selected.' });

    const possibleParts = booking.technicianAssistant?.possibleParts || [];
    const possibleByName = new Map(possibleParts.map(part => {
      const name = String(typeof part === 'string' ? part : part?.name || '').trim();
      return [name.toLowerCase(), { name, serviceName: typeof part === 'object' ? String(part?.serviceName || '').trim() : '' }];
    }).filter(([name]) => name));
    const requestedContingencyParts = isRepairAssignment && Array.isArray(req.body.carriedPossibleParts)
      ? req.body.carriedPossibleParts
      : [];
    const confirmedAt = new Date();
    const confirmedContingencyParts = [];
    const seenContingencyParts = new Set();
    for (const row of requestedContingencyParts) {
      const key = String(row?.name || '').trim().toLowerCase();
      const suggested = possibleByName.get(key);
      if (!suggested || seenContingencyParts.has(key)) continue;
      seenContingencyParts.add(key);
      confirmedContingencyParts.push({
        name: suggested.name,
        quantity: Math.max(1, parseInt(row.quantity, 10) || 1),
        serviceName: suggested.serviceName,
        confirmedBroughtAt: confirmedAt,
        confirmedBy: tech._id,
      });
    }

    booking.servicePreparation = {
      confirmed: true, confirmedAt: new Date(), confirmedBy: tech._id, recommendationGeneratedAt: new Date(),
      aiContingencyParts: confirmedContingencyParts,
      items: normalized.map(i => ({ inventoryId: i.tool._id, name: i.tool.itemName, kind: i.kind, quantity: i.quantity, recommended: i.recommended })),
    };
    if (isRepairAssignment && booking.technicianAssistant) {
      booking.technicianAssistant.carriedPossibleParts = confirmedContingencyParts.map(part => ({
        name: part.name,
        quantity: part.quantity,
        serviceName: part.serviceName,
        confirmedBrought: true,
        confirmedBroughtAt: part.confirmedBroughtAt,
        confirmedBy: part.confirmedBy,
      }));
    }
    await booking.save();
    // Compatibility flag: this now means the list was reviewed, not that
    // assets were physically issued or inventory was deducted.
    assignment.equipmentCheckedOut = true;
    assignment.equipmentCheckedOutAt = new Date();
    assignment.notes.push({ text: `Equipment and consumables reviewed (${normalized.length} item(s)); ${confirmedContingencyParts.length} optional AI contingency part(s) physically confirmed as brought; no inventory checkout performed`, by: req.user._id, byName: tech.name, createdAt: new Date() });
    await assignment.save();
    return res.json({ success: true, preparation: booking.servicePreparation, assignment });
  } catch (err) { next(err); }
});

/**
 * GET /api/technician/assignments/preparation/next-jobs
 * Returns all accepted bookings that have reserved resources needing checkout.
 * Shows upcoming jobs so technicians can prepare in advance.
 */
router.get('/assignments/preparation/next-jobs', async (req, res, next) => {
  try {
    const Assignment = require('../models/Assignment');
    const EquipmentAssignment = require('../models/EquipmentAssignment');
    const StockReservation = require('../models/StockReservation');
    const BookingService = require('../models/BookingService');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician record not found' });

    const today = new Date(); today.setHours(0, 0, 0, 0);

    // Accept optional date filter — defaults to today
    const filterDate = req.query.date ? new Date(req.query.date) : today;
    filterDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(filterDate); nextDay.setDate(nextDay.getDate() + 1);

    // Get all accepted assignments for the selected date (with or without reserved resources)
    const assignments = await Assignment.find({
      technicianId: tech._id,
      status: { $in: ['accepted', 'en_route', 'on_site', 'in_progress'] },
      bookingDate: { $gte: filterDate, $lt: nextDay },
    }).sort({ bookingDate: 1, startTime: 1 }).lean();

    // ── Daily Kit coverage map ─────────────────────────────────────────────
    // When the Daily Kit was confirmed, equipment/consumable ledger rows are
    // created per ITEM (booked to bookingIds[0]), not per job. Merge kit items
    // back onto each booking here so per-job resource lists stay truthful.
    const DailyKit = require('../models/DailyKit');
    const kit = await DailyKit.findOne({ technicianId: tech._id, workDate: filterDate }).lean();
    const kitItemsByBooking = new Map();
    if (kit) {
      for (const item of [...(kit.items || []), ...(Array.isArray(kit.deltaItems) ? kit.deltaItems : [])]) {
        const statusOk = ['checked_out', 'issued', 'standard_kit', 'reserved'].includes(item.checkoutStatus);
        if (!statusOk) continue;
        (item.bookingIds || []).forEach(bid => {
          const key = String(bid);
          if (!kitItemsByBooking.has(key)) kitItemsByBooking.set(key, []);
          kitItemsByBooking.get(key).push({
            name: item.name,
            quantity: item.quantity || 1,
            category: item.category,
            checkoutStatus: item.checkoutStatus,
          });
        });
      }
    }

    // Fetch booking data for AI diagnosis / parts info
    const bookingIds = assignments.map(a => a.bookingId).filter(Boolean);
    const bookings = await BookingService.find({ _id: { $in: bookingIds } })
      .select('technicianAssistant issueDescription unitInfo services quotation repairSchedule')
      .lean();
    const bookingMap = new Map(bookings.map(b => [String(b._id), b]));

    const result = [];
    for (const asg of assignments) {
      // Get equipment assignments for this booking
      const equipment = await EquipmentAssignment.find({
        bookingId: asg.bookingId,
        status: { $in: ['reserved', 'checked_out', 'in_use'] },
      }).select('equipmentName quantity consumable status').lean();

      // Get reserved repair parts
      const parts = await StockReservation.find({
        bookingId: asg.bookingId,
        status: { $in: ['reserved', 'checked_out'] },
      }).select('itemName quantity status').lean();

      const allReserved = equipment.filter(e => e.status === 'reserved');
      const allCheckedOut = equipment.filter(e => e.status === 'checked_out' || e.status === 'in_use');
      const partsReserved = parts.filter(p => p.status === 'reserved');
      const partsCheckedOut = parts.filter(p => p.status === 'checked_out');

      let preparationStatus = asg.preparationStatus || 'pending';
      if (allCheckedOut.length > 0 && allReserved.length === 0 && partsReserved.length === 0) {
        preparationStatus = 'checked_out';
      } else if (allReserved.length > 0 || partsReserved.length > 0) {
        preparationStatus = 'ready_for_checkout';
      } else if (equipment.length === 0 && parts.length === 0 && asg.resourcesReserved) {
        preparationStatus = 'reserved'; // auto-reserved but no items found
      }
      // Daily Kit confirmation covers this booking even when no per-booking
      // ledger rows exist — surface it as checked out.
      const kitItems = kitItemsByBooking.get(String(asg.bookingId)) || [];
      if (kitItems.length > 0 && ['pending', 'reserved', 'ready_for_checkout'].includes(preparationStatus) && kit.status === 'confirmed') {
        preparationStatus = 'checked_out';
      }

      // Merge kit-covered items into the job's resource lists (skip duplicates)
      const knownNames = new Set([...allReserved, ...allCheckedOut].map(e => String(e.equipmentName || '').trim().toLowerCase()));
      const kitEquipment = [];
      const kitConsumables = [];
      for (const ki of kitItems) {
        const lname = String(ki.name || '').trim().toLowerCase();
        if (!knownNames.has(lname)) {
          if (ki.category === 'consumable') kitConsumables.push(ki);
          else kitEquipment.push(ki);
        }
      }

      // Enrich with booking data (AI diagnosis, parts needed, etc.)
      const bk = bookingMap.get(String(asg.bookingId));
      const aiDiagnosis = bk?.technicianAssistant || null;
      const unitInfo = bk?.unitInfo || null;
      const issueDescription = bk?.issueDescription || null;

      result.push({
        assignmentId: asg._id,
        bookingId: asg.bookingId,
        serviceType: asg.serviceType,
        serviceName: asg.serviceName,
        customerName: asg.customerName,
        startTime: asg.startTime,
        endTime: asg.endTime,
        address: asg.address,
        bookingDate: asg.bookingDate,
        status: asg.status,
        preparationStatus,
        preparationIssue: asg.preparationIssue || null,
        equipment: {
          reserved: allReserved.map(e => ({ name: e.equipmentName, quantity: e.quantity })),
          checkedOut: [
            ...allCheckedOut.map(e => ({ name: e.equipmentName, quantity: e.quantity })),
            ...kitEquipment.map(k => ({ name: k.name, quantity: k.quantity, fromKit: true })),
          ],
          consumables: kitConsumables.map(k => ({ name: k.name, quantity: k.quantity, fromKit: true })),
        },
        repairParts: {
          reserved: partsReserved.map(p => ({ name: p.itemName, quantity: p.quantity })),
          checkedOut: partsCheckedOut.map(p => ({ name: p.itemName, quantity: p.quantity })),
        },
        // AI diagnosis & parts info for briefing
        aiDiagnosis: aiDiagnosis ? {
          summary: aiDiagnosis.summary || null,
          probableCauses: aiDiagnosis.probableCauses || [],
          suggestedTools: aiDiagnosis.suggestedTools || [],
          possibleParts: aiDiagnosis.possibleParts || [],
          safetyReminders: aiDiagnosis.safetyReminders || [],
          estimatedDurationMinutes: aiDiagnosis.estimatedDurationMinutes || null,
          repairComplexity: aiDiagnosis.repairComplexity || null,
        } : null,
        unitInfo,
        issueDescription,
      });
    }

    // Aggregate all needed resources across all jobs for the "Prepare Next Jobs" summary
    const equipmentSummary = {};
    const consumableSummary = {};
    const partsSummary = {};

    for (const job of result) {
      for (const eq of job.equipment.reserved) {
        const key = eq.name;
        if (!equipmentSummary[key]) equipmentSummary[key] = { name: eq.name, totalQuantity: 0, jobs: [] };
        equipmentSummary[key].totalQuantity += eq.quantity;
        equipmentSummary[key].jobs.push(job.customerName || job.serviceName);
      }
      // Note: consumables are also in equipment but with consumable flag
      // We'll separate them client-side since we don't have the consumable flag here
      for (const pt of job.repairParts.reserved) {
        if (!partsSummary[pt.name]) partsSummary[pt.name] = { name: pt.name, totalQuantity: 0, jobs: [] };
        partsSummary[pt.name].totalQuantity += pt.quantity;
        partsSummary[pt.name].jobs.push(job.customerName || job.serviceName);
      }
    }

    return res.json({
      success: true,
      jobs: result,
      preparationSummary: {
        equipment: Object.values(equipmentSummary),
        parts: Object.values(partsSummary),
      },
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/assignments/checkout-batch
 * Batch checkout: transitions all reserved EquipmentAssignments and StockReservations
 * for the given assignment IDs from 'reserved' to 'checked_out'.
 * Body: { assignmentIds: [String] }
 */
router.post('/assignments/checkout-batch', async (req, res, next) => {
  try {
    const Assignment = require('../models/Assignment');
    const EquipmentAssignment = require('../models/EquipmentAssignment');
    const StockReservation = require('../models/StockReservation');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician record not found' });

    const { assignmentIds } = req.body;
    if (!Array.isArray(assignmentIds) || !assignmentIds.length) {
      return res.status(400).json({ error: 'Provide an array of assignment IDs to check out.' });
    }

    const results = [];
    for (const asgId of assignmentIds) {
      if (!mongoose.Types.ObjectId.isValid(asgId)) continue;
      const assignment = await Assignment.findOne({ _id: asgId, technicianId: tech._id });
      if (!assignment) continue;

      // Checkout equipment
      const reserved = await EquipmentAssignment.find({ bookingId: assignment.bookingId, status: 'reserved' });
      const checkedOut = [];
      for (const eq of reserved) {
        const tool = await Tool.findById(eq.equipmentId);
        if (!tool) continue;
        if (Tool.effectiveInventoryClass(tool) !== 'operational_asset' || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)) continue;
        if (tool.quantity < eq.quantity) continue;

        tool.quantity -= eq.quantity;
        tool.reservedQuantity = Math.max(0, (tool.reservedQuantity || 0) - eq.quantity);
        if (!eq.consumable) {
          tool.checkedOutQuantity = (tool.checkedOutQuantity || 0) + eq.quantity;
          tool.assetStatus = 'checked_out';
        }
        await tool.save();

        eq.status = eq.consumable ? 'consumed' : 'checked_out';
        eq.checkedOutAt = new Date();
        eq.checkedOutBy = req.user._id;
        await eq.save();
        checkedOut.push({ name: eq.equipmentName, quantity: eq.quantity, kind: eq.consumable ? 'consumable' : 'equipment' });
      }

      // Checkout repair parts (StockReservations)
      const reservedParts = await StockReservation.find({ bookingId: assignment.bookingId, status: 'reserved' });
      const checkedOutParts = [];
      for (const sr of reservedParts) {
        const tool = await Tool.findById(sr.toolId);
        if (tool) {
          tool.reservedQuantity = Math.max(0, (tool.reservedQuantity || 0) - sr.quantity);
          await tool.save();
        }
        sr.status = 'checked_out';
        sr.fulfilledAt = new Date();
        await sr.save();
        checkedOutParts.push({ name: sr.itemName, quantity: sr.quantity });
      }

      // Update assignment
      assignment.equipmentCheckedOut = true;
      assignment.equipmentCheckedOutAt = new Date();
      assignment.preparationStatus = 'checked_out';
      assignment.notes.push({
        text: `Batch checkout: ${checkedOut.length} equipment, ${checkedOutParts.length} parts`,
        by: req.user._id, byName: tech.name, createdAt: new Date(),
      });
      await assignment.save();

      results.push({
        assignmentId: asg._id,
        bookingId: assignment.bookingId,
        checkedOut,
        checkedOutParts,
      });
    }

    return res.json({ success: true, results });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/assignments/:id/checkout
 * Technician confirms receipt of all assigned reserved equipment.
 */
router.post("/assignments/:id/checkout", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const reserved = await EquipmentAssignment.find({ bookingId: assignment.bookingId, status: "reserved" });
    const checkedOut = [];
    const skipped = [];
    for (const eq of reserved) {
      const tool = await Tool.findById(eq.equipmentId);
      if (!tool) { skipped.push({ id: eq._id, name: eq.equipmentName, reason: "Tool not found" }); continue; }
      if (Tool.effectiveInventoryClass(tool) !== 'operational_asset' || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)) {
        skipped.push({ id: eq._id, name: eq.equipmentName, reason: "Not an assignable operational asset" }); continue;
      }
      if (tool.quantity < eq.quantity) { skipped.push({ id: eq._id, name: eq.equipmentName, reason: "Insufficient stock" }); continue; }
      tool.quantity -= eq.quantity;
      tool.reservedQuantity = Math.max(0, (tool.reservedQuantity || 0) - eq.quantity);
      if (!eq.consumable) {
        tool.checkedOutQuantity = (tool.checkedOutQuantity || 0) + eq.quantity;
        tool.assetStatus = 'checked_out';
      }
      await tool.save();
      eq.status = eq.consumable ? "consumed" : "checked_out";
      eq.checkedOutAt = new Date();
      eq.checkedOutBy = req.user._id;
      await eq.save();
      checkedOut.push({ id: eq._id, name: eq.equipmentName, qty: eq.quantity });
    }

    if (!reserved.length || checkedOut.length > 0) {
      assignment.equipmentCheckedOut = true;
      assignment.equipmentCheckedOutAt = new Date();
      assignment.notes.push({
        text: `Checked out ${checkedOut.length} equipment item(s)`,
        by: req.user._id,
        byName: tech.name,
        createdAt: new Date(),
      });
      await assignment.save();
    }

    return res.json({ message: "Equipment checked out.", checkedOut, skipped, assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/return
 * Technician confirms return of all assigned equipment.
 */
router.post("/assignments/:id/return", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const inUse = await EquipmentAssignment.find({ bookingId: assignment.bookingId, status: { $in: ["checked_out", "in_use"] } });
    const returned = [];
    for (const eq of inUse) {
      if (eq.consumable) continue; // consumables are not returned
      const tool = await Tool.findById(eq.equipmentId);
      if (tool) {
        tool.quantity += eq.quantity;
        tool.checkedOutQuantity = Math.max(0, (tool.checkedOutQuantity || 0) - eq.quantity);
        tool.assetStatus = tool.checkedOutQuantity > 0 ? 'checked_out' : 'available';
        await tool.save();
      }
      eq.status = "returned";
      eq.returnedAt = new Date();
      await eq.save();
      returned.push({ id: eq._id, name: eq.equipmentName, qty: eq.quantity });
    }

    assignment.equipmentReturned = true;
    assignment.equipmentReturnedAt = new Date();
    assignment.notes.push({
      text: `Returned ${returned.length} equipment item(s)`,
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    return res.json({ message: "Equipment returned.", returned, assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/decline
 * Body: { reason?: string }
 * Technician declines a pending assignment.
 */
router.post("/assignments/:id/decline", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (assignment.status !== "pending_acceptance") {
      return res.status(400).json({ error: "Assignment is not pending acceptance." });
    }

    const reason = String(req.body.reason || "").trim().slice(0, 500);
    assignment.status = "declined";
    assignment.declinedAt = new Date();
    assignment.declineReason = reason;
    assignment.notes.push({
      text: `Assignment declined${reason ? ": " + reason : ""}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const BookingService = require("../models/BookingService");
    const bookingBeforeDecline = await BookingService.findById(assignment.bookingId).lean();
    const newCount = (bookingBeforeDecline?.reassignmentCount || 0) + 1;
    await BookingService.findByIdAndUpdate(assignment.bookingId, {
      $set: {
        status: "pending_reassignment",
        technicianId: null,
        assignmentId: null,
        notes: `[Technician Declined] ${tech.name} declined: ${reason || "No reason provided"}`,
        ...(newCount >= 3 ? { escalated: true } : {}),
      },
      $inc: { reassignmentCount: 1 },
      $push: {
        cancellationHistory: {
          technicianId: tech._id,
          technicianName: tech.name,
          action: "declined",
          reason: reason || "No reason provided",
          timestamp: new Date(),
        },
      },
    });

    // ── Cleanup: Release reserved equipment for this booking ─────────────
    try {
      const EquipmentAssignment = require("../models/EquipmentAssignment");
      const Tool = require("../models/Tool");
      const reserved = await EquipmentAssignment.find({
        bookingId: assignment.bookingId,
        status: "reserved",
      }).lean();
      if (reserved.length) {
        for (const eq of reserved) {
          if (eq.equipmentId) {
            await Tool.findByIdAndUpdate(eq.equipmentId, { $inc: { reservedQuantity: -(eq.quantity || 1) } }).catch(() => {});
          }
        }
        await EquipmentAssignment.deleteMany({
          bookingId: assignment.bookingId,
          status: "reserved",
        });
      }
    } catch (eqErr) {
      console.warn("Equipment cleanup on decline skipped:", eqErr.message);
    }

    // ── Socket: Notify Admins ────────────────────────────────────────────
    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("assignment:declined", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        reason: reason || "No reason provided",
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
      });
    }

    // Create notification for admins
    const { createNotification } = require('../utils/notify');
    await createNotification({
      type: 'assignment_declined',
      title: 'Assignment Declined',
      message: `${tech.name} declined the assignment for ${assignment.serviceName || 'a service'}. ${reason ? 'Reason: ' + reason : ''}`,
      role: 'admin',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/admin/appointments/queue',
      priority: 'high',
      io,
    });

    // ── Email: Notify Admins of Decline ──────────────────────────────────
    try {
      const User = require("../models/User");
      const BookingServiceForEmail = require("../models/BookingService");
      const { sendTechnicianDeclinedEmail } = require("../utils/mailer");
      const adminUser = await User.findOne({ role: "admin" }).lean();
      const adminEmail = adminUser?.email;
      const bookingForEmail = await BookingServiceForEmail.findById(assignment.bookingId).lean();
      if (adminEmail && bookingForEmail) {
        const dateLabel = assignment.bookingDate
          ? new Date(assignment.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        sendTechnicianDeclinedEmail({
          to: adminEmail,
          adminName: adminUser.name || "Admin",
          technicianName: tech.name,
          bookingReference: bookingForEmail.bookingReference || `#${String(bookingForEmail._id).slice(-6).toUpperCase()}`,
          serviceName: assignment.serviceName || "Service",
          customerName: assignment.customerName || "Customer",
          dateLabel,
          timeLabel: assignment.startTime || "TBD",
          reason: reason || "",
        }).catch((err) => console.error("[MAILER] Failed to send decline email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Decline email error:", mailErr.message);
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.decline",
      module: "technician",
      req,
      details: { assignmentId: id, reason },
    }).catch(() => { });

    // ── Sync Project teamStatus (if this assignment belongs to a project) ────
    try {
      const Project = require("../models/Project");
      const project = await Project.findOne({
        "assignedTechnicians._id": tech._id,
      });
      if (project) {
        const ts = project.teamStatus || [];
        let entry = ts.find((t) => t._id && t._id.toString() === tech._id.toString());
        if (!entry) {
          entry = { _id: tech._id, name: tech.name, status: "declined", declinedReason: reason || "" };
          ts.push(entry);
        } else {
          entry.status = "declined";
          entry.declinedReason = reason || "";
          entry.acknowledgedAt = undefined;
        }
        project.teamStatus = ts;
        await project.save();

        const ioProject = req.app.get("io");
        if (ioProject) {
          ioProject.to("admin-room").emit("project:team-status", {
            projectId: project._id,
            teamStatus: project.teamStatus,
            techName: tech.name,
            action: "declined",
          });
        }
      }
    } catch (projErr) {
      console.warn("Project teamStatus sync skipped:", projErr.message);
    }

    return res.json({ message: "Assignment declined.", assignment });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1D. MARK AS NO-SHOW
// ============================================================================
router.post("/assignments/:id/no-show", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    return res.status(409).json({
      error: "Start the customer-not-available wait flow and submit the no-show report with arrival evidence.",
      code: "NO_SHOW_EVIDENCE_REQUIRED",
    });

    const id = req.params.id;
    const tech = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found." });
    const assignment = await Assignment.findOne({ _id: id, technicianId: { $in: [tech._id, req.user._id] } });
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (!["on_site", "no_show"].includes(assignment.status)) {
      return res.status(400).json({ error: "Can only mark no-show if currently arrived/on-site." });
    }

    // Legacy compatibility endpoint: a technician report must remain pending
    // until an admin confirms or reschedules it in the Resolution Center.
    const now = new Date();

    // The technician only reports the incident. Customer reschedule access is
    // created later, and only if an admin explicitly allows it.
    assignment.status = "no_show_reported";
    assignment.noShowReportedAt = now;
    if (!assignment.notes) assignment.notes = [];
    assignment.notes.push({
      text: "Technician reported customer as No-Show. Pending admin review.",
      by: req.user._id,
      byName: req.user.name || "Technician",
      createdAt: now
    });
    await assignment.save();
    await releaseTechnicianAfterNoShow(tech._id);

    // Update BookingService
    const booking = await BookingService.findById(assignment.bookingId);
    if (booking) {
      const prevStatus = booking.status;
      await BookingService.findByIdAndUpdate(booking._id, {
        $set: {
          status: "no-show-reported",
          noShowRescheduleStatus: "pending",
          noShowAt: now,
          "noShowReport.reportedAt": now,
          "noShowReport.reportedBy": req.user._id,
          "noShowReport.reportedByName": req.user.name || "Technician",
          "noShowReport.contactAttempts": assignment.contactAttempts || [],
          "noShowReport.arrivalProofUrl": assignment.arrivalProofUrl || "",
          "noShowReport.arrivalProofCapturedAt": assignment.arrivalProofCapturedAt || null,
          "noShowReport.arrivedAt": assignment.arrivedAt || now,
          "noShowReport.waitedMinutes": assignment.arrivedAt ? Math.max(0, Math.round((now - assignment.arrivedAt) / 60000)) : 0,
          "noShowReport.reviewStatus": "pending",
          "noShowReport.customerNotified": false,
        },
        $unset: {
          noShowRescheduleToken: 1,
          noShowRescheduleExpiry: 1,
          rescheduleAccessToken: 1,
          rescheduleAccessExpiry: 1,
          rescheduleAccessStatus: 1,
        },
        $push: {
          statusHistory: {
            fromStatus: prevStatus,
            toStatus: "no-show-reported",
            reason: "Customer reported as No-Show by technician. Pending admin review.",
            timestamp: now,
            changedByName: req.user.name || "Technician",
            changedByModel: "User",
          },
        },
      });

      // Notify admin in real-time
      const { createNotification } = require("../utils/notify");
      const bookingRef = booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`;
      await createNotification({
        role: "admin",
        type: "booking_no_show",
        title: "Customer No-Show",
        message: `${req.user.name || "Technician"} reported no-show for ${bookingRef} — ${assignment.serviceName}. Admin review is required.`,
        referenceId: booking._id,
        referenceModel: "BookingService",
        link: "/admin/appointments/attention?issue=no_show",
        priority: "high",
        io: req.app.get("io"),
      }).catch(() => {});

    }

    res.json({ message: "No-show reported. Pending admin review." });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1D. CUSTOMER NOT AVAILABLE (waiting-for-customer → no-show-reported)
// ============================================================================
/** Helper: configured no-show waiting window (minutes) */
async function getNoShowWaitMinutes() {
  try {
    const SiteSetting = require("../models/SiteSetting");
    const doc = await SiteSetting.findOne({ key: "noShowWaitMinutes" }).lean();
    const mins = Number(doc?.value ?? 15);
    return Number.isFinite(mins) && mins > 0 ? mins : 15;
  } catch (_) {
    return 15;
  }
}

async function releaseTechnicianAfterNoShow(technicianId) {
  try {
    // Clear the visit-level busy state first, then let attendance/leave decide
    // whether the technician should be Available or Offline.
    await Technician.findByIdAndUpdate(technicianId, { $set: { availabilityStatus: "Available" } });
    const technician = await Technician.findById(technicianId);
    if (technician) {
      const { resolveAvailabilityStatus } = require("../utils/availability");
      await resolveAvailabilityStatus(technician, null, null, { syncDb: true });
    }
  } catch (err) {
    console.warn("[NO-SHOW] Could not refresh technician availability:", err.message);
  }
}

/**
 * POST /api/technician/assignments/:id/customer-not-available
 * Body: { contactAttempts: string[], arrivalProofUrl?: string }
 * Tech has arrived but customer is not present. Starts the waiting window.
 */
router.post("/assignments/:id/customer-not-available", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { createNotification } = require("../utils/notify");

    const id = req.params.id;
    const { contactAttempts = [], arrivalProofUrl = "" } = req.body || {};

    const attempts = Array.isArray(contactAttempts)
      ? contactAttempts.map((a) => String(a).trim()).filter(Boolean)
      : [];
    if (!attempts.length) {
      return res.status(400).json({ error: "Select at least one contact attempt (Call, SMS, or In-app notification)." });
    }
    if (!String(arrivalProofUrl || "").startsWith("data:image/")) {
      return res.status(400).json({ error: "A proof-of-arrival photo is required before reporting a no-show." });
    }

    const tech = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found." });
    const assignment = await Assignment.findOne({ _id: id, technicianId: { $in: [tech._id, req.user._id] } });
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });
    if (assignment.status !== "on_site") {
      return res.status(400).json({ error: "Can only mark customer as unavailable after arriving on site." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const waitMinutes = await getNoShowWaitMinutes();
    const now = new Date();
    const arrivedAt = assignment.arrivedAt || now;
    const waitingUntil = new Date(arrivedAt.getTime() + waitMinutes * 60 * 1000);

    // Update Assignment
    assignment.status = "waiting_for_customer";
    assignment.waitingForCustomerAt = now;
    assignment.contactAttempts = attempts;
    assignment.arrivalProofUrl = String(arrivalProofUrl || "").trim();
    assignment.arrivalProofCapturedAt = now;
    assignment.notes.push({
      text: `Customer not available. Waiting until ${waitingUntil.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}. Contact attempts: ${attempts.join(", ")}.`,
      by: req.user._id,
      byName: req.user.name || "Technician",
      createdAt: now,
    });
    await assignment.save();

    // Update BookingService
    if (booking) {
      const prevStatus = booking.status;
      await BookingService.findByIdAndUpdate(booking._id, {
        $set: {
          status: "waiting-for-customer",
          noShowReport: {
            reportedAt: null,
            reportedBy: req.user._id,
            reportedByName: req.user.name || "Technician",
            contactAttempts: attempts,
            arrivalProofUrl: String(arrivalProofUrl || "").trim(),
            arrivalProofCapturedAt: now,
            arrivedAt,
            waitedMinutes: 0,
            waitingUntil,
            reviewStatus: "pending",
            customerNotified: false,
          },
        },
        $push: {
          statusHistory: {
            fromStatus: prevStatus,
            toStatus: "waiting-for-customer",
            reason: `Customer not available. Waiting ${waitMinutes} min. Attempts: ${attempts.join(", ")}.`,
            timestamp: now,
            changedByName: req.user.name || "Technician",
            changedByModel: "User",
          },
        },
      });

      // Notify admin
      const bookingRef = booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`;
      await createNotification({
        role: "admin",
        type: "booking_waiting_customer",
        title: "Waiting for Customer",
        message: `${req.user.name || "Technician"} is at the site for ${bookingRef} — customer not available. Will report no-show after ${waitMinutes} min (${waitingUntil.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}).`,
        referenceId: booking._id,
        referenceModel: "BookingService",
        link: "/admin/appointments",
        priority: "normal",
        io: req.app.get("io"),
      }).catch(() => {});
    }

    res.json({
      message: `Customer not available. Waiting until ${waitingUntil.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}.`,
      waitingUntil,
      waitMinutes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/report-no-show
 * After the waiting window has elapsed, the technician reports the no-show.
 * Booking moves to no-show-reported; admin reviews and confirms.
 */
router.post("/assignments/:id/report-no-show", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { createNotification } = require("../utils/notify");

    const id = req.params.id;
    const tech = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found." });
    const assignment = await Assignment.findOne({ _id: id, technicianId: { $in: [tech._id, req.user._id] } });
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (!["waiting_for_customer", "no_show_reported"].includes(assignment.status)) {
      return res.status(400).json({ error: "Customer must be marked unavailable and the waiting window started first." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const waitingUntil = booking.noShowReport?.waitingUntil
      ? new Date(booking.noShowReport.waitingUntil)
      : null;
    const now = new Date();
    if (waitingUntil && now < waitingUntil) {
      const minsLeft = Math.ceil((waitingUntil - now) / 60000);
      return res.status(409).json({
        error: `Please wait until the waiting period ends (${minsLeft} min remaining).`,
        code: "WAITING_PERIOD_NOT_ELAPSED",
        waitingUntil,
      });
    }

    const waitedMinutes = booking.noShowReport?.arrivedAt
      ? Math.max(0, Math.round((now - new Date(booking.noShowReport.arrivedAt)) / 60000))
      : Math.max(0, Math.round(((now - (assignment.arrivedAt || now)) / 60000)));

    // The technician records evidence and reports the incident. Reschedule
    // access remains locked until the Resolution Center decision.
    assignment.status = "no_show_reported";
    assignment.noShowReportedAt = now;
    assignment.notes.push({
      text: `No-show reported after waiting ${waitedMinutes} min. Pending admin review.`,
      by: req.user._id,
      byName: req.user.name || "Technician",
      createdAt: now,
    });
    await assignment.save();
    await releaseTechnicianAfterNoShow(tech._id);

    // Update BookingService
    const prevStatus = booking.status;
    await BookingService.findByIdAndUpdate(booking._id, {
      $set: {
        status: "no-show-reported",
        noShowRescheduleStatus: "pending",
        "noShowReport.reportedAt": now,
        "noShowReport.reportedBy": req.user._id,
        "noShowReport.reportedByName": req.user.name || "Technician",
        "noShowReport.waitedMinutes": waitedMinutes,
        "noShowReport.reviewStatus": "pending",
        "noShowReport.customerNotified": false,
      },
      $unset: {
        noShowRescheduleToken: 1,
        noShowRescheduleExpiry: 1,
        rescheduleAccessToken: 1,
        rescheduleAccessExpiry: 1,
        rescheduleAccessStatus: 1,
      },
      $push: {
        statusHistory: {
          fromStatus: prevStatus,
          toStatus: "no-show-reported",
          reason: `No-show reported by technician after waiting ${waitedMinutes} min. Pending admin review.`,
          timestamp: now,
          changedByName: req.user.name || "Technician",
          changedByModel: "User",
        },
      },
    });

    // 4. Notify admin (high priority — No-Show Review)
    const bookingRef = booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`;
    await createNotification({
      role: "admin",
      type: "booking_no_show_report",
      title: "No-Show Review Needed",
      message: `${req.user.name || "Technician"} reported a no-show for ${bookingRef} (${assignment.serviceName}). Waited ${waitedMinutes} min. Review and confirm or reschedule.`,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/attention?issue=no_show",
      priority: "high",
      io: req.app.get("io"),
    }).catch(() => {});

    res.json({
      message: "No-show reported. Pending admin review.",
      waitedMinutes,
      noShowRescheduleStatus: "pending",
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1E. TECHNICIAN-INITIATED NO-SHOW RESCHEDULE
// ============================================================================
router.post("/assignments/:id/no-show-reschedule", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    return res.status(409).json({
      error: "No-show rescheduling requires an admin decision in the Booking Resolution Center.",
      code: "NO_SHOW_ADMIN_DECISION_REQUIRED",
    });
    const { newDate, newTime } = req.body;

    if (!newDate || !newTime) {
      return res.status(400).json({ error: "newDate and newTime are required." });
    }

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (assignment.status !== "no_show") {
      return res.status(400).json({ error: "Can only reschedule no-show assignments." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    // Conflict check
    const hasConflict = await BookingService.findOne({
      _id: { $ne: booking._id },
      bookingDate: new Date(newDate),
      startTime: newTime,
      status: { $in: ["confirmed", "scheduled", "in-progress", "en-route", "on-the-way", "re-scheduled"] },
    });
    if (hasConflict) {
      return res.status(409).json({ error: "That time slot is already booked. Please choose another." });
    }

    // Update booking
    const prevRescheduleStatus = booking.status;
    await BookingService.findByIdAndUpdate(booking._id, {
      $set: {
        bookingDate: new Date(newDate),
        startTime: newTime,
        selectedTimeLabel: newTime,
        status: "re-scheduled",
        noShowRescheduleStatus: "rescheduled",
        noShowRescheduleToken: undefined,
      },
      $push: {
        statusHistory: {
          fromStatus: prevRescheduleStatus,
          toStatus: "re-scheduled",
          reason: `Rescheduled by technician from No-Show to ${newDate} at ${newTime}`,
          timestamp: new Date(),
          changedByName: req.user.name || "Technician",
          changedByModel: "User",
        },
      },
    });

    // Create new assignment in pending_acceptance
    await Assignment.create({
      bookingId: booking._id,
      customerName: booking.customer?.name || "Customer",
      serviceName: booking.serviceName || "Service",
      serviceType: booking.serviceType || "core",
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      status: "pending_acceptance",
    });

    res.json({ ok: true, message: "Booking rescheduled successfully." });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1F. TECHNICIAN-INITIATED NO-SHOW CANCEL
// ============================================================================
router.post("/assignments/:id/no-show-cancel", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    return res.status(409).json({
      error: "No-show cancellation requires an admin decision in the Booking Resolution Center.",
      code: "NO_SHOW_ADMIN_DECISION_REQUIRED",
    });

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (assignment.status !== "no_show") {
      return res.status(400).json({ error: "Can only cancel no-show assignments." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const prevCancelStatus = booking.status;
    await BookingService.findByIdAndUpdate(booking._id, {
      $set: {
        status: "cancelled",
        cancellationReason: "Cancelled by technician after No-Show.",
        noShowRescheduleStatus: "cancelled",
        noShowRescheduleToken: undefined,
      },
      $push: {
        statusHistory: {
          fromStatus: prevCancelStatus,
          toStatus: "cancelled",
          reason: "Booking cancelled by technician after No-Show.",
          timestamp: new Date(),
          changedByName: req.user.name || "Technician",
          changedByModel: "User",
        },
      },
    });

    res.json({ ok: true, message: "Booking cancelled." });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/mark-delayed
 * Technician manually flags the current job as delayed. Cascades to later
 * same-technician bookings on the same day: those are flagged and their
 * customers are NOTIFIED (notify-only — no auto-reschedule).
 * Body: { reason?: string }
 */
router.post("/assignments/:id/mark-delayed", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const { markJobDelayed } = require("../utils/delayNotifier");
    const affected = await markJobDelayed(booking._id, {
      reason: reason || "Technician marked the previous job as delayed.",
      io: req.app.get("io"),
      byTechId: tech._id,
    });

    res.json({
      ok: true,
      message: `Marked delayed. ${affected.length} later appointment(s) notified.`,
      affectedCount: affected.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/technician/assignments/:id/status
 * Body: { status: "en_route" | "on_site" | "in_progress" | "completed" }
 * Transitions assignment status forward in the pipeline.
 */
router.patch("/assignments/:id/status", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const Technician = require("../models/Technician");
    const mongoose = require("mongoose");
    const audit = require("../utils/audit");

    const { id } = req.params;
    const { status: newStatus, startProofUrl, startProofNotes, arrivalProofUrl } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const validTransitions = {
      accepted: ["en_route", "cancelled"],
      en_route: ["on_site", "cancelled"],
      on_site: ["in_progress", "cancelled"],
      in_progress: ["completed"],
    };

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (newStatus === "no_show") {
      return res.status(409).json({
        error: "Use Customer Not Available to record arrival proof and complete the waiting period before reporting a no-show.",
        code: "NO_SHOW_REVIEW_REQUIRED",
        assignmentId: assignment._id,
      });
    }

    const allowed = validTransitions[assignment.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from "${assignment.status}" to "${newStatus}". Allowed: ${allowed ? allowed.join(", ") : "none"}`,
      });
    }
    // Missed-schedule guard: a job whose service window elapsed without being
    // started can no longer be started — it must be rescheduled by an admin.
    if (newStatus === "en_route" && assertNotMissedSchedule(assignment)) {
      return res.status(409).json({
        error: "The scheduled time for this job has passed. It cannot be started — please wait for the administrator to reschedule it.",
        code: "SCHEDULE_MISSED",
      });
    }
    if (newStatus === "completed") {
      return res.status(409).json({
        error: "Submit proof of completion to complete this assignment.",
        code: "COMPLETION_PROOF_REQUIRED",
      });
    }
    if (newStatus === "on_site" && !String(arrivalProofUrl || "").startsWith("data:image/")) {
      return res.status(400).json({ error: "A proof-of-arrival photo is required." });
    }
    if (newStatus === 'en_route' && assignment.serviceType !== 'repair' && assignment.serviceType !== 'project') {
      const DailyKit = require('../models/DailyKit');
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const dailyKit = await DailyKit.findOne({ technicianId: tech._id, workDate: todayStart }).lean();
      if (!dailyKit || !['confirmed', 'in_progress'].includes(dailyKit.status)) {
        return res.status(409).json({ error: 'Complete your Daily Preparation before going En Route.', code: 'DAILY_KIT_REQUIRED' });
      }
      // Late-accepted booking gate: every new requirement introduced after the
      // kit was prepared must have a field decision (add / not needed /
      // alternative / reported) before the technician travels.
      if (dailyKit.hasDelta && Array.isArray(dailyKit.deltaItems) && dailyKit.deltaItems.length) {
        const undecided = dailyKit.deltaItems.filter(i => !i.resolution?.status);
        if (undecided.length) {
          return res.status(409).json({
            error: `New items were added to your Daily Kit (${undecided.map(i => i.name).join(', ')}). Review them in Daily Preparation before going En Route.`,
            code: 'DAILY_KIT_DELTA_REQUIRED',
            items: undecided.map(i => ({ name: i.name, category: i.category, quantity: i.quantity })),
          });
        }
      }
    }
    if (newStatus === "in_progress" && !String(startProofUrl || "").startsWith("data:image/")) {
      return res.status(400).json({ error: "A starting-work proof photo is required." });
    }

    // -- En Route Time Guard (TEMPORARILY DISABLED) ---------------------
    // if (newStatus === "en_route" && assignment.bookingDate) {
    //   const bookingDateObj = new Date(assignment.bookingDate);
    //   const bookingDateMidnight = new Date(bookingDateObj.getFullYear(), bookingDateObj.getMonth(), bookingDateObj.getDate(), 0, 0, 0, 0);
    //   const nowLocal = new Date();
    //   const todayMidnight = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), 0, 0, 0, 0);
    //   if (bookingDateMidnight > todayMidnight) {
    //     const bookingLabel = bookingDateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    //     return res.status(400).json({ error: `...`, code: "TOO_EARLY" });
    //   }
    //   if (bookingDateMidnight.getTime() === todayMidnight.getTime() && assignment.startTime) { ... }
    // }

    const now = new Date();
    assignment.status = newStatus;
    if (newStatus === "on_site") {
      assignment.arrivalProofUrl = String(arrivalProofUrl || "").trim();
      assignment.arrivalProofCapturedAt = now;
    }
    if (newStatus === "in_progress") {
      assignment.startProofUrl = startProofUrl;
      assignment.startProofNotes = String(startProofNotes || "").trim();
      assignment.startProofCapturedAt = now;
    }

    const statusTimestamps = {
      en_route: "enRouteAt",
      on_site: "arrivedAt",
      in_progress: "startedAt",
      completed: "completedAt",
      cancelled: "cancelledAt",
    };
    if (statusTimestamps[newStatus]) {
      assignment[statusTimestamps[newStatus]] = now;
    }
    if (newStatus === 'completed' && assignment.serviceType !== 'repair' && assignment.serviceType !== 'project') {
      const consumables = await EquipmentAssignment.find({ bookingId: assignment.bookingId, technicianId: tech._id, consumable: true, status: 'reserved' });
      for (const item of consumables) {
        const tool = await Tool.findById(item.equipmentId);
        if (!tool) continue;
        tool.quantity = Math.max(0, Number(tool.quantity || 0) - Number(item.quantity || 0));
        tool.reservedQuantity = Math.max(0, Number(tool.reservedQuantity || 0) - Number(item.quantity || 0));
        await tool.save();
        item.status = 'consumed';
        item.consumableUsed = item.quantity;
        item.checkedOutAt = new Date();
        item.checkedOutBy = req.user._id;
        await item.save();
      }
    }

    assignment.notes.push({
      text: `Status changed to ${newStatus.replace(/_/g, " ")}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: now,
    });
    await assignment.save();

    const availabilityMap = {
      en_route: "On The Way",
      on_site: "In Progress",
      in_progress: "In Progress",
    };
    if (availabilityMap[newStatus]) {
      tech.availabilityStatus = availabilityMap[newStatus];
      await tech.save();
    }

    if (newStatus === "completed" || newStatus === "cancelled") {
      const { resolveAvailabilityStatus } = require("../utils/availability");
      const resolvedStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      tech.availabilityStatus = resolvedStatus;
      await tech.save();
    }

    // -- Sync Booking Status ----------------------------------------------
    const BookingService = require("../models/BookingService");
    const bookingStatusMap = {
      en_route: "on-the-way",
      on_site: "arrived",
      in_progress: "in-progress",
      completed: "completed",
      cancelled: "pending_reassignment",
    };
    if (bookingStatusMap[newStatus]) {
      const isRepair = assignment.serviceType === "repair";
      // For repair services, intermediate technician states (en_route, on_site)
      // should still sync to the booking so the customer sees "On the Way" / "Arrived".
      // The in_progress and completed states are handled by dedicated repair endpoints.
      const skipForRepair = isRepair && (newStatus === "in_progress" || newStatus === "completed");
      if (!skipForRepair) {
        const updateData = { status: bookingStatusMap[newStatus] };
        if (newStatus === "completed") {
          updateData.completedAt = now;
          const configuredWarranty = await configuredBookingWarranty({ serviceType: assignment.serviceType }, now);
          if (configuredWarranty.coverage) updateData.warranty = configuredWarranty.coverage;
        }
        await BookingService.findByIdAndUpdate(assignment.bookingId, updateData);

        try {
          const io = req.app.get("io");
          if (io) {
            const updatedBooking = await BookingService.findById(assignment.bookingId).lean();
            const customerId = updatedBooking?.customerId?._id || updatedBooking?.customerId;
            if (customerId) {
              io.to("customer:" + customerId).emit("booking:status-change", {
                bookingId: assignment.bookingId,
                status: bookingStatusMap[newStatus],
                technicianName: tech.name,
                timestamp: Date.now(),
              });
            }
          }
        } catch (sockErr) {
          console.warn("[socket] booking:status-change emit failed", sockErr?.message);
        }
      }
    }

    if (newStatus === "en_route") {
      try {
        const { sendTechArrivalNotificationEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendTechArrivalNotificationEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send on-the-way email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] On-the-way email error:", mailErr.message);
      }
    }

    if (newStatus === "on_site") {
      try {
        const { sendTechnicianArrivedEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendTechnicianArrivedEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send arrived email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Arrived email error:", mailErr.message);
      }
    }

    if (newStatus === "in_progress") {
      try {
        const { sendWorkStartedEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendWorkStartedEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            serviceType: updatedBookingForEmail.serviceType || updatedBookingForEmail.serviceModel,
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send work started email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Work started email error:", mailErr.message);
      }
    }

    if (newStatus === "completed") {
      // Report creation removed — data already in Assignment/Payment/ServiceToolUsage

      const { createNotification } = require("../utils/notify");
      const io = req.app.get("io");
      const completedBooking = await BookingService.findById(assignment.bookingId).lean();
      await createNotification({
        type: "booking_completed",
        title: "Booking Completed",
        message: `${tech.name} completed ${assignment.serviceName || "a service"} for ${assignment.customerName || "a customer"}.`,
        role: "admin",
        referenceId: assignment.bookingId,
        referenceModel: "BookingService",
        link: "/admin/appointments/completed",
        priority: "normal",
        io,
      });

      try {
        const { sendBookingCompletedEmail } = require("../utils/mailer");
        if (completedBooking?.customer?.email) {
          const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendBookingCompletedEmail({
            to: completedBooking.customer.email,
            customerName: completedBooking.customer.name || "Customer",
            bookingReference: completedBooking.bookingReference || `#${String(completedBooking._id).slice(-6).toUpperCase()}`,
            serviceName: assignment.serviceName || "Service",
            technicianName: techFullName,
            dateLabel,
          }).catch((err) => console.error("[MAILER] Failed to send completion email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Completion email error:", mailErr.message);
      }
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.status." + newStatus,
      module: "technician",
      req,
      details: { assignmentId: id, newStatus },
    }).catch(() => { });

    return res.json({ message: `Status updated to ${newStatus.replace(/_/g, " ")}.`, assignment });
  } catch (err) {
    next(err);
  }
});
/**
 * POST /api/technician/assignments/:id/collect-payment
 * Body: { amount: number, notes?: string }
 * Technician collects the final balance while work is in progress, before the
 * proof-of-completion commit. Payment and completion remain separate events.
 * Only allowed for COD bookings with remaining balance.
 */
router.post("/assignments/:id/collect-payment", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    const { amount, method = "cash", reference, proofUrl, customerSignature, customerPhotoUrl, notes, location } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (!["in_progress", "completed"].includes(assignment.status)) {
      return res.status(400).json({ error: "Payment can only be collected after work has started." });
    }
    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const existingPayments = await Payment.find({ bookingId: booking._id }).lean();
    const { reconcileBookingPayments } = require("../utils/paymentSummary");
    const reconciliation = reconcileBookingPayments(booking, existingPayments);
    const hasTraceableMismatch = reconciliation.hasLedgerMismatch && existingPayments.length > 0;
    if (booking.balanceCollected && !hasTraceableMismatch) {
      return res.json({
        message: "Payment was already recorded. Continue to proof of completion.",
        alreadyCollected: true,
        paymentStatus: booking.paymentStatus,
        balanceAmount: 0,
        balanceCollected: true,
        repairPaymentCollected: booking.repairPaymentCollected,
        repairPaymentAmount: booking.repairPaymentAmount,
        amountPaid: booking.amountPaid,
      });
    }
    const paymentMethod = String(method).toLowerCase();
    if (!["cash", "gcash", "bank"].includes(paymentMethod)) return res.status(400).json({ error: "Invalid payment method." });
    if (paymentMethod === "cash" && !customerSignature && !proofUrl && !customerPhotoUrl) {
      return res.status(400).json({ error: "Cash collection requires a customer signature, receipt photo, or customer confirmation photo." });
    }
    if (["gcash", "bank"].includes(paymentMethod) && (!String(reference || "").trim() || !proofUrl)) {
      return res.status(400).json({ error: "Reference number and receipt screenshot are required." });
    }
    // Prefer the ledger-derived shortage when an older record says "settled"
    // but its traceable transactions do not cover the booking total.
    const storedBalance = Number(booking.balanceAmount);
    const calculatedBalance = Math.max(
      0,
      Number(booking.totalPrice || booking.estimatedFee || 0) - Number(booking.amountPaid || 0),
    );
    const due = hasTraceableMismatch
      ? reconciliation.outstandingFromLedger
      : Math.max(Number.isFinite(storedBalance) ? storedBalance : 0, calculatedBalance);
    if (due <= 0) {
      return res.status(409).json({ error: "This booking has no remaining balance to collect." });
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value - due) > 0.01) {
      return res.status(400).json({
        error: `Final collection must equal the complete remaining balance of ₱${due.toLocaleString()}.`,
        balanceAmount: due,
      });
    }
    const now = new Date();
    const payment = await Payment.create({
      bookingId: booking._id, amount: value, method: paymentMethod, type: due > value ? "downpayment" : "final",
      gateway: paymentMethod === "cash" ? "cod" : paymentMethod, status: "waiting_for_remittance",
      reference: String(reference || "").trim() || undefined, proofUrl: proofUrl || undefined,
      customerSignature: customerSignature || undefined, customerPhotoUrl: customerPhotoUrl || undefined,
      collectedBy: tech._id, collectedByName: tech.name, collectedAt: now,
      collectionLocation: location || undefined, notes,
      events: [
        { status: "payment_collected", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: now, metadata: { method: paymentMethod, reference: reference || null } },
        { status: "waiting_for_remittance", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: now }
      ]
    });
    booking.amountPaid = (hasTraceableMismatch ? reconciliation.ledgerCollected : Number(booking.amountPaid || 0)) + value;
    booking.balanceAmount = Math.max(0, due - value);
    booking.balanceCollected = booking.balanceAmount === 0;
    if (booking.balanceCollected) {
      booking.balanceCollectedAt = now;
      booking.balanceCollectedBy = tech._id;

      // Repair bookings use a dedicated flag in the technician workflow. A
      // final balance collected through the shared assignment endpoint must
      // satisfy that same payment gate or the UI will offer payment twice.
      const isRepairBooking = booking.serviceType === "repair"
        || (booking.services || []).some(service => service.type === "repair");
      if (isRepairBooking && Number(booking.quotation?.totalCost || 0) > 0) {
        booking.repairPaymentCollected = true;
        booking.repairPaymentAmount = Math.min(value, Number(booking.quotation.totalCost));
        booking.repairPaymentMethod = paymentMethod;
        booking.repairPaymentCollectedAt = now;
        booking.repairPaymentCollectedBy = tech._id;
        if (proofUrl) booking.repairPaymentProof = proofUrl;
      }
    }
    booking.paymentStatus = "waiting_for_remittance";
    booking.statusHistory.push({ toStatus: booking.status, changedBy: tech._id, changedByModel: "Technician", changedByName: tech.name, reason: "Payment Collected", notes: `Waiting for Remittance (${paymentMethod})`, timestamp: now, metadata: { paymentId: payment._id, paymentStatus: "waiting_for_remittance" } });
    await booking.save();
    return res.status(201).json({
      message: "Payment recorded. Waiting for admin remittance verification.",
      paymentId: payment._id,
      paymentStatus: booking.paymentStatus,
      balanceAmount: booking.balanceAmount,
      balanceCollected: booking.balanceCollected,
      repairPaymentCollected: booking.repairPaymentCollected,
      repairPaymentAmount: booking.repairPaymentAmount,
      amountPaid: booking.amountPaid,
    });
  } catch (err) { next(err); }
});

router.post("/assignments/:id/collect-payment-legacy", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    const { amount, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Only COD bookings with remaining balance can collect payment
    if (!["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod)) {
      return res.status(400).json({ error: "Payment collection is only available for Cash, Cash on Delivery, or Downpayment bookings." });
    }
    if (booking.balanceCollected) {
      return res.status(400).json({ error: "Balance has already been collected for this booking." });
    }
    const balance = booking.balanceAmount || 0;
    if (balance <= 0) {
      return res.status(400).json({ error: "No remaining balance to collect." });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Please enter a valid payment amount." });
    }

    const now = new Date();

    // Update booking payment
    booking.amountPaid = (booking.amountPaid || 0) + amount;
    booking.balanceAmount = Math.max(0, balance - amount);
    booking.balanceCollected = booking.balanceAmount <= 0;
    if (booking.balanceCollected) {
      booking.balanceCollectedAt = now;
      booking.balanceCollectedBy = tech._id;
      booking.paymentStatus = "paid";
    }
    if (notes) {
      booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[Payment Collected] ₱${amount.toLocaleString()} — ${notes}`;
    }
    await booking.save();

    // Create a Payment record for this collection
    await Payment.create({
      bookingId: booking._id,
      amount: amount,
      method: "cod",
      type: "final",
      gateway: "cod",
      status: "paid",
      reference: notes || `Collected by ${tech.name}`,
      verifiedAt: now,
      completedAt: now,
      notes: `Balance collected by technician ${tech.name}`,
    });

    // Notify admins
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    const collectedAll = booking.balanceCollected;
    await createNotification({
      type: "payment_collected",
      title: collectedAll ? "Full Payment Received" : "Partial Balance Collected",
      message: collectedAll
        ? `${tech.name} collected the remaining balance of ₱${amount.toLocaleString()} for ${booking.bookingReference}. Payment is now complete.`
        : `${tech.name} collected ₱${amount.toLocaleString()} for ${booking.bookingReference}. Remaining balance: ₱${booking.balanceAmount.toLocaleString()}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      priority: collectedAll ? "normal" : "high",
      io,
    });

    console.log(`💰 Payment collected for ${booking.bookingReference}: ₱${amount} (remaining: ₱${booking.balanceAmount})`);
    return res.json({
      message: collectedAll
        ? `Full payment of ₱${booking.amountPaid.toLocaleString()} recorded. Booking fully paid.`
        : `₱${amount.toLocaleString()} collected. Remaining balance: ₱${booking.balanceAmount.toLocaleString()}.`,
      booking: {
        amountPaid: booking.amountPaid,
        balanceAmount: booking.balanceAmount,
        balanceCollected: booking.balanceCollected,
        paymentStatus: booking.paymentStatus,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/cancel
 * Body: { reason: string, customReason?: string }
 * Technician cancels an active assignment. Booking goes back to reassignment queue.
 * Enterprise-level: validates status, notifies eligible techs, emails customer, audits.
 */
router.post("/assignments/:id/cancel", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const cancellableStatuses = ["accepted", "en_route", "on_site"];
    if (!cancellableStatuses.includes(assignment.status)) {
      return res.status(400).json({ error: `Cannot cancel assignment in "${assignment.status}" status. Only accepted, en route, or on site assignments can be cancelled.` });
    }

    const { reason, customReason } = req.body;
    if (!reason) return res.status(400).json({ error: "Cancellation reason is required." });

    const validReasons = ["emergency", "vehicle_breakdown", "personal", "weather", "overlapping_job", "other"];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: "Invalid cancellation reason." });
    }

    const reasonLabels = {
      emergency: "Emergency",
      vehicle_breakdown: "Vehicle Breakdown",
      personal: "Personal Reason",
      weather: "Weather Conditions",
      overlapping_job: "Overlapping Job Conflict",
      other: "Other",
    };
    const cancellationReason = reason === "other"
      ? `Other: ${(customReason || "").trim().slice(0, 500) || "No details provided"}`
      : reasonLabels[reason];

    const now = new Date();
    assignment.status = "cancelled";
    assignment.cancelledAt = now;
    assignment.cancellationReason = cancellationReason;
    assignment.notes.push({
      text: `Assignment cancelled by technician. Reason: ${cancellationReason}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: now,
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const cancelNote = `[Technician Cancelled] ${tech.name} cancelled: ${cancellationReason}`;
    console.log("[CANCEL] Updating booking:", assignment.bookingId, "to status: pending_reassignment");
    const bookingBeforeCancel = await BookingService.findById(assignment.bookingId).lean();
    const newCancelCount = (bookingBeforeCancel?.reassignmentCount || 0) + 1;
    const booking = await BookingService.findByIdAndUpdate(assignment.bookingId, {
      $set: {
        status: "pending_reassignment",
        technicianId: null,
        assignmentId: null,
        cancellationReason: `[Technician Cancelled] ${tech.name}: ${cancellationReason}`,
        notes: cancelNote,
        ...(newCancelCount >= 3 ? { escalated: true } : {}),
      },
      $inc: { reassignmentCount: 1 },
      $push: {
        cancellationHistory: {
          technicianId: tech._id,
          technicianName: tech.name,
          action: "cancelled",
          reason: cancellationReason,
          timestamp: new Date(),
        },
      },
    }, { returnDocument: "after" }).lean();
    console.log("[CANCEL] Booking updated:", booking ? { _id: booking._id, status: booking.status } : "NOT FOUND");

    // ── Resolve Technician Availability ──────────────────────────────────
    const { resolveAvailabilityStatus } = require("../utils/availability");
    const resolvedStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
    tech.availabilityStatus = resolvedStatus;
    await tech.save();

    const io = req.app.get("io");

    // ── Find Eligible Technicians & Push Vacancy Notification ────────────
    try {
      const allTechs = await Technician.find({ active: true, _id: { $ne: tech._id } }).lean();
      const eligibleTechIds = [];

      for (const candidate of allTechs) {
        // Check leave
        const onLeave = await LeaveRequest.findOne({
          technicianId: candidate._id,
          status: "approved",
          startDate: { $lte: booking.bookingDate },
          endDate: { $gte: booking.bookingDate },
        }).lean();
        if (onLeave) continue;

        // Check schedule
        const schedule = await TechnicianSchedule.findOne({ technicianId: candidate._id }).lean();
        if (!schedule) continue;
        const bookingDay = new Date(booking.bookingDate).getDay();
        const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
        if (!isWorkingDay) continue;
        const isRestDate = (schedule.restDates || []).some(rd => {
          const rdDate = new Date(rd).toDateString();
          return rdDate === new Date(booking.bookingDate).toDateString();
        });
        if (isRestDate) continue;

        // Check capacity (< 3 active assignments)
        const activeCount = await Assignment.countDocuments({
          technicianId: candidate._id,
          status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
        });
        if (activeCount >= 3) continue;

        eligibleTechIds.push(String(candidate._id));
      }

      // Push vacancy notification to each eligible technician
      for (const techId of eligibleTechIds) {
        if (io) {
          io.to("tech:" + techId).emit("assignment:vacancy", {
            bookingId: booking._id,
            bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
            serviceName: assignment.serviceName || "Service",
            customerName: assignment.customerName || "Customer",
            bookingDate: booking.bookingDate,
            startTime: assignment.startTime,
            address: assignment.address,
            estimatedFee: assignment.estimatedFee,
            message: `New job available: ${assignment.serviceName || "Service"} for ${assignment.customerName || "Customer"}`,
          });
        }

        // In-app notification for each eligible tech
        const { createNotification } = require("../utils/notify");
        await createNotification({
          type: "assignment_new",
          title: "New Job Available",
          message: `A job was cancelled. Available: ${assignment.serviceName || "Service"} for ${assignment.customerName || "Customer"} on ${assignment.bookingDate ? new Date(assignment.bookingDate).toLocaleDateString("en-PH") : "TBD"}.`,
          role: "technician",
          referenceId: booking._id,
          referenceModel: "BookingService",
          link: "/technician/assignments?tab=available",
          priority: "normal",
          io,
        }).catch(() => { });
      }
    } catch (vacancyErr) {
      console.error("[CANCEL] Vacancy notification error:", vacancyErr.message);
    }

    // ── Notify Admins ────────────────────────────────────────────────────
    if (io) {
      io.to("admin-room").emit("assignment:cancelled", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        reason: cancellationReason,
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
        bookingDate: assignment.bookingDate,
      });
    }

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "booking_cancelled",
      title: "Technician Cancelled Assignment",
      message: `${tech.name} cancelled the assignment for ${assignment.serviceName || "a service"}. Reason: ${cancellationReason}`,
      role: "admin",
      referenceId: assignment._id,
      referenceModel: "Assignment",
      link: "/admin/appointments/attention?issue=technician_issue",
      priority: "high",
      io,
    });

    // ── Email: Notify Customer ───────────────────────────────────────────
    try {
      const { sendTechnicianCancelledEmail } = require("../utils/mailer");
      if (booking?.customer?.email) {
        const dateLabel = booking.bookingDate
          ? new Date(booking.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        const timeLabel = booking.startTime || "TBD";
        sendTechnicianCancelledEmail({
          to: booking.customer.email,
          customerName: booking.customer?.name || "Customer",
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.isMultiService && Array.isArray(booking.services) && booking.services.length > 0 ? booking.services.map(s => s.name).join(', ') : (booking.service?.name || assignment.serviceName || "Service"),
          technicianName: tech.name,
          dateLabel,
          timeLabel,
          reason: cancellationReason,
        }).catch(err => console.error("[MAILER] Failed to send cancellation email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Cancellation email error:", mailErr.message);
    }

    // ── Audit Log ────────────────────────────────────────────────────────
    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.cancel",
      module: "technician",
      req,
      details: {
        assignmentId: id,
        bookingId: assignment.bookingId,
        reason: cancellationReason,
        previousStatus: assignment.status,
      },
    }).catch(() => { });

    return res.json({
      message: "Assignment cancelled. The booking has been returned to the reassignment queue.",
      assignment,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/available-jobs
 * Returns pending_reassignment bookings the technician is eligible to accept.
 * Filters by: schedule, leave, capacity (< 3 active).
 */
router.get("/available-jobs", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Check capacity
    const activeCount = await Assignment.countDocuments({
      technicianId: tech._id,
      status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
    });

    if (activeCount >= 3) {
      return res.json({ items: [], total: 0, reason: "capacity_full" });
    }

    // Check schedule
    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();
    if (!schedule) {
      return res.json({ items: [], total: 0, reason: "no_schedule" });
    }

    // Check leave
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).lean();
    if (activeLeave) {
      return res.json({ items: [], total: 0, reason: "on_leave" });
    }

    // Find bookings in pending_reassignment
    const bookings = await BookingService.find({
      status: "pending_reassignment",
      bookingDate: { $gte: today },
    })
      .sort({ bookingDate: 1 })
      .limit(50)
      .lean();

    // Filter by eligibility (working day, not rest date)
    const eligible = bookings.filter(b => {
      const bookingDay = new Date(b.bookingDate).getDay();
      const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
      if (!isWorkingDay) return false;
      const isRestDate = (schedule.restDates || []).some(rd => {
        return new Date(rd).toDateString() === new Date(b.bookingDate).toDateString();
      });
      if (isRestDate) return false;
      return true;
    });

    const items = eligible.map(b => ({
      _id: b._id,
      bookingReference: b.bookingReference || `#${String(b._id).slice(-6).toUpperCase()}`,
      customerName: b.customer?.name || b.customerName || "Customer",
      serviceName: b.isMultiService && Array.isArray(b.services) && b.services.length > 0 ? b.services.map(s => s.name).join(', ') : (b.service?.name || "Service"),
      bookingDate: b.bookingDate,
      startTime: b.startTime,
      address: b.location?.address || "",
      estimatedFee: b.estimatedFee || b.totalPrice || 0,
      travelFare: b.travelFare || 0,
      priority: b.priority || "normal",
    }));

    return res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/available-jobs/:bookingId/accept
 * Technician accepts a pending_reassignment booking from the available jobs queue.
 */
router.post("/available-jobs/:bookingId/accept", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Re-verify eligibility
    const activeCount = await Assignment.countDocuments({
      technicianId: tech._id,
      status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
    });
    if (activeCount >= 3) {
      return res.status(400).json({ error: "You have reached the maximum active assignments (3)." });
    }

    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();
    if (!schedule) return res.status(400).json({ error: "No schedule configured." });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "pending_reassignment") {
      return res.status(400).json({ error: "This booking is no longer available for acceptance." });
    }

    // Check working day
    const bookingDay = new Date(booking.bookingDate).getDay();
    const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
    if (!isWorkingDay) return res.status(400).json({ error: "This booking date is not a working day for you." });

    // Check rest date
    const isRestDate = (schedule.restDates || []).some(rd => {
      return new Date(rd).toDateString() === new Date(booking.bookingDate).toDateString();
    });
    if (isRestDate) return res.status(400).json({ error: "This date is a rest day for you." });

    // Check leave
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: booking.bookingDate },
      endDate: { $gte: booking.bookingDate },
    }).lean();
    if (activeLeave) return res.status(400).json({ error: "You are on approved leave for this date." });

    const now = new Date();

    // Create assignment
    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: booking.customer?.name || booking.customerName || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      serviceType: booking.service?.type || "",
      serviceName: booking.service?.name || "",
      servicePrice: booking.servicePrice || 0,
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      endTime: booking.endTime,
      address: booking.location?.address || "",
      coordinates: booking.location?.coordinates,
      status: "pending_acceptance",
      priority: "normal",
      slaDeadline: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      estimatedFee: booking.estimatedFee || booking.totalPrice || 0,
      travelFare: booking.travelFare || 0,
      travelTime: booking.travelTime || 0,
      assignedAt: now,
      notes: [{ text: "Assigned from available jobs queue", by: req.user._id, byName: tech.name, createdAt: now }],
    });

    // Update booking
    booking.status = "assigned";
    booking.technicianId = tech._id;
    booking.assignmentId = assignment._id;
    booking.assignedAt = now;
    booking.technician = { name: tech.name, phone: tech.phone, email: tech.email };
    await booking.save();

    // Update technician availability
    tech.availabilityStatus = "Assigned";
    await tech.save();

    const io = req.app.get("io");

    // Notify admins
    if (io) {
      io.to("admin-room").emit("assignment:accepted_from_queue", {
        assignmentId: assignment._id,
        bookingId: booking._id,
        technicianName: tech.name,
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
        bookingDate: assignment.bookingDate,
      });
    }

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "assignment_accepted",
      title: "Job Accepted from Queue",
      message: `${tech.name} accepted the available job for ${assignment.customerName || "a customer"} (${assignment.serviceName || "Service"}).`,
      role: "admin",
      referenceId: assignment._id,
      referenceModel: "Assignment",
      link: "/admin/appointments/active",
      io,
    });

    // Email customer
    try {
      const { sendBookingAcceptedEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        const dateLabel = booking.bookingDate
          ? new Date(booking.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        sendBookingAcceptedEmail({
          to: booking.customer.email,
          customerName: booking.customer.name || "Customer",
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.service?.name || "Service",
          technicianName: tech.name,
          dateLabel,
          timeLabel: booking.startTime || "TBD",
          locationAddress: booking.location?.address || "",
        }).catch(err => console.error("[MAILER] Failed to send acceptance email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Acceptance email error:", mailErr.message);
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.accept_from_queue",
      module: "technician",
      req,
      details: { assignmentId: assignment._id, bookingId: booking._id },
    }).catch(() => { });

    return res.json({ message: "Job accepted successfully.", assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/note
 * Body: { text }
 * Add a note to an assignment.
 */
router.post("/assignments/:id/note", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    const { text } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Note text is required" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    assignment.notes.push({
      text: String(text).trim().slice(0, 1000),
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    return res.json({ message: "Note added.", assignment });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EXPENSES — CRUD
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/expenses/by-booking/:bookingId
 * Returns all expenses linked to a specific booking for this technician.
 */
router.get("/expenses/by-booking/:bookingId", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const expenses = await Expense.find({
      technicianId: tech._id,
      bookingId: bookingId,
    })
      .sort({ expenseDate: -1 })
      .lean();

    const totalAmount = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const approvedTotal = expenses
      .filter(e => e.status === "approved")
      .reduce((sum, e) => sum + (e.amount || 0), 0);
    const pendingTotal = expenses
      .filter(e => e.status === "pending")
      .reduce((sum, e) => sum + (e.amount || 0), 0);

    return res.json({
      expenses,
      summary: { totalAmount, approvedTotal, pendingTotal, count: expenses.length },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/expenses/available-bookings
 * Returns completed assignments the technician can link expenses to.
 * Only completed bookings — expenses should be tied to finished jobs.
 */
router.get("/expenses/available-bookings", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const inspectedRepairStatuses = [
      "inspection_completed", "awaiting_approval", "repair_approved",
      "waiting_parts", "parts_reserved", "ready_for_repair",
      "repair_scheduled", "repair_in_progress"
    ];
    const inspectedBookingIds = await BookingService.find({
      technicianId: tech._id,
      status: { $in: inspectedRepairStatuses },
    }).distinct("_id");
    const assignments = await Assignment.find({
      technicianId: tech._id,
      bookingDate: { $gte: since },
      $or: [
        { status: "completed" },
        { bookingId: { $in: inspectedBookingIds } },
      ],
    })
      .sort({ bookingDate: -1 })
      .limit(100)
      .select("bookingId customerName serviceName bookingDate startTime address status")
      .lean();

    return res.json({ bookings: assignments });
  } catch (err) {
    next(err);
  }
});

router.get("/expenses/available-projects", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const Project = require("../models/Project");
    const projects = await Project.find({ $or: [{ "assignedTechnicians._id": tech._id }, { leadTechnicianId: tech._id }] })
      .select("projectCode title name status customerName").sort({ updatedAt: -1 }).limit(50).lean();
    return res.json({ projects });
  } catch (err) { next(err); }
});

router.post("/expenses/upload-receipt", (req, res) => {
  expenseReceiptUpload(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Receipt must be 5 MB or smaller." : "Invalid receipt file." });
    if (!req.file) return res.status(400).json({ error: "Receipt file is required." });
    return res.json({ url: `/uploads/expense-receipts/${req.file.filename}` });
  });
});

/**
 * GET /api/technician/expenses
 * Query: ?type=fuel|material|...&status=pending|approved|rejected&page=1&limit=20
 */
router.get("/expenses", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { type, status, page = 1, limit = 20, startDate, endDate } = req.query;
    const filter = { technicianId: tech._id };

    if (type) filter.type = type;
    if (status) filter.status = status;
    if (startDate || endDate) {
      filter.expenseDate = {};
      if (startDate) {
        const sd = new Date(startDate);
        sd.setHours(0, 0, 0, 0);
        filter.expenseDate.$gte = sd;
      }
      if (endDate) {
        const ed = new Date(endDate);
        ed.setHours(23, 59, 59, 999);
        filter.expenseDate.$lte = ed;
      }
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      Expense.find(filter)
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(lim)
        .populate("bookingId", "bookingReference customerName service bookingDate startTime")
        .populate("projectId", "projectCode title name status customerName")
        .lean(),
      Expense.countDocuments(filter),
    ]);

    const summary = await Expense.getMonthlySummary(
      tech._id,
      new Date().getFullYear(),
      new Date().getMonth()
    );

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim), summary });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/expenses
 * Body: { type, amount, description, bookingId?, fuelLiters?, pricePerLiter?, odometerReading?, gasStation?, receiptImage?, expenseDate? }
 */
router.post("/expenses", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { type, amount, description, bookingId, projectId, fuelLiters, pricePerLiter, odometerReading, gasStation, receiptImage, expenseDate } = req.body;

    if (!type) return res.status(400).json({ error: "Expense type is required" });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Valid amount is required" });
    if (!description || !String(description).trim()) return res.status(400).json({ error: "Description is required" });

    const expenseData = {
      technicianId: tech._id,
      technicianName: tech.name,
      type,
      amount: Number(amount),
      description: String(description).trim().slice(0, 500),
      expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
    };

    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      const Assignment = require("../models/Assignment");
      const ownAssignment = await Assignment.findOne({
        bookingId: bookingId,
        technicianId: tech._id,
      }).lean();
      if (!ownAssignment) {
        return res.status(403).json({ error: "This booking is not assigned to you." });
      }
      expenseData.bookingId = bookingId;
      if (ownAssignment.bookingDate) expenseData.expenseDate = new Date(ownAssignment.bookingDate);
    }

    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const Project = require("../models/Project");
      const ownProject = await Project.findOne({ _id: projectId, $or: [{ "assignedTechnicians._id": tech._id }, { leadTechnicianId: tech._id }] }).lean();
      if (!ownProject) return res.status(403).json({ error: "This project is not assigned to you." });
      expenseData.projectId = projectId;
    }
    if (fuelLiters) expenseData.fuelLiters = Number(fuelLiters);
    if (pricePerLiter) expenseData.pricePerLiter = Number(pricePerLiter);
    if (odometerReading) expenseData.odometerReading = Number(odometerReading);
    if (gasStation) expenseData.gasStation = String(gasStation).trim();
    if (receiptImage) expenseData.receiptImage = receiptImage;

    const expense = await Expense.create(expenseData);

    // Notify admins of new expense submission
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "expense_submitted",
      title: "Expense Submitted",
      message: `${tech.name} submitted a ${type} expense of ₱${Number(amount).toLocaleString()}.`,
      role: "admin",
      referenceId: expense._id,
      referenceModel: "Expense",
      link: "/admin/appointments/expenses",
      priority: "normal",
      io,
    });

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "expense.create",
      module: "technician",
      req,
      details: { expenseId: expense._id, type, amount },
    }).catch(() => { });

    return res.status(201).json({ message: "Expense recorded.", expense });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/expenses/:id
 * Only allows deleting pending expenses.
 */
router.delete("/expenses/:id", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const expense = await Expense.findOne({ _id: id, technicianId: tech._id });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (expense.status !== "pending") {
      return res.status(400).json({ error: "Only pending expenses can be deleted." });
    }

    await expense.deleteOne();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "expense.delete",
      module: "technician",
      req,
      details: { expenseId: id },
    }).catch(() => { });

    return res.json({ message: "Expense deleted." });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TOOL ASSIGNMENTS — Assigned Tools
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/tools/assigned
 * Returns tools currently assigned to the technician.
 */
router.get("/tools/assigned", async (req, res, next) => {
  try {
    const ToolAssignment = require("../models/ToolAssignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await ToolAssignment.find({
      technicianId: tech._id,
      status: "assigned",
    })
      .sort({ assignedDate: -1 })
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tools/assigned/history
 * Returns all tool assignment history (assigned + returned).
 */
router.get("/tools/assigned/history", async (req, res, next) => {
  try {
    const ToolAssignment = require("../models/ToolAssignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await ToolAssignment.find({ technicianId: tech._id })
      .sort({ assignedDate: -1 })
      .limit(100)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EQUIPMENT USAGE LOG (per-date equipment usage notes)
// ═════════════════════════════════════════════════════════════════════════════

router.get("/equipment-usage", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.json({ items: [] });

    const filter = { technicianId: tech._id };
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to) { const to = new Date(req.query.to); to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
    }

    const items = await EquipmentUsageLog.find(filter)
      .populate("equipmentId", "itemName assetCode category specification")
      .sort({ date: -1, createdAt: -1 })
      .limit(200)
      .lean();

    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

router.post("/equipment-usage", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found." });

    const { equipmentId, date, notes } = req.body;
    if (!equipmentId) return res.status(400).json({ error: "Select an equipment item." });
    if (!date) return res.status(400).json({ error: "Select a date." });

    const equipment = await Tool.findById(equipmentId).lean();
    if (!equipment) return res.status(404).json({ error: "Equipment not found." });

    const logDate = new Date(date);
    logDate.setHours(0, 0, 0, 0);

    const log = await EquipmentUsageLog.create({
      technicianId: tech._id,
      equipmentId: equipment._id,
      equipmentName: equipment.itemName,
      equipmentCode: equipment.assetCode || "",
      date: logDate,
      notes: String(notes || "").trim().slice(0, 500),
      createdBy: req.user._id,
    });

    res.status(201).json({ message: "Equipment usage logged.", item: log });
  } catch (err) { next(err); }
});

router.delete("/equipment-usage/:id", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found." });

    const log = await EquipmentUsageLog.findOneAndDelete({ _id: req.params.id, technicianId: tech._id });
    if (!log) return res.status(404).json({ error: "Log not found." });

    res.json({ message: "Log deleted." });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// LIVE TRACKING — Location Feed
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/tracking/live
 * Returns all active technicians with locations for the live map.
 */
router.get("/tracking/live", async (req, res, next) => {
  try {
    const { resolveAvailabilityBulk } = require("../utils/availability");

    // Fetch all technicians with locations (exclude obviously offline ones at DB level for performance)
    const techs = await Technician.find({
      availabilityStatus: { $nin: ["Offline", "Unavailable"] },
      "location.coordinates": { $exists: true, $ne: null },
    })
      .select("name availabilityStatus location locationText rating")
      .lean();

    // Re-validate with centralized logic to catch stale DB statuses
    const resolvedStatuses = await resolveAvailabilityBulk(techs);

    const validTechs = techs.filter(t => {
      const effectiveStatus = resolvedStatuses.get(String(t._id)) || "Offline";
      return effectiveStatus !== "Offline" && effectiveStatus !== "Unavailable";
    }).map(t => ({
      ...t,
      availabilityStatus: resolvedStatuses.get(String(t._id)) || t.availabilityStatus,
    }));

    return res.json({ technicians: validTechs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tracking/history
 * Returns today's location history for the authenticated technician.
 */
router.get("/tracking/history", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // For now, return current location — full history would need a LocationHistory model
    return res.json({
      current: {
        lat: tech.location?.coordinates?.[1],
        lng: tech.location?.coordinates?.[0],
        text: tech.locationText,
        status: tech.availabilityStatus,
        updatedAt: tech.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/appointments/:id/update-cost
 * Technician updates the cost of a service after diagnosis.
 * Body: { serviceIndex, newCost, diagnosisNotes }
 */
router.post("/appointments/:id/update-cost", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { serviceIndex, newCost, diagnosisNotes } = req.body;

    if (serviceIndex === undefined || newCost === undefined) {
      return res.status(400).json({ error: "serviceIndex and newCost are required" });
    }
    if (!Number.isFinite(Number(newCost)) || Number(newCost) < 0) {
      return res.status(400).json({ error: "newCost must be a non-negative number" });
    }

    const Technician = require("../models/Technician");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Verify technician owns this booking
    if (String(booking.technicianId) !== String(tech._id)) {
      return res.status(403).json({ error: "This booking is not assigned to you" });
    }

    booking.updateServiceCost(serviceIndex, Number(newCost), tech._id, diagnosisNotes || null);
    await booking.save();

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "cost_updated",
      title: "Service cost updated",
      message: `Service "${booking.services?.[serviceIndex]?.name || "Service"}" cost updated to ₱${Number(newCost).toLocaleString()}`,
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

/**
 * GET /api/technician/tracking/customers
 * Returns all accepted/confirmed/in-progress bookings with customer locations for the live map.
 */
router.get("/tracking/customers", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const bookings = await BookingService.find({
      status: { $in: ["confirmed", "on-the-way", "arrived", "in-progress", "scheduled"] },
      "location.lat": { $exists: true, $ne: null },
      "location.lng": { $exists: true, $ne: null },
    })
      .select("customerName customer serviceId service status bookingDate startTime location bookingReference")
      .populate("serviceId", "name title")
      .sort({ bookingDate: -1 })
      .lean();

    const customers = bookings.map(b => {
      const serviceName = (b.serviceId && (b.serviceId.name || b.serviceId.title)) || (b.service && typeof b.service === "string" && b.service) || "Service";
      return {
        _id: b._id,
        bookingId: String(b._id),
        customerName: b.customerName || (b.customer && b.customer.name) || "Customer",
        serviceName,
        status: b.status,
        address: b.location?.address || "",
        lat: b.location?.lat,
        lng: b.location?.lng,
        bookingDate: b.bookingDate,
        startTime: b.startTime,
        bookingReference: b.bookingReference,
        technicianId: b.technicianId ? String(b.technicianId) : null,
      };
    });

    return res.json({ customers });
  } catch (err) {
    next(err);
  }
});

// ── Proof of Completion Upload + Complete Status ──────────────────────
router.post("/assignments/:id/proof-of-completion", auth.authenticate, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "technician") {
      return res.status(403).json({ error: "Access denied" });
    }

    proofUpload(req, res, async (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? "File too large. Max 5MB." : err.message || "Upload failed";
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please select a photo to upload" });
      }

      const { id } = req.params;
      const Assignment = require("../models/Assignment");
      const BookingService = require("../models/BookingService");
      const Technician = require("../models/Technician");
      const User = require("../models/User");

      const assignment = await Assignment.findById(id).lean();
      if (!assignment) return res.status(404).json({ error: "Assignment not found" });

      const tech = await Technician.findOne({ user: req.user._id }).lean();
      if (!tech || String(assignment.technicianId) !== String(tech._id)) {
        return res.status(403).json({ error: "Not your assignment" });
      }

      if (assignment.status !== "in_progress" && assignment.status !== "completed") {
        return res.status(400).json({ error: "Can only submit proof from In Progress or Completed status" });
      }

      const booking = await BookingService.findById(assignment.bookingId);
      if (booking && ["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod) && !booking.balanceCollected && (booking.balanceAmount || 0) > 0) {
        return res.status(400).json({ error: "You must collect the remaining balance before completing this job." });
      }

      const proofUrl = "/uploads/completion-proofs/" + req.file.filename;
      const completedAt = new Date();
      const configuredWarranty = await configuredBookingWarranty(booking || { serviceType: assignment.serviceType }, completedAt);
      const warrantyCoverage = configuredWarranty.coverage;

      // Update assignment
      const updatedAssignment = await Assignment.findByIdAndUpdate(id, {
        $set: {
          status: "completed",
          completedAt,
          "proofPhoto": proofUrl,
        },
        $push: {
          notes: {
            text: `Proof of completion uploaded. Service marked as completed.`,
            by: req.user._id,
            byName: tech.name || req.user.name || "Technician",
            createdAt: new Date(),
          },
        },
      }, { returnDocument: "after" }).lean();

      // Update booking — only for non-repair services (repair status is managed by complete-repair)
      const bookingForCheck = await BookingService.findById(assignment.bookingId);
      const isRepair = bookingForCheck && bookingForCheck.serviceType === "repair";
      if (!isRepair) {
        const bookingCompletion = {
          status: "completed",
          completedAt,
          proofPhoto: proofUrl,
        };
        if (warrantyCoverage) bookingCompletion.warranty = warrantyCoverage;
        await BookingService.findByIdAndUpdate(assignment.bookingId, {
          $set: bookingCompletion,
        });
      } else {
        // For repair services, just attach the proof photo without overwriting status
        await BookingService.findByIdAndUpdate(assignment.bookingId, {
          $set: { proofPhoto: proofUrl },
        });
      }

      if (!isRepair) {
        try {
          const completedBooking = await BookingService.findById(assignment.bookingId);
          if (completedBooking) {
            completedBooking.maintenance = completedBooking.maintenance || {};
            const requestedInterval = String(req.body.nextMaintenanceDays || "").trim()
              ? Math.min(730, Math.max(30, Number(req.body.nextMaintenanceDays)))
              : null;
            if (Number.isFinite(requestedInterval)) completedBooking.maintenance.nextRecommendedDays = requestedInterval;
            completedBooking.maintenance.nextRecommendationNotes = String(
              req.body.nextMaintenanceNotes || "",
            ).slice(0, 1000);
            await completedBooking.save();
            const { syncMaintenanceFromBooking } = require("../utils/maintenanceLifecycle");
            await syncMaintenanceFromBooking(completedBooking, {
              intervalDays: requestedInterval || undefined,
              notes: completedBooking.maintenance.nextRecommendationNotes,
              recommendedBy: tech._id,
              recommendedByName: tech.name || "Technician",
            });
          }
        } catch (maintenanceError) {
          console.error("Failed to create booking maintenance schedules:", maintenanceError.message);
        }
      }

      // Update technician availability
      const { resolveAvailabilityStatus } = require("../utils/availability");
      await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      // Availability status synced via syncDb: true above

      // Emit socket event
      const io = req.app.get("io");
      if (io) {
        const booking = await BookingService.findById(assignment.bookingId).lean();
        if (booking) {
          const customerId = booking.customerId?._id || booking.customerId;
          if (customerId) {
            io.to("customer:" + customerId).emit("booking:status-change", {
              bookingId: assignment.bookingId,
              status: "completed",
              technicianName: tech.name,
              proofPhoto: proofUrl,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Send completion email
      try {
        const { sendBookingCompletedEmail } = require("../utils/mailer");
        const booking = await BookingService.findById(assignment.bookingId).populate("customerId", "name email").lean();
        if (booking) {
          const customerEmail = booking.customerId?.email;
          const customerName = booking.customerId?.name || "Customer";
          if (customerEmail) {
            const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
            const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
            sendBookingCompletedEmail({
              to: customerEmail,
              customerName,
              bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
              serviceName: booking.serviceName || "Service",
              technicianName: techFullName,
              dateLabel,
            }).catch(err => console.error("[MAILER] Failed to send completion email:", err.message));
          }
        }
      } catch (emailErr) {
        console.error("[MAILER] Completion email error:", emailErr.message);
      }

      return res.json({
        message: "Proof submitted and job completed",
        proofPhoto: proofUrl,
      });
    });
  } catch (err) {
    console.error("Proof of completion error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE REPAIR WORK ORDER ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════
const { generateAssistantReport, getTroubleshootingGuide, callGeminiAPI, tavilyInspectionSearch, tavilyPartsPricingSearch, tavilyMaintenanceSearch } = require('../utils/aiTechnicianAssistant');

function aiPhilippineLanguageInstruction(...values) {
  const text = values.flat(Infinity).map(value => {
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  }).join(' ').toLowerCase();
  const filipinoPattern = /\b(ang|mga|hindi|wala|may|sira|maingay|umiingay|lumalamig|tumutulo|umaandar|kailangan|palitan|linisin|ayusin|barado|maluwag|mahina|mainit|amoy|kulang|dahil|pero|kapag|naka|yung|iyong|para|naman|po)\b/i;
  const style = filipinoPattern.test(text) ? 'Filipino/Taglish' : 'English';
  return `LANGUAGE RULE: Understand English, Filipino/Tagalog, and Taglish input, including informal appliance terms and spelling variations. Respond in ${style}, matching the language style used in the supplied complaint and technician findings. Keep standard technical component names in English where clearer. Keep JSON property names exactly as requested in English.`;
}

// ── Helper: Record status transition with full audit trail ───────────────────
async function transitionRepairStatus(booking, newStatus, tech, opts = {}) {
  const prevStatus = booking.status;
  booking.status = newStatus;

  // Mixed bookings keep Repair as an independent child workflow. Mirror only
  // Repair lifecycle milestones into Repair items; Core items are untouched.
  const mixedItems = Array.isArray(booking.services)
    && booking.services.some(item => item.type === 'core')
    && booking.services.some(item => item.type === 'repair');
  const repairItemStatus = {
    inspection_completed: 'awaiting_customer_decision',
    awaiting_approval: 'awaiting_customer_decision',
    repair_in_progress: 'repair_in_progress',
    repair_completed: 'completed',
    repair_declined: 'repair_declined',
  }[newStatus];
  if (mixedItems && repairItemStatus) {
    for (const item of booking.services) {
      if (item.type !== 'repair' || item.status === repairItemStatus) continue;
      item.status = repairItemStatus;
      if (['repair_in_progress', 'completed'].includes(repairItemStatus)) item.phase = 'repair_phase_2';
      item.statusHistory = item.statusHistory || [];
      item.statusHistory.push({
        status: repairItemStatus,
        changedAt: new Date(),
        changedBy: tech._id,
        changedByName: tech.name || 'Technician',
        reason: opts.reason || `Repair workflow moved to ${newStatus}`,
      });
    }
  }

  if (!booking.statusHistory) booking.statusHistory = [];
  booking.statusHistory.push({
    fromStatus: prevStatus,
    toStatus: newStatus,
    changedBy: tech._id,
    changedByModel: 'Technician',
    changedByName: tech.name || 'Technician',
    reason: opts.reason || '',
    notes: opts.notes || '',
    timestamp: new Date(),
    metadata: opts.metadata || {}
  });

  // SLA tracking: record response time when technician first engages
  if (newStatus === 'inspection_scheduled' && booking.slaTracking && !booking.slaTracking.responseAt) {
    booking.slaTracking.responseAt = new Date();
    if (booking.slaTracking.responseTarget && new Date() > booking.slaTracking.responseTarget) {
      booking.slaTracking.responseBreached = true;
    }
  }

  await booking.save();
  return { prevStatus, newStatus };
}

// POST /appointments/:id/ai-diagnose
// AI Technician Assistant: generates preliminary recommendations for the technician
router.post("/appointments/:id/ai-diagnose", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const selectedRepairs = (Array.isArray(booking.services) ? booking.services : [])
      .map((service, serviceIndex) => ({ service, serviceIndex }))
      .filter(({ service }) => service?.type === 'repair');
    const targets = selectedRepairs.length ? selectedRepairs.map(({ service, serviceIndex }) => ({
      serviceIndex, serviceId: service.serviceId, serviceName: service.name || 'Repair Service',
      quantity: Math.max(1, Number(service.quantity) || 1),
      unitType: service.applianceTypeName || service.airconTypeName || service.name || 'Appliance',
      brand: service.brand || '', model: service.model || '',
      problemDescription: service.problemDescription || service.repairIssue || booking.issueDescription || '',
      photos: booking.unitInfo?.photos || [],
    })) : [{
      serviceIndex: 0, serviceId: booking.serviceId, serviceName: booking.service?.name || 'Repair Service',
      quantity: Math.max(1, Number(booking.quantity) || 1),
      unitType: booking.unitInfo?.unitType || booking.applianceTypeName || 'Appliance',
      brand: booking.unitInfo?.brand || booking.brand || '', model: booking.unitInfo?.model || '',
      problemDescription: booking.unitInfo?.problemDescription || booking.issueDescription || '', photos: booking.unitInfo?.photos || [],
    }];
    const reports = await Promise.all(targets.map(async target => ({ target, result: await generateAssistantReport(target) })));
    const serviceAnalyses = reports.map(({ target, result }) => ({ ...target, ...(result.technicianAssistant || {}) }));
    const unique = values => [...new Set(values.filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)))].map(value => { try { return JSON.parse(value); } catch (_) { return value; } });
    const rank = { low: 1, medium: 2, high: 3, specialist_required: 4 };
    const reportSources = unique(serviceAnalyses.map(a => a._source || 'fallback'));
    const reportProviders = unique(serviceAnalyses.map(a => a._provider || (a._source === 'ai' ? 'gemini' : a._source === 'ai-groq' ? 'groq' : 'local')));
    const reportModels = unique(serviceAnalyses.map(a => a._model).filter(Boolean));
    const ta = {
      summary: serviceAnalyses.map(a => `${a.serviceName} (${a.unitType}, qty ${a.quantity}): ${a.summary || 'On-site inspection required.'}`).join('\n'),
      probableCauses: serviceAnalyses.flatMap(a => (a.probableCauses || []).map(c => ({ ...(typeof c === 'object' ? c : { cause: c }), serviceIndex: a.serviceIndex, serviceName: a.serviceName, unitType: a.unitType }))),
      inspectionChecklist: serviceAnalyses.flatMap(a => (a.inspectionChecklist || []).map(c => ({ ...(typeof c === 'object' ? c : { action: c }), serviceIndex: a.serviceIndex, serviceName: a.serviceName, unitType: a.unitType }))),
      suggestedTools: unique(serviceAnalyses.flatMap(a => a.suggestedTools || [])),
      possibleParts: serviceAnalyses.flatMap(a => (a.possibleParts || []).map(p => ({ ...(typeof p === 'object' ? p : { name: p }), serviceIndex: a.serviceIndex, serviceName: a.serviceName, unitType: a.unitType }))),
      repairComplexity: serviceAnalyses.reduce((value, a) => (rank[a.repairComplexity] || 0) > (rank[value] || 0) ? a.repairComplexity : value, 'low'),
      estimatedDurationMinutes: serviceAnalyses.reduce((sum, a) => sum + Math.max(1, Number(a.quantity) || 1) * (Number(a.estimatedDurationMinutes) || 60), 0),
      safetyReminders: unique(serviceAnalyses.flatMap(a => a.safetyReminders || [])),
      additionalNotes: 'Optional preliminary reference only. Inspect each selected appliance on site before confirming diagnosis, parts, or quotation.',
      serviceAnalyses,
      _source: reportSources.length === 1 ? reportSources[0] : 'mixed',
      _provider: reportProviders.length === 1 ? reportProviders[0] : 'mixed',
      _model: reportModels.length === 1 ? reportModels[0] : reportModels.join(', '),
      _webResearchFetched: serviceAnalyses.some(a => a._webResearchFetched),
      _webResearchUsed: serviceAnalyses.some(a => a._webResearchUsed),
      _webSources: unique(serviceAnalyses.flatMap(a => a._webSources || [])),
    };

    // Save to booking (including web research metadata)
    booking.technicianAssistant = {
      generatedAt: new Date(),
      source: ta._source || 'fallback',
      provider: ta._provider || 'local',
      model: ta._model || 'local-knowledge-base',
      webResearchFetched: ta._webResearchFetched || false,
      webResearchUsed: ta._webResearchUsed || false,
      webSources: ta._webSources || [],
      summary: ta.summary || '',
      probableCauses: ta.probableCauses || [],
      inspectionChecklist: ta.inspectionChecklist || [],
      suggestedTools: ta.suggestedTools || [],
      possibleParts: ta.possibleParts || [],
      repairComplexity: ta.repairComplexity || 'medium',
      estimatedDurationMinutes: ta.estimatedDurationMinutes || 60,
      safetyReminders: ta.safetyReminders || [],
      additionalNotes: ta.additionalNotes || '',
      serviceAnalyses: ta.serviceAnalyses || [],
      technicianNotes: '',
      verifiedByTechnician: false,
    };
    booking.preventiveMaintenance = unique(serviceAnalyses.flatMap(a => a.preventiveMaintenance || []));
    try {
      await booking.save();
    } catch (saveErr) {
      console.error("AI diagnose: booking.save() failed:", saveErr.message, saveErr.stack);
      return res.status(500).json({ error: "Failed to save AI assistant report to booking", detail: saveErr.message });
    }

    // Get troubleshooting guide for quick reference
    const troubleshootingGuide = getTroubleshootingGuide(
      targets[0]?.unitType,
      targets[0]?.problemDescription
    );

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `AI Technician Assistant report generated for ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({
      success: true,
      technicianAssistant: booking.technicianAssistant,
      troubleshootingGuide,
      unitInfo: booking.unitInfo
    });
  } catch (err) {
    console.error("AI Technician Assistant error:", err.message, err.stack);
    return res.status(500).json({ error: "Failed to generate technician assistant report", detail: err.message });
  }
});

// POST /appointments/:id/ai-diagnose/verify
// Technician verifies/adjusts AI technician assistant recommendations
router.post("/appointments/:id/ai-diagnose/verify", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { technicianNotes, verified } = req.body;
    const selectedIndexes = new Set((Array.isArray(req.body.carriedPartIndexes) ? req.body.carriedPartIndexes : [])
      .map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 0));

    if (booking.technicianAssistant) {
      booking.technicianAssistant.technicianNotes = technicianNotes || '';
      booking.technicianAssistant.carriedPossibleParts = (booking.technicianAssistant.possibleParts || [])
        .filter((part, index) => selectedIndexes.has(index))
        .map(part => ({
          name: String(typeof part === 'string' ? part : part?.name || '').trim(),
          quantity: 1,
          serviceIndex: typeof part === 'object' ? part?.serviceIndex : undefined,
          serviceName: typeof part === 'object' ? part?.serviceName : undefined,
          unitType: typeof part === 'object' ? part?.unitType : undefined,
          declaredAt: new Date(),
        })).filter(part => part.name);
      booking.technicianAssistant.verifiedByTechnician = verified !== false;
      booking.technicianAssistant.verifiedAt = new Date();
      await booking.save();
    }

    return res.json({ success: true, technicianAssistant: booking.technicianAssistant });
  } catch (err) {
    console.error("Verify technician assistant error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/ai-generate-notes
// AI generates professional repair documentation based on inspection + diagnosis
router.post("/appointments/:id/ai-generate-notes", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const unitType = booking.unitInfo?.unitType || 'unit';
    const brand = booking.unitInfo?.brand || '';
    const model = booking.unitInfo?.model || '';
    const problem = booking.unitInfo?.problemDescription || booking.issueDescription || '';
    const findings = booking.inspection?.findings || '';
    const severity = booking.inspection?.severity || '';
    const diagnosis = booking.diagnosis?.findings || '';
    const parts = (booking.diagnosis?.requiredParts || []).map(p => `${p.name} x${p.quantity || 1}`).join(', ') || '';
    const laborDuration = booking.diagnosis?.laborDuration || '';
    const aiCauses = (booking.technicianAssistant?.probableCauses || []).map(c => c.cause).join('; ') || '';

    const prompt = `You are an expert HVAC/appliance repair documentation assistant. Generate a professional, concise repair report based on the following information. Return ONLY the report text, no JSON or markdown formatting.

UNIT: ${brand} ${model} (${unitType})
CUSTOMER COMPLAINT: ${problem}
AI PRELIMINARY ANALYSIS: ${aiCauses}
INSPECTION FINDINGS: ${findings}
SEVERITY: ${severity}
CONFIRMED DIAGNOSIS: ${diagnosis}
PARTS REPLACED/USED: ${parts || 'None specified yet'}
LABOR DURATION: ${laborDuration || 'Not specified'}

${aiPhilippineLanguageInstruction(problem, findings, diagnosis)}

Write a professional repair report (3-5 paragraphs) that:
1. Describes the issue reported by the customer
2. Summarizes the inspection process and findings
3. States the confirmed diagnosis
4. Documents the repair actions taken
5. Notes any recommendations or follow-up needed

Use professional language suitable for customer-facing documentation. Do not include headers or labels.`;

    try {
      const result = await callGeminiAPI(prompt);
      const notes = typeof result === 'string' ? result : (result.text || JSON.stringify(result));
      booking.aiGeneratedNotes = notes;
      await booking.save();
      return res.json({ success: true, notes });
    } catch (geminiErr) {
      // Fallback: generate basic notes from available data
      const fallbackNotes = `REPAIR REPORT — ${brand} ${model} (${unitType})\n\nCustomer reported: ${problem}\n\nInspection: ${findings || 'Inspection completed.'}${severity ? ` Severity classified as ${severity}.` : ''}\n\nDiagnosis: ${diagnosis || 'Pending formal diagnosis.'}\n\n${parts ? `Parts used: ${parts}` : ''}${laborDuration ? ` Estimated repair time: ${laborDuration}.` : ''}\n\nReport generated by AI Technician Assistant (local fallback).`;
      booking.aiGeneratedNotes = fallbackNotes;
      await booking.save();
      return res.json({ success: true, notes: fallbackNotes, source: 'fallback' });
    }
  } catch (err) {
    console.error("AI generate notes error:", err);
    return res.status(500).json({ error: "Failed to generate repair notes" });
  }
});

// POST /appointments/:id/ai-update-on-inspection
// AI updates recommendations based on real-time inspection data entered by technician
router.post("/appointments/:id/ai-update-on-inspection", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const { inspectionData, serviceItemId } = req.body;
    const repairItem = mongoose.Types.ObjectId.isValid(serviceItemId)
      ? booking.services.id(serviceItemId)
      : null;
    if (serviceItemId && (!repairItem || repairItem.type !== 'repair')) {
      return res.status(404).json({ error: 'Repair service item not found' });
    }
    // inspectionData: { refrigerantPressure, capacitor, compressor, airflow, temperature, etc. }

    const existing = booking.technicianAssistant || {};
    const existingCauses = (existing.probableCauses || []).map(c => `${c.cause} (${c.likelihood})`).join('\n');

    // Augment with Tavily specification data
    let webContext = '';
    let webSources = [];
    try {
      const targetUnit = repairItem ? {
        unitType: repairItem.applianceTypeName || repairItem.airconTypeName || repairItem.name,
        brand: repairItem.brand || '',
        model: repairItem.model || '',
        problemDescription: repairItem.problemDescription || repairItem.repairIssue || '',
      } : (booking.unitInfo || {});
      const webResearch = await tavilyInspectionSearch(targetUnit, inspectionData || {});
      if (webResearch.searchUsed) {
        webContext = webResearch.webContext;
        webSources = webResearch.sources || [];
        console.log(`[Tavily] Inspection research complete for booking ${booking._id}`);
      }
    } catch (err) {
      console.warn('[Tavily] Inspection search failed:', err.message);
    }

    const targetLabel = repairItem
      ? `${repairItem.brand || ''} ${repairItem.applianceTypeName || repairItem.airconTypeName || repairItem.name || ''} ${repairItem.model || ''}`.trim()
      : `${booking.unitInfo?.brand || ''} ${booking.unitInfo?.unitType || ''}`.trim();
    const targetProblem = repairItem?.problemDescription || repairItem?.repairIssue || booking.unitInfo?.problemDescription || '';
    const prompt = `You are an AI Technician Assistant helping a field technician during an on-site inspection. Analyze only the selected repair appliance; do not mix findings from other service items in the booking. The technician has entered the following readings/observations:

${Object.entries(inspectionData || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

INITIAL ANALYSIS (before inspection):
${existingCauses || 'No initial analysis available'}

SELECTED REPAIR APPLIANCE: ${targetLabel} — ${targetProblem}
${webContext}

${aiPhilippineLanguageInstruction(targetProblem, inspectionData)}

Based on these inspection readings and web research data (if available), provide:
1. UPDATED likely cause (narrow down from the initial analysis)
2. RECOMMENDED NEXT STEPS for the technician
3. Any SAFETY CONCERNS based on the readings
4. Reference any specification data found in web research to validate readings

Return JSON:
{
  "updatedCause": "Most likely cause based on readings",
  "confidence": "high|medium|low",
  "nextSteps": ["step1", "step2"],
  "safetyConcerns": ["concern1"],
  "notes": "Brief explanation of reasoning"
}`;

    try {
      const result = await callGeminiAPI(prompt);
      return res.json({ success: true, update: result, serviceItemId: repairItem?._id || null, webResearchUsed: webContext.length > 0, webSources });
    } catch (geminiErr) {
      return res.json({
        success: true,
        update: {
          updatedCause: 'Requires further analysis based on readings',
          confidence: 'medium',
          nextSteps: ['Review all inspection data', 'Cross-reference with initial probable causes'],
          safetyConcerns: [],
          notes: 'AI update unavailable (local mode). Use professional judgment.'
        },
        source: 'fallback'
      });
    }
  } catch (err) {
    console.error("AI inspection update error:", err);
    return res.status(500).json({ error: "Failed to update AI analysis" });
  }
});

// POST /appointments/:id/ai-generate-quotation
// AI assists technician in building a quotation based on diagnosis
// Enhanced with Tavily for real-time parts pricing
router.post("/appointments/:id/ai-generate-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const serviceItemId = req.body.serviceItemId;
    const repairItem = mongoose.Types.ObjectId.isValid(serviceItemId) ? booking.services.id(serviceItemId) : null;
    if (serviceItemId && (!repairItem || repairItem.type !== 'repair')) return res.status(404).json({ error: 'Repair service item not found' });
    const repairIndex = repairItem ? booking.services.findIndex(item => String(item._id) === String(repairItem._id)) : -1;
    const diagnosis = repairItem?.diagnosisNotes || booking.diagnosis?.findings || '';
    const parts = repairItem?.quotation?.parts?.length ? repairItem.quotation.parts : (booking.diagnosis?.requiredParts || []);
    const laborDuration = repairItem?.schedule?.durationMinutes || booking.diagnosis?.laborDuration || '';
    const inspectionCost = booking.inspection?.estimatedRepairCost || 0;
    const aiParts = (booking.technicianAssistant?.possibleParts || [])
      .filter(p => repairIndex < 0 || p.serviceIndex == null || Number(p.serviceIndex) === repairIndex)
      .map(p => ({
      name: typeof p === 'string' ? p : p.name,
      estimatedCost: typeof p === 'object' ? (p.estimatedCostPHP || 0) : 0
    }));
    const brand = repairItem?.brand || booking.unitInfo?.brand || '';

    // Augment with Tavily real-time pricing
    let pricingContext = '';
    let webResearchUsed = false;
    try {
      const partNames = [...parts.map(p => p.name), ...aiParts.map(p => p.name)].filter(Boolean);
      if (partNames.length > 0) {
        const pricingResult = await tavilyPartsPricingSearch(partNames, brand);
        if (pricingResult.searchUsed) {
          pricingContext = pricingResult.pricingData;
          webResearchUsed = true;
          console.log(`[Tavily] Parts pricing research complete for ${partNames.length} parts`);
        }
      }
    } catch (err) {
      console.warn('[Tavily] Parts pricing search failed:', err.message);
    }

    const prompt = `You are an AI quotation assistant for an HVAC/appliance repair company in the Philippines.

CONFIRMED DIAGNOSIS: ${diagnosis}
TECHNICIAN-SPECIFIED PARTS: ${parts.map(p => `${p.name} (qty: ${p.quantity || 1}, est. cost: ₱${p.cost || 0})`).join(', ') || 'None specified yet'}
AI-SUGGESTED PARTS: ${aiParts.map(p => `${p.name} (est. ₱${p.estimatedCost})`).join(', ') || 'None'}
LABOR DURATION: ${laborDuration || 'Not specified'}
INSPECTION ESTIMATE: ₱${inspectionCost}
${pricingContext}

${aiPhilippineLanguageInstruction(diagnosis, parts)}

Generate a fair quotation recommendation in JSON:
{
  "parts": [
    { "name": "Part Name", "quantity": 1, "costPHP": 500, "reason": "Why this part" }
  ],
  "laborCostPHP": 500,
  "laborHours": 1,
  "totalEstimatePHP": 1000,
  "notes": "Brief justification for pricing"
}

RULES:
- All prices in Philippine Pesos
- Use realistic local market prices — if web research data is available, use those prices as reference
- Labor rate: ~₱300-500/hour for standard repair, ~₱500-800/hour for complex
- Include only parts actually needed for the confirmed diagnosis
- Do NOT include unnecessary parts`;

    try {
      const result = await callGeminiAPI(prompt);
      const quotation = result.quotation || result;
      return res.json({ success: true, quotation, webResearchUsed });
    } catch (geminiErr) {
      // Fallback: build from technician-specified parts
      const partsTotal = parts.reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
      const laborCost = 500;
      return res.json({
        success: true,
        quotation: {
          parts: parts.map(p => ({ name: p.name, quantity: p.quantity || 1, costPHP: p.cost || 0, reason: 'Technician-specified' })),
          laborCostPHP: laborCost,
          laborHours: 1,
          totalEstimatePHP: partsTotal + laborCost,
          notes: 'Fallback estimate. Technician should adjust prices based on actual costs.'
        },
        source: 'fallback',
        webResearchUsed: false
      });
    }
  } catch (err) {
    console.error("AI quotation error:", err);
    return res.status(500).json({ error: "Failed to generate quotation" });
  }
});

// POST /appointments/:id/ai-maintenance-tips
// AI generates preventive maintenance recommendations after repair
// Enhanced with Tavily for latest maintenance best practices
router.post("/appointments/:id/ai-maintenance-tips", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const unitType = booking.unitInfo?.unitType || 'unit';
    const brand = booking.unitInfo?.brand || '';
    const problem = booking.unitInfo?.problemDescription || '';
    const diagnosis = booking.diagnosis?.findings || booking.inspection?.findings || '';
    const prevRepairs = booking.previousRepairs || [];

    // Augment with Tavily maintenance best practices
    let webContext = '';
    let webResearchUsed = false;
    try {
      const maintenanceResearch = await tavilyMaintenanceSearch({ unitType, brand, problem });
      if (maintenanceResearch.searchUsed) {
        webContext = maintenanceResearch.webContext;
        webResearchUsed = true;
        console.log(`[Tavily] Maintenance research complete for ${brand} ${unitType}`);
      }
    } catch (err) {
      console.warn('[Tavily] Maintenance search failed:', err.message);
    }

    const prompt = `You are an HVAC/appliance maintenance expert. Based on the repair just completed, generate preventive maintenance recommendations.

UNIT: ${brand} ${unitType}
ORIGINAL ISSUE: ${problem}
CONFIRMED DIAGNOSIS: ${diagnosis}
${prevRepairs.length ? `PREVIOUS REPAIRS: ${prevRepairs.map(r => `${r.issue || r.description}`).join('; ')}` : ''}
${webContext}

Generate 4-6 specific preventive maintenance tips as a JSON array of strings:
{
  "tips": [
    "Specific maintenance action with frequency (e.g., Clean condenser coil every 6 months)",
    "..."
  ]
}

Tips should be:
- Specific to this unit type and the issue that was repaired
- Include frequency/recommended intervals
- Practical for the customer to follow
- Written in clear, simple language
- If web research data is available, incorporate manufacturer-recommended schedules and latest best practices`;

    try {
      const result = await callGeminiAPI(prompt);
      const tips = result.tips || result.maintenanceTips || result;
      booking.preventiveMaintenance = Array.isArray(tips) ? tips : (tips.tips || []);
      await booking.save();
      return res.json({ success: true, tips: booking.preventiveMaintenance, webResearchUsed });
    } catch (geminiErr) {
      const fallbackTips = [
        `Schedule preventive maintenance for ${brand} ${unitType} every 6 months`,
        'Keep the unit clean and free from dust buildup',
        'Check and clean air filters monthly',
        'Monitor performance and report unusual sounds or behavior early',
        'Schedule professional inspection annually'
      ];
      booking.preventiveMaintenance = fallbackTips;
      await booking.save();
      return res.json({ success: true, tips: fallbackTips, source: 'fallback', webResearchUsed: false });
    }
  } catch (err) {
    console.error("AI maintenance tips error:", err);
    return res.status(500).json({ error: "Failed to generate maintenance tips" });
  }
});

// POST /appointments/:id/ai-check-history
// AI checks previous repair history for recurring issues
router.post("/appointments/:id/ai-check-history", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Find previous repairs for the same customer + unit type
    const previousBookings = await BookingService.find({
      _id: { $ne: booking._id },
      $or: [
        { customerId: booking.customerId },
        { 'customer.email': booking.customer?.email }
      ],
      'unitInfo.unitType': booking.unitInfo?.unitType || '',
      status: { $in: ['repair_completed', 'closed'] }
    }).sort({ createdAt: -1 }).limit(5).lean();

    const history = previousBookings.map(pb => ({
      date: pb.createdAt ? new Date(pb.createdAt).toLocaleDateString('en-PH') : '',
      issue: pb.unitInfo?.problemDescription || pb.issueDescription || '',
      diagnosis: pb.diagnosis?.findings || '',
      cost: pb.quotation?.totalCost || 0,
      technician: pb.technicianId?.name || ''
    }));

    // Store on current booking
    booking.previousRepairs = history.map(h => ({
      date: h.date,
      issue: h.issue,
      description: h.diagnosis,
      technician: h.technician,
      cost: h.cost,
      recurring: false
    }));

    // Check if current issue is similar to any previous
    if (history.length > 0) {
      const currentProblem = (booking.unitInfo?.problemDescription || '').toLowerCase();
      for (const h of history) {
        if (h.issue && currentProblem) {
          const prevWords = h.issue.toLowerCase().split(/\s+/);
          const matchCount = prevWords.filter(w => currentProblem.includes(w) && w.length > 3).length;
          if (matchCount >= 2) {
            const idx = booking.previousRepairs.findIndex(pr => pr.date === h.date);
            if (idx >= 0) booking.previousRepairs[idx].recurring = true;
          }
        }
      }
    }

    await booking.save();
    return res.json({
      success: true,
      history,
      recurringDetected: booking.previousRepairs.some(pr => pr.recurring),
      message: history.length === 0
        ? 'No previous repair history found for this customer/unit.'
        : `Found ${history.length} previous repair(s).${booking.previousRepairs.some(pr => pr.recurring) ? ' RECURRING ISSUE DETECTED.' : ''}`
    });
  } catch (err) {
    console.error("AI check history error:", err);
    return res.status(500).json({ error: "Failed to check repair history" });
  }
});

// POST /appointments/:id/upload-photos
// Upload repair photos (before/during)
const repairPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "../public/uploads/repair-photos");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, "repair-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  }
}).array("photos", 10);

router.post("/appointments/upload-repair-photos", (req, res, next) => {
  repairPhotoUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: "Photo upload failed: " + err.message });
    const urls = req.files.map(f => "/uploads/repair-photos/" + f.filename);
    return res.json({ urls });
  });
});

// POST /appointments/:id/estimate-repair-duration
// Re-estimates work time from the technician's confirmed on-site findings.
router.post("/appointments/:id/estimate-repair-duration", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const diagnoses = (Array.isArray(req.body.confirmedDiagnoses) ? req.body.confirmedDiagnoses : [])
      .map(value => String(value || '').trim()).filter(Boolean).slice(0, 20);
    const repairAction = String(req.body.recommendedAction || '').trim().slice(0, 2000);
    const parts = (Array.isArray(req.body.parts) ? req.body.parts : []).slice(0, 20).map(part => ({
      name: String(part.name || '').trim().slice(0, 150),
      quantity: Math.max(1, Number(part.quantity) || 1),
    })).filter(part => part.name);
    const laborCategory = normalizeRepairComplexity(req.body.laborCategory);

    if (!diagnoses.length) return res.status(400).json({ error: "Confirm at least one actual diagnosis first." });
    if (!repairAction) return res.status(400).json({ error: "Describe the actual repair action first." });

    const repairItems = (booking.services || []).filter(item => item.type === 'repair').map(item => ({
      service: item.name || item.applianceTypeName || 'Repair service', brand: item.brand || '',
      model: item.model || '', quantity: Math.max(1, Number(item.quantity) || 1),
    }));
    const units = repairItems.length ? repairItems : [{
      service: booking.service?.name || booking.unitInfo?.unitType || 'Repair service',
      brand: booking.unitInfo?.brand || '', model: booking.unitInfo?.model || '', quantity: Math.max(1, Number(booking.quantity) || 1),
    }];
    const fallbackBase = { minor: 45, standard: 90, complex: 150, major: 240 }[laborCategory] || 90;
    const fallbackMinutes = Math.min(480, Math.max(30, Math.round((fallbackBase + Math.max(0, diagnoses.length - 1) * 15 + parts.length * 20) / 15) * 15));

    let estimate = { estimatedDurationMinutes: fallbackMinutes, recommendedComplexity: laborCategory, rationale: 'Estimated from confirmed diagnoses, repair action, and replacement-part scope.', source: 'workflow_fallback' };
    try {
      const aiResult = await callGeminiAPI(`You estimate hands-on appliance repair duration for a field technician after an actual on-site inspection.
Return JSON only: {"estimatedDurationMinutes": number, "recommendedComplexity": "minor|standard|complex|major", "rationale": "one concise sentence explaining both time and complexity"}.
Estimate repair work time only; exclude travel, payment, and customer approval waiting time. Use 15-minute increments, minimum 30 and maximum 480 minutes.
Units: ${JSON.stringify(units)}
Technician-confirmed diagnoses: ${JSON.stringify(diagnoses)}
Technician repair action: ${JSON.stringify(repairAction)}
Replacement parts: ${JSON.stringify(parts)}
Technician-confirmed complexity: ${laborCategory}
${aiPhilippineLanguageInstruction(booking.unitInfo?.problemDescription, diagnoses, repairAction, parts)}
      The rationale must follow that language rule.`);
      const minutes = Math.min(480, Math.max(30, Math.round(Number(aiResult.estimatedDurationMinutes) / 15) * 15));
      const recommendedComplexity = normalizeRepairComplexity(aiResult.recommendedComplexity);
      if (Number.isFinite(minutes)) estimate = { estimatedDurationMinutes: minutes, recommendedComplexity, rationale: String(aiResult.rationale || 'Estimated from the technician-confirmed repair scope.'), source: 'ai_actual_diagnosis' };
    } catch (aiError) {
      console.warn('[Repair Duration] AI estimate unavailable, using workflow fallback:', aiError.message);
    }

    return res.json({ success: true, ...estimate });
  } catch (err) { next(err); }
});

// POST /appointments/:id/complete-inspection
// Technician submits combined inspection + quotation → booking status: awaiting_approval (admin must approve before technician can proceed)
// Enterprise: auto-generates findings, actions, and quote from confirmed diagnosis
router.post("/appointments/:id/complete-inspection", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { diagnosis, confirmedDiagnoses, parts, laborCategory,
      quotationNotes, photos, estimatedDurationMinutes, complexity, recommendedAction,
      replacementPartsRequired } = req.body;

    if (!diagnosis || !diagnosis.trim()) {
      return res.status(400).json({ error: "Diagnosis is required" });
    }
    if (!Array.isArray(confirmedDiagnoses) || !confirmedDiagnoses.some(item => String(item || '').trim())) {
      return res.status(400).json({ error: "At least one technician-confirmed diagnosis is required" });
    }
    if (!recommendedAction || !String(recommendedAction).trim()) {
      return res.status(400).json({ error: "Repair action is required" });
    }
    const confirmedLaborCategory = normalizeRepairComplexity(laborCategory);
    const confirmedDurationMinutes = Math.round(Number(estimatedDurationMinutes));
    if (!Number.isFinite(confirmedDurationMinutes) || confirmedDurationMinutes < 30 || confirmedDurationMinutes > 480) {
      return res.status(400).json({ error: "A valid estimated repair duration between 30 and 480 minutes is required" });
    }
    const officialLaborFees = await getRepairLaborFees();
    const officialLaborFee = officialLaborFees[confirmedLaborCategory];

    const allowedFrom = ["inspection_scheduled", "confirmed", "on-the-way", "arrived", "inspection_completed"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot complete inspection from status: ${booking.status}` });
    }

    // ── Auto-generate findings from confirmed diagnoses ────────────────
    const diagnosesList = confirmedDiagnoses || [diagnosis];
    const findingsText = _autoGenerateFindings(diagnosesList);
    const actionsText = _autoGenerateActions(diagnosesList, parts || []);

    // ── Save inspection data ──
    booking.inspection = {
      ...booking.inspection,
      completedAt: new Date(),
      technicianId: tech._id,
      findings: findingsText,
      severity: "",
      damagedParts: [],
      recommendedAction: recommendedAction || actionsText,
      photos: photos || [],
      estimatedRepairCost: 0,
      findingsChecklist: [],
      actionsChecklist: [],
    };

    // ── Determine which parts are billable (repair parts / consumables, not equipment) ──
    const rawParts = (parts || []);
    const toolIds = rawParts.filter(p => p.toolId && mongoose.Types.ObjectId.isValid(p.toolId)).map(p => p.toolId);
    const tools = toolIds.length ? await Tool.find({ _id: { $in: toolIds }, $and: [Tool.merchandiseFilter()] }).select('type inventoryClass costPrice sellingPrice quantity reservedQuantity').lean() : [];
    const typeMap = new Map(tools.map(t => [String(t._id), t.type === 'tool' ? 'equipment' : (t.type || 'part')]));
    const toolMap = new Map(tools.map(t => [String(t._id), t]));
    const billableParts = rawParts.filter(p => {
      if (!p.toolId) return true; // manual line item
      return toolMap.has(String(p.toolId)) && typeMap.get(String(p.toolId)) !== 'equipment';
    }).map(p => {
      const inventory = p.toolId ? toolMap.get(String(p.toolId)) : null;
      const sellingPrice = inventory
        ? (Number(inventory.sellingPrice) || Number(inventory.costPrice) || 0)
        : (Number(p.sellingPrice) || Number(p.cost) || 0);
      return { ...p, sellingPrice, purchasePrice: inventory ? (Number(inventory.costPrice) || 0) : (Number(p.purchasePrice) || 0), cost: sellingPrice };
    });
    const requiresReplacement = replacementPartsRequired === true || replacementPartsRequired === "true";
    if (requiresReplacement && billableParts.length === 0) {
      return res.status(400).json({ error: "Add at least one replacement part, or choose No replacement parts required." });
    }
    if (!requiresReplacement && billableParts.length > 0) {
      return res.status(400).json({ error: "Parts were submitted while No replacement parts required was selected." });
    }
    // Availability is authoritative on the server and booking-aware. A hard
    // reservation has already reduced Tool.quantity, while a soft reservation
    // is represented in reservedQuantity; either kind remains available to the
    // booking that owns it.
    const StockReservation = require('../models/StockReservation');
    const activeReservations = toolIds.length ? await StockReservation.find({
      bookingId: booking._id,
      toolId: { $in: toolIds },
      status: { $in: ['reserved', 'checked_out'] },
    }).select('toolId quantity').lean() : [];
    const bookingReservedByTool = activeReservations.reduce((map, row) => {
      const key = String(row.toolId);
      map.set(key, (map.get(key) || 0) + Math.max(0, Number(row.quantity) || 0));
      return map;
    }, new Map());
    const verifiedHasUnavailableParts = billableParts.some(part => {
      if (!part.toolId) return true;
      const inventory = toolMap.get(String(part.toolId));
      if (!inventory) return true;
      const unreservedQuantity = Math.max(0, Number(inventory.quantity || 0) - Number(inventory.reservedQuantity || 0));
      const availableToBooking = unreservedQuantity + (bookingReservedByTool.get(String(part.toolId)) || 0);
      return availableToBooking < Math.max(1, Number(part.quantity) || 1);
    });

    // ── Save diagnosis data ──
    booking.diagnosis = {
      ...booking.diagnosis,
      findings: findingsText,
      diagnosisSummary: diagnosis.trim(),
      confirmedDiagnoses: diagnosesList,
      repairAction: String(recommendedAction).trim(),
      replacementPartsRequired: requiresReplacement,
      requiredParts: billableParts.map(p => ({
        name: p.name || "",
        quantity: parseInt(p.quantity) || 1,
        cost: parseFloat(p.cost) || 0,
        sellingPrice: parseFloat(p.sellingPrice) || 0,
        purchasePrice: parseFloat(p.purchasePrice) || 0,
        toolId: p.toolId || null,
        itemType: p.toolId ? (typeMap.get(String(p.toolId)) || 'part') : 'part',
      })),
      laborDuration: String(confirmedDurationMinutes) + ' min',
      laborCost: officialLaborFee,
      laborCategory: confirmedLaborCategory,
      completedAt: new Date(),
      technicianId: tech._id,
    };

    // ── Save quotation data (auto-computed) ──
    const partsTotal = billableParts.reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
    const labor = officialLaborFee;
    let quotationTotal = partsTotal + labor;

    booking.quotation = {
        parts: billableParts.map(p => ({
          name: p.name || "",
          cost: parseFloat(p.cost) || 0,
          sellingPrice: parseFloat(p.sellingPrice) || 0,
          purchasePrice: parseFloat(p.purchasePrice) || 0,
          quantity: parseInt(p.quantity) || 1,
          toolId: p.toolId || null,
          itemType: p.toolId ? (typeMap.get(String(p.toolId)) || 'part') : 'part',
        })),
        laborCost: labor,
        laborCategory: confirmedLaborCategory,
        repairAction: String(recommendedAction).trim(),
        replacementPartsRequired: requiresReplacement,
        totalCost: quotationTotal,
        notes: quotationNotes || "",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    if (!verifiedHasUnavailableParts) {
      booking.approval = {
        status: "pending",
        decidedAt: undefined,
        reason: undefined,
      };
    }

    // Set balance amount for COD/cash bookings
    if (["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod) && quotationTotal > 0) {
      const isMixedBooking = booking.serviceType === 'mixed'
        || ((booking.services || []).some(item => item.type === 'core')
          && (booking.services || []).some(item => item.type === 'repair'));
      if (isMixedBooking) {
        const initialBookingTotal = Math.max(0, Number(booking.totalPrice || booking.estimatedFee) || 0);
        booking.balanceAmount = Math.max(0, initialBookingTotal + quotationTotal - Number(booking.amountPaid || 0));
      } else {
        const phase1Charges = Math.max(0, Number(booking.initialCost) || 0) + Math.max(0, Number(booking.travelFare) || 0);
        booking.balanceAmount = booking.inspectionFeeCollected
          ? quotationTotal
          : Math.max(0, quotationTotal + phase1Charges - (Number(booking.downpaymentAmount) || 0));
      }
      booking.balanceCollected = false;
    }

    // Store estimated duration and complexity
    if (confirmedDurationMinutes) {
      booking.technicianAssistant = booking.technicianAssistant || {};
      booking.technicianAssistant.estimatedDurationMinutes = confirmedDurationMinutes;
    }
    if (complexity) {
      booking.repairComplexity = complexity;
    }

    // Mark AI as verified
    if (booking.technicianAssistant) {
      booking.technicianAssistant.verifiedByTechnician = true;
      booking.technicianAssistant.verifiedAt = new Date();
    }

    // Status transition — inspection completed
    await transitionRepairStatus(booking, 'inspection_completed', tech, {
      reason: 'Inspection completed',
      notes: findingsText,
      metadata: {
        diagnosis: diagnosis.trim(),
        hasQuotation: quotationTotal > 0,
        hasPhotos: (photos || []).length > 0,
        technicianAssistantVerified: !!booking.technicianAssistant?.verifiedByTechnician,
      }
    });

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Inspection & quotation submitted for ${booking.workOrderNumber || booking._id}`,
        quotationTotal
      });
    }

    // ── Emails ──
    try {
      const { sendInspectionCompletedEmail, sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail) {
        await sendInspectionCompletedEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          findings: findingsText,
          severity: '',
        });
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation?.parts || [],
          laborCost: officialLaborFee,
          totalCost: quotationTotal,
          quotationNotes: quotationNotes || '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send inspection completed email:", e.message); }

    return res.json({
      success: true,
      status: booking.status,
      inspection: booking.inspection,
      quotation: booking.quotation,
      quotationTotal,
      technicianAssistant: booking.technicianAssistant,
      slaTracking: booking.slaTracking
    });
  } catch (err) {
    console.error("Complete inspection error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Helpers: auto-generate findings and actions from confirmed diagnoses ──
function _autoGenerateFindings(diagnoses) {
  const findingsMap = {
    'capacitor': ['Capacitor shows signs of swelling', 'Capacitor not holding charge', 'Visible capacitor damage'],
    'compressor': ['Compressor not cycling properly', 'Compressor drawing excessive amps', 'Compressor making unusual noise'],
    'refrigerant': ['Low refrigerant pressure', 'Refrigerant leak detected', 'Oil residue at connection points', 'Evaporator coil shows frost pattern'],
    'fan': ['Fan motor not spinning freely', 'Fan blade damage visible', 'Fan motor bearing noise'],
    'coil': ['Evaporator coil shows damage', 'Condenser coil dirty/blocked', 'Coil fins bent or corroded'],
    'wiring': ['Wiring connections loose', 'Visible wire damage', 'Burn marks on connectors'],
    'thermostat': ['Thermostat not reading correctly', 'Temperature differential abnormal'],
    'drain': ['Condensate drain clogged', 'Drain pan overflow', 'Water leakage detected'],
    'airflow': ['Restricted airflow detected', 'Filter heavily soiled', 'Blower wheel dirty']
  };

  const matched = [];
  const allText = diagnoses.join(' ').toLowerCase();
  for (const [keyword, list] of Object.entries(findingsMap)) {
    if (allText.includes(keyword)) {
      matched.push(...list);
    }
  }

  if (matched.length === 0) {
    return 'Unit not operating normally. Physical inspection completed. Visual signs of wear/damage noted.';
  }

  return [...new Set(matched)].join('. ') + '.';
}

function _autoGenerateActions(diagnoses, parts) {
  const actionMap = {
    'capacitor': ['Replace capacitor', 'Test capacitor rating', 'Verify system startup'],
    'compressor': ['Replace compressor', 'Check compressor mounts', 'Test compressor windings', 'Verify system operation'],
    'refrigerant': ['Recharge refrigerant', 'Repair refrigerant leak', 'Replace Schrader valve', 'Braze leak point', 'Pressure test system'],
    'fan': ['Replace fan motor', 'Lubricate fan bearings', 'Replace fan blade'],
    'coil': ['Clean condenser coil', 'Replace evaporator coil', 'Chemical coil cleaning'],
    'wiring': ['Repair wiring connections', 'Replace damaged wires', 'Secure all connections'],
    'thermostat': ['Replace thermostat', 'Recalibrate thermostat', 'Check thermostat wiring'],
    'drain': ['Clear condensate drain', 'Replace drain line', 'Clean drain pan'],
    'airflow': ['Replace air filter', 'Clean blower wheel', 'Seal ductwork']
  };

  const actions = [];
  const allText = diagnoses.join(' ').toLowerCase();
  for (const [keyword, list] of Object.entries(actionMap)) {
    if (allText.includes(keyword)) {
      actions.push(...list);
    }
  }

  (parts || []).forEach(p => {
    if (p.name) actions.push(`Install ${p.name}`);
  });

  if (actions.length === 0) {
    return 'Perform diagnostic tests. Verify system operation after repair. Clean and inspect unit.';
  }

  return [...new Set(actions)].join('. ') + '.';
}

// POST /appointments/:id/collect-inspection-payment
// Technician collects inspection/diagnosis fee from customer
router.post("/appointments/:id/collect-inspection-payment", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    const { amount, inspectionFee, distanceFare, method, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).populate("user", "firstName lastName name email");
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const mixedPhaseOne = getMixedPhaseOnePayment(booking);
    const isMixedBooking = mixedPhaseOne.isMixedBooking;
    if ((!isMixedBooking && booking.inspectionFeeCollected)
      || (isMixedBooking && booking.inspectionFeeCollected && mixedPhaseOne.amountDue <= 0.01)) {
      return res.json({
        success: true,
        alreadyCollected: true,
        message: mixedPhaseOne.allCoreCompleted ? "Phase 1 payment was already recorded." : "Inspection fee was already recorded.",
        booking: {
          amountPaid: booking.amountPaid,
          inspectionFeeCollected: true,
          inspectionFeeAmount: booking.inspectionFeeAmount,
          inspectionFeeDistanceFare: booking.inspectionFeeDistanceFare,
          inspectionFeeTotalCollected: booking.inspectionFeeTotalCollected,
          coreServicePaymentCollected: booking.coreServicePaymentCollected,
          coreServicePaymentAmount: booking.coreServicePaymentAmount,
        },
      });
    }

    const grossInspectionFee = Math.max(0, Number(
      isMixedBooking ? mixedPhaseOne.repairInspectionFee : (inspectionFee !== undefined ? inspectionFee : amount)
    ) || 0);
    const grossDistanceFare = isMixedBooking ? mixedPhaseOne.distanceFare : Math.max(0, Number(distanceFare) || 0);
    const downpaymentCredit = Math.min(Math.max(0, Number(booking.downpaymentAmount) || 0), grossInspectionFee + grossDistanceFare);
    const expectedCollection = isMixedBooking ? mixedPhaseOne.amountDue : Math.max(0, grossInspectionFee + grossDistanceFare - downpaymentCredit);
    const submittedCollection = inspectionFee !== undefined ? Number(amount) : expectedCollection;
    if ((!isMixedBooking && grossInspectionFee <= 0) || !Number.isFinite(submittedCollection) || Math.abs(submittedCollection - expectedCollection) > 0.01) {
      return res.status(400).json({ error: `Inspection collection must equal the remaining Phase 1 balance of ₱${expectedCollection.toLocaleString()}.` });
    }

    const now = new Date();
    const techName = (tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || 'Technician';
    const totalCollected = expectedCollection;
    const amountPaidBefore = Math.max(0, Number(booking.amountPaid) || 0);
    const outstandingInspectionCash = Math.max(0, grossInspectionFee + grossDistanceFare - amountPaidBefore);
    const inspectionCashCollectedNow = Math.min(totalCollected, outstandingInspectionCash);
    const coreCashCollectedNow = isMixedBooking && mixedPhaseOne.allCoreCompleted
      ? Math.max(0, totalCollected - inspectionCashCollectedNow)
      : 0;

    // Map frontend method values to valid Payment model enum values
    const methodMap = { cash: 'cod', cod: 'cod', gcash: 'gcash', maya: 'other', bank_transfer: 'bank' };
    const paymentMethod = methodMap[method] || 'cod';

    // Update booking payment records
    booking.amountPaid = amountPaidBefore + totalCollected;
    booking.inspectionFeeCollected = true;
    booking.inspectionFeeAmount = grossInspectionFee;
    booking.inspectionFeeDistanceFare = grossDistanceFare;
    booking.inspectionFeeTotalCollected = Math.max(Number(booking.inspectionFeeTotalCollected) || 0, inspectionCashCollectedNow);
    booking.downpaymentAppliedToInspection = downpaymentCredit;
    booking.inspectionFeeMethod = method || 'cash';
    booking.inspectionFeeCollectedAt = booking.inspectionFeeCollectedAt || now;
    if (isMixedBooking && mixedPhaseOne.allCoreCompleted) {
      booking.coreServicePaymentCollected = true;
      booking.coreServicePaymentAmount = mixedPhaseOne.coreServiceAmount;
      booking.coreServicePaymentCashCollected = (Number(booking.coreServicePaymentCashCollected) || 0) + coreCashCollectedNow;
      booking.coreServicePaymentMethod = method || 'cash';
      booking.coreServicePaymentCollectedAt = now;
    }
    booking.paymentStatus = "waiting_for_remittance";
    if (isMixedBooking) {
      // Once all Core work is complete, Phase 1 settles the original mixed
      // booking total. Only the approved Repair quotation remains for Phase 2.
      const initialBookingTotal = mixedPhaseOne.phaseOneTarget;
      const repairQuotationTotal = Math.max(0, Number(booking.quotation?.totalCost) || 0);
      booking.balanceAmount = Math.max(0, initialBookingTotal + repairQuotationTotal - Number(booking.amountPaid || 0));
    } else if (booking.quotation?.totalCost > 0) {
      // Repair-only Phase 1 is settled; only the quotation remains.
      booking.balanceAmount = Number(booking.quotation.totalCost);
    }
    if (notes) {
      booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[${isMixedBooking && mixedPhaseOne.allCoreCompleted ? 'Mixed Phase 1' : 'Inspection Fee'}] ₱${totalCollected.toLocaleString()} collected via ${method || 'cash'} — ${notes || ''}`;
    }
    await booking.save();

    // Create a Payment record
    await Payment.create({
      bookingId: booking._id,
      amount: totalCollected,
      method: paymentMethod,
      type: "inspection",
      gateway: paymentMethod,
      status: "waiting_for_remittance",
      reference: notes || `Inspection fee collected by ${techName}`,
      collectedBy: tech._id,
      collectedByName: techName,
      collectedAt: now,
      events: [
        { status: "payment_collected", actor: req.user._id, actorName: techName, actorRole: "technician", at: now },
        { status: "waiting_for_remittance", actor: req.user._id, actorName: techName, actorRole: "technician", at: now },
      ],
      notes: isMixedBooking && mixedPhaseOne.allCoreCompleted
        ? `Mixed Phase 1 payment — inspection: ₱${grossInspectionFee.toLocaleString()}, fare: ₱${grossDistanceFare.toLocaleString()}, completed Core service: ₱${mixedPhaseOne.coreServiceAmount.toLocaleString()}; cash collected: ₱${totalCollected.toLocaleString()} by ${techName}`
        : `Inspection fee: ₱${grossInspectionFee.toLocaleString()}${grossDistanceFare > 0 ? ' + fare: ₱' + grossDistanceFare.toLocaleString() : ''}. Collected by ${techName}`,
    });

    // Notify admins
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "payment_collected",
      title: isMixedBooking && mixedPhaseOne.allCoreCompleted ? "Mixed Phase 1 Payment Collected" : "Inspection Fee Collected",
      message: `${techName} collected ₱${totalCollected.toLocaleString()} for ${isMixedBooking && mixedPhaseOne.allCoreCompleted ? 'Repair inspection and completed Core service' : 'Repair inspection'} on ${booking.bookingReference || booking.workOrderNumber || id}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      priority: "normal",
      io,
    });

    console.log(`💰 Inspection payment collected for ${booking.bookingReference || id}: ₱${totalCollected} via ${method || 'cash'}`);
    return res.json({
      success: true,
      message: `₱${totalCollected.toLocaleString()} ${isMixedBooking && mixedPhaseOne.allCoreCompleted ? "Phase 1 balance" : "inspection fee"} collected.`,
      phaseOnePayment: {
        inspectionFee: grossInspectionFee,
        distanceFare: grossDistanceFare,
        coreServiceAmount: isMixedBooking && mixedPhaseOne.allCoreCompleted ? mixedPhaseOne.coreServiceAmount : 0,
        amountCollected: totalCollected,
        remainingInitialBalance: Math.max(0, mixedPhaseOne.phaseOneTarget - Number(booking.amountPaid || 0)),
      },
      booking: {
        amountPaid: booking.amountPaid,
        inspectionFeeCollected: booking.inspectionFeeCollected,
        inspectionFeeAmount: booking.inspectionFeeAmount,
        inspectionFeeDistanceFare: booking.inspectionFeeDistanceFare,
        inspectionFeeTotalCollected: booking.inspectionFeeTotalCollected,
        coreServicePaymentCollected: booking.coreServicePaymentCollected,
        coreServicePaymentAmount: booking.coreServicePaymentAmount,
        balanceAmount: booking.balanceAmount,
      },
    });
  } catch (err) {
    console.error("Collect inspection payment error:", err);
    return res.status(500).json({ error: err.message || "Server error collecting payment" });
  }
});

// POST /appointments/:id/submit-diagnosis
// Technician submits formal diagnosis → booking status: awaiting_approval (ready for quotation)
router.post("/appointments/:id/submit-diagnosis", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { findings, requiredParts, laborDuration, laborCategory } = req.body;
    const confirmedLaborCategory = normalizeRepairComplexity(laborCategory);
    const officialLaborFee = (await getRepairLaborFees())[confirmedLaborCategory];
    if (!findings || !findings.trim()) {
      return res.status(400).json({ error: "Diagnosis findings are required" });
    }

    const allowedFrom = ["inspection_completed"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit diagnosis from status: ${booking.status}` });
    }

    // Store diagnosis on the booking
    booking.diagnosis = {
      findings: findings.trim(),
      requiredParts: (requiredParts || []).map(p => ({
        name: p.name || "",
        quantity: parseInt(p.quantity) || 1,
        cost: parseFloat(p.cost) || 0
      })),
      laborDuration: laborDuration || "",
      laborCost: officialLaborFee,
      laborCategory: confirmedLaborCategory,
      completedAt: new Date(),
      technicianId: tech._id,
    };

    if (booking.technicianAssistant) {
      booking.technicianAssistant.verifiedByTechnician = true;
      booking.technicianAssistant.verifiedAt = new Date();
    }

    // Record diagnosis status in history (status stays inspection_completed until quotation)
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: 'inspection_completed',
      toStatus: 'inspection_completed',
      changedBy: tech._id,
      changedByModel: 'Technician',
      changedByName: tech.name || 'Technician',
      reason: 'Diagnosis submitted',
      notes: findings.trim(),
      timestamp: new Date(),
      metadata: {
        type: 'diagnosis',
        requiredPartsCount: (requiredParts || []).length,
        laborCost: officialLaborFee,
        laborDuration
      }
    });
    await booking.save();

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Diagnosis completed for ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({
      success: true,
      status: booking.status,
      diagnosis: booking.diagnosis,
      customerName: booking.customer?.name || 'Customer',
      serviceName: booking.serviceName || 'Repair'
    });
  } catch (err) {
    console.error("Submit diagnosis error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/submit-quotation
// Technician submits repair quotation → booking status: awaiting_approval
router.post("/appointments/:id/submit-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { parts, laborCategory, notes, repairActionSummary } = req.body;
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: "At least one parts entry is required" });
    }

    // Validate each part has required fields
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i].name || parts[i].name.trim().length === 0) {
        return res.status(400).json({ error: `Part ${i + 1}: name is required` });
      }
      if (parts[i].cost === undefined || parts[i].cost < 0) {
        return res.status(400).json({ error: `Part ${i + 1}: valid cost is required` });
      }
    }

    const allowedFrom = ["inspection_completed", "awaiting_approval"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit quotation from status: ${booking.status}` });
    }

    // Inventory prices are authoritative: customers are quoted the selling
    // price while purchase price is retained privately for COGS/margin KPIs.
    const quotationToolIds = parts.filter(p => p.toolId && mongoose.Types.ObjectId.isValid(p.toolId)).map(p => p.toolId);
    const quotationTools = quotationToolIds.length
      ? await Tool.find({ _id: { $in: quotationToolIds }, $and: [Tool.merchandiseFilter()] }).select("costPrice sellingPrice type inventoryClass").lean()
      : [];
    const quotationToolMap = new Map(quotationTools.map(t => [String(t._id), t]));
    const pricedParts = parts.filter(p => !p.toolId || quotationToolMap.has(String(p.toolId))).map(p => {
      const inventory = p.toolId ? quotationToolMap.get(String(p.toolId)) : null;
      const sellingPrice = inventory
        ? (Number(inventory.sellingPrice) || Number(inventory.costPrice) || 0)
        : (Number(p.sellingPrice) || Number(p.cost) || 0);
      return {
        ...p,
        quantity: parseInt(p.quantity) || 1,
        cost: sellingPrice,
        sellingPrice,
        purchasePrice: inventory ? (Number(inventory.costPrice) || 0) : (Number(p.purchasePrice) || 0),
      };
    });
    const partsTotal = pricedParts.reduce((sum, p) => sum + (p.sellingPrice * p.quantity), 0);
    const confirmedLaborCategory = normalizeRepairComplexity(laborCategory || booking.diagnosis?.laborCategory);
    const labor = (await getRepairLaborFees())[confirmedLaborCategory];
    const total = partsTotal + labor;

    // Calculate cost deviation from inspection estimate
    const estimatedCost = booking.inspection?.estimatedRepairCost || 0;
    const costDeviation = estimatedCost > 0 ? {
      estimated: estimatedCost,
      actual: total,
      difference: total - estimatedCost,
      percentage: Math.round(((total - estimatedCost) / estimatedCost) * 100),
      message: total > estimatedCost
        ? `Quotation is ${Math.round(((total - estimatedCost) / estimatedCost) * 100)}% higher than initial estimate`
        : total < estimatedCost
          ? `Quotation is ${Math.round(((estimatedCost - total) / estimatedCost) * 100)}% lower than initial estimate`
          : 'Quotation matches initial estimate'
    } : null;

    // Validate quotation total is reasonable
    if (total <= 0) {
      return res.status(400).json({ error: "Quotation total must be greater than zero" });
    }

    booking.quotation = {
      parts: pricedParts.map(p => ({
        name: p.name || "",
        cost: p.sellingPrice,
        sellingPrice: p.sellingPrice,
        purchasePrice: p.purchasePrice,
        quantity: p.quantity,
        toolId: p.toolId || null,
      })),
      laborCost: labor,
      laborCategory: confirmedLaborCategory,
      totalCost: total,
      notes: notes || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    };

    booking.approval = {
      status: "pending",
      decidedAt: undefined,
      reason: undefined,
    };

    // Enterprise: Use safe status transition with audit trail
    await transitionRepairStatus(booking, 'awaiting_approval', tech, {
      reason: 'Quotation submitted for customer approval',
      notes: `Parts: ${parts.length}, Labor: ₱${labor}, Total: ₱${total}`,
      metadata: {
        partsCount: parts.length,
        laborCost: labor,
        totalCost: total,
        costDeviation,
        repairActionSummary: repairActionSummary || ''
      }
    });

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Quotation submitted for ${booking.workOrderNumber || booking._id}: ₱${total.toLocaleString()}`,
        costDeviation
      });
    }

    // Notify customer
    try {
      const { sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail) {
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation?.parts || [],
          laborCost: labor,
          totalCost: total,
          quotationNotes: quotationNotes || '',
          deviationNote: costDeviation ? costDeviation.message : '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send quotation email:", e.message); }

    return res.json({
      success: true,
      status: booking.status,
      quotation: booking.quotation,
      costDeviation
    });
  } catch (err) {
    console.error("Submit quotation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/onsite-approve
// Technician chose "Repair Now" → start repair immediately from inspection_completed
router.post("/appointments/:id/onsite-approve", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    const inspectionWasCompleted = Boolean(booking.inspection?.completedAt);
    const hasSubmittedQuotation = Boolean(booking.quotation?.createdAt && booking.quotation?.parts?.length);
    const recoverableLegacyStatus = ["waiting_parts", "inspection_scheduled"].includes(booking.status)
      && inspectionWasCompleted
      && hasSubmittedQuotation;
    if (booking.status !== "inspection_completed" && !recoverableLegacyStatus) {
      return res.status(400).json({
        error: `Cannot start repair from status: ${booking.status}. Complete the inspection and quotation first.`,
      });
    }

    // Record approval
    booking.approval = {
      status: "approved",
      decidedAt: new Date(),
      reason: "Approved on-site by technician",
    };

    // Existing technician reservations (including parts already checked out and
    // brought to the site) satisfy the quotation first. Only reserve a genuine
    // uncovered balance; otherwise this endpoint would reserve the same parts a
    // second time and incorrectly report zero stock.
    let hasInsufficientStock = false;
    let insufficientItems = [];
    try {
      const StockReservation = require("../models/StockReservation");
      const ServiceToolUsage = require("../models/ServiceToolUsage");
      const parts = (booking.quotation?.parts || []).filter(part => part.source !== "external_purchase");
      const activeReservations = await StockReservation.find({
        bookingId: booking._id,
        status: { $in: ["reserved", "checked_out"] },
      }).lean();

      // Treat reservations as consumable coverage so duplicate quotation rows
      // cannot reuse the same reserved quantity.
      const reservationPool = activeReservations.map(row => ({
        ...row,
        remaining: Math.max(0, Number(row.quantity) || 0),
        normalizedName: String(row.itemName || "").trim().toLowerCase(),
      }));
      const uncoveredParts = [];
      for (const part of parts) {
        let remaining = Math.max(1, Number(part.quantity) || 1);
        const toolId = part.toolId ? String(part.toolId) : "";
        const normalizedName = String(part.name || part.itemName || "").trim().toLowerCase();

        for (const held of reservationPool) {
          if (remaining <= 0) break;
          const sameTool = toolId && held.toolId && String(held.toolId) === toolId;
          const sameName = normalizedName && held.normalizedName === normalizedName;
          if (held.remaining <= 0 || (!sameTool && !sameName)) continue;
          const covered = Math.min(remaining, held.remaining);
          remaining -= covered;
          held.remaining -= covered;
        }

        if (remaining > 0) {
          const partData = typeof part.toObject === "function" ? part.toObject() : part;
          uncoveredParts.push({ ...partData, quantity: remaining });
        }
      }

      if (uncoveredParts.length > 0) {
        const { insufficientStock } = await StockReservation.reserveForBooking({
          bookingId: booking._id,
          parts: uncoveredParts,
          reservedBy: req.user._id,
        });
        if (insufficientStock.length > 0) {
          console.warn(`[STOCK] Insufficient stock for booking ${booking._id}:`, insufficientStock);
          hasInsufficientStock = true;
          insufficientItems = insufficientStock;
        }
      }

      // A reserved soft hold becomes physical stock usage when the technician
      // starts the repair. Deducted reservations were already removed from
      // on-hand stock, but both types are marked checked_out and audited.
      if (!hasInsufficientStock) {
        const reservationsToCheckout = await StockReservation.find({
          bookingId: booking._id,
          status: "reserved",
        });
        for (const reservation of reservationsToCheckout) {
          const usageNote = `Stock reservation ${reservation._id}`;
          const usageAlreadyRecorded = await ServiceToolUsage.exists({
            bookingId: booking._id,
            notes: usageNote,
          });
          if (usageAlreadyRecorded) {
            reservation.status = "checked_out";
            await reservation.save();
            continue;
          }

          const tool = reservation.toolId ? await Tool.findById(reservation.toolId) : null;
          const quantity = Math.max(1, Number(reservation.quantity) || 1);
          if (!tool || Tool.effectiveInventoryClass(tool) !== "merchandise") {
            hasInsufficientStock = true;
            insufficientItems.push({ itemName: reservation.itemName || "Unknown part", requested: quantity, available: 0 });
            continue;
          }
          if (reservation.stockTreatment === "soft_hold" && Number(tool.quantity || 0) < quantity) {
            hasInsufficientStock = true;
            insufficientItems.push({ itemName: reservation.itemName || tool.itemName, requested: quantity, available: Number(tool.quantity || 0) });
            continue;
          }

          if (reservation.stockTreatment === "soft_hold") {
            tool.quantity = Math.max(0, Number(tool.quantity || 0) - quantity);
            tool.reservedQuantity = Math.max(0, Number(tool.reservedQuantity || 0) - quantity);
            await tool.save();
          }

          await ServiceToolUsage.updateOne(
            { bookingId: booking._id, notes: usageNote },
            {
              $setOnInsert: {
                bookingId: booking._id,
                serviceItemId: reservation.serviceItemId || undefined,
                technicianId: tech._id,
                toolItemId: reservation.toolId,
                inventoryItemId: reservation.toolId,
                itemName: reservation.itemName || tool.itemName,
                itemType: tool.type === "tool" ? "equipment" : (tool.type || "part"),
                quantityUsed: quantity,
                unitPrice: Number(reservation.unitPrice) || Number(tool.costPrice) || 0,
                deductedFromInventory: true,
                toolCost: (Number(reservation.unitPrice) || Number(tool.costPrice) || 0) * quantity,
                notes: usageNote,
                recordedBy: req.user._id,
                usedAt: new Date(),
              },
            },
            { upsert: true }
          );
          reservation.status = "checked_out";
          await reservation.save();
        }
      }
    } catch (e) {
      console.error('[STOCK] Reservation/checkout error:', e.message);
      throw e;
    }

    if (hasInsufficientStock) {
      const prevStatus = booking.status;
      booking.status = "waiting_parts";
      if (!booking.statusHistory) booking.statusHistory = [];
      if (prevStatus !== "waiting_parts") booking.statusHistory.push({
        fromStatus: prevStatus,
        toStatus: "waiting_parts",
        changedBy: tech._id,
        changedByModel: 'Technician',
        changedByName: tech.name || 'Technician',
        reason: `Parts out of stock: ${insufficientItems.map(i => i.itemName).join(', ')}`,
        notes: '',
        timestamp: new Date(),
        metadata: { approvalMethod: 'technician_decision' }
      });
      await booking.save();

      // Notify admin about waiting_parts
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id, status: booking.status,
          message: `On-site approval: Repair started but waiting for parts – ${insufficientItems.map(i => i.itemName).join(', ')}`,
        });
      }

      return res.json({
        success: true,
        status: booking.status,
        waitingParts: true,
        insufficientItems: insufficientItems.map(i => i.itemName),
        message: `Some parts are out of stock: ${insufficientItems.map(i => i.itemName).join(', ')}. Admin has been notified.`
      });
    }

    await transitionRepairStatus(booking, 'repair_in_progress', tech, {
      reason: 'Repair started immediately after inspection',
      metadata: { approvalMethod: 'technician_decision', quotationTotal: booking.quotation?.totalCost || 0 }
    });

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id, status: booking.status,
        message: `On-site approval: Repair started for ${booking.workOrderNumber || booking._id}`,
      });
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id, status: booking.status,
        message: `Your repair has begun! ${booking.workOrderNumber || ""}`,
      });
    }

    return res.json({ success: true, status: booking.status, warranty: booking.warranty });
  } catch (err) {
    console.error("On-site approve error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/notify-quotation
// Send email to customer with quotation for later scheduling (on-site declined)
router.post("/appointments/:id/notify-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    try {
      const { sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail && booking.quotation) {
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation.parts || [],
          laborCost: booking.quotation.laborCost || 0,
          totalCost: booking.quotation.totalCost || 0,
          quotationNotes: booking.quotation.notes || '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send quotation email:", e.message); }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/technician-schedule-later
// Technician chose "Schedule Later" after inspection → auto-approves quotation, sends scheduling email
router.post("/appointments/:id/technician-schedule-later", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    const mixedPhaseOne = getMixedPhaseOnePayment(booking);
    if (mixedPhaseOne.isMixedBooking && !mixedPhaseOne.allCoreCompleted) {
      return res.status(409).json({
        error: "Complete every Core service item before closing the mixed booking's first visit as Schedule Later.",
        code: "CORE_SERVICE_PENDING",
      });
    }
    const phaseOnePaymentMissing = !booking.inspectionFeeCollected
      || (mixedPhaseOne.isMixedBooking && mixedPhaseOne.allCoreCompleted && mixedPhaseOne.amountDue > 0.01);
    if (Number(booking.initialCost || mixedPhaseOne.repairInspectionFee || 0) > 0 && phaseOnePaymentMissing) {
      return res.status(409).json({
        error: mixedPhaseOne.isMixedBooking && mixedPhaseOne.allCoreCompleted
          ? "Collect the Repair inspection and completed Core service balance before closing Phase 1."
          : "Collect the inspection fee before closing Phase 1 for Schedule Later.",
        code: "PHASE_ONE_PAYMENT_REQUIRED",
        amountDue: mixedPhaseOne.amountDue,
      });
    }

    // No dates needed — admin will schedule
    // Auto-approve the quotation (customer approved on-site)
    if (!booking.approval) booking.approval = {};
    booking.approval.status = "approved";
    booking.approval.decidedAt = new Date();
    booking.approval.reason = "Approved on-site by customer (Schedule Later)";

    // Set repair schedule preference
    booking.repairSchedule = {
      preference: "later",
      decidedAt: new Date(),
    };

    // Transition status to repair_approved (admin will handle scheduling), unless waiting for parts
    const prevStatus = booking.status;
    if (prevStatus !== "waiting_parts") {
      booking.status = "repair_approved";
    }
    if (mixedPhaseOne.isMixedBooking) {
      for (const item of booking.services.filter(row => row.type === "repair" && !["completed", "repair_declined", "cancelled"].includes(row.status))) {
        item.status = "repair_approved";
        item.phase = "repair_phase_2";
        item.statusHistory = item.statusHistory || [];
        item.statusHistory.push({
          status: "repair_approved",
          changedAt: new Date(),
          changedBy: tech._id,
          changedByName: tech.name || "Technician",
          reason: booking.status === "waiting_parts"
            ? "Customer approved Schedule Later; waiting for required parts"
            : "Customer approved Schedule Later; awaiting admin schedule",
        });
      }
    }
    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: booking.status,
      reason: "Customer approved on-site, queued for admin scheduling",
      changedBy: req.user._id,
      changedByModel: "Technician",
      changedByName: tech.name || "Technician",
    });

    await booking.save();

    // Schedule Later closes the first on-site visit. Phase 2 receives a fresh
    // assignment from Admin, even when the same technician is selected again.
    const phaseOneAssignment = await Assignment.findOne({
      bookingId: booking._id,
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
    });
    if (phaseOneAssignment) {
      phaseOneAssignment.status = "completed";
      phaseOneAssignment.completedAt = new Date();
      phaseOneAssignment.notes = phaseOneAssignment.notes || [];
      phaseOneAssignment.notes.push({
        text: "Phase 1 Core service and Repair inspection completed; Repair queued for a later Phase 2 visit.",
        by: req.user._id,
        byName: tech.name || "Technician",
        createdAt: new Date(),
      });
      await phaseOneAssignment.save();
      const { resolveAvailabilityStatus } = require("../utils/availability");
      await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
    }

    // Notify admin via socket
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Customer approved quotation for ${booking.workOrderNumber || booking._id} – chose to schedule later.`,
      });
    }

    return res.json({
      success: true,
      status: booking.status,
      phaseOneAssignmentCompleted: Boolean(phaseOneAssignment),
      message: booking.status === "waiting_parts"
        ? "Quotation approved. Waiting for required parts before Admin scheduling."
        : "Quotation approved. Awaiting Admin scheduling.",
    });
  } catch (err) {
    console.error("Technician schedule later error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

function localPurchaseMinuteValue(value) {
  const raw = String(value || '').trim();
  const twelve = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (twelve) {
    let hour = Number(twelve[1]) % 12;
    if (twelve[3].toUpperCase() === 'PM') hour += 12;
    return hour * 60 + Number(twelve[2]);
  }
  const twentyFour = raw.match(/^(\d{1,2}):(\d{2})$/);
  return twentyFour ? Number(twentyFour[1]) * 60 + Number(twentyFour[2]) : NaN;
}

async function evaluateLocalPurchaseFeasibility({ booking, tech, localParts, customerAgreed, supplierName, supplierCanProvide, purchaseMinutes }) {
  const Assignment = require('../models/Assignment');
  const reasons = [];
  if (!Array.isArray(localParts) || !localParts.length) reasons.push('No missing repair part was supplied.');
  const quotedPartNames = new Set((booking.quotation?.parts || []).map(part => String(part.name || '').trim().toLowerCase()).filter(Boolean));
  const invalidParts = (localParts || []).filter(part => !quotedPartNames.has(String(part.partName || '').trim().toLowerCase()));
  if (invalidParts.length) reasons.push(`Local purchase is limited to parts in the approved quotation: ${invalidParts.map(part => part.partName).join(', ')}.`);
  if (!customerAgreed) reasons.push('Customer approval is required.');
  if (!String(supplierName || '').trim() || !supplierCanProvide) reasons.push('Select a supplier and confirm that the missing part may be available.');

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const assignments = await Assignment.find({
    technicianId: tech._id,
    bookingId: { $ne: booking._id },
    bookingDate: { $gte: todayStart, $lte: todayEnd },
    status: { $in: ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'] },
  }).select('bookingId startTime serviceName').lean();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const future = assignments.map(row => ({ ...row, minute: localPurchaseMinuteValue(row.startTime) }))
    .filter(row => Number.isFinite(row.minute) && row.minute > currentMinute).sort((a, b) => a.minute - b.minute);
  const nextBooking = future[0] || null;
  const repairMinutes = Math.max(30, Number(booking.technicianAssistant?.estimatedDurationMinutes) || 90);
  const procurementMinutes = Math.max(15, Math.min(240, Number(purchaseMinutes) || 45));
  const requiredMinutes = procurementMinutes + repairMinutes + 30; // handoff/travel safety buffer
  const companyEndMinute = 17 * 60;
  const availableMinutes = (nextBooking?.minute || companyEndMinute) - currentMinute;
  if (availableMinutes < requiredMinutes) reasons.push(`Purchase, travel buffer and repair need about ${requiredMinutes} minutes, but only ${Math.max(0, availableMinutes)} minutes remain${nextBooking ? ' before the next booking' : ' in the workday'}.`);
  return {
    possible: reasons.length === 0, reasons, requiredMinutes, availableMinutes,
    procurementMinutes, repairMinutes,
    nextBooking: nextBooking ? { bookingId: nextBooking.bookingId, serviceName: nextBooking.serviceName, startTime: nextBooking.startTime } : null,
  };
}

router.post('/appointments/:id/local-purchase-feasibility', async (req, res) => {
  try {
    const BookingService = require('../models/BookingService');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician profile not found' });
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (String(booking.technicianId) !== String(tech._id)) return res.status(403).json({ error: 'Not assigned to this booking' });
    const result = await evaluateLocalPurchaseFeasibility({ booking, tech, ...req.body });
    return res.status(result.possible ? 200 : 409).json(result);
  } catch (error) {
    console.error('Local purchase feasibility error:', error);
    return res.status(500).json({ error: 'Could not evaluate local purchase availability.' });
  }
});

// POST /appointments/:id/local-purchase-repair
// Technician buys missing parts locally and starts repair immediately
router.post("/appointments/:id/local-purchase-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const StockReservation = require("../models/StockReservation");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (!["inspection_completed"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot start repair from status: ${booking.status}. Expected inspection_completed.` });
    }

    const {
      localParts = [], purchaseBy = 'technician', customerAgreed = false,
      supplierName = '', supplierAddress = '', supplierContact = '',
      supplierCanProvide = false, purchaseMinutes = 45,
    } = req.body;
    // localParts: [{ partName, quotedCustomerPrice, actualPurchaseCost, toolId }]

    if (!localParts.length) {
      return res.status(400).json({ error: "No local parts provided." });
    }
    if (!['technician', 'customer'].includes(purchaseBy)) return res.status(400).json({ error: 'Purchase By must be technician or customer.' });

    const feasibility = await evaluateLocalPurchaseFeasibility({ booking, tech, localParts, customerAgreed, supplierName, supplierCanProvide, purchaseMinutes });
    if (!feasibility.possible) return res.status(409).json({ error: 'local_purchase_not_feasible', message: feasibility.reasons.join(' '), feasibility });

    // Local purchase cost is a company cost, not an automatic customer charge.
    // A cost above the quoted part revenue reduces margin but does not mutate or
    // invalidate the customer's already-approved quotation.

    // Record approval
    booking.approval = {
      status: "approved",
      decidedAt: new Date(),
      reason: "Approved on-site — local parts purchase",
    };

    // Record local purchase records
    booking.localPurchase = localParts.map(p => ({
      partName: p.partName,
      toolId: p.toolId || null,
      quotedCustomerPrice: p.quotedCustomerPrice,
      expectedPurchaseCost: Number(p.expectedPurchaseCost ?? p.actualPurchaseCost) || 0,
      actualPurchaseCost: 0,
      source: "External Supplier",
      supplierName: String(supplierName).trim(), supplierAddress: String(supplierAddress).trim(), supplierContact: String(supplierContact).trim(),
      supplierAvailabilityConfirmed: true,
      purchaseByType: purchaseBy,
      purchasedBy: purchaseBy === 'technician' ? tech._id : null,
      purchasedByName: purchaseBy === 'technician' ? (tech.name || "Technician") : (booking.customer?.name || 'Customer'),
      purchaseStatus: purchaseBy === 'technician' ? 'pending' : 'awaiting_customer',
      adminVerificationStatus: purchaseBy === 'technician' ? 'pending' : 'not_required',
      notes: "",
    }));

    // Mark quotation parts as external_purchase where applicable
    if (booking.quotation && booking.quotation.parts) {
      for (const lp of localParts) {
        const qPart = booking.quotation.parts.find(
          qp => qp.name === lp.partName && (!lp.toolId || String(qp.toolId) === String(lp.toolId))
        );
        if (qPart) {
          qPart.source = "external_purchase";
        }
      }
    }

    // Do not start the repair yet. Technician purchases require a receipt and
    // actual cost; customer purchases require technician part verification.
    await booking.save();
    return res.json({
      success: true,
      awaitingPurchase: true,
      purchaseBy,
      requiresReceipt: purchaseBy === 'technician',
      requiresCustomerPartVerification: purchaseBy === 'customer',
      localPurchase: booking.localPurchase,
      feasibility,
      message: purchaseBy === 'technician'
        ? 'Purchase plan recorded. Upload the receipt and actual cost before starting repair.'
        : 'Customer purchase plan recorded. Verify the customer-provided part before starting repair.',
    });

    // Attempt to reserve stock for any remaining company-inventory parts
    let hasInsufficientStock = false;
    let insufficientItems = [];
    try {
      const companyParts = (booking.quotation?.parts || []).filter(
        p => p.source !== "external_purchase"
      );
      if (companyParts.length > 0) {
        const { reservations, insufficientStock } = await StockReservation.reserveForBooking({
          bookingId: booking._id,
          parts: companyParts,
          reservedBy: req.user._id,
        });
        if (insufficientStock.length > 0) {
          hasInsufficientStock = true;
          insufficientItems = insufficientStock;
        }
      }
    } catch (e) { console.error('[STOCK] Reservation error in local-purchase:', e.message); }

    if (hasInsufficientStock) {
      // Some non-external parts are still missing — cannot proceed
      booking.approval.status = "pending";
      booking.localPurchase = [];
      await booking.save();
      return res.status(400).json({
        error: "remaining_parts_out_of_stock",
        message: `Still missing company-inventory parts: ${insufficientItems.map(i => i.itemName).join(', ')}. Cannot start repair.`,
        insufficientItems: insufficientItems.map(i => i.itemName),
      });
    }

    // Transition to repair_in_progress
    const prevStatus = booking.status;
    await transitionRepairStatus(booking, 'repair_in_progress', tech, {
      reason: 'Repair started — local parts purchase',
      metadata: {
        approvalMethod: 'local_purchase',
        localPartsCount: localParts.length,
        totalLocalCost: localParts.reduce((s, p) => s + (p.actualPurchaseCost || 0), 0),
        quotationTotal: booking.quotation?.totalCost || 0,
      }
    });

    await booking.save();

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Local purchase repair started for ${booking.workOrderNumber || booking._id}. Parts: ${localParts.map(p => p.partName).join(', ')}`,
      });
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Your repair has begun! ${booking.workOrderNumber || ""}`,
      });
    }

    // Create Expense records for each local purchase (external_parts type)
    try {
      const Expense = require("../models/Expense");
      for (const lp of booking.localPurchase) {
        await Expense.create({
          technicianId: tech._id,
          technicianName: tech.name || "Technician",
          type: "external_parts",
          amount: lp.actualPurchaseCost || 0,
          description: `Local purchase: ${lp.partName} for ${booking.workOrderNumber || booking._id}`,
          bookingId: booking._id,
          receiptImage: lp.receiptUrl || "",
          expenseDate: lp.purchasedAt || new Date(),
        });
      }
    } catch (e) { console.error('[EXPENSE] Failed to create expense records:', e.message); }

    return res.json({
      success: true,
      status: booking.status,
      localPurchase: booking.localPurchase,
      message: "Local purchase recorded. Repair started.",
    });
  } catch (err) {
    console.error("Local purchase repair error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/local-purchase-receipt
// Technician uploads receipt for a local purchase item
router.post("/appointments/:id/local-purchase-receipt", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { partIndex, receiptUrl, actualPurchaseCost, quantity = 1, notes = '' } = req.body;
    if (partIndex == null || !receiptUrl || !(Number(actualPurchaseCost) > 0)) {
      return res.status(400).json({ error: "partIndex, receipt, and actual purchase cost are required." });
    }

    if (!booking.localPurchase || !booking.localPurchase[partIndex]) {
      return res.status(400).json({ error: "Local purchase item not found." });
    }

    const purchase = booking.localPurchase[partIndex];
    if (purchase.purchaseByType !== 'technician') return res.status(400).json({ error: 'Receipt expense is only applicable to technician purchases.' });
    purchase.receiptUrl = receiptUrl;
    purchase.actualPurchaseCost = Number(actualPurchaseCost);
    purchase.purchaseStatus = "receipt_uploaded";
    purchase.purchasedAt = new Date();
    purchase.notes = `${notes || ''}${notes ? ' · ' : ''}Quantity: ${Math.max(1, Number(quantity) || 1)}`;
    purchase.adminVerificationStatus = 'pending';

    const Expense = require('../models/Expense');
    await Expense.findOneAndUpdate(
      { bookingId: booking._id, technicianId: tech._id, type: 'external_parts', description: { $regex: `^Local purchase: ${String(purchase.partName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } },
      { technicianId: tech._id, technicianName: tech.name || 'Technician', type: 'external_parts', amount: purchase.actualPurchaseCost,
        description: `Local purchase: ${purchase.partName} from ${purchase.supplierName || 'External Supplier'} for ${booking.workOrderNumber || booking._id}`,
        bookingId: booking._id, receiptImage: receiptUrl, expenseDate: purchase.purchasedAt, status: 'pending' },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    const technicianPurchases = booking.localPurchase.filter(row => row.purchaseByType === 'technician');
    const allReceiptsUploaded = technicianPurchases.length > 0 && technicianPurchases.every(row => row.receiptUrl && Number(row.actualPurchaseCost) > 0);
    if (allReceiptsUploaded) {
      await transitionRepairStatus(booking, 'repair_in_progress', tech, { reason: 'Local purchase receipts and actual costs recorded', metadata: { source: 'external_supplier', inventoryDeduction: 0 } });
    }
    await booking.save();

    return res.json({ success: true, repairStarted: allReceiptsUploaded, status: booking.status, message: allReceiptsUploaded ? "Receipt recorded. Repair started." : "Receipt recorded. Complete the remaining purchase records." });
  } catch (err) {
    console.error("Local purchase receipt error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/request-parts
// Technician reports missing parts → status: waiting_parts, creates parts request, notifies admin + customer
router.post("/appointments/:id/request-parts", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id)
      .populate("customerId", "name email phone")
      .populate("service", "name");
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const missingParts = [...new Set((Array.isArray(req.body.missingParts) ? req.body.missingParts : [])
      .map(name => String(name || '').trim()).filter(Boolean))];
    if (!missingParts.length) return res.status(400).json({ error: 'At least one unavailable part is required.' });

    // Requesting an AI-recommended part is an explicit technician decision to
    // accept that diagnosis. Persist the review so fulfillment can advance the
    // workflow instead of returning to a stale "Review AI Diagnosis" step.
    const recommendedNames = new Set((booking.technicianAssistant?.possibleParts || [])
      .map(part => String(typeof part === 'string' ? part : part?.name || '').trim().toLowerCase())
      .filter(Boolean));
    if (booking.technicianAssistant?.summary
      && missingParts.some(name => recommendedNames.has(name.toLowerCase()))) {
      booking.technicianAssistant.verifiedByTechnician = true;
      booking.technicianAssistant.verifiedAt = new Date();
    }

    // Transition to waiting_parts
    const prevStatus = booking.status;
    booking.status = "waiting_parts";
    if (prevStatus !== 'waiting_parts') {
      booking.recordStatusHistory({
        fromStatus: prevStatus,
        toStatus: "waiting_parts",
        reason: `Parts out of stock: ${missingParts.join(', ')}`,
        changedBy: req.user._id,
        changedByModel: "Technician",
        changedByName: tech.name || "Technician",
      });
    }

    // Merge with an existing open request so retries do not duplicate items.
    const existingItems = new Map((booking.partsRequest?.items || [])
      .map(item => [String(item.itemName || '').trim().toLowerCase(), item]));
    for (const name of missingParts) {
      const key = name.toLowerCase();
      if (!existingItems.has(key)) existingItems.set(key, { itemName: name, requestedQty: 1, availableQty: 0, status: 'waiting' });
    }
    booking.partsRequest = {
      status: "pending",
      requestedAt: new Date(),
      requestedBy: req.user._id,
      resumeStatus: booking.partsRequest?.resumeStatus || prevStatus,
      items: [...existingItems.values()],
    };

    // The admin procurement workflow reads the dedicated PartsRequest model.
    // Keep it synchronized with the booking snapshot and merge retries.
    const PartsRequest = require('../models/PartsRequest');
    let procurementRequest = await PartsRequest.findOne({
      bookingId: booking._id,
      status: { $in: ['pending', 'procuring'] },
    });
    if (!procurementRequest) {
      procurementRequest = new PartsRequest({
        bookingId: booking._id,
        workOrderNumber: booking.workOrderNumber,
        customerId: booking.customerId?._id || booking.customerId,
        customerName: booking.customerId?.name || booking.customer?.name || 'Customer',
        technicianId: tech._id,
        technicianName: tech.name || 'Technician',
        requestedBy: req.user._id,
        requestedAt: new Date(),
        resumeStatus: prevStatus,
        status: 'pending',
        items: [],
      });
    }
    const procurementNames = new Set(procurementRequest.items.map(item => String(item.itemName || '').trim().toLowerCase()));
    for (const name of missingParts) {
      if (procurementNames.has(name.toLowerCase())) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inventoryItem = await Tool.findOne({
        active: { $ne: false },
        $and: [Tool.merchandiseFilter()],
        itemName: { $regex: new RegExp(`^${escaped}$`, 'i') },
      }).select('_id itemName quantity reservedQuantity').lean();
      procurementRequest.items.push({
        toolId: inventoryItem?._id || null,
        itemName: inventoryItem?.itemName || name,
        requestedQty: 1,
        availableQty: Math.max(0, Number(inventoryItem?.quantity || 0) - Number(inventoryItem?.reservedQuantity || 0)),
        status: 'waiting',
      });
      procurementNames.add(name.toLowerCase());
    }
    await procurementRequest.save();

    await booking.save();

    // Notify admin via socket
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: "waiting_parts",
        message: `Parts request created for booking ${booking.workOrderNumber || booking._id}: ${missingParts.join(', ')}`,
      });
    }

    // Send customer notification email
    try {
      const { sendPartsRequestEmail } = require("../utils/mailer");
      const customerEmail = booking.customerId?.email || booking.customer?.email;
      if (customerEmail && typeof sendPartsRequestEmail === "function") {
        await sendPartsRequestEmail({
          to: customerEmail,
          customerName: booking.customerId?.name || booking.customer?.name || "Customer",
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || "Repair Service",
          missingParts,
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send parts request email:", e.message); }

    return res.json({
      success: true,
      status: "waiting_parts",
      missingParts,
      message: `Parts request created. Status set to Waiting for Parts.`,
    });
  } catch (err) {
    console.error("[REQUEST-PARTS]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/technician-decline-repair
// Technician chose "Decline" after inspection → booking status: repair_declined
// Repair-only bookings close here. Mixed bookings keep the assignment active
// until their Core service items are also finished.
router.post("/appointments/:id/technician-decline-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const { resolveAvailabilityStatus } = require("../utils/availability");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    const isMixedBooking = booking.serviceType === 'mixed'
      || ((booking.services || []).some(item => item.type === 'core')
        && (booking.services || []).some(item => item.type === 'repair'));
    const requiredInspectionFee = isMixedBooking
      ? (booking.services || []).filter(item => item.type === 'repair')
        .reduce((sum, item) => sum + Math.max(0, Number(item.totalPrice || ((item.unitPrice || 0) * (item.quantity || 1))) || 0), 0)
      : Number(booking.initialCost || 0);
    if (requiredInspectionFee > 0 && !booking.inspectionFeeCollected) {
      return res.status(409).json({ error: "Collect the inspection fee before closing a declined repair.", code: "INSPECTION_FEE_REQUIRED" });
    }
    if (isMixedBooking) {
      // A declined quotation is not chargeable. Keep only the original mixed
      // booking lines (Core + inspection + travel) in the shared ledger.
      const initialBookingTotal = Math.max(0, Number(booking.totalPrice || booking.estimatedFee) || 0);
      booking.balanceAmount = Math.max(0, initialBookingTotal - Number(booking.amountPaid || 0));
      booking.balanceCollected = booking.balanceAmount === 0;
      await booking.save();
      const coreAlreadyFinished = (booking.services || []).filter(item => item.type === 'core')
        .every(item => ['completed', 'cancelled'].includes(item.status));
      if (coreAlreadyFinished && booking.balanceAmount > 0) {
        return res.status(409).json({
          error: `Collect the remaining booking balance of ₱${booking.balanceAmount.toLocaleString()} before closing the mixed booking.`,
          code: 'BOOKING_BALANCE_REQUIRED',
          balanceAmount: booking.balanceAmount,
        });
      }
    }

    const { reason } = req.body;

    booking.approval = {
      status: "declined",
      decidedAt: new Date(),
      reason: reason || "Declined by technician – customer did not approve",
    };

    await transitionRepairStatus(booking, 'repair_declined', tech, {
      reason: reason || 'Customer declined repair after inspection',
      notes: reason || 'Repair declined',
      metadata: {
        quotationTotal: booking.quotation?.totalCost || 0,
        declinedBy: 'technician_on_site'
      }
    });

    // ── Mark the assignment as declined to free the time slot ────────────
    const terminalStatuses = ["completed", "cancelled", "declined", "no_show"];
    const _activeStatuses = ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'];
    let assignment = await Assignment.findById(booking.assignmentId)
      || await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id, status: { $in: _activeStatuses } }).sort({ assignedAt: -1 });
    let remainingCoreItems = [];
    if (isMixedBooking) {
      remainingCoreItems = (booking.services || []).filter(item =>
        item.type === 'core' && !['completed', 'cancelled'].includes(item.status)
      );
      const allItemsFinished = (booking.services || []).length > 0
        && booking.services.every(item => ['completed', 'cancelled', 'repair_declined'].includes(item.status));
      const aggregateStatus = allItemsFinished ? 'completed' : 'in-progress';
      const aggregateAt = new Date();
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        fromStatus: booking.status,
        toStatus: aggregateStatus,
        changedBy: tech._id,
        changedByModel: 'Technician',
        changedByName: tech.name || 'Technician',
        reason: allItemsFinished
          ? 'Repair declined and all remaining mixed-booking work is finished'
          : 'Repair declined; Core service work remains active',
        timestamp: aggregateAt,
        metadata: { remainingCoreItems: remainingCoreItems.length },
      });
      booking.status = aggregateStatus;
      if (allItemsFinished) booking.completedAt = booking.completedAt || aggregateAt;
      await booking.save();

      if (assignment && !terminalStatuses.includes(assignment.status)) {
        assignment.status = allItemsFinished ? 'completed' : 'in_progress';
        assignment.completedAt = allItemsFinished ? aggregateAt : null;
        assignment.notes.push({
          text: allItemsFinished
            ? 'Repair declined; all mixed-booking service components are finished.'
            : `Repair declined; ${remainingCoreItems.length} Core service item(s) remain active.`,
          by: req.user._id,
          byName: tech.name,
          createdAt: aggregateAt,
        });
        await assignment.save();
      }
    }

    if (!isMixedBooking && assignment && !terminalStatuses.includes(assignment.status)) {
      const now = new Date();
      assignment.status = "declined";
      assignment.declinedAt = now;
      assignment.declineReason = reason || "Technician declined repair after inspection";
      assignment.notes.push({
        text: `Assignment declined — repair declined after inspection. ${reason || ''}`.trim(),
        by: req.user._id,
        byName: tech.name,
        createdAt: now,
      });
      await assignment.save();
    }

    // ── Detach technician from booking so the slot is freed ───────────────
    if (!isMixedBooking) await BookingService.findByIdAndUpdate(booking._id, {
      $set: { technicianId: null, assignmentId: null },
    });

    // ── Resolve technician availability ──────────────────────────────────
    const resolvedStatus = isMixedBooking && remainingCoreItems.length > 0
      ? 'In Progress'
      : await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
    tech.availabilityStatus = resolvedStatus;
    await tech.save();

    // ── Notify admin ─────────────────────────────────────────────────────
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Repair declined for ${booking.workOrderNumber || booking._id}`,
      });
      if (!isMixedBooking) global.io.to("admin-room").emit("assignment:declined", {
        assignmentId: assignment?._id,
        bookingId: booking._id,
        technicianName: tech.name,
        reason: `Repair declined: ${reason || 'Customer declined'}`,
        customerName: assignment?.customerName || booking.customer?.name,
        serviceName: assignment?.serviceName || 'Service',
        bookingDate: assignment?.bookingDate || booking.bookingDate,
      });
    }

    // ── Notify customer ──────────────────────────────────────────────────
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, "Repair Service Update",
          `Dear ${booking.customer.name || 'Customer'},

We wanted to inform you that the repair service for work order ${booking.workOrderNumber || ''} has been declined.

${reason ? `Reason: ${reason}` : ''}

If you have any questions or would like to reschedule, please contact us.

Thank you,
RACS Team`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({
      success: true,
      status: booking.status,
      mixedBooking: isMixedBooking,
      remainingCoreItems: remainingCoreItems.map(item => ({ _id: item._id, name: item.name, status: item.status })),
    });
  } catch (err) {
    console.error("Technician decline repair error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/start-repair
// Technician starts repair work → booking status: repair_in_progress
router.post("/appointments/:id/start-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["ready_for_repair", "scheduled", "repair_scheduled", "repair_approved", "on-the-way", "arrived"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot start repair from status: ${booking.status}` });
    }

    // Check parts availability — prevent starting if parts are out of stock
    const quotation = booking.quotation || {};
    const parts = quotation.parts || [];
    const checkedParts = parts.filter(p => p.checked !== false);
    const EquipmentAssignment = require("../models/EquipmentAssignment");
    const Tool = require("../models/Tool");
    const outOfStockParts = [];
    for (const p of checkedParts) {
      if (p.toolId) {
        try {
          const tool = await Tool.findById(p.toolId);
          if (!tool || tool.quantity < (p.quantity || 1)) {
            outOfStockParts.push(p.name || 'Unknown part');
          }
        } catch (e) { /* skip if tool lookup fails */ }
      }
    }
    if (outOfStockParts.length > 0) {
      return res.status(400).json({ error: `Cannot start repair: parts out of stock: ${outOfStockParts.join(', ')}` });
    }

    // Enterprise: Use safe status transition with audit trail
    await transitionRepairStatus(booking, 'repair_in_progress', tech, {
      reason: 'Repair work started',
      metadata: {
        repairStartedAt: new Date(),
        estimatedDuration: booking.technicianAssistant?.estimatedDurationMinutes || null,
        safetyReminders: booking.technicianAssistant?.safetyReminders || []
      }
    });

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Repair started for ${booking.workOrderNumber || booking._id}`,
      });
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Your repair has begun! ${booking.workOrderNumber || ""}`,
      });
    }

    return res.json({
      success: true,
      status: booking.status,
      estimatedDuration: booking.technicianAssistant?.estimatedDurationMinutes || null,
      safetyReminders: booking.technicianAssistant?.safetyReminders || []
    });
  } catch (err) {
    console.error("Start repair error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/save-materials
// Save materials/tools used without completing the repair
router.post("/appointments/:id/save-materials", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { partsInstalled, actionsPerformed, completionNotes } = req.body;

    booking.repairCompletion = {
      partsInstalled: partsInstalled || [],
      actionsPerformed: actionsPerformed || [],
      completionNotes: completionNotes || "",
      completedAt: null,
    };
    await booking.save();

    return res.json({ success: true, repairCompletion: booking.repairCompletion });
  } catch (err) {
    console.error("Save materials error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/collect-repair-payment
// Technician collects the full quotation payment for a completed repair
// Body: { amount, method, proofUrl? }
router.post("/appointments/:id/collect-repair-payment", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (!["repair_in_progress", "arrived", "in-progress"].includes(booking.status)) {
      return res.status(400).json({ error: "Can only collect payment when repair is in progress." });
    }
    if (booking.repairPaymentCollected) {
      return res.json({
        success: true,
        alreadyCollected: true,
        message: "Repair payment was already recorded. Continue to proof of completion.",
        booking: {
          repairPaymentCollected: true,
          repairPaymentAmount: booking.repairPaymentAmount,
          repairPaymentMethod: booking.repairPaymentMethod,
          amountPaid: booking.amountPaid,
        },
      });
    }

    const { amount, method, proofUrl } = req.body;
    if (!proofUrl || typeof proofUrl !== "string") {
      return res.status(400).json({ error: "Proof of payment is required before the repair payment can be recorded." });
    }
    const quotationTotal = Math.max(0, Number(booking.quotation?.totalCost) || 0);
    const isMixedBooking = booking.serviceType === 'mixed'
      || ((booking.services || []).some(item => item.type === 'core')
        && (booking.services || []).some(item => item.type === 'repair'));
    const mixedRepairInspectionFee = isMixedBooking
      ? (booking.services || []).filter(item => item.type === 'repair')
        .reduce((sum, item) => sum + Math.max(0, Number(item.totalPrice || ((item.unitPrice || 0) * (item.quantity || 1))) || 0), 0)
      : 0;
    const inspectionFee = Math.max(0, Number(
      booking.inspectionFeeAmount || mixedRepairInspectionFee || booking.initialCost
      || booking.totalInitialCost || booking.servicePrice || booking.estimatedFee
    ) || 0);
    const distanceFare = Math.max(0, Number(booking.inspectionFeeDistanceFare || booking.travelFare) || 0);
    const phase1Settled = Boolean(booking.inspectionFeeCollected);
    // The booking downpayment is a Phase 1 inspection credit only. It must
    // never discount the approved Phase 2 repair quotation.
    const downpaymentCredit = phase1Settled
      ? Math.max(0, Number(booking.downpaymentAppliedToInspection) || 0)
      : Math.min(Math.max(0, Number(booking.downpaymentAmount) || 0), inspectionFee + distanceFare);
    const phase1CashDue = phase1Settled ? 0 : Math.max(0, inspectionFee + distanceFare - downpaymentCredit);
    const initialBookingTotal = isMixedBooking
      ? getMixedPhaseOnePayment(booking).phaseOneTarget
      : Math.max(0, Number(booking.totalPrice || booking.estimatedFee) || 0);
    const finalAmountDue = isMixedBooking
      ? Math.max(0, initialBookingTotal + quotationTotal - Number(booking.amountPaid || 0))
      : phase1Settled
        ? quotationTotal
        : quotationTotal + phase1CashDue;
    const collected = Number(amount);
    if (!Number.isFinite(collected) || collected <= 0 || Math.abs(collected - finalAmountDue) > 0.01) {
      return res.status(400).json({ error: `Final payment must equal the remaining balance of ₱${finalAmountDue.toLocaleString()}.`, finalAmountDue });
    }

    // Record payment
    booking.repairPaymentCollected = true;
    booking.repairPaymentAmount = quotationTotal;
    booking.repairPaymentMethod = method || "cash";
    booking.repairPaymentCollectedAt = new Date();
    booking.repairPaymentCollectedBy = tech._id;
    booking.repairPaymentProof = proofUrl;

    // Update booking payment totals
    booking.amountPaid = (booking.amountPaid || 0) + collected;
    booking.balanceAmount = 0;
    booking.balanceCollected = true;
    booking.balanceCollectedAt = booking.repairPaymentCollectedAt;
    booking.balanceCollectedBy = tech._id;
    booking.paymentStatus = "waiting_for_remittance";
    if (!booking.inspectionFeeCollected && (inspectionFee > 0 || distanceFare > 0)) {
      booking.inspectionFeeCollected = true;
      booking.inspectionFeeAmount = inspectionFee;
      booking.inspectionFeeDistanceFare = distanceFare;
      booking.inspectionFeeTotalCollected = phase1CashDue;
      booking.downpaymentAppliedToInspection = downpaymentCredit;
      booking.inspectionFeeMethod = method || "cash";
      booking.inspectionFeeCollectedAt = booking.repairPaymentCollectedAt;
    }

    await booking.save();

    const methodMap = { cash: 'cod', cod: 'cod', gcash: 'gcash', maya: 'other', bank_transfer: 'bank' };
    const mappedMethod = methodMap[method] || methodMap["cash"];

    // Payment record
    await Payment.create({
      bookingId: booking._id,
      amount: collected,
      method: mappedMethod,
      type: "final",
      gateway: mappedMethod,
      status: "waiting_for_remittance",
      reference: `Repair payment collected by ${tech.name}`,
      proofUrl: proofUrl || "",
      collectedBy: tech._id,
      collectedByName: tech.name,
      collectedAt: booking.repairPaymentCollectedAt,
      events: [
        { status: "payment_collected", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: booking.repairPaymentCollectedAt },
        { status: "waiting_for_remittance", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: booking.repairPaymentCollectedAt },
      ],
      notes: `Repair quotation payment of ₱${collected.toLocaleString()} collected by technician ${tech.name}`,
    });

    // Notify admin
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "payment_collected",
      title: "Repair Payment Collected",
      message: `${tech.name} collected ₱${collected.toLocaleString()} for repair of ${booking.workOrderNumber || booking._id}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      io,
    });

    // Socket notify customer
    if (global.io) {
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Payment of ₱${collected.toLocaleString()} received for your repair.`,
      });
    }

    return res.json({
      success: true,
      message: `Repair payment of ₱${collected.toLocaleString()} collected successfully.`,
      paymentLedger: { inspectionFee, distanceFare, downpaymentAppliedToInspection: downpaymentCredit, phase1CashDue, repairTotal: quotationTotal, collected, balance: 0 },
      booking: {
        repairPaymentCollected: true,
        repairPaymentAmount: quotationTotal,
        repairPaymentMethod: method || "cash",
        amountPaid: booking.amountPaid,
      },
    });
  } catch (err) {
    console.error("Collect repair payment error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// POST /appointments/:id/upload-proof
// Multer-based proof of payment upload for repair payment
const repairProofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/proofs')),
    filename: (req, file, cb) => cb(null, 'proof-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  },
}).single('proofPhoto');

const proofsDir = path.join(__dirname, '../public/uploads/proofs');
if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });

router.post("/appointments/:id/upload-proof", (req, res, next) => {
  repairProofUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: '/uploads/proofs/' + req.file.filename });
  });
});

// POST /appointments/:id/complete-repair
// Technician completes repair → booking status: repair_completed + warranty + invoice
router.post("/appointments/:id/complete-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id }).populate("user", "firstName lastName name email");
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["ready_for_repair", "scheduled", "repair_approved", "repair_in_progress", "inspection_completed", "awaiting_approval", "repair_completed", "arrived", "in-progress"];
    const alreadyCompleted = booking.status === "repair_completed";
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot complete repair from status: ${booking.status}` });
    }

    // Require payment collection before completing repair
    const paymentRequired = (booking.quotation?.totalCost || 0) + (booking.travelFare || 0);
    const paymentSettled = Boolean(booking.repairPaymentCollected || booking.balanceCollected);
    if (paymentRequired > 0 && !paymentSettled) {
      return res.status(400).json({ error: "Payment must be collected before completing the repair." });
    }

    // Backfill repair-specific payment metadata for older payments collected
    // through the shared final-balance endpoint. This keeps later invoices,
    // reports, and reloads on the same authoritative state.
    if (paymentRequired > 0 && booking.balanceCollected && !booking.repairPaymentCollected) {
      booking.repairPaymentCollected = true;
      booking.repairPaymentAmount = paymentRequired;
      booking.repairPaymentMethod = booking.repairPaymentMethod || booking.paymentMethod || "cash";
      booking.repairPaymentCollectedAt = booking.repairPaymentCollectedAt || booking.balanceCollectedAt || new Date();
      booking.repairPaymentCollectedBy = booking.repairPaymentCollectedBy || booking.balanceCollectedBy || tech._id;
    }

    const { completionNotes, actionsPerformed, partsInstalled, proofUrl } = req.body || {};
    if (!String(proofUrl || "").startsWith("/uploads/proofs/")) {
      return res.status(400).json({ error: "A valid proof-of-completion photo is required." });
    }

    // Auto-start repair if not already in progress
    if (!alreadyCompleted && booking.status !== "repair_in_progress") {
      await transitionRepairStatus(booking, 'repair_in_progress', tech, {
        reason: 'Auto-started repair for completion',
      });
    }

    // Save materials/parts used on the booking (safe — won't crash if field missing)
    try {
      booking.repairCompletion = {
        partsInstalled: partsInstalled || [],
        actionsPerformed: actionsPerformed || [],
        completionNotes: completionNotes || "",
        completedAt: new Date(),
      };
      booking.proofPhoto = proofUrl;
    } catch (e) { console.error("repairCompletion set error:", e.message); }

    // Snapshot the configured repair warranty for this completion.
    const configuredWarranty = await configuredBookingWarranty(booking, new Date());
    const warrantyDays = configuredWarranty.rule.enabled ? configuredWarranty.rule.days : 0;
    try {
      if (configuredWarranty.coverage) booking.warranty = configuredWarranty.coverage;
    } catch (e) { console.error("warranty set error:", e.message); }

    // Transition to repair_completed
    if (!alreadyCompleted) {
      await transitionRepairStatus(booking, 'repair_completed', tech, {
        reason: 'Repair completed',
        notes: completionNotes || '',
        metadata: {
          completionNotes,
          actionsPerformed: actionsPerformed || [],
          partsInstalled: partsInstalled || [],
          warrantyDays,
          warrantyEnd: booking.warranty?.endDate,
          proofUrl,
        }
      });
    }

    // A mixed booking is one shared visit with independent Core and Repair
    // workstreams. Completing Repair must not close the assignment while any
    // Core item is still unfinished.
    const repairCompletedAt = new Date();
    for (const serviceItem of booking.services || []) {
      if (serviceItem.type !== 'repair' || serviceItem.status === 'completed') continue;
      serviceItem.status = 'completed';
      serviceItem.phase = 'repair_phase_2';
      serviceItem.statusHistory = serviceItem.statusHistory || [];
      serviceItem.statusHistory.push({
        status: 'completed',
        changedAt: repairCompletedAt,
        changedBy: tech._id,
        changedByName: tech.name || 'Technician',
        reason: 'Repair completed with proof of completion',
      });
    }

    const isMixedBooking = booking.serviceType === 'mixed'
      || ((booking.services || []).some(item => item.type === 'core')
        && (booking.services || []).some(item => item.type === 'repair'));
    const remainingCoreItems = (booking.services || []).filter(
      item => item.type === 'core' && item.status !== 'completed'
    );
    const allServiceItemsCompleted = (booking.services || []).length > 0
      && booking.services.every(item => item.status === 'completed');

    if (isMixedBooking) {
      const aggregateStatus = allServiceItemsCompleted ? 'completed' : 'in-progress';
      if (booking.status !== aggregateStatus) {
        booking.statusHistory = booking.statusHistory || [];
        booking.statusHistory.push({
          fromStatus: booking.status,
          toStatus: aggregateStatus,
          changedBy: tech._id,
          changedByModel: 'Technician',
          changedByName: tech.name || 'Technician',
          reason: allServiceItemsCompleted
            ? 'All Core and Repair service items completed'
            : 'Repair completed; Core service work remains active',
          timestamp: repairCompletedAt,
          metadata: { remainingCoreItems: remainingCoreItems.length },
        });
      }
      booking.status = aggregateStatus;
      if (allServiceItemsCompleted) booking.completedAt = booking.completedAt || repairCompletedAt;
    }

    // Set SLA resolution tracking (safe)
    try {
      if (booking.slaTracking && typeof booking.slaTracking === 'object') {
        booking.slaTracking.resolutionAt = new Date();
        if (booking.slaTracking.resolutionTarget && new Date() > booking.slaTracking.resolutionTarget) {
          booking.slaTracking.resolutionBreached = true;
        }
      }
    } catch (e) { /* non-critical */ }

    await booking.save();

    try {
      booking.maintenance = booking.maintenance || {};
      const requestedInterval = String(req.body?.nextMaintenanceDays || "").trim()
        ? Math.min(730, Math.max(30, Number(req.body.nextMaintenanceDays)))
        : null;
      if (Number.isFinite(requestedInterval)) booking.maintenance.nextRecommendedDays = requestedInterval;
      booking.maintenance.nextRecommendationNotes = String(
        req.body?.nextMaintenanceNotes || completionNotes || "",
      ).slice(0, 1000);
      await booking.save();
      const { syncMaintenanceFromBooking } = require("../utils/maintenanceLifecycle");
      await syncMaintenanceFromBooking(booking, {
        intervalDays: requestedInterval || undefined,
        notes: booking.maintenance.nextRecommendationNotes,
        recommendedBy: tech._id,
        recommendedByName: tech.name || "Technician",
      });
    } catch (maintenanceError) {
      console.error("Failed to create repair maintenance schedules:", maintenanceError.message);
    }

    // Fulfill stock reservations (convert to ServiceToolUsage records)
    try {
      const StockReservation = require("../models/StockReservation");
      await StockReservation.fulfillForBooking({
        bookingId: booking._id,
        technicianId: tech._id,
        recordedBy: req.user._id,
      });
    } catch (e) { console.error('[STOCK] Fulfillment error:', e.message); }

    // Set assignment to completed (atomic update — always runs)
    const Assignment = require("../models/Assignment");
    const assignmentCompleted = !isMixedBooking || allServiceItemsCompleted;
    const assignmentUpdate = assignmentCompleted
      ? { status: "completed", completedAt: repairCompletedAt, proofPhoto: proofUrl }
      : { status: "in_progress", completedAt: null, proofPhoto: proofUrl };
    const assignmentPush = {};
    if (completionNotes) {
      assignmentPush.notes = {
        text: "[Repair Complete] " + completionNotes,
        by: req.user._id,
        byName: tech.name,
        createdAt: new Date(),
      };
    }
    const updatedAssignment = await Assignment.findOneAndUpdate(
      { bookingId: booking._id, technicianId: tech._id },
      { $set: assignmentUpdate, ...(Object.keys(assignmentPush).length ? { $push: assignmentPush } : {}) },
      { returnDocument: "after" }
    );
    if (!updatedAssignment) {
      console.error(`Assignment not found for booking ${booking._id} tech ${tech._id}`);
    }

    // Socket notifications (safe)
    try {
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          priority: booking.priority,
          message: `Repair completed for ${booking.workOrderNumber || booking._id}`,
        });
        const warrantyEndStr = booking.warranty?.endDate ? booking.warranty.endDate.toLocaleDateString() : null;
        global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: warrantyEndStr
            ? `Your repair has been completed! Warranty until ${warrantyEndStr}.`
            : "Your repair has been completed.",
        });
      }
    } catch (e) { /* non-critical */ }

    // Send repair completed email with invoice + thank you (safe — non-blocking)
    try {
      const { sendRepairCompletedEmail } = require("../utils/mailer");
      const populatedBooking = await BookingService.findById(booking._id).populate("customerId", "name email").lean();
      const customerEmail = populatedBooking?.customerId?.email;
      if (customerEmail) {
        const quotation = booking.quotation || {};
        const repairComp = booking.repairCompletion || {};
        const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        const techFullName = ((tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || "Your technician");
        const partsList = (quotation.parts || repairComp.partsInstalled || []).map(p => ({
          name: p.name || p.partName || "Part",
          quantity: p.quantity || 1,
          unitPrice: p.unitPrice || p.cost || p.price || 0,
          total: (p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1),
        }));
        const inspectionFee = booking.inspectionFeeTotalCollected || booking.initialCost || 0;
        const travelFee = booking.travelFare || 0;
        const invoiceData = {
          workOrderNumber: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
          customerName: populatedBooking?.customerId?.name || "Customer",
          serviceName: booking.serviceName || booking.serviceType || "Repair",
          technicianName: techFullName,
          parts: partsList,
          laborCost: quotation.laborCost || 0,
          partsTotal: partsList.reduce((sum, p) => sum + p.total, 0),
          inspectionFee: inspectionFee,
          travelFee: travelFee,
          totalAmount: quotation.totalCost || 0,
          grandTotal: inspectionFee + travelFee + (quotation.totalCost || 0),
          downpayment: booking.downpaymentAmount || 0,
          balanceCollected: !!booking.balanceCollected,
          balancePaid: booking.balanceCollected ? (booking.balanceAmount || Math.max(0, (booking.amountPaid || 0) - (booking.downpaymentAmount || 0))) : 0,
          totalPaid: (booking.inspectionFeeTotalCollected || 0) + (booking.repairPaymentAmount || 0) + (booking.downpaymentAmount || 0),
          actionsPerformed: repairComp.actionsPerformed || [],
        };
        sendRepairCompletedEmail({
          to: customerEmail,
          customerName: populatedBooking?.customerId?.name || "Customer",
          bookingReference: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.serviceName || booking.serviceType || "Repair",
          technicianName: techFullName,
          dateLabel,
          invoice: invoiceData,
          warranty: booking.warranty?.startDate && booking.warranty?.endDate ? {
            duration: `${booking.warranty.days} days`,
            startDate: booking.warranty.startDate?.toLocaleDateString?.('en-PH') || 'N/A',
            endDate: booking.warranty.endDate?.toLocaleDateString?.('en-PH') || 'N/A',
          } : null,
        }).catch(err => console.error("[MAILER] Failed to send repair completion email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair completion email error:", mailErr.message);
    }

    // Build invoice data for response
    const quotation = booking.quotation || {};
    const repairComp = booking.repairCompletion || {};
    const inspection = booking.inspection || {};
    const diagnosis = booking.diagnosis || {};
    const inspectionFee = booking.inspectionFeeTotalCollected || booking.initialCost || 0;
    const travelFee = booking.travelFare || 0;
    const quotationTotal = quotation.totalCost || 0;
    const grandTotal = inspectionFee + travelFee + quotationTotal;
    const totalPaid = (booking.inspectionFeeTotalCollected || 0) + (booking.repairPaymentAmount || 0) + (booking.downpaymentAmount || 0);
    const invoice = {
      workOrderNumber: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
      customerName: booking.customer?.name || 'Customer',
      serviceName: booking.serviceName || booking.serviceType || 'Repair',
      serviceAddress: booking.customer?.address || booking.address || '',
      technicianName: (tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || '',
      dateCompleted: new Date().toLocaleDateString('en-PH'),
      parts: (quotation.parts || repairComp.partsInstalled || []).map(p => ({
        name: p.name || p.partName || 'Part',
        quantity: p.quantity || 1,
        unitPrice: p.unitPrice || p.cost || p.price || 0,
        total: (p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1),
      })),
      laborCost: quotation.laborCost || 0,
      partsTotal: (quotation.parts || []).length > 0
        ? (quotation.parts || []).reduce((sum, p) => sum + ((p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1)), 0)
        : (repairComp.partsInstalled || []).reduce((sum, p) => sum + ((p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1)), 0),
      inspectionFee: inspectionFee,
      travelFee: travelFee,
      totalAmount: quotationTotal,
      grandTotal: grandTotal,
      downpayment: booking.downpaymentAmount || 0,
      balanceCollected: !!booking.balanceCollected,
      balancePaid: booking.balanceCollected ? (booking.balanceAmount || Math.max(0, (booking.amountPaid || 0) - (booking.downpaymentAmount || 0))) : 0,
      totalPaid: totalPaid,
      warranty: booking.warranty?.startDate && booking.warranty?.endDate ? {
        duration: `${booking.warranty.days} days`,
        startDate: booking.warranty.startDate?.toLocaleDateString('en-PH') || 'N/A',
        endDate: booking.warranty.endDate?.toLocaleDateString('en-PH') || 'N/A',
      } : null,
      inspection: {
        findings: inspection.findings || '',
        severity: inspection.severity || '',
        damagedParts: inspection.damagedParts || [],
        recommendedAction: inspection.recommendedAction || '',
      },
      diagnosis: {
        findings: diagnosis.findings || '',
      },
      actionsPerformed: repairComp.actionsPerformed || [],
      completionNotes: repairComp.completionNotes || '',
    };

    return res.json({
      success: true,
      status: booking.status,
      assignmentCompleted,
      remainingCoreItems: remainingCoreItems.map(item => ({
        _id: item._id,
        name: item.name || 'Core Service',
        status: item.status,
      })),
      invoice,
      warranty: booking.warranty,
      statusHistory: booking.statusHistory?.slice(-3)
    });
  } catch (err) {
    console.error("Complete repair error:", err.message, err.stack);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// POST /appointments/:id/scheduling-request
// Technician submits scheduling request on behalf of customer (for "schedule later" flow)
router.post("/appointments/:id/scheduling-request", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["awaiting_approval", "repair_approved"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit scheduling request from status: ${booking.status}` });
    }

    const { preferredDates, preferredTime, notes } = req.body;
    if (!preferredDates || !preferredDates.length) {
      return res.status(400).json({ error: "At least one preferred date is required" });
    }

    booking.schedulingRequest = {
      preferredDates: preferredDates.map(d => new Date(d)),
      preferredTime: preferredTime || 'Any Time',
      status: 'pending',
      notes: notes || '',
      createdAt: new Date(),
    };
    await booking.save();

    // Notify admin of scheduling request
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Scheduling request submitted for ${booking.workOrderNumber || booking._id}. Customer preferred dates: ${preferredDates.join(', ')}`,
      });
    }

    return res.json({
      success: true,
      schedulingRequest: booking.schedulingRequest,
    });
  } catch (err) {
    console.error("Scheduling request error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/repair-today-choice
// Technician chooses "Repair Today" or "Schedule Later" after customer approved quotation
router.post("/appointments/:id/repair-today-choice", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (booking.status !== "repair_approved") {
      return res.status(400).json({ error: `Cannot make scheduling choice from status: ${booking.status}` });
    }

    const { choice, preferredDates, preferredTime } = req.body;

    if (choice === "today") {
      // Check if technician has remaining working hours today
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      const todayAssignments = await Assignment.find({
        technicianId: tech._id,
        status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
      }).select("bookingDate serviceDurationMinutes").lean();

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
          success: false,
          available: false,
          message: activeJobs.length > 0
            ? "Technician is currently on another job. Please schedule for another day."
            : "Not enough remaining working hours today. Please schedule for another day.",
          status: booking.status,
          remainingHours: Math.floor(remainingMinutes / 60),
          estimatedDuration
        });
      }

      // Available! Mark as ready to start
      booking.repairSchedule = {
        preference: "today",
        decidedAt: new Date(),
      };
      await booking.save();

      return res.json({
        success: true,
        available: true,
        message: "Technician is available! Repair will start shortly.",
        status: booking.status,
        technicianName: tech.name || "Technician"
      });
    }

    if (choice === "later") {
      if (!preferredDates || !Array.isArray(preferredDates) || preferredDates.length === 0) {
        return res.status(400).json({ error: "Please provide at least one preferred date" });
      }

      booking.preferredSchedule = {
        dates: preferredDates.map(d => new Date(d)),
        timeWindow: preferredTime || "any",
        submittedAt: new Date(),
        submittedBy: req.user._id,
      };
      booking.repairSchedule = {
        preference: "later",
        decidedAt: new Date(),
      };
      await booking.save();

      // Notify admin
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Technician submitted scheduling request for ${booking.workOrderNumber || booking._id}. Preferred dates: ${preferredDates.join(', ')}`,
        });
      }

      return res.json({
        success: true,
        message: "Scheduling request submitted. Admin will confirm the final schedule.",
        status: booking.status,
      });
    }

    return res.status(400).json({ error: "Invalid choice. Must be 'today' or 'later'." });
  } catch (err) {
    console.error("Repair today choice error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DAILY DISPATCH KIT — One preparation for the entire day
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/daily-kit
 * Get or generate today's daily kit. Returns existing kit or creates new one.
 * Query: ?date=YYYY-MM-DD (defaults to today)
 * Enhanced to include job details and AI contingency part suggestions.
 */
router.get("/daily-kit", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const Order = require("../models/Order");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const kit = await syncDailyKit(tech._id, req.query.date || new Date());

    // Enrich with job details
    const assignments = await Assignment.find({
      _id: { $in: kit.assignmentIds || [] },
    }).populate("bookingId", "serviceName serviceType services technicianAssistant status").lean();

    const jobDetails = assignments.map(a => ({
      assignmentId: a._id,
      bookingId: a.bookingId?._id || a.bookingId,
      serviceName: a.serviceName || a.bookingId?.serviceName || "Service",
      serviceType: a.serviceType || a.bookingId?.serviceType || "core",
      startTime: a.startTime || "",
      status: a.status,
    }));
    const installationOrders = await Order.find({ _id: { $in: kit.orderIds || [] } })
      .select("orderReference customer items fulfillmentType delivery.preferredDate timeSlot status preparation")
      .lean();
    for (const order of installationOrders) {
      jobDetails.push({
        orderId: order._id,
        serviceName: `Delivery & Installation · ${order.orderReference || String(order._id).slice(-6).toUpperCase()}`,
        serviceType: "order_installation",
        startTime: order.timeSlot || "",
        status: order.status,
        customerName: order.customer?.name || "Customer",
      });
    }

    // Collect AI contingency part suggestions from repair bookings
    const aiContingencySuggestions = [];
    for (const a of assignments) {
      const booking = a.bookingId;
      if (!booking) continue;
      const isRepair = (a.serviceType === "repair" || booking.serviceType === "repair" || booking.serviceType === "mixed");
      if (!isRepair) continue;
      const assistant = booking.technicianAssistant;
      if (!assistant || !assistant.possibleParts || !assistant.possibleParts.length) continue;
      // Only suggest if AI diagnosis has been reviewed
      if (!assistant.verifiedByTechnician) continue;
      const confirmedNames = new Set(
        (booking.servicePreparation?.aiContingencyParts || []).map(p => String(p.name || "").toLowerCase())
      );
      for (const part of assistant.possibleParts) {
        const name = typeof part === "string" ? part : part?.name || "";
        if (!name) continue;
        aiContingencySuggestions.push({
          name,
          serviceName: typeof part === "object" ? (part.serviceName || a.serviceName || "Repair") : a.serviceName || "Repair",
          bookingId: String(booking._id),
          assignmentId: String(a._id),
          alreadyConfirmed: confirmedNames.has(name.toLowerCase()),
        });
      }
    }

    return res.json({
      success: true,
      kit: kit.toObject(),
      jobDetails,
      aiContingencySuggestions,
    });
  } catch (err) { next(err); }
});

router.get("/daily-kit-legacy", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Tool = require("../models/Tool");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const filterDate = req.query.date ? new Date(req.query.date) : today;
    filterDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(filterDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Check if kit already exists for this date
    let kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: filterDate, $lt: nextDay },
    }).lean();

    if (kit) {
      return res.json({ success: true, kit, isNew: false });
    }

    // Generate new kit for today
    // Get all accepted assignments for the date
    const assignments = await Assignment.find({
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
      bookingDate: { $gte: filterDate, $lt: nextDay },
    }).sort({ startTime: 1 }).lean();

    if (assignments.length === 0) {
      return res.json({
        success: true,
        kit: {
          technicianId: tech._id,
          workDate: filterDate,
          status: "draft",
          items: [],
          assignmentIds: [],
          bookingIds: [],
        },
        isNew: true,
      });
    }

    const bookingIds = assignments.map(a => a.bookingId).filter(Boolean);
    const bookings = await BookingService.find({ _id: { $in: bookingIds } })
      .select("serviceType services technicianAssistant issueDescription unitInfo")
      .lean();
    const bookingMap = new Map(bookings.map(b => [String(b._id), b]));

    // Collect job-specific equipment from service type defaults
    const jobEquipment = new Map(); // name -> { name, quantity, source, assignmentIds, bookingIds }
    const jobConsumables = new Map();

    for (const asg of assignments) {
      const bk = bookingMap.get(String(asg.bookingId));
      if (!bk) continue;

      const isRepair = bk.serviceType === "repair";
      const isInstallation = bk.serviceType === "installation";
      const isCleaning = bk.serviceType === "cleaning" || bk.serviceType === "maintenance";

      // Add standard equipment based on service type
      if (isRepair) {
        const repairTools = ["Multimeter", "Manifold Gauge", "Clamp Meter", "Inspection Mirror"];
        repairTools.forEach(name => {
          if (!jobEquipment.has(name)) {
            jobEquipment.set(name, { name, quantity: 1, category: "equipment", source: "job_specific", assignmentIds: [], bookingIds: [] });
          }
          jobEquipment.get(name).assignmentIds.push(asg._id);
          jobEquipment.get(name).bookingIds.push(asg.bookingId);
        });

        // Standard repair consumables
        const repairConsumables = ["Electrical Tape", "Cable Ties", "Cleaning Cloth"];
        repairConsumables.forEach(name => {
          if (!jobConsumables.has(name)) {
            jobConsumables.set(name, { name, quantity: 1, category: "consumable", source: "job_specific", unit: "roll", assignmentIds: [], bookingIds: [] });
          }
          jobConsumables.get(name).assignmentIds.push(asg._id);
          jobConsumables.get(name).bookingIds.push(asg.bookingId);
        });
      } else if (isInstallation) {
        const installTools = ["Drill", "Level", "Vacuum Pump", "Manifold Gauge", "Pipe Cutter", "Flaring Tool"];
        installTools.forEach(name => {
          if (!jobEquipment.has(name)) {
            jobEquipment.set(name, { name, quantity: 1, category: "equipment", source: "job_specific", assignmentIds: [], bookingIds: [] });
          }
          jobEquipment.get(name).assignmentIds.push(asg._id);
          jobEquipment.get(name).bookingIds.push(asg.bookingId);
        });

        const installConsumables = ["Coil Cleaner", "Refrigerant", "Copper Pipe", "Insulation Tape", "Wall Plugs"];
        installConsumables.forEach(name => {
          if (!jobConsumables.has(name)) {
            const qty = name === "Wall Plugs" ? 8 : name === "Copper Pipe" ? 2 : 1;
            const unit = name === "Copper Pipe" ? "m" : name === "Refrigerant" ? "kg" : "pcs";
            jobConsumables.set(name, { name, quantity: qty, category: "consumable", source: "job_specific", unit, assignmentIds: [], bookingIds: [] });
          }
          jobConsumables.get(name).assignmentIds.push(asg._id);
          jobConsumables.get(name).bookingIds.push(asg.bookingId);
        });
      } else if (isCleaning || asg.serviceName?.toLowerCase().includes("clean")) {
        const cleanTools = ["Pressure Washer", "Coil Cleaning Brush", "Fin Comb"];
        cleanTools.forEach(name => {
          if (!jobEquipment.has(name)) {
            jobEquipment.set(name, { name, quantity: 1, category: "equipment", source: "job_specific", assignmentIds: [], bookingIds: [] });
          }
          jobEquipment.get(name).assignmentIds.push(asg._id);
          jobEquipment.get(name).bookingIds.push(asg.bookingId);
        });

        const cleanConsumables = ["Coil Cleaner", "Cleaning Cloth", "Gloves", "Protective Cover"];
        cleanConsumables.forEach(name => {
          if (!jobConsumables.has(name)) {
            const qty = name === "Cleaning Cloth" ? 3 : name === "Gloves" ? 1 : 1;
            const unit = name === "Gloves" ? "pair" : name === "Cleaning Cloth" ? "pcs" : "pcs";
            jobConsumables.set(name, { name, quantity: qty, category: "consumable", source: "job_specific", unit, assignmentIds: [], bookingIds: [] });
          }
          jobConsumables.get(name).assignmentIds.push(asg._id);
          jobConsumables.get(name).bookingIds.push(asg.bookingId);
        });
      }

      // Add AI suggested tools if available
      if (bk.technicianAssistant?.suggestedTools?.length > 0) {
        bk.technicianAssistant.suggestedTools.forEach(t => {
          const name = typeof t === "string" ? t : t.name || t;
          if (!name) return;
          if (!jobEquipment.has(name)) {
            jobEquipment.set(name, { name, quantity: 1, category: "equipment", source: "ai_recommended", assignmentIds: [], bookingIds: [] });
          }
          jobEquipment.get(name).assignmentIds.push(asg._id);
          jobEquipment.get(name).bookingIds.push(asg.bookingId);
        });
      }
    }

    // Standard kit (always bring)
    const standardEquipment = [
      { name: "Multimeter", quantity: 1 },
      { name: "Screwdriver Set", quantity: 1 },
      { name: "Pliers", quantity: 1 },
      { name: "Flashlight", quantity: 1 },
      { name: "Tool Bag", quantity: 1 },
    ];

    const standardConsumables = [
      { name: "Gloves", quantity: 2, unit: "pair" },
      { name: "Electrical Tape", quantity: 1, unit: "roll" },
      { name: "Cable Ties", quantity: 10, unit: "pcs" },
      { name: "Cleaning Cloth", quantity: 5, unit: "pcs" },
      { name: "Masking Tape", quantity: 1, unit: "roll" },
    ];

    const items = [];

    // Add standard kit items
    standardEquipment.forEach(e => {
      items.push({
        name: e.name,
        quantity: e.quantity,
        category: "equipment",
        source: "standard",
        checkoutStatus: "pending",
        assignmentIds: [],
        bookingIds: [],
      });
    });

    standardConsumables.forEach(c => {
      items.push({
        name: c.name,
        quantity: c.quantity,
        unit: c.unit || "pcs",
        category: "consumable",
        source: "standard",
        quantityIssued: 0,
        quantityUsed: 0,
        quantityReturned: 0,
        assignmentIds: [],
        bookingIds: [],
      });
    });

    // Add job-specific equipment (skip duplicates from standard kit)
    const standardNames = new Set(standardEquipment.map(e => e.name));
    jobEquipment.forEach((eq, name) => {
      if (standardNames.has(name)) {
        // Just add the assignment/booking references to existing standard item
        const existing = items.find(i => i.name === name);
        if (existing) {
          existing.assignmentIds = [...new Set([...existing.assignmentIds, ...eq.assignmentIds])];
          existing.bookingIds = [...new Set([...existing.bookingIds, ...eq.bookingIds])];
          existing.source = "job_specific"; // upgraded from standard
        }
        return;
      }
      items.push({
        ...eq,
        checkoutStatus: "pending",
      });
    });

    // Add job-specific consumables
    const standardConsumableNames = new Set(standardConsumables.map(c => c.name));
    jobConsumables.forEach((cn, name) => {
      if (standardConsumableNames.has(name)) {
        const existing = items.find(i => i.name === name && i.category === "consumable");
        if (existing) {
          existing.assignmentIds = [...new Set([...existing.assignmentIds, ...cn.assignmentIds])];
          existing.bookingIds = [...new Set([...existing.bookingIds, ...cn.bookingIds])];
          existing.quantity = Math.max(existing.quantity, cn.quantity);
        }
        return;
      }
      items.push({
        ...cn,
        checkoutStatus: "pending",
        quantityIssued: 0,
        quantityUsed: 0,
        quantityReturned: 0,
      });
    });

    // Check equipment availability
    const allToolNames = items.filter(i => i.category === "equipment").map(i => i.name);
    const tools = await Tool.find({ name: { $in: allToolNames } }).lean();
    const toolMap = new Map(tools.map(t => [t.name, t]));

    // Check which tools are already checked out to other technicians today
    const todayToolsCheckedOut = await EquipmentAssignment.find({
      workDate: { $gte: filterDate, $lt: nextDay },
      status: { $in: ["checked_out", "in_use"] },
      technicianId: { $ne: tech._id },
    }).populate("technicianId", "name").lean();

    const checkedOutByOther = new Map();
    todayToolsCheckedOut.forEach(ea => {
      if (ea.equipmentName) {
        checkedOutByOther.set(ea.equipmentName, ea.technicianId?.name || "Another technician");
      }
    });

    items.forEach(item => {
      if (item.category === "equipment") {
        const tool = toolMap.get(item.name);
        if (!tool) {
          item.conflict = { isUnavailable: true, checkedOutTo: null, message: "Item not found in inventory" };
          item.checkoutStatus = "unavailable";
        } else if (checkedOutByOther.has(item.name)) {
          item.conflict = { isUnavailable: true, checkedOutTo: checkedOutByOther.get(item.name), message: `Checked out to ${checkedOutByOther.get(item.name)}` };
          item.checkoutStatus = "unavailable";
        } else if (tool.quantity <= 0) {
          item.conflict = { isUnavailable: true, checkedOutTo: null, message: "Out of stock" };
          item.checkoutStatus = "unavailable";
        } else {
          item.toolId = tool._id;
          item.toolCode = tool.code || null;
        }
      }
    });

    // Create the kit
    kit = await DailyKit.create({
      technicianId: tech._id,
      workDate: filterDate,
      status: "draft",
      items,
      assignmentIds: assignments.map(a => a._id),
      bookingIds: bookingIds.filter(Boolean),
      generatedAt: new Date(),
    });

    return res.json({ success: true, kit: kit.toObject(), isNew: true });
  } catch (err) {
    console.error("Daily kit error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/technician/daily-kit/confirm
 * Confirm the daily kit is prepared. Checks out equipment and issues consumables.
 */
router.post("/daily-kit/confirm", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const kit = await confirmDailyKit({ technicianId: tech._id, userId: req.user._id, date: req.body?.date || new Date() });
    return res.json({ success: true, kit: kit.toObject() });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, unavailable: err.unavailable });
    next(err);
  }
});

router.post("/daily-kit-legacy/confirm", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });
    if (kit.status === "confirmed" || kit.status === "in_progress" || kit.status === "completed") {
      return res.status(400).json({ error: "Kit is already confirmed" });
    }

    // Check for unavailable items
    const unavailable = kit.items.filter(i => i.category === "equipment" && i.checkoutStatus === "unavailable");
    if (unavailable.length > 0) {
      return res.status(400).json({
        error: "Some equipment is unavailable",
        unavailable: unavailable.map(i => ({ name: i.name, message: i.conflict?.message })),
      });
    }

    const now = new Date();

    // Check out equipment and issue consumables
    for (const item of kit.items) {
      if (item.category === "equipment" && item.toolId) {
        // Create EquipmentAssignment for each booking this item is used for
        const bookingIds = item.bookingIds.length > 0 ? item.bookingIds : kit.bookingIds;
        for (const bookingId of bookingIds) {
          await EquipmentAssignment.create({
            bookingId,
            technicianId: tech._id,
            workDate: today,
            equipmentId: item.toolId,
            equipmentName: item.name,
            quantity: item.quantity,
            consumable: false,
            status: "checked_out",
            checkedOutAt: now,
            checkedOutBy: req.user._id,
          });
        }

        // Update tool inventory
const Tool = require("../models/Tool");
const EquipmentUsageLog = require("../models/EquipmentUsageLog");
        await Tool.findByIdAndUpdate(item.toolId, {
          $inc: { quantity: -item.quantity, checkedOutQuantity: item.quantity },
          assetStatus: "checked_out",
        });

        item.checkoutStatus = "checked_out";
        item.checkedOutAt = now;
      } else if (item.category === "consumable") {
        item.quantityIssued = item.quantity;
        item.checkoutStatus = "checked_out";
      }
    }

    kit.status = "confirmed";
    kit.confirmedAt = now;
    await kit.save();

    return res.json({ success: true, kit: kit.toObject() });
  } catch (err) {
    console.error("Daily kit confirm error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/technician/daily-kit/consume
 * Record actual usage of a consumable item.
 * Body: { itemName, quantityUsed }
 */
router.post("/daily-kit/consume", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { itemName, quantityUsed, bookingId, orderId, serviceItemId } = req.body;
    if (!itemName || !quantityUsed) return res.status(400).json({ error: "itemName and quantityUsed required" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    const item = kit.items.find(i => i.name === itemName && i.category === "consumable");
    if (!item) return res.status(404).json({ error: "Consumable item not found in kit" });

    const used = Number(quantityUsed);
    if (!Number.isFinite(used) || used <= 0 || item.quantityUsed + used > item.quantityIssued - item.quantityReturned) {
      return res.status(400).json({ error: "Usage must be positive and cannot exceed the issued, unreturned quantity" });
    }
    if (bookingId && (!mongoose.Types.ObjectId.isValid(bookingId) || !item.bookingIds.some(id => String(id) === String(bookingId)))) {
      return res.status(403).json({ error: "Booking is not covered by this Daily Kit" });
    }
    if (orderId && (!mongoose.Types.ObjectId.isValid(orderId) || !(item.orderIds || []).some(id => String(id) === String(orderId)))) {
      return res.status(403).json({ error: "Order is not covered by this Daily Kit" });
    }
    item.quantityUsed += used;
    await kit.save();
    if ((bookingId || orderId) && item.toolId) {
      const ServiceToolUsage = require("../models/ServiceToolUsage");
      const tool = await Tool.findById(item.toolId).select("costPrice").lean();
      await ServiceToolUsage.create({ bookingId: bookingId || undefined, orderId: orderId || undefined, serviceItemId: mongoose.Types.ObjectId.isValid(serviceItemId) ? serviceItemId : undefined,
        technicianId: tech._id, toolItemId: item.toolId, inventoryItemId: item.toolId, itemName: item.name,
        itemType: "consumable", unit: item.unit || "pcs", quantityUsed: used, unitPrice: Number(tool?.costPrice || 0),
        deductedFromInventory: true, notes: "Actual usage from Daily Kit issuance", recordedBy: req.user._id });
    }

    return res.json({ success: true, item });
  } catch (err) {
    console.error("Daily kit consume error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/technician/daily-kit/return
 * Return unused equipment at end of day.
 * Body: { itemName }
 */
router.post("/daily-kit/return", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const EquipmentAssignment = require("../models/EquipmentAssignment");
    const Tool = require("../models/Tool");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { itemName } = req.body;
    if (!itemName) return res.status(400).json({ error: "itemName required" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    const item = kit.items.find(i => i.name === itemName && i.category === "equipment");
    if (!item) return res.status(404).json({ error: "Equipment item not found in kit" });

    // Return equipment assignments
    const eqAssignments = await EquipmentAssignment.find({
      dailyKitId: kit._id,
      technicianId: tech._id,
      equipmentName: itemName,
      status: { $in: ["checked_out", "in_use"] },
    });

    const now = new Date();
    for (const eq of eqAssignments) {
      eq.status = "returned";
      eq.returnedAt = now;
      await eq.save();
    }

    // Return to inventory
    if (item.toolId) {
      await Tool.findByIdAndUpdate(item.toolId, {
        $inc: { quantity: item.quantity, checkedOutQuantity: -item.quantity },
      });
    }

    item.checkoutStatus = "returned";
    item.returnedAt = now;
    await kit.save();

    return res.json({ success: true, item });
  } catch (err) {
    console.error("Daily kit return error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Return unused issued consumables to available stock. */
router.post("/daily-kit/return-consumable", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const quantity = Number(req.body.quantity);
    if (!req.body.itemName || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: "itemName and a positive quantity are required" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const kit = await DailyKit.findOne({ technicianId: tech._id, workDate: today });
    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });
    const item = kit.items.find(row => row.category === "consumable" && row.name === req.body.itemName);
    if (!item) return res.status(404).json({ error: "Consumable item not found in kit" });
    const returnable = item.quantityIssued - item.quantityUsed - item.quantityReturned;
    if (quantity > returnable) return res.status(400).json({ error: `Only ${returnable} ${item.unit || "pcs"} can be returned` });
    const tool = await Tool.findOneAndUpdate({ _id: item.toolId }, { $inc: { quantity } }, { returnDocument: "after" });
    if (!tool) return res.status(404).json({ error: "Inventory item not found" });
    item.quantityReturned += quantity;
    if (item.quantityReturned + item.quantityUsed === item.quantityIssued) item.checkoutStatus = "returned";
    await kit.save();
    return res.json({ success: true, item });
  } catch (err) { next(err); }
});

/**
 * GET /api/technician/daily-kit/inventory-search
 * Search inventory catalog for adding items to the daily kit.
 * Query: ?q=searchterm&category=equipment|consumable
 */
router.get("/daily-kit/inventory-search", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { q, category } = req.query;
    if (!q || q.trim().length < 1) return res.json({ items: [] });
    const regex = new RegExp(escapeRegex(q.trim()).replace(/\s+/g, ".*"), "i");
    const filter = {
      itemName: regex,
      active: { $ne: false },
      quantity: { $gt: 0 },
    };
    if (category === "equipment") {
      filter.type = { $in: ["equipment", "tool"] };
    } else if (category === "consumable") {
      filter.type = "consumable";
    } else if (category === "repair_part") {
      filter.type = "part";
    }
    // No category = search all types
    const items = await Tool.find(filter)
      .select("itemName type inventoryClass quantity unit assetCode category")
      .sort({ itemName: 1 })
      .limit(20)
      .lean();
    return res.json({
      items: items.map(t => ({
        _id: t._id,
        name: t.itemName,
        type: t.type,
        category: t.type === "consumable" ? "consumable" : t.type === "part" ? "repair_part" : "equipment",
        available: Math.max(0, Number(t.quantity || 0)),
        unit: t.unit || "pcs",
        assetCode: t.assetCode || "",
        inventoryCategory: t.category || "",
      })),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/daily-kit/add-item
 * Add an item to the daily kit (manual addition).
 * Body: { name, quantity, category, unit?, inventoryItemId? }
 */
router.post("/daily-kit/add-item", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { name, quantity, category, unit, inventoryItemId } = req.body;
    if (!name || !["equipment", "consumable", "repair_part"].includes(category)) return res.status(400).json({ error: "Only equipment, consumables, or repair parts can be added to a Daily Kit" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    // Manual additions must still resolve to the canonical inventory catalog.
    if (kit.status !== "draft") return res.status(409).json({ error: "Confirmed kits can only be extended by newly assigned jobs" });

    // Find inventory item by ID or name
    let inventory;
    if (inventoryItemId) {
      inventory = await Tool.findById(inventoryItemId);
    } else {
      inventory = await Tool.findOne({ itemName: name, active: { $ne: false } });
    }
    if (!inventory) return res.status(404).json({ error: "Choose an item from the existing equipment or consumables catalog" });

    // Determine actual category from inventory type
    let actualCategory;
    if (inventory.type === "consumable") {
      actualCategory = "consumable";
    } else if (inventory.type === "part") {
      actualCategory = "repair_part";
    } else {
      actualCategory = "equipment";
    }

    // Validate category match
    if (actualCategory !== category) {
      return res.status(400).json({ error: "Inventory classification does not match. Item is type \"" + inventory.type + "\", expected \"" + category + "\"" });
    }

    // Equipment must be operational asset class
    if (actualCategory === "equipment" && Tool.effectiveInventoryClass(inventory) !== "operational_asset") {
      return res.status(400).json({ error: "Inventory classification does not match" });
    }
    const existing = kit.items.find(i => String(i.toolId) === String(inventory._id));
    if (existing) {
      existing.quantity = Math.max(existing.quantity, Number(quantity) || 1);
    } else {
      kit.items.push({
        name: inventory.itemName,
        quantity: Number(quantity) || 1,
        unit: inventory.unit || unit || "pcs",
        category,
        source: "manual",
        toolId: inventory._id,
        toolCode: inventory.assetCode || inventory.barcode || null,
        checkoutStatus: "pending",
      });
    }

    await kit.save();
    return res.json({ success: true, kit: kit.toObject() });
  } catch (err) {
    console.error("Daily kit add item error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/technician/daily-kit/remove-item
 * Remove an item from the daily kit.
 * Body: { itemName }
 */
router.delete("/daily-kit/remove-item", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { itemName } = req.body;
    if (!itemName) return res.status(400).json({ error: "itemName required" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    kit.items = kit.items.filter(i => i.name !== itemName);
    await kit.save();

    return res.json({ success: true, kit: kit.toObject() });
  } catch (err) {
    console.error("Daily kit remove item error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/technician/daily-kit/check-delta
 * Check if new bookings were added after kit confirmation.
 * Returns delta items that need to be prepared.
 */
router.post("/daily-kit/check-delta", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    // Get current assignments
    const currentAssignments = await Assignment.find({
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
      bookingDate: { $gte: today, $lt: nextDay },
    }).lean();

    const currentBookingIds = currentAssignments.map(a => String(a.bookingId)).filter(Boolean);
    const kitBookingIds = kit.bookingIds.map(id => String(id));

    // Find new bookings not in the kit
    const newBookingIds = currentBookingIds.filter(id => !kitBookingIds.includes(id));

    if (newBookingIds.length === 0) {
      return res.json({ success: true, hasDelta: false, deltaItems: [] });
    }

    // Generate delta items for new bookings
    const BookingService = require("../models/BookingService");
    const newBookings = await BookingService.find({ _id: { $in: newBookingIds } })
      .select("serviceType services")
      .lean();

    const deltaItems = [];
    for (const bk of newBookings) {
      if (bk.serviceType === "repair") {
        deltaItems.push({ name: "Multimeter", quantity: 1, category: "equipment", source: "job_specific" });
        deltaItems.push({ name: "Manifold Gauge", quantity: 1, category: "equipment", source: "job_specific" });
      } else if (bk.serviceType === "installation") {
        deltaItems.push({ name: "Drill", quantity: 1, category: "equipment", source: "job_specific" });
        deltaItems.push({ name: "Vacuum Pump", quantity: 1, category: "equipment", source: "job_specific" });
      }
    }

    // Deduplicate against existing kit items
    const existingNames = new Set(kit.items.map(i => i.name));
    const uniqueDelta = deltaItems.filter(d => !existingNames.has(d.name));

    // Update kit with delta
    kit.hasDelta = uniqueDelta.length > 0;
    kit.deltaItems = uniqueDelta;
    kit.bookingIds = [...new Set([...kit.bookingIds, ...newBookingIds.map(id => new mongoose.Types.ObjectId(id))])];
    await kit.save();

    return res.json({ success: true, hasDelta: kit.hasDelta, deltaItems: kit.deltaItems });
  } catch (err) {
    console.error("Daily kit delta error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/technician/daily-kit/notify-admin
 * Notify admin about unavailable items in the daily kit.
 */
router.post("/daily-kit/notify-admin", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Technician = require("../models/Technician");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: nextDay },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for today" });

    const unavailableItems = (kit.items || []).filter(i => i.checkoutStatus === "unavailable");
    if (unavailableItems.length === 0) {
      return res.status(400).json({ error: "No unavailable items to report" });
    }

    // Mark all unavailable items as admin_notified
    for (const item of unavailableItems) {
      item.resolution = {
        status: "admin_notified",
        resolvedBy: req.user._id,
        resolvedAt: new Date(),
        resolutionNote: "Technician requested admin assistance",
      };
    }
    await kit.save();

    // Send real notification to admin
    const { createNotification } = require("../utils/notify");
    const itemList = unavailableItems.map(i => i.name).join(", ");
    await createNotification({
      role: "admin",
      type: "daily_kit_issue",
      title: "Preparation Issue — Items Unavailable",
      message: `${tech.name} reported ${unavailableItems.length} item(s) missing: ${itemList}`,
      referenceId: kit._id,
      referenceModel: "BookingService",
      link: "/admin/dashboard",
      priority: "high",
      io: req.app.get("io"),
    }).catch(() => {});

    return res.json({ success: true, message: "Admin has been notified about " + unavailableItems.length + " unavailable item(s)" });
  } catch (err) {
    console.error("Daily kit notify admin error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

 /**
  * POST /api/technician/daily-kit/resolve-item
  * Field-level decision on a kit item (works for both regular and delta items).
  * Body: {
  *   itemName: string,
  *   category?: "equipment"|"consumable"|"repair_part",
  *   resolution: "confirmed_available"|"not_required"|"admin_notified",
  *   source?: string,          // confirmed_available: what will be used instead
  *   reasonCode?: string,      // not_required preset (see NOT_REQUIRED_REASONS)
  *   note?: string             // free-text detail (required when reasonCode = other)
  * }
  */
 const NOT_REQUIRED_REASONS = [
   "existing_equipment_sufficient",
   "job_condition_not_required",
   "alternative_approved_material",
   "recommendation_not_applicable",
   "other",
 ];
 const NOT_REQUIRED_REASON_LABELS = {
   existing_equipment_sufficient: "Existing equipment can perform the task",
   job_condition_not_required: "Job condition does not require it",
   alternative_approved_material: "Alternative approved tool/material available",
   recommendation_not_applicable: "Recommendation is not applicable",
   other: "Other",
 };
 router.post("/daily-kit/resolve-item", async (req, res, next) => {
   try {
     const DailyKit = require("../models/DailyKit");

     const tech = await Technician.findOne({ user: req.user._id });
     if (!tech) return res.status(404).json({ error: "Technician record not found" });

     const { itemName, category, resolution, source, reasonCode, note } = req.body;
     if (!itemName || !["confirmed_available", "not_required", "admin_notified"].includes(resolution)) {
       return res.status(400).json({ error: "itemName and valid resolution required" });
     }
     if (resolution === "not_required") {
       if (!NOT_REQUIRED_REASONS.includes(reasonCode)) {
         return res.status(400).json({ error: "A valid reason is required to mark an item as not needed.", code: "REASON_REQUIRED" });
       }
       if (reasonCode === "other" && !String(note || "").trim()) {
         return res.status(400).json({ error: "Please explain why this item is not needed.", code: "NOTE_REQUIRED" });
       }
     }

     const { start, end } = dailyKitDayBounds(req.body?.date || new Date());

     const kit = await DailyKit.findOne({
       technicianId: tech._id,
       workDate: { $gte: start, $lt: end },
     });

     if (!kit) return res.status(404).json({ error: "No daily kit found for the selected date" });

     // Search regular items first, then pending delta items (late-accepted bookings)
     let item = null;
     let itemList = null;
     for (const list of [kit.items, Array.isArray(kit.deltaItems) ? kit.deltaItems : []]) {
       if (!Array.isArray(list)) continue;
       const found = list.find(i =>
         i.name === itemName &&
         (!category || i.category === category) &&
         ["pending", "unavailable", "reserved"].includes(i.checkoutStatus)
       );
       if (found) { item = found; itemList = list; break; }
     }
     if (!item) return res.status(404).json({ error: "Resolvable item not found: " + itemName });

     item.resolution = {
       status: resolution,
       source: resolution === "confirmed_available" ? (source || "personal_equipment") : null,
       reasonCode: resolution === "not_required" ? reasonCode : null,
       resolvedBy: req.user._id,
       resolvedAt: new Date(),
       resolutionNote:
         resolution === "not_required"
           ? `${NOT_REQUIRED_REASON_LABELS[reasonCode]}${note && reasonCode !== "other" ? ` — ${String(note).trim()}` : ""}${reasonCode === "other" ? `: ${String(note).trim()}` : ""}`
           : (note || null),
     };

     // Alternative available / not required → no inventory checkout will occur.
     if (resolution === "confirmed_available") {
       item.checkoutStatus = "exception";
       item.exception = { approved: true, reason: `Alternative in use: ${source || "personal equipment"}`, approvedBy: req.user._id };
     } else if (resolution === "not_required") {
       item.checkoutStatus = "exception";
       item.exception = { approved: true, reason: `Not required — ${NOT_REQUIRED_REASON_LABELS[reasonCode]}`, approvedBy: req.user._id };
     }

     await kit.save();
     try {
       audit.logEvent({
         actor: req.user._id,
         actorRole: "technician",
         action: "daily_kit_item_resolved",
         entityType: "DailyKit",
         entityId: kit._id,
         details: { itemName, category: item.category, resolution, reasonCode: item.resolution.reasonCode, source: item.resolution.source },
       });
     } catch (_) {}
     return res.json({ success: true, item: item.toObject() });
   } catch (err) {
     console.error("Daily kit resolve item error:", err);
     return res.status(err.status || 500).json({ error: err.status ? err.message : "Server error" });
   }
 });

/**
 * POST /api/technician/daily-kit/notify-admin-item
 * Notify admin about a specific unavailable item.
 * Body: { itemName }
 */
router.post("/daily-kit/notify-admin-item", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { itemName } = req.body;
    if (!itemName) return res.status(400).json({ error: "itemName required" });

    const { start, end } = dailyKitDayBounds(req.body?.date || new Date());

    const kit = await DailyKit.findOne({
      technicianId: tech._id,
      workDate: { $gte: start, $lt: end },
    });

    if (!kit) return res.status(404).json({ error: "No daily kit found for the selected date" });

    // Search regular items and pending delta items (late-accepted bookings)
    const lists = [kit.items, Array.isArray(kit.deltaItems) ? kit.deltaItems : []];
    let item = null;
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      item = list.find(i => i.name === itemName && ["unavailable", "pending", "reserved"].includes(i.checkoutStatus));
      if (item) break;
    }
    if (!item) return res.status(404).json({ error: "Resolvable item not found" });

    // Mark as admin notified
    item.resolution = {
      status: "admin_notified",
      resolvedBy: req.user._id,
      resolvedAt: new Date(),
      resolutionNote: "Technician requested admin to add to catalog",
    };

    await kit.save();

    // Send real notification to admin
    const { createNotification } = require("../utils/notify");
    const prefillParams = new URLSearchParams({
      prefillName: itemName,
      prefillType: "equipment",
      prefillQty: "1",
    }).toString();
    await createNotification({
      role: "admin",
      type: "daily_kit_issue",
      title: "Equipment Not in Catalog",
      message: `${tech.name} needs "${itemName}" added to inventory. Required for today's jobs.`,
      referenceId: kit._id,
      referenceModel: "BookingService",
      link: `/admin/inventory/repair-parts?${prefillParams}`,
      priority: "normal",
      io: req.app.get("io"),
    }).catch(() => {});

    return res.json({ success: true, message: "Admin has been notified about \"" + itemName + "\"" });
  } catch (err) {
    console.error("Daily kit notify admin item error:", err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// REPAIR UNIFIED WORKFLOW — Enterprise En Route → Arrived → Start → Complete
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/technician/repairs/:bookingId/en-route
 * Technician goes en route for a repair booking.
 * Creates or updates an Assignment, transitions booking to on-the-way.
 */
router.post("/repairs/:bookingId/en-route", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");

    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Verify this tech is assigned
    const techId = String(booking.technicianId || '');
    const inspectionTechId = String(booking.inspection?.technicianId || '');
    if (techId !== String(tech._id) && inspectionTechId !== String(tech._id)) {
      return res.status(403).json({ error: "You are not assigned to this repair" });
    }

    if (!booking.technicianAssistant?.summary || !booking.technicianAssistant?.verifiedByTechnician) {
      return res.status(400).json({ error: "Review and confirm the AI diagnosis before going En Route." });
    }

    // Must be in a ready state — Phase 1 (inspection) or Phase 2 (repair execution)
    const allowedStatuses = [
      // Phase 0 - Initial assignment
      "assigned",
      // Phase 1 - Inspection visit
      "inspection_scheduled", "confirmed",
      // Waiting states — admin has approved/scheduled, parts incoming
      "awaiting_approval", "repair_approved", "waiting_parts",
      // Phase 2 - Repair execution (parts ready / scheduled)
      "repair_scheduled", "ready_for_repair", "parts_reserved"
    ];
    if (!allowedStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot go en route from status "${booking.status}". Booking must be ready for a visit (${allowedStatuses.join(", ")}).` });
    }

    const now = new Date();

    // Find or create assignment
    const activeStatuses = ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'];
    let assignment = await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id, status: { $in: activeStatuses } }).sort({ assignedAt: -1 });
    if (!assignment) {
      // Create a new assignment for this repair
      assignment = await Assignment.create({
        bookingId: booking._id,
        technicianId: tech._id,
        customerName: booking.customerId?.name || "Customer",
        customerPhone: booking.customerId?.phone || "",
        customerEmail: booking.customerId?.email || "",
        serviceType: "repair",
        serviceName: "Repair Service",
        servicePrice: booking.quotation?.totalCost || 0,
        bookingDate: booking.bookingDate || now,
        startTime: booking.startTime || "",
        endTime: booking.endTime || "",
        address: booking.location?.address || "",
        coordinates: booking.location?.coordinates,
        status: "en_route",
        enRouteAt: now,
        notes: [{ text: "Technician en route for repair", by: req.user._id, byName: tech.name, createdAt: now }],
      });
    } else {
      // Update existing assignment
      const validTransitions = {
        accepted: ["en_route", "cancelled"],
        pending_acceptance: ["en_route", "cancelled"],
        in_progress: ["en_route", "cancelled"], // Allow re-route for repair reschedule
        on_site: ["en_route"], // Allow if technician needs to restart
        en_route: ["en_route"], // Allow re-trigger (idempotent)
      };
      const allowed = validTransitions[assignment.status];
      if (!allowed || !allowed.includes("en_route")) {
        return res.status(400).json({ error: `Cannot transition from "${assignment.status}" to en_route` });
      }
      // Reset assignment timestamps for the repair execution phase
      assignment.status = "en_route";
      assignment.enRouteAt = now;
      assignment.arrivedAt = null;
      assignment.startedAt = null;
      assignment.completedAt = null;
      assignment.notes.push({ text: "Technician en route for repair execution", by: req.user._id, byName: tech.name, createdAt: now });
      await assignment.save();
    }

    // Update booking status
    const prevBookingStatus = booking.status;
    booking.status = "on-the-way";
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      fromStatus: prevBookingStatus,
      toStatus: "on-the-way",
      reason: "Technician en route",
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: tech.name,
      timestamp: now,
    });
    await booking.save();
    await syncMixedVisitItems(booking._id, "en_route", tech);

    // Update tech availability
    tech.availabilityStatus = "On The Way";
    await tech.save();

    // Send on-the-way email
    try {
      const { sendTechArrivalNotificationEmail } = require("../utils/mailer");
      const customer = await BookingService.findById(bookingId).populate("customerId", "name email").lean();
      if (customer?.customerId?.email) {
        const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
        sendTechArrivalNotificationEmail({
          to: customer.customerId.email,
          customerName: customer.customerId.name || "Customer",
          bookingReference: booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`,
          techName: techFullName,
          serviceName: "Repair Service",
          dateLabel: now.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
          timeLabel: booking.startTime || "TBD",
          locationAddress: booking.location?.address || "",
        }).catch(err => console.error("[MAILER] Repair en-route email error:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair en-route email error:", mailErr.message);
    }

    // Socket notification
    if (global.io) {
      const customerId = booking.customerId?._id || booking.customerId;
      if (customerId) {
        global.io.to("customer:" + customerId).emit("booking:status-change", {
          bookingId: booking._id,
          status: "on-the-way",
          technicianName: tech.name,
          timestamp: Date.now(),
        });
      }
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: "on-the-way",
        message: `${tech.name} is en route for repair ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({ success: true, message: "En route! Heading to customer.", assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/repairs/:bookingId/status
 * Unified status transition for repairs: arrived, start_work, complete.
 * No-show uses the evidence + waiting-window endpoints instead.
 * Maps to the existing assignment lifecycle.
 */
router.post("/repairs/:bookingId/status", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");

    const { bookingId } = req.params;
    const { status: newStatus, startProofUrl, startProofNotes, arrivalProofUrl } = req.body;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const activeStatuses = ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'];
    const assignment = await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id, status: { $in: activeStatuses } }).sort({ assignedAt: -1 });
    if (!assignment) return res.status(404).json({ error: "No assignment found for this repair" });
    if (newStatus === "no_show") {
      return res.status(409).json({
        error: "Use Customer Not Available to record arrival proof and complete the waiting period before reporting a no-show.",
        code: "NO_SHOW_REVIEW_REQUIRED",
        assignmentId: assignment._id,
      });
    }

    const validTransitions = {
      en_route: ["on_site", "cancelled"],
      on_site: ["in_progress", "cancelled"],
      in_progress: ["completed"],
    };
    const allowed = validTransitions[assignment.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({ error: `Cannot transition from "${assignment.status}" to "${newStatus}"` });
    }
    if (newStatus === "on_site" && !String(arrivalProofUrl || "").startsWith("data:image/")) {
      return res.status(400).json({ error: "A proof-of-arrival photo is required." });
    }
    if (newStatus === "in_progress" && !String(startProofUrl || "").startsWith("data:image/")) {
      return res.status(400).json({ error: "A starting-work proof photo is required." });
    }

    const now = new Date();
    const statusTimestamps = { on_site: "arrivedAt", in_progress: "startedAt", completed: "completedAt", cancelled: "cancelledAt" };
    if (statusTimestamps[newStatus]) assignment[statusTimestamps[newStatus]] = now;

    assignment.status = newStatus;
    if (newStatus === "on_site") {
      assignment.arrivalProofUrl = String(arrivalProofUrl || "").trim();
      assignment.arrivalProofCapturedAt = now;
    }
    if (newStatus === "in_progress") {
      assignment.startProofUrl = startProofUrl;
      assignment.startProofNotes = String(startProofNotes || "").trim();
      assignment.startProofCapturedAt = now;
    }
    assignment.notes.push({ text: `Status changed to ${newStatus.replace(/_/g, " ")}`, by: req.user._id, byName: tech.name, createdAt: now });
    await assignment.save();
    if (["on_site", "in_progress"].includes(newStatus)) {
      await syncMixedVisitItems(booking._id, newStatus, tech);
    }

    // Update availability
    const availabilityMap = { on_site: "In Progress", in_progress: "In Progress" };
    if (availabilityMap[newStatus]) {
      tech.availabilityStatus = availabilityMap[newStatus];
      await tech.save();
    }
    if (newStatus === "completed" || newStatus === "cancelled") {
      const { resolveAvailabilityStatus } = require("../utils/availability");
      tech.availabilityStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      await tech.save();
    }

    // Map assignment status to booking status — phase aware
    // If inspection is already completed, any new visit is Phase 2
    const isPhase1 = !booking.inspection?.completedAt && ["inspection_scheduled", "confirmed", "on-the-way", "arrived"].includes(booking.status);
    const isMixedBooking = booking.serviceType === 'mixed'
      || ((booking.services || []).some(item => item.type === 'core')
        && (booking.services || []).some(item => item.type === 'repair'));
    const bookingStatusMap = {
      // on_site: "arrived" works for both phases
      on_site: "arrived",
      // in_progress: Phase 1 → stay at whatever it was (inspection_scheduled)
      //              Phase 2 → repair_in_progress
      in_progress: isPhase1 ? null : "repair_in_progress",
      completed: "repair_completed",
      cancelled: "pending_reassignment",
    };
    const newBookingStatus = bookingStatusMap[newStatus];
    if (newBookingStatus) {
      const prevStatus = booking.status;
      booking.status = newBookingStatus;
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        fromStatus: prevStatus,
        toStatus: newBookingStatus,
        reason: `Technician ${newStatus.replace(/_/g, " ")}`,
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: tech.name,
        timestamp: now,
      });
      if (newBookingStatus === "repair_in_progress" && isMixedBooking) {
        for (const item of booking.services.filter(row => row.type === "repair" && !["completed", "repair_declined", "cancelled"].includes(row.status))) {
          item.status = "repair_in_progress";
          item.phase = "repair_phase_2";
          item.statusHistory = item.statusHistory || [];
          item.statusHistory.push({
            status: "repair_in_progress",
            changedAt: now,
            changedBy: tech._id,
            changedByName: tech.name || "Technician",
            reason: "Phase 2 Repair work started",
          });
        }
      }
      if (newStatus === "completed") {
        booking.completedAt = now;
        // Fulfill stock reservations
        try {
          const StockReservation = require("../models/StockReservation");
          await StockReservation.fulfillForBooking({
            bookingId: booking._id,
            technicianId: tech._id,
            recordedBy: req.user._id,
          });
        } catch (e) {
          console.error("[STOCK] Fulfill reservation error:", e.message);
        }
      }
      await booking.save();
    }

    // Send mailer for key events
    try {
      const customer = await BookingService.findById(bookingId).populate("customerId", "name email").lean();
      if (customer?.customerId?.email) {
        const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
        const bookingRef = booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`;
        const dateLabel = now.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

        if (newStatus === "on_site") {
          const { sendTechnicianArrivedEmail } = require("../utils/mailer");
          sendTechnicianArrivedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            techName: techFullName,
            serviceName: "Repair Service",
            dateLabel,
            timeLabel: booking.startTime || "TBD",
            locationAddress: booking.location?.address || "",
          }).catch(err => console.error("[MAILER] Repair arrived email error:", err.message));
        } else if (newStatus === "in_progress") {
          const { sendWorkStartedEmail } = require("../utils/mailer");
          sendWorkStartedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            techName: techFullName,
            serviceName: booking.service?.name || "Repair Service",
            serviceType: booking.serviceType || booking.serviceModel || "repair",
            dateLabel,
            timeLabel: booking.startTime || "TBD",
            locationAddress: booking.location?.address || "",
          }).catch(err => console.error("[MAILER] Repair started email error:", err.message));
        } else if (newStatus === "completed") {
          const { sendRepairCompletedEmail } = require("../utils/mailer");
          sendRepairCompletedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            technicianName: techFullName,
            serviceName: "Repair Service",
            dateLabel,
            quotationTotal: booking.quotation?.totalCost || 0,
          }).catch(err => console.error("[MAILER] Repair completed email error:", err.message));
        }
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair status email error:", mailErr.message);
    }

    // Socket notifications
    if (global.io) {
      const customerId = booking.customerId?._id || booking.customerId;
      if (customerId) {
        global.io.to("customer:" + customerId).emit("booking:status-change", {
          bookingId: booking._id,
          status: bookingStatusMap[newStatus] || newStatus,
          technicianName: tech.name,
          timestamp: Date.now(),
        });
      }
    }

    return res.json({ success: true, message: `Status updated to ${newStatus.replace(/_/g, " ")}`, assignment });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Equipment checkout / return (booking-level)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/equipment
 * List all equipment assignments for the authenticated technician.
 */
router.get("/equipment", async (req, res, next) => {
  try {
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const items = await EquipmentAssignment.find({ technicianId: { $in: technicianIds.map(id => new mongoose.Types.ObjectId(id)) } })
      .populate("bookingId", "bookingReference customer service bookingDate")
      .populate("equipmentId", "itemName barcode quantity status")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) { next(err); }
});

/**
 * GET /api/technician/equipment/:bookingId
 * List equipment assigned to a booking for the authenticated technician.
 */
router.get("/equipment/:bookingId", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) { console.error('[parts] Technician not found for user', req.user && req.user._id); return res.status(404).json({ error: "Technician record not found", code: "TECH_NOT_FOUND" }); }

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(bookingId).select("technicianId").lean();
    if (!booking) { console.error('[parts] Booking not found:', bookingId); return res.status(404).json({ error: "Booking not found", code: "BOOKING_NOT_FOUND", bookingId }); }
    if (!technicianIds.includes(String(booking.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    const items = await EquipmentAssignment.find({ bookingId })
      .populate("equipmentId", "itemName barcode quantity status")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/equipment/:assignmentId/checkout
 * Technician confirms they received the assigned equipment.
 */
router.post("/equipment/:assignmentId/checkout", async (req, res, next) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: "Invalid id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Equipment assignment not found" });
    if (!technicianIds.includes(String(assignment.technicianId || ""))) {
      return res.status(403).json({ error: "Not assigned to you" });
    }
    if (assignment.status !== "reserved") return res.status(400).json({ error: "Equipment already checked out or returned" });

    const tool = await Tool.findById(assignment.equipmentId);
    if (!tool) return res.status(404).json({ error: "Tool not found" });
    if (Tool.effectiveInventoryClass(tool) !== 'operational_asset' || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)) {
      return res.status(400).json({ error: 'Only available operational assets can be checked out' });
    }
    if (tool.quantity < assignment.quantity) return res.status(400).json({ error: "Insufficient stock for " + tool.itemName });

    tool.quantity -= assignment.quantity;
    tool.reservedQuantity = Math.max(0, (tool.reservedQuantity || 0) - assignment.quantity);
    if (!assignment.consumable) {
      tool.checkedOutQuantity = (tool.checkedOutQuantity || 0) + assignment.quantity;
      tool.assetStatus = 'checked_out';
    }
    await tool.save();
    assignment.status = assignment.consumable ? "consumed" : "checked_out";
    assignment.checkedOutAt = new Date();
    assignment.checkedOutBy = req.user._id;
    await assignment.save();

    res.json({ success: true, assignment });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/equipment/:assignmentId/return
 * Technician returns equipment. condition = good|damaged|lost
 */
router.post("/equipment/:assignmentId/return", async (req, res, next) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: "Invalid id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { condition = "good", damageDescription = "", damagePhoto = "" } = req.body;
    const allowedConditions = ["good", "fair", "damaged", "lost"];
    if (!allowedConditions.includes(condition)) return res.status(400).json({ error: "Invalid condition" });

    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Equipment assignment not found" });
    if (!technicianIds.includes(String(assignment.technicianId || ""))) {
      return res.status(403).json({ error: "Not assigned to you" });
    }
    if (assignment.status !== "checked_out" && assignment.status !== "in_use") {
      return res.status(400).json({ error: "Equipment is not checked out" });
    }

    const tool = await Tool.findById(assignment.equipmentId);
    assignment.condition = condition;
    assignment.damageDescription = damageDescription;
    assignment.damagePhoto = damagePhoto;
    assignment.returnedAt = new Date();
    assignment.returnedTo = String(req.user._id);

    if (condition === "good" || condition === "fair") {
      if (tool) {
        tool.quantity += assignment.quantity;
        tool.checkedOutQuantity = Math.max(0, (tool.checkedOutQuantity || 0) - assignment.quantity);
        tool.assetCondition = condition;
        tool.assetStatus = tool.checkedOutQuantity > 0 ? 'checked_out' : 'available';
      }
      assignment.status = "returned";
    } else if (condition === "damaged" || condition === "lost") {
      assignment.status = condition;
      if (tool) {
        tool.checkedOutQuantity = Math.max(0, (tool.checkedOutQuantity || 0) - assignment.quantity);
        tool.assetCondition = 'damaged';
        tool.assetStatus = condition === 'damaged' ? 'damaged' : 'retired';
        tool.assignable = false;
      }
    }

    if (tool) await tool.save();
    await assignment.save();
    res.json({ success: true, assignment });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Repair-part reservations (technician initiated)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/bookings/:bookingId/reserved-parts
 * Lists reserved and checked-out repair parts for a booking.
 */
router.get("/bookings/:bookingId/reserved-parts", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) { console.error('[parts] Technician not found for user', req.user && req.user._id); return res.status(404).json({ error: "Technician record not found", code: "TECH_NOT_FOUND" }); }

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(bookingId).select("technicianId").lean();
    if (!booking) { console.error('[parts] Booking not found:', bookingId); return res.status(404).json({ error: "Booking not found", code: "BOOKING_NOT_FOUND", bookingId }); }
    if (String(booking.technicianId) !== String(tech._id)) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    const StockReservation = require("../models/StockReservation");
    const reservations = await StockReservation.find({ bookingId })
      .populate("toolId", "itemName quantity costPrice sellingPrice type barcode")
      .sort({ reservedAt: -1 })
      .lean();

    return res.json({ reservations });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/bookings/:bookingId/reserve-parts
 * Body: { partName, quantity, toolId? }
 * Reserves a repair part from the catalog.
 */
router.post("/bookings/:bookingId/reserve-parts", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) { console.error('[parts] Technician not found for user', req.user && req.user._id); return res.status(404).json({ error: "Technician record not found", code: "TECH_NOT_FOUND" }); }

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(bookingId).select("technicianId status technicianAssistant").lean();
    if (!booking) { console.error('[parts] Booking not found:', bookingId); return res.status(404).json({ error: "Booking not found", code: "BOOKING_NOT_FOUND", bookingId }); }
    if (String(booking.technicianId) !== String(tech._id)) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    let { partName, quantity, toolId } = req.body;
    partName = String(partName || "").trim();
    const qty = Math.max(1, parseInt(quantity) || 1);
    if (!partName) return res.status(400).json({ error: "partName is required" });

    const StockReservation = require("../models/StockReservation");
    const escapedPartName = partName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recommendedNames = new Set((booking.technicianAssistant?.possibleParts || [])
      .map(part => String(typeof part === "string" ? part : part?.name || "").trim().toLowerCase())
      .filter(Boolean));
    const isAiRecommendedPart = recommendedNames.has(partName.toLowerCase());
    const acknowledgeAiReview = async () => {
      if (!isAiRecommendedPart || !booking.technicianAssistant?.summary) return false;
      await BookingService.findByIdAndUpdate(bookingId, {
        $set: {
          "technicianAssistant.verifiedByTechnician": true,
          "technicianAssistant.verifiedAt": new Date(),
        },
      });
      return true;
    };
    const existingReservation = await StockReservation.findOne({
      bookingId,
      status: { $in: ["reserved", "checked_out"] },
      itemName: { $regex: new RegExp(`^${escapedPartName}$`, "i") },
    }).lean();
    if (existingReservation) {
      const aiVerified = await acknowledgeAiReview();
      return res.json({ reservation: existingReservation, alreadyReserved: true, aiVerified });
    }

    let tool = null;
    if (toolId && mongoose.Types.ObjectId.isValid(toolId)) {
      tool = await Tool.findById(toolId).lean();
      if (tool && Tool.effectiveInventoryClass(tool) !== 'merchandise') {
        return res.status(400).json({ error: 'Operational assets cannot be reserved as repair parts' });
      }
    }
    if (!tool) {
      let candidates = await Tool.find({
        active: true,
        $and: [Tool.merchandiseFilter()],
        itemName: { $regex: new RegExp(`^${escapedPartName}$`, "i") },
      }).lean();

      // Deleted/test bookings must not keep a part locked forever. Reconcile
      // exact catalog matches before calculating availability, then select the
      // matching SKU with the most genuinely available units.
      await Promise.all(candidates.map((candidate) => StockReservation.releaseOrphanedForTool(candidate._id)));
      candidates = await Tool.find({
        active: true,
        $and: [Tool.merchandiseFilter()],
        itemName: { $regex: new RegExp(`^${escapedPartName}$`, "i") },
      }).lean();
      candidates.sort((a, b) => {
        const availableA = Math.max(0, Number(a.quantity || 0) - Number(a.reservedQuantity || 0));
        const availableB = Math.max(0, Number(b.quantity || 0) - Number(b.reservedQuantity || 0));
        return availableB - availableA || Number(b.quantity || 0) - Number(a.quantity || 0);
      });
      tool = candidates[0] || null;
    } else {
      await StockReservation.releaseOrphanedForTool(tool._id);
      tool = await Tool.findById(tool._id).lean();
    }

    if (!tool) {
      return res.status(409).json({
        error: `${partName} is not available in the inventory catalog. A parts request is required.`,
        code: "PART_NOT_IN_INVENTORY",
        partName,
        requested: qty,
        available: 0,
      });
    }

    let unitPrice = 0;
    const available = Math.max(0, (tool.quantity || 0) - (tool.reservedQuantity || 0));
    if (qty > available) {
      return res.status(409).json({
        error: `${tool.itemName} has ${tool.quantity || 0} on hand, but ${tool.reservedQuantity || 0} already reserved (${available} available, ${qty} required).`,
        code: "PART_OUT_OF_STOCK",
        partName: tool.itemName,
        toolId: tool._id,
        requested: qty,
        available,
        onHand: Number(tool.quantity || 0),
        reserved: Number(tool.reservedQuantity || 0),
      });
    }
    // Atomically claim available stock so simultaneous requests cannot reserve
    // the same final unit.
    const claimedTool = await Tool.findOneAndUpdate(
      {
        _id: tool._id,
        active: true,
        $expr: {
          $gte: [
            { $subtract: [{ $ifNull: ["$quantity", 0] }, { $ifNull: ["$reservedQuantity", 0] }] },
            qty,
          ],
        },
      },
      { $inc: { reservedQuantity: qty } },
      { returnDocument: "after" },
    ).lean();
    if (!claimedTool) {
      const latest = await Tool.findById(tool._id).lean();
      const latestAvailable = Math.max(0, Number(latest?.quantity || 0) - Number(latest?.reservedQuantity || 0));
      return res.status(409).json({
        error: `${tool.itemName} is out of stock (${latestAvailable} available, ${qty} required).`,
        code: "PART_OUT_OF_STOCK",
        partName: tool.itemName,
        toolId: tool._id,
        requested: qty,
        available: latestAvailable,
        onHand: Number(latest?.quantity || 0),
        reserved: Number(latest?.reservedQuantity || 0),
      });
    }
    unitPrice = Number(tool.costPrice) || Number(tool.sellingPrice) || 0;

    let reservation;
    try {
      reservation = await StockReservation.create({
        toolId: tool._id,
        bookingId,
        quantity: qty,
        status: "reserved",
        stockTreatment: "soft_hold",
        itemName: partName,
        unitPrice,
        reservedAt: new Date(),
      });
    } catch (createError) {
      // Do not leak a stock hold if reservation persistence fails.
      await Tool.findByIdAndUpdate(tool._id, { $inc: { reservedQuantity: -qty } }).catch(() => {});
      throw createError;
    }

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "parts_reserved",
      title: "Repair Part Reserved",
      message: `${tech.name} reserved ${partName} ×${qty}`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/inventory/reservations",
      priority: "normal",
      io: req.app.get("io"),
    }).catch(() => {});

    const aiVerified = await acknowledgeAiReview();
    return res.status(201).json({ reservation, tool: claimedTool, aiVerified });
  } catch (err) { next(err); }
});

router.post('/appointments/:id/local-purchase/customer-verify', async (req, res) => {
  try {
    const BookingService = require('../models/BookingService');
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: 'Technician profile not found' });
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (String(booking.technicianId) !== String(tech._id)) return res.status(403).json({ error: 'Not assigned to this booking' });
    if (!req.body.correctPartVerified) return res.status(400).json({ error: 'The technician must verify that the customer obtained the correct part.' });
    const customerRows = booking.localPurchase.filter(row => row.purchaseByType === 'customer');
    if (!customerRows.length) return res.status(400).json({ error: 'No customer local-purchase plan exists.' });
    customerRows.forEach(row => { row.purchaseStatus = 'verified'; row.verifiedAt = new Date(); row.purchasedAt = row.purchasedAt || new Date(); row.actualPurchaseCost = 0; row.notes = req.body.notes || 'Customer-provided part verified by technician'; });
    await transitionRepairStatus(booking, 'repair_in_progress', tech, { reason: 'Customer-provided local part verified', metadata: { source: 'customer_purchase', inventoryDeduction: 0, companyCost: 0 } });
    await booking.save();
    return res.json({ success: true, repairStarted: true, status: booking.status });
  } catch (error) {
    console.error('Customer local purchase verification error:', error);
    return res.status(500).json({ error: 'Could not verify customer-provided part.' });
  }
});

/**
 * Submit the technician's complete Phase 1 repair-parts selection to admin.
 * Available parts may already be soft-reserved; unavailable/custom parts stay
 * in the same request so admin sees one authoritative list.
 */
router.post("/bookings/:bookingId/submit-parts-review", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: 'Invalid booking id' });
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: 'Technician record not found' });

    const BookingService = require('../models/BookingService');
    const PartsRequest = require('../models/PartsRequest');
    const StockReservation = require('../models/StockReservation');
    const booking = await BookingService.findById(bookingId).populate('customerId', 'name email phone');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (String(booking.technicianId) !== String(tech._id)) return res.status(403).json({ error: 'You are not assigned to this booking' });
    if (!booking.technicianAssistant?.summary) return res.status(409).json({ error: 'Open AI Analysis before submitting repair parts.' });

    const submitted = Array.isArray(req.body.parts) ? req.body.parts.slice(0, 50) : [];
    const merged = new Map();
    submitted.forEach(part => {
      const name = String(part?.name || part?.partName || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      const quantity = Math.max(1, Math.min(999, Number(part.quantity) || 1));
      const existing = merged.get(key);
      merged.set(key, {
        name,
        quantity: existing ? Math.max(existing.quantity, quantity) : quantity,
        toolId: mongoose.Types.ObjectId.isValid(part.toolId) ? part.toolId : (existing?.toolId || null),
      });
    });
    const selectedParts = [...merged.values()];
    if (!selectedParts.length) return res.status(400).json({ error: 'Select or add at least one repair part.' });

    const activeReservations = await StockReservation.find({
      bookingId: booking._id,
      status: { $in: ['reserved', 'checked_out'] },
    }).select('toolId itemName quantity').lean();
    const requestItems = [];
    for (const part of selectedParts) {
      let tool = null;
      if (part.toolId) tool = await Tool.findOne({ _id: part.toolId, $and: [Tool.merchandiseFilter()] }).lean();
      if (!tool) {
        const escaped = part.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        tool = await Tool.findOne({
          active: { $ne: false },
          $and: [Tool.merchandiseFilter()],
          itemName: { $regex: new RegExp(`^${escaped}$`, 'i') },
        }).lean();
      }
      const reservedQty = activeReservations
        .filter(row => (tool && String(row.toolId) === String(tool._id)) || String(row.itemName || '').trim().toLowerCase() === part.name.toLowerCase())
        .reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
      const freeQty = tool ? Math.max(0, Number(tool.quantity || 0) - Number(tool.reservedQuantity || 0)) : 0;
      requestItems.push({
        toolId: tool?._id || null,
        itemName: tool?.itemName || part.name,
        requestedQty: part.quantity,
        availableQty: Math.min(part.quantity, reservedQty + freeQty),
        status: 'waiting',
      });
    }

    const resumeStatus = booking.status === 'waiting_parts'
      ? (booking.partsRequest?.resumeStatus || 'inspection_scheduled')
      : booking.status;
    let partsRequest = await PartsRequest.findOne({ bookingId: booking._id, status: { $in: ['pending', 'procuring'] } });
    if (partsRequest?.status === 'procuring') return res.status(409).json({ error: 'Admin has already started procurement. The submitted parts list can no longer be changed.' });
    if (!partsRequest) {
      partsRequest = new PartsRequest({
        bookingId: booking._id,
        workOrderNumber: booking.workOrderNumber,
        customerId: booking.customerId?._id || booking.customerId,
        customerName: booking.customerId?.name || booking.customer?.name || 'Customer',
        technicianId: tech._id,
        technicianName: tech.name || 'Technician',
        requestedBy: req.user._id,
      });
    }
    partsRequest.items = requestItems;
    partsRequest.status = 'pending';
    partsRequest.requestedAt = new Date();
    partsRequest.resumeStatus = resumeStatus;
    partsRequest.notes = 'Phase 1 AI/technician repair-parts review';
    await partsRequest.save();

    const previousStatus = booking.status;
    const allPartsSecured = requestItems.every(item => Number(item.availableQty || 0) >= Number(item.requestedQty || 1));
    const targetStatus = allPartsSecured ? resumeStatus : 'waiting_parts';
    booking.partsRequest = {
      status: 'pending', requestedAt: new Date(), requestedBy: req.user._id,
      resumeStatus, items: requestItems,
    };
    booking.technicianAssistant.verifiedByTechnician = true;
    booking.technicianAssistant.verifiedAt = booking.technicianAssistant.verifiedAt || new Date();
    booking.status = targetStatus;
    if (previousStatus !== targetStatus) {
      booking.recordStatusHistory({
        fromStatus: previousStatus, toStatus: targetStatus,
        reason: allPartsSecured
          ? `All preparation parts secured; admin review recorded: ${requestItems.map(item => item.itemName).join(', ')}`
          : `Waiting for unavailable repair parts: ${requestItems.filter(item => Number(item.availableQty || 0) < Number(item.requestedQty || 1)).map(item => item.itemName).join(', ')}`,
        changedBy: req.user._id, changedByModel: 'Technician', changedByName: tech.name || 'Technician',
      });
    }
    await booking.save();

    const { createNotification } = require('../utils/notify');
    await createNotification({
      type: 'parts_request', title: 'Repair Parts Ready for Review',
      message: `${tech.name || 'Technician'} submitted ${requestItems.length} repair part(s) for ${booking.workOrderNumber || booking._id}.`,
      role: 'admin', referenceId: booking._id, referenceModel: 'BookingService',
      link: '/admin/appointments/repair-scheduling', priority: 'high', io: req.app.get('io'),
    }).catch(() => {});
    if (global.io) global.io.to('admin').emit('booking:updated', { bookingId: booking._id, status: targetStatus, requestPhase: 'phase_1_ai_preparation' });

    return res.json({ success: true, requestId: partsRequest._id, items: requestItems, allPartsSecured, status: targetStatus, requestPhase: 'phase_1_ai_preparation' });
  } catch (err) { next(err); }
});

/** Confirm the required repair preparation steps before departure. */
router.post("/bookings/:bookingId/confirm-preparation", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (String(booking.technicianId) !== String(tech._id)) return res.status(403).json({ error: "You are not assigned to this booking" });
    const assignments = await Assignment.find({ bookingId, technicianId: tech._id }).select("equipmentCheckedOut").lean();
    const anyEquipmentChecked = assignments.some(a => a.equipmentCheckedOut);
    const DailyKit = require('../models/DailyKit');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dailyKit = await DailyKit.findOne({ technicianId: tech._id, workDate: todayStart }).lean();
    const kitConfirmed = dailyKit && ['confirmed', 'in_progress'].includes(dailyKit.status);
    if (!anyEquipmentChecked && !kitConfirmed) return res.status(400).json({ error: "Complete Daily Preparation first." });
    booking.repairPreparation = { confirmed: true, confirmedAt: new Date(), confirmedBy: tech._id };
    await booking.save();
    return res.json({ success: true, repairPreparation: booking.repairPreparation });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/bookings/:id/check-out-parts
 * Checks out all reserved repair parts for a booking.
 * Deducts stock, marks reservation as checked_out, and records usage.
 */
router.post("/bookings/:id/check-out-parts", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id).select("technicianId").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (String(booking.technicianId) !== String(tech._id)) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    const StockReservation = require("../models/StockReservation");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const reservations = await StockReservation.find({ bookingId: id, status: "reserved" }).lean();

    const checkedOut = [];
    const failed = [];
    for (const resv of reservations) {
      if (!resv.toolId) {
        failed.push({ _id: resv._id, itemName: resv.itemName, reason: "No inventory link" });
        continue;
      }
      const tool = await Tool.findById(resv.toolId);
      if (!tool) {
        failed.push({ _id: resv._id, itemName: resv.itemName, reason: "Tool not found" });
        continue;
      }
      if (Tool.effectiveInventoryClass(tool) !== 'merchandise') {
        failed.push({ _id: resv._id, itemName: resv.itemName, reason: 'Operational assets cannot be consumed as repair parts' });
        continue;
      }
      const isSoftHold = resv.stockTreatment === "soft_hold";
      if (isSoftHold && tool.quantity < resv.quantity) {
        failed.push({ _id: resv._id, itemName: resv.itemName, reason: `Only ${tool.quantity} in stock` });
        continue;
      }

      // Admin/quotation reservations already deducted on-hand stock. Only a
      // technician soft hold is deducted when the part is physically checked out.
      if (isSoftHold) {
        tool.quantity -= resv.quantity;
        tool.reservedQuantity = Math.max(0, (tool.reservedQuantity || 0) - resv.quantity);
        await tool.save();
      }

      await StockReservation.findByIdAndUpdate(resv._id, { status: "checked_out" });

      await ServiceToolUsage.create({
        bookingId: id,
        serviceItemId: resv.serviceItemId || null,
        technicianId: tech._id,
        toolItemId: resv.toolId,
        inventoryItemId: resv.toolId,
        itemName: resv.itemName || tool.itemName,
        itemType: tool.type === "tool" ? "equipment" : (tool.type || "part"),
        quantityUsed: resv.quantity,
        unitPrice: resv.unitPrice || tool.costPrice || 0,
        deductedFromInventory: true,
        toolCost: (resv.unitPrice || tool.costPrice || 0) * resv.quantity,
        recordedBy: req.user._id,
        usedAt: new Date(),
      });

      checkedOut.push({ _id: resv._id, itemName: resv.itemName || tool.itemName, quantity: resv.quantity });
    }

    return res.json({ checkedOut, failed });
  } catch (err) { next(err); }
});

module.exports = router;
