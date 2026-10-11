"use strict";

const { cancelBookingRecord } = require("./bookingLifecycle");
const { normalizeLifecycleReason } = require("./dataLifecycle");
const { reopenScheduleAfterBookingCancellation } = require("./maintenanceLifecycle");

const INACTIVE_ASSIGNMENTS = ["cancelled", "declined", "expired", "no_show"];
const INACTIVE_PAYMENTS = ["rejected", "failed", "refunded"];

function isAftercareBooking(booking) {
  return Boolean(booking?.maintenance?.isMaintenance && booking.maintenance.assetId
    && booking.maintenance.scheduleId && (booking.maintenance.paymentOnSite === true
      || String(booking.paymentNotes || "").startsWith("Maintenance requested from Aftercare")));
}

function maintenanceCancellationBlock(booking) {
  if (!isAftercareBooking(booking)) return "This visit cannot be cancelled from Aftercare.";
  if (!["pending", "awaiting_assignment"].includes(booking.status)) {
    return "This visit is already being handled by staff. Please contact us to cancel it.";
  }
  if (booking.technicianId || booking.assignmentId || booking.assignedAt
    || (booking.services || []).some(item => item.technicianId || item.assignmentId
      || !["pending", "awaiting_assignment"].includes(item.status || "pending"))) {
    return "A technician has been assigned. Please contact us to cancel this visit.";
  }
  if (Number(booking.amountPaid || 0) > 0 || booking.balanceCollected || booking.paymentVerifiedAt
    || !["pending", "rejected", "failed"].includes(booking.paymentStatus || "pending")
    || booking.paymentProof || booking.paymentReference
    || (booking.payments || []).some(payment => !INACTIVE_PAYMENTS.includes(payment.status))) {
    return "This visit has a payment to review. Please contact us to cancel it.";
  }
  return null;
}

function models(overrides = {}) {
  return {
    Booking: overrides.Booking || require("../models/BookingService"),
    Assignment: overrides.Assignment || require("../models/Assignment"),
    Payment: overrides.Payment || require("../models/Payment"),
    mongoose: overrides.mongoose || require("mongoose"),
    reopen: overrides.reopen || reopenScheduleAfterBookingCancellation,
  };
}

// The flag is only a UI hint. The cancellation transaction checks fresh records.
async function attachMaintenanceCancellation(bookings, overrides = {}) {
  const candidates = bookings.filter(booking => !maintenanceCancellationBlock(booking));
  const blocked = new Set();
  if (candidates.length) {
    const { Assignment, Payment } = models(overrides);
    const bookingIds = candidates.map(booking => booking._id);
    const [assigned, paid] = await Promise.all([
      Assignment.distinct("bookingId", { bookingId: { $in: bookingIds }, status: { $nin: INACTIVE_ASSIGNMENTS } }),
      Payment.distinct("bookingId", { bookingId: { $in: bookingIds }, status: { $nin: INACTIVE_PAYMENTS } }),
    ]);
    [...assigned, ...paid].forEach(id => blocked.add(String(id)));
  }
  return bookings.map(booking => isAftercareBooking(booking) ? { ...booking, customerCanCancelMaintenance:
    !maintenanceCancellationBlock(booking) && !blocked.has(String(booking._id)) } : booking);
}

async function cancelCustomerMaintenance({ bookingId, customerId, actorName, reason }, overrides = {}) {
  const normalizedReason = normalizeLifecycleReason(reason, "Cancellation");
  const { Booking, Assignment, Payment, mongoose, reopen } = models(overrides);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const booking = await Booking.findById(bookingId).session(session);
      if (!booking) throw Object.assign(new Error("Appointment not found"), { status: 404 });
      if (String(booking.customerId) !== String(customerId)) {
        throw Object.assign(new Error("You can only cancel your own appointments"), { status: 403 });
      }
      if (!isAftercareBooking(booking)) {
        throw Object.assign(new Error("This visit cannot be cancelled from Aftercare."), { status: 409 });
      }
      if (booking.status !== "cancelled") {
        let block = maintenanceCancellationBlock(booking);
        if (!block) {
          const assigned = await Assignment.exists({ bookingId, status: { $nin: INACTIVE_ASSIGNMENTS } }).session(session);
          const paid = await Payment.exists({ bookingId, status: { $nin: INACTIVE_PAYMENTS } }).session(session);
          if (assigned || paid) block = "This visit has an assignment or payment to review. Please contact us to cancel it.";
        }
        if (block) throw Object.assign(new Error(block), { status: 409, code: "MAINTENANCE_CANCELLATION_REQUIRES_STAFF" });
      }
      const cancellation = cancelBookingRecord(booking, { actorId: customerId, actorName, reason: normalizedReason });
      if (cancellation.changed) await booking.save({ session });
      // Both changes commit together. Retrying cannot reopen a newer booking.
      await reopen(booking, { session, actorId: customerId, actorName });
      result = { booking, cancellation };
    });
    result?.booking.$session?.(null);
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { isAftercareBooking, maintenanceCancellationBlock, attachMaintenanceCancellation, cancelCustomerMaintenance };
