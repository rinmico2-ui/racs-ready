const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const Assignment = require("../models/Assignment");
const { resolveAvailabilityBulk } = require("./availability");
const { BookingStatus } = require("../models/BookingStatus");
const {
  calculateWorkload,
  generateTimeWindowsForDate,
  APPOINTMENT_WINDOWS,
} = require("./enterpriseSchedulingEngine");

const AUTO_ASSIGN_WINDOW_MINUTES = 60;

async function findVacantTechnicians(booking) {
  const bookingDate = new Date(booking.bookingDate);
  bookingDate.setHours(0, 0, 0, 0);
  const dayOfWeek = bookingDate.getDay();

  const targetStartMin = parseMinuteValue(booking.startTime);
  const targetEndMin = deriveEndMinutes(booking);

  if (!Number.isFinite(targetStartMin) || !Number.isFinite(targetEndMin)) {
    return [];
  }

  const allTechs = await Technician.find({ active: { $ne: false } })
    .select("_id name phone email userEmail availabilityStatus rating")
    .lean();

  if (!allTechs.length) return [];

  const techIds = allTechs.map((t) => t._id);

  const [schedules, leaveRecords, activeAssignments, existingBookings] =
    await Promise.all([
      TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean(),
      LeaveRequest.find({
        technicianId: { $in: techIds },
        status: "approved",
        startDate: { $lte: bookingDate },
        endDate: { $gte: bookingDate },
      }).select("technicianId").lean(),
      Assignment.find({
        technicianId: { $in: techIds },
        status: {
          $in: [
            "pending_acceptance",
            "accepted",
            "en_route",
            "on_site",
            "in_progress",
          ],
        },
      }).select("technicianId").lean(),
      BookingService.find({
        _id: { $ne: booking._id },
        bookingDate: { $gte: bookingDate, $lte: dayEnd(bookingDate) },
        technicianId: { $in: techIds },
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
            "repair_requested",
            "inspection_scheduled",
            "inspection_in_progress",
            "repair_approved",
            "ready_for_repair",
            "repair_scheduled",
            "repair_in_progress",
          ],
        },
      })
        .select("technicianId startTime endTime serviceDurationMinutes travelTime")
        .lean(),
    ]);

  const scheduleMap = {};
  schedules.forEach((s) => {
    scheduleMap[s.technicianId.toString()] = s;
  });

  const leaveTechIds = new Set(leaveRecords.map((l) => l.technicianId.toString()));

  const workloadMap = {};
  activeAssignments.forEach((a) => {
    const tid = a.technicianId.toString();
    workloadMap[tid] = (workloadMap[tid] || 0) + 1;
  });

  const overlapTechIds = new Set();
  for (const eb of existingBookings) {
    const tid = eb.technicianId.toString();
    const ebStart = parseMinuteValue(eb.startTime);
    const ebEnd = deriveEndMinutes(eb);
    if (!Number.isFinite(ebStart) || !Number.isFinite(ebEnd) || ebEnd <= ebStart)
      continue;
    if (targetStartMin < ebEnd && targetEndMin > ebStart) {
      overlapTechIds.add(tid);
    }
  }

  const { resolveAvailabilityBulk } = require("./availability");
  const availabilityMap = await resolveAvailabilityBulk(allTechs);

  const MAX_ACTIVE_ASSIGNMENTS = 3;
  const eligible = [];

  for (const tech of allTechs) {
    const tid = tech._id.toString();

    if (leaveTechIds.has(tid)) continue;

    const schedule = scheduleMap[tid];
    if (!schedule) continue;

    const workingDay = schedule.workingDays?.find(
      (wd) => wd.dayOfWeek === dayOfWeek,
    );
    const isNonWorkingWeekday = schedule.nonWorkingWeekdays?.some(
      (nwd) => nwd.dayOfWeek === dayOfWeek,
    );
    if (!workingDay || isNonWorkingWeekday) continue;

    const isRestDate = schedule.restDates?.some((rd) => {
      const rdDate = new Date(rd.date);
      return (
        rdDate.getFullYear() === bookingDate.getFullYear() &&
        rdDate.getMonth() === bookingDate.getMonth() &&
        rdDate.getDate() === bookingDate.getDate()
      );
    });
    if (isRestDate) continue;

    const currentWorkload = workloadMap[tid] || 0;
    if (currentWorkload >= MAX_ACTIVE_ASSIGNMENTS) continue;

    if (overlapTechIds.has(tid)) continue;

    const status = availabilityMap.get(tid);
    if (status !== "Available") continue;

    const bookingLat =
      booking.location?.lat || booking.bookingLocation?.lat || null;
    const bookingLng =
      booking.location?.lng || booking.bookingLocation?.lng || null;
    const techCoords = tech.location?.coordinates || null;
    let distanceKm = null;
    if (bookingLat && bookingLng && techCoords && techCoords.length === 2) {
      const R = 6371;
      const dLat = ((techCoords[1] - bookingLat) * Math.PI) / 180;
      const dLng = ((techCoords[0] - bookingLng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((bookingLat * Math.PI) / 180) *
          Math.cos((techCoords[1] * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distanceKm = Math.round(R * c * 10) / 10;
    }

    eligible.push({
      ...tech,
      currentWorkload,
      availabilityStatus: tech.availabilityStatus || "Offline",
      distanceKm,
    });
  }

  eligible.sort((a, b) => {
    let scoreA = 0;
    let scoreB = 0;
    if (a.availabilityStatus === "Available") scoreA += 100;
    if (b.availabilityStatus === "Available") scoreB += 100;
    scoreA += (a.rating || 0) * 8;
    scoreB += (b.rating || 0) * 8;
    scoreA += Math.max(0, 40 - (a.currentWorkload || 0) * 15);
    scoreB += Math.max(0, 40 - (b.currentWorkload || 0) * 15);
    if (a.distanceKm != null) scoreA += Math.max(0, 60 - a.distanceKm * 2);
    if (b.distanceKm != null) scoreB += Math.max(0, 60 - b.distanceKm * 2);
    return scoreB - scoreA;
  });

  return eligible;
}

async function autoAssignBooking(bookingId, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const booking = await BookingService.findById(bookingId).session(session);
    if (!booking) {
      await session.abortTransaction();
      session.endSession();
      return { success: false, error: "Booking not found" };
    }

    if (booking.status !== BookingStatus.PENDING_REASSIGNMENT) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        error: `Booking is in "${booking.status}" status, not pending_reassignment`,
      };
    }

    // Past-date guard: a booking whose scheduled time already elapsed must be
    // rescheduled via the Resolution Center, not auto-assigned.
    const { isBookingPast } = require('./bookingPolicy');
    if (isBookingPast(booking)) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        error: 'Cannot assign — the scheduled time has passed. Resolve this booking in the Resolution Center.',
        code: 'PAST_DATE_BOOKING',
      };
    }

    const eligible = await findVacantTechnicians(booking);

    if (eligible.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        error: "No vacant technicians available for this booking's schedule",
      };
    }

    const technician = eligible[0];

    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + 2);

    const assignment = new Assignment({
      bookingId: booking._id,
      technicianId: technician._id,
      customerName: booking.customer?.name || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      serviceName: booking.service?.name || "",
      serviceType: booking.serviceType || (booking.serviceModel === "RepairService" ? "repair" : "core"),
      servicePrice: booking.totalPrice || booking.estimatedFee || 0,
      bookingDate: booking.bookingDate,
      startTime: booking.startTime || "",
      endTime: booking.endTime || "",
      address: booking.location?.address || "",
      priority: "normal",
      slaDeadline,
      estimatedFee: booking.totalPrice || booking.estimatedFee || 0,
      status: "pending_acceptance",
    });
    assignment.notes.push({
      text: "Auto-assigned to vacant technician by system",
      byName: "System",
    });
    await assignment.save({ session });

    const isRepair = booking.serviceModel === "RepairService";
    booking.status = isRepair ? BookingStatus.INSPECTION_SCHEDULED : BookingStatus.ASSIGNED;
    booking.technicianId = technician._id;
    booking.assignedAt = new Date();
    booking.assignedBy = null;
    booking.assignmentId = assignment._id;
    booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
    booking.cancellationHistory.push({
      technicianId: null,
      technicianName: "System Auto-Assignment",
      action: "reassigned",
      reason: "Technician declined; auto-assigned to vacant technician",
      timestamp: new Date(),
    });
    await booking.save({ session });

    const Technician = require("../models/Technician");
    const freshTech = await Technician.findById(technician._id).session(session);
    if (freshTech) {
      freshTech.availabilityStatus = "Assigned";
      const resolvedStatus = await resolveAvailabilityStatus(
        freshTech,
        null,
        null,
        { syncDb: false },
      );
      await Technician.findByIdAndUpdate(technician._id, {
        availabilityStatus: resolvedStatus,
      }).session(session);
    }

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      booking,
      assignment,
      technician,
      message: `Booking ${booking.bookingReference} auto-assigned to ${technician.name}`,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

