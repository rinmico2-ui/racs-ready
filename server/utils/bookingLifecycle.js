const { normalizeLifecycleReason } = require("./dataLifecycle");

const NON_CANCELLABLE_BOOKING_STATUSES = new Set([
  "completed",
  "repair_completed",
  "closed",
  "rejected",
]);

function cancelBookingRecord(booking, { actorId, actorName, reason, at = new Date() }) {
  if (!booking) throw Object.assign(new Error("Booking not found"), { status: 404 });
  if (booking.status === "cancelled") return { booking, changed: false };
  if (NON_CANCELLABLE_BOOKING_STATUSES.has(booking.status)) {
    throw Object.assign(new Error(`A booking in "${booking.status}" status cannot be cancelled.`), { status: 409 });
  }

  const normalizedReason = normalizeLifecycleReason(reason, "Cancellation");
  const previousStatus = booking.status;
  booking.status = "cancelled";
  booking.cancellationReason = normalizedReason;
  booking.cancelledAt = at;
  booking.cancelledBy = actorId || null;
  if (Array.isArray(booking.services)) {
    booking.services.forEach((service) => {
      if (service && !["completed", "cancelled", "repair_declined"].includes(service.status)) {
        service.status = "cancelled";
        if (Array.isArray(service.statusHistory)) {
          service.statusHistory.push({
            status: "cancelled",
            changedAt: at,
            changedBy: actorId || null,
            changedByName: actorName || "Administrator",
            reason: normalizedReason,
          });
        }
      }
    });
  }
  if (typeof booking.recordStatusHistory === "function") {
    booking.recordStatusHistory({
      fromStatus: previousStatus,
      toStatus: "cancelled",
      changedBy: actorId || null,
      changedByModel: "User",
      changedByName: actorName || "Administrator",
      reason: normalizedReason,
    });
  }
  return { booking, changed: true, previousStatus, reason: normalizedReason };
}

module.exports = { NON_CANCELLABLE_BOOKING_STATUSES, cancelBookingRecord };
