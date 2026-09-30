"use strict";

// Informational badges only. Decisions still use their authoritative endpoints.
async function buildAdminNavigationSummary(now = new Date()) {
  const Booking = require("../models/BookingService");
  const count = expression => ({ $sum: { $cond: [expression, 1, 0] } });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const [bookingRows, pendingExpenses, pendingLeaveRequests, auditToday, actionable, pendingScheduling, overdue, maintenance] = await Promise.all([
    Booking.aggregate([{ $group: {
      _id: null,
      pendingBookings: count({ $eq: ["$status", "pending"] }),
      activeJobs: count({ $in: ["$status", ["confirmed", "scheduled", "on-the-way", "arrived", "in-progress"]] }),
      assignmentQueue: count({ $in: ["$status", ["awaiting_assignment", "pending_reassignment"]] }),
      escalatedBookings: count({ $or: [{ $eq: ["$escalated", true] }, { $gte: ["$reassignmentCount", 3] }] }),
      repairPending: count({ $and: [{ $eq: ["$repairSchedule.preference", "later"] }, { $in: ["$status", ["repair_approved", "ready_for_repair"]] }] }),
    } }]),
    require("../models/Expense").countDocuments({ status: "pending" }),
    require("../models/LeaveRequest").countDocuments({ status: "pending" }),
    require("../models/ActivityLog").countDocuments({ createdAt: { $gte: today } }),
    require("../models/Order").countDocuments({ status: { $in: ["pending_payment", "preparing_unit", "ready_for_pickup", "technician_declined"] } }),
    require("../models/Project").countDocuments({ status: "pending_project_scheduling" }),
    require("../models/EquipmentAssignment").countDocuments({
      consumable: { $ne: true }, status: { $in: ["checked_out", "in_use"] },
      $or: [{ expectedReturnAt: { $lt: now } }, { $and: [{ expectedReturnAt: null }, { workDate: { $lt: today } }] }],
    }),
    require("./maintenanceSummary").maintenanceSummary({}, now),
  ]);
  const booking = bookingRows[0] || {};
  return {
    counts: { pendingBookings: booking.pendingBookings || 0, activeJobs: booking.activeJobs || 0,
      assignmentQueue: booking.assignmentQueue || 0, escalatedBookings: booking.escalatedBookings || 0,
      pendingExpenses, pendingLeaveRequests, auditToday },
    orders: { actionable }, projects: { pendingScheduling }, returns: { overdue },
    repairScheduling: { pendingScheduling: booking.repairPending || 0 }, maintenance,
    asOf: now.toISOString(),
  };
}

module.exports = { buildAdminNavigationSummary };
