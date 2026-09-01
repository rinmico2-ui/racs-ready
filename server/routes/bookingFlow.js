/**
 * Enterprise Booking Flow API
 * Mounted at /api/booking-flow
 * Handles the 6-stage booking lifecycle:
 *   1. Booking Request (customer)
 *   2. Admin Review (reject/verify payment)
 *   3. Assignment Queue
 *   4. Admin Assigns Technician
 *   5. Technician Response (accept/decline)
 *   6. Service Execution
 */
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE 2: Admin Reviews Booking Request
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * POST /api/booking-flow/:id/reject
 * Body: { reason: string, note?: string }
 * Admin rejects a pending booking.
 * Booking Status: pending â†’ rejected
 */
router.post("/:id/reject", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    const { reason, note } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });
    if (!reason) return res.status(400).json({ error: "Rejection reason is required" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "pending") {
      return res.status(400).json({ error: `Cannot reject booking with status "${booking.status}"` });
    }

    const validReasons = ["invalid_payment", "incomplete_info", "duplicate_booking", "unavailable", "other"];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: `Invalid reason. Must be one of: ${validReasons.join(", ")}` });
    }

    booking.status = "rejected";
    booking.rejectionReason = reason;
    booking.rejectionNote = (note || "").trim().slice(0, 500);
    booking.rejectedAt = new Date();
    booking.rejectedBy = req.user._id;
    await booking.save();

    await audit.logEvent({
      actor: req.user._id,
      target: booking._id,
      action: "booking.reject",
      module: "admin",
      req,
      details: { reason, note },
    }).catch(() => {});

    return res.json({ message: "Booking rejected.", booking });
  } catch (err) { next(err); }
});

/**
 * POST /api/booking-flow/:id/verify-payment
 * Body: { notes?: string }
 * Admin verifies the payment proof and marks payment as verified.
 * Booking Status: pending â†’ payment_verified
 * Payment Status: pending â†’ paid
 */
