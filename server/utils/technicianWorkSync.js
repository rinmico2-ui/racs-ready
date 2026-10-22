"use strict";
const { manilaDateKey, parseAppointmentTime } = require("./bookingDateTime");
const ref = value => String(value?._id || value || "");
const HISTORY_STATUSES = new Set(["completed", "cancelled", "declined", "no_show", "no_show_reported", "expired"]);
const UNAVAILABLE_BOOKING_STATUSES = new Set(["cancelled", "rejected", "closed", "expired", "completed", "repair_completed", "repair_declined", "reschedule-required", "reschedule_required", "re-scheduled", "pending_reassignment", "no-show", "no-show-reported", "no_show", "no_show_reported"]);
const BOOKING_WORK_SELECT = "status archivedAt isProject sourceOrderId technicianId assignmentId technicianTeam bookingDate startTime repairSchedule services._id services.status services.technicianId services.assignmentId services.schedule";

function assignmentWorkDecision(assignment, booking, { includeProjects = false } = {}) {
  if (!booking) return { current: false, reason: "Booking no longer exists." };
  if (booking.archivedAt) return { current: false, reason: "Booking was archived." };
  if (booking.sourceOrderId) return { current: false, reason: "Delivery and installation work is managed in My Orders." };
  if (!includeProjects && (booking.isProject || assignment.serviceType === "project")) return { current: false, reason: "Project work is managed in Projects." };
  if (HISTORY_STATUSES.has(assignment.status)) return { current: true, historical: true };
  if (UNAVAILABLE_BOOKING_STATUSES.has(booking.status)) return { current: false, reason: "Staff changed this booking. Refresh your jobs to see the current schedule." };
  const teamMember = require('./standardJobTeam').member(booking, assignment.technicianId);
  const teamAssignment = teamMember && ref(teamMember.assignmentId) === ref(assignment._id);
  const matchingItems = (booking.services || []).filter(item =>
    (!assignment.serviceItemId || ref(item._id) === ref(assignment.serviceItemId))
    && ref(item.assignmentId) === ref(assignment._id) && ref(item.technicianId) === ref(assignment.technicianId));
  const itemClosed = item => ["cancelled", "repair_declined", "completed", "repair_completed"].includes(item.status);
  const item = matchingItems.find(item => !itemClosed(item)) || matchingItems[0];
  // A visit assignment owns all its service items. Finishing the first Core
  // item must not revoke access to the Repair work or the final handover.
  const sharedVisit = !assignment.serviceItemId && (teamAssignment
    || ref(booking.assignmentId) === ref(assignment._id) && ref(booking.technicianId) === ref(assignment.technicianId));
  if (assignment.serviceItemId && !item) return { current: false, reason: "This service item was reassigned." };
  if (item && itemClosed(item) && !sharedVisit) return { current: false, reason: "This service item is no longer active." };
  if (!item && !teamAssignment && ((booking.assignmentId !== undefined && ref(booking.assignmentId) !== ref(assignment._id))
    || (booking.technicianId !== undefined && ref(booking.technicianId) !== ref(assignment.technicianId)))) {
    return { current: false, reason: "This booking is no longer assigned to you." };
  }
  // Mixed service items and repair follow-up visits can have their own date.
  const schedule = !sharedVisit && item?.schedule?.date ? item.schedule : assignment.serviceType === "repair" && booking.repairSchedule?.date ? booking.repairSchedule : null;
  const date = schedule?.date || booking.bookingDate;
  const time = schedule?.startTime || schedule?.time || booking.startTime;
  const assignmentDate = assignment.bookingDate && manilaDateKey(assignment.bookingDate);
  const bookingDate = date && manilaDateKey(date);
  if (assignmentDate && bookingDate && assignmentDate !== bookingDate) return { current: false, reason: "Staff moved this visit to a new date." };
  const assignmentTime = parseAppointmentTime(assignment.startTime), bookingTime = parseAppointmentTime(time);
  if (Number.isFinite(assignmentTime) && Number.isFinite(bookingTime) && assignmentTime !== bookingTime) return { current: false, reason: "Staff changed this visit's start time." };
  return { current: true, historical: false };
}

async function technicianAssignmentScope(technicianId, { Assignments = require("../models/Assignment"), Bookings = require("../models/BookingService") } = {}) {
  // Validate before pagination and counting; filtering one returned page leaves
  // phantom jobs in run sheets, badges and subsequent pages.
  const assignments = await Assignments.find({ technicianId, status: { $ne: "expired" } })
    .select("bookingId technicianId serviceItemId serviceType status bookingDate startTime").lean();
  const ids = [...new Map(assignments.filter(item => item.bookingId).map(item => [ref(item.bookingId), item.bookingId])).values()];
  const bookings = ids.length ? await Bookings.find({ _id: { $in: ids } }).select(BOOKING_WORK_SELECT).lean() : [];
  const sources = new Map(bookings.map(booking => [ref(booking._id), booking]));
  const excluded = assignments.filter(item => !assignmentWorkDecision(item, sources.get(ref(item.bookingId))).current).map(item => item._id);
  return { technicianId, ...(excluded.length ? { _id: { $nin: excluded } } : {}) };
}

async function publishBookingWorkUpdate({ io, booking, technicianIds = [], reason = "updated", Technicians = require("../models/Technician"), Assignments = require("../models/Assignment") }) {
  if (!io || !booking?._id) return;
  const previousAssignments = await Assignments.find({ bookingId: booking._id }).select("technicianId").lean();
  const ids = [...new Set([...technicianIds, booking.technicianId, ...previousAssignments.map(item => item.technicianId), ...(booking.services || []).map(item => item.technicianId)].filter(Boolean).map(ref))];
  const technicians = ids.length ? await Technicians.find({ _id: { $in: ids } }).select("user").lean() : [];
  let recipients = io.to("admin-room");
  if (booking.customerId) recipients = recipients.to(`customer:${ref(booking.customerId)}`);
  for (const id of ids) recipients = recipients.to(`tech:${id}`);
  for (const technician of technicians) if (technician.user) recipients = recipients.to(`user:${ref(technician.user)}`);
  recipients.emit("booking:updated", { bookingId: booking._id, status: booking.status, reason, timestamp: Date.now() });
}

module.exports = { BOOKING_WORK_SELECT, assignmentWorkDecision, technicianAssignmentScope, publishBookingWorkUpdate };
