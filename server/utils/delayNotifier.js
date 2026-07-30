/**
 * Delay Notifier — Overtime cascade handling
 *
 * When a technician's earlier job overruns into a later customer's slot, that
 * later booking is flagged `delay` and the CUSTOMER is notified (notify-only
 * product decision — no auto-reschedule). Triggers:
 *   1. Technician taps "Mark Delayed" on a job (manual).
 *   2. System auto-detects overtime: a job still active after its buffered
 *      capacity end, with a same-tech later booking overlapping the overrun.
 */

const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const { createNotification } = require("./notify");
const { sendEmail } = require("./mailer");
const { getBufferMinutesSync } = require("./bookingPolicy");

// Active statuses that mean "this job is still occupying the technician".
const ACTIVE_STATUSES = [
  "assigned", "confirmed", "scheduled", "on-the-way",
  "arrived", "in-progress", "repair_scheduled", "repair_in_progress",
  "inspection_scheduled", "inspection_in_progress", "ready_for_repair",
];

function timeToMin(v) {
  if (v == null) return NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const s = String(v).trim();
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  let h = parseInt(ampm ? ampm[1] : s.split(":")[0], 10);
  const m = parseInt(ampm ? ampm[2] : s.split(":")[1] || "0", 10);
  if (ampm && ampm[3].toUpperCase() === "PM" && h < 12) h += 12;
  if (ampm && ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + m;
}

/**
 * Buffered capacity end (minutes) for a booking — mirrors bookingPolicy math.
 * Used to know how far a late job bleeds into later slots.
 */
function capacityEndMin(b) {
  const s = timeToMin(b.startTime);
  if (!Number.isFinite(s)) return NaN;
  const explicit = timeToMin(b.endTime);
  if (Number.isFinite(explicit) && explicit > s) return explicit;
  const svc = Number(b.serviceDurationMinutes) || 60;
  const travel = Math.max(0, Number(b.travelTime) || 0);
  const buffer = getBufferMinutesSync();
  return s + svc + travel + buffer;
}

/**
 * Given a late/active job, find same-tech, same-day bookings whose scheduled
 * start falls at/after this job's start and within its prolonged span, and
 * flag + notify each. Idempotent: skips bookings already flagged.
 */
async function cascadeDelayFromJob(lateJob, { io = null, reason = "" } = {}) {
  if (!lateJob || !lateJob.technicianId) return [];
  const techId = lateJob.technicianId;
  const day = new Date(lateJob.bookingDate);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);

  const lateStart = timeToMin(lateJob.startTime);
  // A job bleeds to the WORST-CASE of its scheduled end and its buffered
  // capacity end, so a manual "I'm delayed" (or an overrun past the
  // scheduled endTime) still cascades to later same-tech bookings.
  const buffered = capacityEndMin(lateJob);
  const explicitEnd = timeToMin(lateJob.endTime);
  let lateEnd = lateStart + 60;
  if (Number.isFinite(buffered)) lateEnd = Math.max(lateEnd, buffered);
  if (Number.isFinite(explicitEnd) && explicitEnd > lateStart) lateEnd = Math.max(lateEnd, explicitEnd);

  const laterBookings = await BookingService.find({
    technicianId: techId,
    bookingDate: { $gte: day, $lt: nextDay },
    status: { $in: ACTIVE_STATUSES },
    _id: { $ne: lateJob._id },
  }).select("bookingDate startTime endTime serviceDurationMinutes travelTime customerId technicianId delay status").lean();

  const affected = [];
  for (const b of laterBookings) {
    const bStart = timeToMin(b.startTime);
    if (!Number.isFinite(bStart)) continue;
    // A technician is one person: any later same-day booking that starts at or
    // after the late job's start is at risk of overrun, so notify its customer.
    // (We deliberately do NOT cap at the scheduled endTime — if the tech is
    // delayed, the scheduled end is already wrong.)
    if (bStart >= lateStart) {
      affected.push(b);
    }
  }
  if (!affected.length) return [];

  for (const b of affected) {
    if (b.delay && b.delay.delayed) continue; // already notified
    await BookingService.updateOne(
      { _id: b._id },
      {
        $set: {
          "delay.delayed": true,
          "delay.delayedBy": lateJob._id,
          "delay.delayedAt": new Date(),
          "delay.reason": reason || "Previous appointment is running longer than expected.",
          "delay.notifiedCustomer": true,
          "delay.notifiedAt": new Date(),
        },
      }
    );
    await notifyCustomerOfDelay(b, lateJob, reason);
  }
  return affected;
}