router.post("/:id/verify-payment", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
const Payment = require("../models/Payment");
const { calculatePaymentBreakdown } = require("../utils/paymentPolicy");
    const { id } = req.params;
    const { notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "pending") {
      return res.status(400).json({ error: `Cannot verify payment for booking with status "${booking.status}"` });
    }

    // Update booking
    const totalAmount = booking.totalPrice || booking.estimatedFee || 0;
    const isCOD = booking.paymentMethod === 'cod';

    if (isCOD) {
      const downpayment = booking.downpaymentAmount || calculatePaymentBreakdown(totalAmount, booking.downpaymentPercentage).downpaymentAmount;
      booking.paymentStatus = 'partial';
      booking.amountPaid = downpayment;
      booking.balanceAmount = Math.max(0, totalAmount - downpayment);
      booking.balanceCollected = false;
    } else {
      booking.paymentStatus = 'paid';
      booking.amountPaid = totalAmount;
      booking.balanceAmount = 0;
    }

    booking.status = "payment_verified";
    booking.paymentVerifiedAt = new Date();
    booking.paymentVerifiedBy = req.user._id;
    if (notes) booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[Payment Verified] ${notes}`;
    await booking.save();

    // Update payment record
    const paymentUpdateData = isCOD
      ? { status: "partial", verifiedAt: new Date(), notes: notes || "", amount: booking.downpaymentAmount || calculatePaymentBreakdown(totalAmount, booking.downpaymentPercentage).downpaymentAmount }
      : { status: "paid", verifiedAt: new Date(), notes: notes || "" };
    await Payment.updateMany(
      { bookingId: booking._id, status: "pending" },
      { $set: paymentUpdateData }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: booking._id,
      action: "booking.verify_payment",
      module: "admin",
      req,
      details: { notes },
    }).catch(() => {});

    return res.json({ message: "Payment verified. Booking moved to assignment queue.", booking });
  } catch (err) { next(err); }
});

/**
 * POST /api/booking-flow/:id/move-to-queue
 * Moves a payment_verified booking to the assignment queue.
 * Booking Status: payment_verified â†’ awaiting_assignment
 */
router.post("/:id/move-to-queue", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "payment_verified") {
      return res.status(400).json({ error: `Cannot move to queue. Status is "${booking.status}"` });
    }

    booking.status = "awaiting_assignment";
    await booking.save();

    return res.json({ message: "Booking moved to assignment queue.", booking });
  } catch (err) { next(err); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE 3: Assignment Queue
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * GET /api/booking-flow/queue
 * Returns all bookings in the assignment queue (awaiting_assignment).
 */
router.get("/queue", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { page = 1, limit = 20, search } = req.query;

    const filter = { status: "awaiting_assignment" };
    if (search) {
      filter.$or = [
        { "customer.name": { $regex: search, $options: "i" } },
        { "customer.email": { $regex: search, $options: "i" } },
        { "service.name": { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      BookingService.find(filter)
        .sort({ createdAt: 1 }) // oldest first (FIFO)
        .skip(skip)
        .limit(lim)
        .lean(),
      BookingService.countDocuments(filter),
    ]);

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) { next(err); }
});

/**
 * GET /api/booking-flow/queue/stats
 * Returns queue statistics.
 */
router.get("/queue/stats", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const stats = await BookingService.aggregate([
      {
        $facet: {
          awaitingAssignment: [
            { $match: { status: "awaiting_assignment" } },
            { $count: "count" },
          ],
          assigned: [
            { $match: { status: "assigned" } },
            { $count: "count" },
          ],
          pendingReview: [
            { $match: { status: "pending" } },
            { $count: "count" },
          ],
          paymentVerified: [
            { $match: { status: "payment_verified" } },
            { $count: "count" },
          ],
          pendingReassignment: [
            { $match: { status: "pending_reassignment" } },
            { $count: "count" },
          ],
          totalActive: [
            { $match: { status: { $nin: ["completed", "cancelled", "rejected"] } } },
            { $count: "count" },
          ],
        },
      },
    ]);

    const s = stats[0] || {};
    return res.json({
      awaitingAssignment: s.awaitingAssignment[0]?.count || 0,
      assigned: s.assigned[0]?.count || 0,
      pendingReview: s.pendingReview[0]?.count || 0,
      paymentVerified: s.paymentVerified[0]?.count || 0,
      pendingReassignment: s.pendingReassignment[0]?.count || 0,
      totalActive: s.totalActive[0]?.count || 0,
    });
  } catch (err) { next(err); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE 4: Admin Assigns Technician
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * GET /api/booking-flow/:id/eligible-technicians
 * Returns technicians eligible for assignment.
 *
 * Eligibility is based on:
 *   âœ“ Technician account is active
 *   âœ“ Technician is not on leave on the booking date
 *   âœ“ Technician has working hours configured on the booking date
 *   âœ“ Technician has not exceeded booking capacity
 *
 * Attendance status and availabilityStatus are NOT used to determine
 * future assignment eligibility â€” they are operational tracking for the
 * current workday only.
 */
router.get("/:id/eligible-technicians", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    // â”€â”€ 1. Fetch the booking to get its date & location â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const booking = await BookingService.findById(id).select("bookingDate location").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const bookingDate = new Date(booking.bookingDate);
    bookingDate.setHours(0, 0, 0, 0);
    const dayOfWeek = bookingDate.getDay();

    // Booking coordinates [lng, lat]
    const bookingCoords = booking.location?.coordinates?.coordinates;
    const bookingLat = bookingCoords ? bookingCoords[1] : null;
    const bookingLng = bookingCoords ? bookingCoords[0] : null;

    // â”€â”€ 2. Fetch ALL active technicians â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const allTechs = await Technician.find({ active: true })
      .select("name email phone availabilityStatus rating location")
      .sort({ name: 1 })
      .lean();

    if (allTechs.length === 0) {
      return res.json({ available: [], offlinePresent: [], total: 0 });
    }

    const techIds = allTechs.map(t => t._id);

    // â”€â”€ 3. Batch-fetch schedules, leave records, and active assignments â”€â”€â”€â”€
    const [schedules, leaveRecords, activeAssignments] = await Promise.all([
      TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean(),
      LeaveRequest.find({
        technicianId: { $in: techIds },
        status: "approved",
        startDate: { $lte: bookingDate },
        endDate: { $gte: bookingDate },
      }).select("technicianId").lean(),
      Assignment.find({
        technicianId: { $in: techIds },
        status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
      }).select("technicianId").lean(),
    ]);

    // Build lookup maps
    const scheduleMap = {};
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    const leaveTechIds = new Set(leaveRecords.map(lr => lr.technicianId.toString()));

    const workloadMap = {};
    activeAssignments.forEach(a => {
      const tid = a.technicianId.toString();
      workloadMap[tid] = (workloadMap[tid] || 0) + 1;
    });

    // â”€â”€ 4. Filter technicians by eligibility criteria â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const MAX_ACTIVE_ASSIGNMENTS = 3;

    const eligible = [];
    const ineligible = [];

    for (const tech of allTechs) {
      const tid = tech._id.toString();

      // Not on approved leave for the booking date
      if (leaveTechIds.has(tid)) {
        ineligible.push({ ...tech, reason: "On Leave" });
        continue;
      }

      // Has working hours configured for this day of week
      const schedule = scheduleMap[tid];
      if (!schedule) {
        ineligible.push({ ...tech, reason: "No Schedule" });
        continue;
      }

      const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
      const isNonWorkingWeekday = schedule.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek);
      if (!workingDay || isNonWorkingWeekday) {
        ineligible.push({ ...tech, reason: "Not Working This Day" });
        continue;
      }

      // Check individual rest dates
      const isRestDate = schedule.restDates?.some(rd => {
        const rdDate = new Date(rd.date);
        return rdDate.getFullYear() === bookingDate.getFullYear() &&
               rdDate.getMonth() === bookingDate.getMonth() &&
               rdDate.getDate() === bookingDate.getDate();
      });
      if (isRestDate) {
        ineligible.push({ ...tech, reason: "Rest Day" });
        continue;
      }

      // Has not exceeded booking capacity
      const currentWorkload = workloadMap[tid] || 0;
      if (currentWorkload >= MAX_ACTIVE_ASSIGNMENTS) {
        ineligible.push({ ...tech, reason: "At Capacity", workload: currentWorkload });
        continue;
      }

      // Technician is eligible â€” include current workload info
      const techCoords = tech.location?.coordinates?.coordinates || tech.location?.coordinates;
      let distanceKm = null;
      let etaMin = null;
      if (bookingLat != null && bookingLng != null && Array.isArray(techCoords) && techCoords.length === 2) {
        const R = 6371;
        const dLat = ((techCoords[1] - bookingLat) * Math.PI) / 180;
        const dLng = ((techCoords[0] - bookingLng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((bookingLat * Math.PI) / 180) * Math.cos((techCoords[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distanceKm = Math.round(R * c * 10) / 10;
        etaMin = Math.max(10, Math.round(distanceKm * 3 + 5));
      }

      eligible.push({
        ...tech,
        _id: tech._id,
        name: tech.name || [tech.firstName, tech.lastName].filter(Boolean).join(" "),
        currentWorkload,
        distanceKm,
        etaMin,
        availabilityStatus: tech.availabilityStatus || "Offline",
      });
    }

    // â”€â”€ 5. AI scoring â€” rank eligible technicians by best fit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const scoreTech = (t) => {
      let score = 0;
      const status = (t.availabilityStatus || "").toLowerCase();
      // Availability is the strongest signal: never recommend an offline/busy tech
      // when an available one exists.
      if (status === "available") score += 100;
      else if (status === "online") score += 60;
      else score += 0; // offline / unknown â€” heavily deprioritised
      // Rating (0â€“5) weighted
      score += (t.rating || 0) * 8;
      // Workload: fewer active jobs is better
      score += Math.max(0, 40 - (t.currentWorkload || 0) * 15);
      // Distance: closer is strongly preferred
      if (t.distanceKm != null) {
        score += Math.max(0, 60 - t.distanceKm * 2);
      }
      return score;
    };

    eligible.sort((a, b) => scoreTech(b) - scoreTech(a));

    return res.json({
      available: eligible,
      offlinePresent: ineligible,
      bookingLat,
      bookingLng,
      total: eligible.length,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/booking-flow/:id/assign
 * Body: { technicianId: string, priority?: string, notes?: string }
 * Admin assigns a technician to a booking.
 * Booking Status: awaiting_assignment â†’ assigned
 * Creates Assignment document.
 */
router.post("/:id/assign", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const Technician = require("../models/Technician");
    const { id } = req.params;
    const { technicianId, priority, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });
    if (!mongoose.Types.ObjectId.isValid(technicianId)) return res.status(400).json({ error: "Invalid technician id" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!["awaiting_assignment", "pending_reassignment", "assigned"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign technician. Status is "${booking.status}"` });
    }

    const tech = await Technician.findById(technicianId).lean();
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    // If reassignment, decline the old assignment
    if (booking.status === "assigned" && booking.assignmentId) {
      const oldAssignment = await Assignment.findById(booking.assignmentId);
      if (oldAssignment && oldAssignment.status === "pending_acceptance") {
        oldAssignment.status = "declined";
        oldAssignment.declinedAt = new Date();
        oldAssignment.notes.push({
          text: "Reassigned to another technician by admin",
          by: req.user._id,
          byName: req.user.name || "Admin",
          createdAt: new Date(),
        });
        await oldAssignment.save();
      }
    }

    // Calculate SLA deadline (2 hours from now)
    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + 2);

    // Create Assignment
    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: booking.customer?.name || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      serviceType: booking.serviceType || (booking.isMultiService ? "multi" : "single"),
      serviceName: booking.service?.name || "",
      servicePrice: booking.totalPrice || booking.servicePrice || 0,
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      endTime: booking.endTime,
      address: booking.location?.address || "",
      coordinates: {
        lat: booking.location?.lat,
        lng: booking.location?.lng,
      },
      status: "pending_acceptance",
      priority: priority || "normal",
      slaDeadline,
      estimatedFee: booking.estimatedFee || 0,
      travelFare: booking.travelFare || 0,
      travelTime: booking.travelTime || 0,
      notes: notes ? [{
        text: notes,
        by: req.user._id,
        byName: req.user.name || "Admin",
        createdAt: new Date(),
      }] : [],
    });

    // Update booking
    booking.status = "assigned";
    booking.technicianId = tech._id;
    booking.technician = {
      _id: tech._id,
      name: tech.name,
      phone: tech.phone,
      email: tech.email,
    };
    booking.assignedAt = new Date();
    booking.assignedBy = req.user._id;
    booking.assignmentId = assignment._id;
    if (notes) booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[Assigned] ${notes}`;
    await booking.save();

    // Update technician availability (use centralized resolver to respect attendance)
    const { resolveAvailabilityStatus } = require("../utils/availability");
    const freshTech = await Technician.findById(tech._id);
    if (freshTech) {
      freshTech.availabilityStatus = "Assigned";
      const resolvedStatus = await resolveAvailabilityStatus(freshTech, null, null, { syncDb: false });
      // If centralized resolver allows the assignment (tech is checked in), proceed
      // If tech is not checked in, still set Assigned but the resolver will correct on next read
      await Technician.findByIdAndUpdate(tech._id, { availabilityStatus: resolvedStatus });
    }

    await audit.logEvent({
      actor: req.user._id,
      target: booking._id,
      action: "booking.assign",
      module: "admin",
      req,
      details: { technicianId: tech._id, technicianName: tech.name, assignmentId: assignment._id },
    }).catch(() => {});

    // Emit socket notification to technician
    const io = req.app.get("io");
    if (io) {
      io.to("tech:" + tech._id).emit("assignment:new", {
        assignmentId: assignment._id,
        bookingId: booking._id,
        customerName: booking.customer?.name,
        serviceName: booking.service?.name,
        bookingDate: booking.bookingDate,
        priority: priority || "normal",
      });
    }

    // â”€â”€ Email: Notify Technician of Assignment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      const User = require("../models/User");
      const { sendTechnicianNotificationEmail } = require("../utils/mailer");
      const techUser = tech.user ? await User.findById(tech.user).lean() : null;
      const techEmail = techUser?.email;
      const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || techUser?.name || tech.name || "Technician";

      if (techEmail) {
        const dateLabel = booking.bookingDate
          ? new Date(booking.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        const timeLabel = booking.startTime || "TBD";
        sendTechnicianNotificationEmail({
          to: techEmail,
          technicianName: techFullName,
          customerName: booking.customer?.name || "Customer",
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.service?.name || "Service",
          dateLabel,
          timeLabel,
          totalLabel: `â‚±${Number(booking.totalPrice || booking.estimatedFee || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || "",
          issueDescription: booking.issueDescription || "",
        }).catch((err) => console.error("[MAILER] Failed to send assignment email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Assignment email error:", mailErr.message);
    }

    return res.json({
      message: `Assigned to ${tech.name}. Technician has been notified.`,
      assignment,
      booking,
    });
  } catch (err) { next(err); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE 5: Technician Response (handled in technicianApi.js)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// The accept/decline endpoints already exist in technicianApi.js.
// We need to add booking status sync there (Phase 5).

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE 6: Service Execution Status Sync
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * POST /api/booking-flow/:id/sync-status
 * Body: { status: string }
 * Syncs assignment status changes to booking status.
 * Called internally when technician transitions assignment.
 */
router.post("/:id/sync-status", auth.authenticate, async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    const { status: assignmentStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking id" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Map assignment statuses to booking statuses
    const statusMap = {
      "accepted": "confirmed",
      "en_route": "on-the-way",
      "on_site": "arrived",
      "in_progress": "in-progress",
      "completed": "completed",
      "cancelled": "pending_reassignment",
      "declined": "pending_reassignment",
    };

    const newBookingStatus = statusMap[assignmentStatus];
    if (!newBookingStatus) {
      return res.status(400).json({ error: `No booking status mapping for assignment status "${assignmentStatus}"` });
    }

    booking.status = newBookingStatus;
    if (assignmentStatus === "completed") {
      booking.completedAt = new Date();
    }
    await booking.save();

    return res.json({ message: `Booking status updated to ${newBookingStatus}`, booking });
  } catch (err) { next(err); }
});

/**
 * GET /api/booking-flow/all
 * Returns all bookings with their statuses for the admin appointments page.
 * Query: ?status=...&page=1&limit=20&search=...&date=YYYY-MM-DD
 */
router.get("/all", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { status, page = 1, limit = 20, search, date } = req.query;

    const filter = {};
    if (status) {
      if (status === "active") {
        filter.status = { $in: ["confirmed", "scheduled", "on-the-way", "arrived", "in-progress"] };
      } else if (status === "awaiting_action") {
        filter.status = { $in: ["pending", "awaiting_assignment", "assigned", "pending_reassignment"] };
      } else {
        filter.status = status;
      }
    }
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      filter.bookingDate = { $gte: d, $lt: next };
    }
    if (search) {
      filter.$or = [
        { "customer.name": { $regex: search, $options: "i" } },
        { "customer.email": { $regex: search, $options: "i" } },
        { "customer.phone": { $regex: search, $options: "i" } },
        { "service.name": { $regex: search, $options: "i" } },
        { "technician.name": { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      BookingService.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      BookingService.countDocuments(filter),
    ]);

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) { next(err); }
});

module.exports = router;
