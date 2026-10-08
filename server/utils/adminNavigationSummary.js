"use strict";

const STALE_COUNT_MS = 5 * 60 * 1000;
const lastSuccessfulCounts = new Map();
const { manilaDateTime, manilaDateKey } = require('./bookingDateTime');

// Informational badges only. Decisions still use their authoritative endpoints.
async function buildAdminNavigationSummary(now = new Date()) {
  const Booking = require("../models/BookingService");
  const count = expression => ({ $sum: { $cond: [expression, 1, 0] } });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const sources = [
    ['bookings', () => Booking.aggregate([{ $group: {
      _id: null,
      pendingBookings: count({ $eq: ["$status", "pending"] }),
      activeJobs: count({ $in: ["$status", ["confirmed", "scheduled", "on-the-way", "arrived", "in-progress"]] }),
      assignmentQueue: count({ $in: ["$status", ["awaiting_assignment", "pending_reassignment"]] }),
      escalatedBookings: count({ $or: [{ $eq: ["$escalated", true] }, { $gte: ["$reassignmentCount", 3] }] }),
      repairPending: count({ $and: [{ $eq: ["$repairSchedule.preference", "later"] }, { $in: ["$status", ["repair_approved", "ready_for_repair"]] }] }),
    } }])],
    ['expenses', () => require("../models/Expense").countDocuments({ status: "pending" })],
    ['leaveRequests', () => require("../models/LeaveRequest").countDocuments({ status: "pending" })],
    ['auditToday', () => require("../models/ActivityLog").countDocuments({ createdAt: { $gte: manilaDateTime(now, 0), $lte: now } })],
    ['orders', () => require("../models/Order").countDocuments({ status: { $in: ["pending_payment", "preparing_unit", "ready_for_pickup", "technician_declined"] } })],
    ['projects', () => require("../models/Project").countDocuments({ status: "pending_project_scheduling" })],
    ['returns', () => require("../models/EquipmentAssignment").countDocuments({
      consumable: { $ne: true }, status: { $in: ["checked_out", "in_use"] },
      $or: [{ expectedReturnAt: { $lt: now } }, { $and: [{ expectedReturnAt: null }, { workDate: { $lt: today } }] }],
    })],
    ['maintenance', () => require("./maintenanceSummary").maintenanceSummary({}, now)],
  ];
  const settled = await Promise.allSettled(sources.map(([, read]) => Promise.resolve().then(read)));
  const values = {};
  const failedSources = [];
  const staleSources = [];
  settled.forEach((result, index) => {
    const name = sources[index][0];
    if (result.status === 'fulfilled') {
      values[name] = result.value;
      lastSuccessfulCounts.set(name, { value: result.value, at: Date.now(), ...(name === 'auditToday' ? { day: manilaDateKey(now) } : {}) });
      return;
    }
    failedSources.push(name);
    const previous = lastSuccessfulCounts.get(name);
    if (previous && Date.now() - previous.at <= STALE_COUNT_MS && (name !== 'auditToday' || previous.day === manilaDateKey(now))) {
      values[name] = previous.value;
      staleSources.push(name);
    }
  });
  if (failedSources.length) console.warn('[navigation-summary] Count sources unavailable:', failedSources.join(', '));
  const booking = values.bookings?.[0] || {};
  const counts = {};
  if (values.bookings !== undefined) Object.assign(counts, {
    pendingBookings: booking.pendingBookings || 0, activeJobs: booking.activeJobs || 0,
    assignmentQueue: booking.assignmentQueue || 0, escalatedBookings: booking.escalatedBookings || 0,
  });
  if (values.expenses !== undefined) counts.pendingExpenses = values.expenses;
  if (values.leaveRequests !== undefined) counts.pendingLeaveRequests = values.leaveRequests;
  if (values.auditToday !== undefined) counts.auditToday = values.auditToday;
  return {
    counts,
    ...(values.orders !== undefined ? { orders: { actionable: values.orders } } : {}),
    ...(values.projects !== undefined ? { projects: { pendingScheduling: values.projects } } : {}),
    ...(values.returns !== undefined ? { returns: { overdue: values.returns } } : {}),
    ...(values.bookings !== undefined ? { repairScheduling: { pendingScheduling: booking.repairPending || 0 } } : {}),
    ...(values.maintenance !== undefined ? { maintenance: values.maintenance } : {}),
    ...(failedSources.length ? { degraded: true, failedSources, staleSources } : {}),
    asOf: now.toISOString(),
  };
}

module.exports = { buildAdminNavigationSummary };