async function notifyCustomerOfDelay(booking, lateJob, reason) {
  try {
    const User = require("../models/User");
    const user = await User.findById(booking.customerId).lean();
    const custName = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "Valued Customer";
    const startLabel = booking.startTime || "your scheduled time";
    const msg =
      `Your appointment scheduled at ${startLabel} will be delayed because the previous ` +
      `service is taking longer than expected. We apologize for the inconvenience and will ` +
      `keep you updated. (Reason: ${reason || "previous appointment running long"})`;

    await createNotification({
      type: "booking_delay_customer",
      title: "Your appointment is delayed",
      message: msg,
      userId: booking.customerId,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/bookings",
      priority: "high",
      io: global._io || null,
    });

    if (user && user.email) {
      await sendEmail(
        user.email,
        "Appointment Delay Notification — RACS",
        `<p>Hi ${custName},</p><p>${msg}</p><p>— RACS Team</p>`
      ).catch(() => {});
    }
  } catch (e) {
    console.error("notifyCustomerOfDelay failed:", e.message);
  }
}

/**
 * Public: auto-detect overtime for a given job (called from status updates
 * or a periodic monitor). Flags + notifies later same-tech bookings.
 */
async function autoDetectDelay(bookingId, { io = null } = {}) {
  const job = await BookingService.findById(bookingId)
    .select("bookingDate startTime endTime serviceDurationMinutes travelTime technicianId status")
    .lean();
  if (!job || !job.technicianId) return [];
  if (!ACTIVE_STATUSES.includes(job.status)) return [];

  const now = new Date();
  const day = new Date(job.bookingDate);
  day.setHours(0, 0, 0, 0);
  // Only flag if the job's buffered capacity end has already passed "now".
  const endMin = capacityEndMin(job);
  if (!Number.isFinite(endMin)) return [];
  const endTodayMin = day.getHours() * 60 + day.getMinutes();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin <= endMin && nowMin >= endTodayMin) {
    // still within expected window — not yet overtime
    if (nowMin <= endMin) return [];
  }
  return cascadeDelayFromJob(job, { io, reason: "Previous appointment is running longer than expected (auto-detected)." });
}

/**
 * Public: technician manually marks a job as delayed (cascades to later jobs).
 */
async function markJobDelayed(bookingId, { reason = "", io = null, byTechId = null } = {}) {
  const job = await BookingService.findById(bookingId)
    .select("bookingDate startTime endTime serviceDurationMinutes travelTime technicianId status")
    .lean();
  if (!job) throw new Error("Booking not found");
  const affected = await cascadeDelayFromJob(job, { io, reason });
  // Notify dispatch that this job is delayed.
  await createNotification({
    type: "booking_delay",
    title: "Technician marked job delayed",
    message: `Job ${job._id} marked delayed by technician. ${affected.length} later appointment(s) notified.`,
    role: "secretary",
    referenceId: job._id,
    referenceModel: "BookingService",
    priority: "high",
    io: global._io || null,
  });
  return affected;
}

module.exports = { cascadeDelayFromJob, autoDetectDelay, markJobDelayed, capacityEndMin, startDelayMonitor };

/**
 * Periodic monitor (notify-only): find active jobs whose buffered capacity
 * end has already passed "now" and auto-cascade delay to later same-tech
 * bookings on the same day. Runs every 5 minutes.
 */
function startDelayMonitor() {
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(now);
      dayEnd.setHours(23, 59, 59, 999);

      const overruns = await BookingService.find({
        bookingDate: { $gte: dayStart, $lt: dayEnd },
        status: { $in: ACTIVE_STATUSES },
        technicianId: { $exists: true, $ne: null },
      }).select("bookingDate startTime endTime serviceDurationMinutes travelTime technicianId status").lean();

      for (const job of overruns) {
        const endMin = capacityEndMin(job);
        if (!Number.isFinite(endMin)) continue;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        // Only act once the job's buffered end has passed.
        if (nowMin > endMin) {
          try { await autoDetectDelay(job._id, { io: global._io || null }); }
          catch (e) { console.error("[delay-monitor] autoDetect failed:", e.message); }
        }
      }
    } catch (err) {
      console.error("[delay-monitor] error:", err.message);
    }
  }, INTERVAL_MS);
}