async function autoAssignAllPendingReassignments() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AUTO_ASSIGN_WINDOW_MINUTES * 60000);

  const pendingReassignments = await BookingService.find({
    status: BookingStatus.PENDING_REASSIGNMENT,
    $or: [
      { updatedAt: { $lt: cutoff } },
      { reassignmentCount: { $gte: 3 } },
    ],
  })
    .select("_id bookingDate startTime endTime startTime")
    .lean();

  const results = [];
  for (const booking of pendingReassignments) {
    try {
      const result = await autoAssignBooking(booking._id);
      results.push(result);
    } catch (error) {
      console.error(
        `[AutoAssign] Failed to auto-assign booking ${booking._id}:`,
        error.message,
      );
      results.push({
        success: false,
        bookingId: booking._id,
        error: error.message,
      });
    }
  }

  return results;
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

function deriveEndMinutes(booking) {
  const bStart = parseMinuteValue(booking.startTime);
  const explicitEnd = parseMinuteValue(booking.endTime);
  if (Number.isFinite(explicitEnd) && explicitEnd > bStart) return explicitEnd;
  const serviceDuration = Number(booking.serviceDurationMinutes) || 60;
  const travelDuration = Math.max(0, Number(booking.travelTime) || 0);
  if (!Number.isFinite(bStart)) return NaN;
  return bStart + serviceDuration + travelDuration + 30;
}

function dayEnd(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

module.exports = {
  autoAssignBooking,
  autoAssignAllPendingReassignments,
  findVacantTechnicians,
  AUTO_ASSIGN_WINDOW_MINUTES,
};