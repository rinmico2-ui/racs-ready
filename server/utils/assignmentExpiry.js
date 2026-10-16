"use strict";
const Assignment = require("../models/Assignment");
const Booking = require("../models/BookingService");
const Technician = require("../models/Technician");
const Notification = require("../models/Notification");
const locks = require("./operationLock");
const availability = require("./availability");
const notifications = require("./notify");
const { manilaDateKey } = require("./bookingDateTime");
const ACTIVE = ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"];
const REASON = "No response before deadline";
let timer;
let running = false;

async function finishExpiry(assignment, now, io) {
  const booking = await Booking.findById(assignment.bookingId);
  const teamEntry = require('./standardJobTeam').member(booking, assignment.technicianId);
  const teamAssignment = teamEntry && String(teamEntry.assignmentId) === String(assignment._id);
  if (teamAssignment) {
    teamEntry.status = 'expired'; teamEntry.respondedAt = now; teamEntry.reason = REASON;
    await booking.save();
  }
  const current = booking && (booking.assignmentId
    ? String(booking.assignmentId) === String(assignment._id)
    : String(booking.technicianId || "") === String(assignment.technicianId));
  if (current && !teamAssignment && !["completed", "cancelled", "rejected", "no_show"].includes(booking.status)) {
    const other = await Assignment.exists({ _id: { $ne: assignment._id }, bookingId: booking._id, status: { $in: ACTIVE } });
    if (!other) {
      booking.recordStatusHistory({ fromStatus: booking.status, toStatus: "pending_reassignment",
        changedByModel: "System", changedByName: "System", reason: "No response before acceptance deadline; administrator reassignment required" });
      booking.status = "pending_reassignment";
      booking.technicianId = null;
      booking.assignmentId = null;
      booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
      booking.cancellationHistory ||= [];
      booking.cancellationHistory.push({ technicianId: assignment.technicianId, technicianName: "Technician (response timed out)",
        action: "auto_reschedule", reason: "No response before acceptance deadline", timestamp: now });
      await booking.save();
    }
  }
  const tech = await Technician.findById(assignment.technicianId);
  if (tech) {
    const busy = await Assignment.exists({ technicianId: tech._id, status: { $in: ACTIVE } });
    if (!busy) {
      // Release the expired work before resolving attendance/leave. Preserve a
      // technician's explicit break status; do not mark checked-out staff available.
      if (tech.availabilityStatus !== "Unavailable") tech.availabilityStatus = "Offline";
      tech.availabilityStatus = await availability.resolveAvailabilityStatus(tech, null, null, { today: new Date(manilaDateKey(now) + "T00:00:00.000Z") });
    }
    await tech.save();
  }
  const ownerId = tech?.user || assignment.technicianId;
  for (const notification of [
    { role: "admin", userId: null, message: `Assignment for ${assignment.serviceName || "a service"} expired due to no response before the deadline.`, link: "/admin/appointments?tab=queue" },
    { role: "technician", userId: ownerId, message: `Your assignment for ${assignment.serviceName || "a service"} expired because it was not accepted before the deadline.`, link: "/technician/assignments" },
  ]) {
    const existing = await Notification.exists({ type: "assignment_expired", referenceId: assignment._id,
      referenceModel: "Assignment", userId: notification.userId, role: notification.userId ? null : notification.role });
    if (!existing) {
      const saved = await notifications.createNotification({ ...notification, type: "assignment_expired", title: "Assignment Expired", referenceId: assignment._id, referenceModel: "Assignment", io });
      if (!saved) throw new Error("Assignment expiry notification could not be saved");
    }
  }
  await Assignment.updateOne({ _id: assignment._id, status: "expired" }, { $set: { expiryProcessedAt: now } });
  io?.to("admin-room").emit("assignment:expired", { assignmentId: assignment._id, bookingId: assignment.bookingId, reason: REASON });
}

async function processAssignmentExpiry({ io, now = new Date(), onError = error => console.error("[watchdog] acceptance expiry error:", error.message) } = {}) {
  if (running) return;
  running = true;
  try {
    const rows = await Assignment.find({ $or: [
      { status: "pending_acceptance", acceptanceDeadline: { $lt: now } },
      { status: "expired", expiredReason: REASON, expiryProcessedAt: null },
    ] }).limit(100).lean();
    for (const row of rows) {
      try {
        await locks.withOperationLock(`assignment-expiry:${row._id}`, async () => {
          let assignment = await Assignment.findOneAndUpdate({ _id: row._id, status: "pending_acceptance", acceptanceDeadline: { $lt: now } }, {
            $set: { status: "expired", expiredAt: now, expiredReason: REASON },
            $push: { notes: { text: "Assignment expired: no response before deadline", by: null, byName: "System", createdAt: now } },
          }, { returnDocument: "after", runValidators: true });
          if (!assignment) assignment = await Assignment.findOne({ _id: row._id, status: "expired", expiredReason: REASON, expiryProcessedAt: null });
          if (assignment) await finishExpiry(assignment, now, io);
        }, { waitMs: 1, leaseMs: 60000 });
      } catch (error) { if (error.code !== "OPERATION_LOCK_TIMEOUT") onError(error); }
    }
  } catch (error) { onError(error); }
  finally { running = false; }
}
function startAssignmentExpiryScheduler(io) {
  if (timer) return;
  timer = setInterval(() => { void processAssignmentExpiry({ io }); }, 60000);
  timer.unref();
}
function stopAssignmentExpiryScheduler() { clearInterval(timer); timer = null; }
module.exports = { processAssignmentExpiry, finishExpiry, startAssignmentExpiryScheduler, stopAssignmentExpiryScheduler };
