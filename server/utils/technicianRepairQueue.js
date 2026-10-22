'use strict';
function createService(deps = {}) {
  const BookingService = deps.Booking || require('../models/BookingService');
  const Assignment = deps.Assignment || require('../models/Assignment');
  const mongoose = require('mongoose');
  async function read(techId) {
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
      .populate("customerId", "name phone")
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
      .populate("customerId", "name phone")
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


    return { repairQueue, repairCounts };
  }
  return { read };
}
module.exports = { createService };
