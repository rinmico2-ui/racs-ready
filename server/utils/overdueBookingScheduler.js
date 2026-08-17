/**
 * Booking Delay Monitor & Service Delay Detector
 *
 * Runs every 5 minutes:
 *   1. Detects pre-service bookings where technician hasn't departed
 *      beyond the grace period — emits admin, technician, and customer notifications
 *   2. Detects in-progress services running beyond estimated duration
 *      — emits admin "service overrun" notifications
 *
 * IMPORTANT: Bookings are NEVER automatically expired based on scheduled time.
 * Preferred start time is a planned target, not an automatic cancellation trigger.
 * Only admin or explicit customer/payment actions can expire a booking.
 */

const BookingService = require('../models/BookingService');
const Technician = require('../models/Technician');
const User = require('../models/User');
const Assignment = require('../models/Assignment');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Grace period after scheduled time before flagging as "delayed" (30 min)
const DELAY_GRACE_MINUTES = 30;

// Grace period after scheduled time before an unassigned booking in the
// assignment queue is auto-fallen-back to "Needs Reschedule"
const RESCHEDULE_FALLBACK_GRACE_MINUTES = 30;

// Time window (in hours) before scheduled time during which the system reminds
// admins to verify payment / assignment for upcoming bookings
const VERIFY_REMINDER_HOURS = 3;

/**
 * Convert a time string (HH:MM, "8:00 AM", or minutes-from-midnight integer)
 * to a full DateTime combined with the booking date.
 */
function parseBookingDateTime(bookingDate, startTime) {
  if (!bookingDate) return null;
  const base = new Date(bookingDate);
  if (isNaN(base.getTime())) return null;

  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();
  const localBase = new Date(y, mo, d, 0, 0, 0, 0);

  if (startTime !== undefined && startTime !== null && String(startTime).trim() !== '') {
    const raw = String(startTime).trim();

    // Pure integer → minutes-from-midnight
    if (/^\d+$/.test(raw)) {
      const mins = parseInt(raw, 10);
      localBase.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      return localBase;
    }

    // 12-hour format with AM/PM
    const ampmMatch = raw.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
    if (ampmMatch) {
      let hours = parseInt(ampmMatch[1], 10);
      const mins = parseInt(ampmMatch[2], 10);
      const period = ampmMatch[3].toUpperCase();
      if (period === 'PM' && hours < 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      localBase.setHours(hours, mins, 0, 0);
      return localBase;
    }

    // 24-hour format
    const hhmmMatch = raw.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
    if (hhmmMatch) {
      localBase.setHours(parseInt(hhmmMatch[1], 10), parseInt(hhmmMatch[2], 10), 0, 0);
      return localBase;
    }
  }

  return localBase;
}

/**
 * Resolve a readable customer name + id from the booking's embedded customer
 * snapshot or the linked User document.
 */
async function resolveCustomer(customer, customerId) {
  let name = customer && customer.name ? customer.name : 'Customer';
  let id = null;
  if (customerId) id = customerId;
  else if (customer && customer._id) id = customer._id;
  if (id) {
    try {
      const u = await User.findById(id).lean();
      if (u) {
        if (u.firstName && u.lastName) name = `${u.firstName} ${u.lastName}`;
        else if (u.name) name = u.name;
      }
    } catch (_) {}
  }
  return { name, id };
}

/**
 * Detect bookings in the assignment queue that have exceeded their scheduled
 * time WITHOUT a committed technician, and auto-fall them back to
 * "pending_reassignment" so admins can reschedule them.
 *
 * Enterprise rules:
 *  - Only unassigned bookings are touched. A booking whose technician has
 *    ACCEPTED the assignment is never auto-fallen-back — it is handled by the
 *    notify-only delay monitor.
 *  - Auto-fallback is idempotent (guarded by autoReschedulePending).
 *  - The booking is NOT given a new date/time; it just moves to the
 *    reschedule queue where an admin picks the new slot.
 */
async function checkForUnassignedOverdueBookings() {
  try {
    const now = new Date();

    const queueBookings = await BookingService.find({
      status: { $in: ['awaiting_assignment', 'assigned'] },
      autoReschedulePending: { $ne: true },
    }).select(
      'bookingDate startTime serviceName customer customerId technicianId assignmentId bookingReference technician'
    );

    if (!queueBookings.length) return;

    let flaggedCount = 0;

    for (const booking of queueBookings) {
      const scheduledDateTime = parseBookingDateTime(booking.bookingDate, booking.startTime);
      if (!scheduledDateTime) continue;

      const graceEnd = new Date(scheduledDateTime.getTime() + RESCHEDULE_FALLBACK_GRACE_MINUTES * 60000);
      if (now <= graceEnd) continue;

      // `assigned` requires the assignment to still be pending acceptance;
      // if the technician already accepted, this is a lateness case (delay monitor).
      if (booking.status === 'assigned' && booking.assignmentId) {
        let live = false;
        try {
          const assignment = await Assignment.findById(booking.assignmentId)
            .select('status acceptanceDeadline acceptedAt')
            .lean();
          live = !!assignment && !['cancelled', 'declined'].includes(assignment.status);
        } catch (_) {}
        if (live) continue;
      }

      const overdueByMin = Math.round((now - scheduledDateTime) / 60000);
      const reason = `No technician assigned before scheduled time (${overdueByMin} minute(s) overdue). Auto-moved to reschedule queue.`;

      const { name: customerName, id: customerId } = await resolveCustomer(booking.customer, booking.customerId);

      let techName = 'None assigned';
      if (booking.technicianId) {
        try {
          const t = await Technician.findById(booking.technicianId).select('name').lean();
          if (t) techName = t.name;
        } catch (_) {}
      }

      console.warn(
        `[reschedule-monitor] ⏰ Booking ${booking.bookingReference || booking._id} exceeded its schedule (${overdueByMin}m) with no committed technician. Falling back to reschedule. Status: ${booking.status}.`
      );

      // Cancel the stale assignment record (if any) and move booking to queue-for-reschedule
      if (booking.assignmentId) {
        try {
          await Assignment.findByIdAndUpdate(booking.assignmentId, {
            status: 'cancelled',
            cancelledAt: now,
            notes: 'Auto-cancelled: booking exceeded schedule without an accepted technician',
          });
        } catch (_) {}
      }

      booking.status = 'pending_reassignment';
      booking.technicianId = null;
      booking.assignmentId = null;
      booking.autoReschedulePending = true;
      booking.autoRescheduleAt = now;
      booking.autoRescheduleReason = reason;
      booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
      booking.cancellationHistory.push({
        technicianId: null,
        technicianName: techName,
        action: 'auto_reschedule',
        reason,
        timestamp: now,
      });
      booking.recordStatusHistory({
        fromStatus: 'assigned',
        toStatus: 'pending_reassignment',
        changedByModel: 'System',
        changedByName: 'Booking Monitor',
        reason,
        metadata: { auto: true, overdueByMin },
      });
      await booking.save();

      const io = global.io;
      const { createNotification } = require('./notify');

      try {
        await createNotification({
          type: 'booking_overdue_reschedule',
          title: 'Booking Exceeded Schedule — Reschedule Required',
          message: `${booking.serviceName || 'Service'} for ${customerName} (${booking.bookingReference || ''}) exceeded its scheduled time by ${overdueByMin} minute(s) with no assigned technician. Moved to Needs Reschedule.`,
          role: 'admin',
          referenceId: booking._id,
          referenceModel: 'BookingService',
          link: '/admin/appointments?tab=queue',
          priority: 'high',
          io,
        }).catch(() => {});
      } catch (_) {}

      if (customerId && io) {
        try {
          io.to('customer:' + customerId).emit('booking:auto-reschedule-pending', {
            bookingId: booking._id,
            bookingRef: booking.bookingReference,
            serviceName: booking.serviceName,
            message: 'Your appointment passed its scheduled time without a confirmed technician. We are working to reschedule it — you will be notified of the new schedule.',
          });
        } catch (_) {}
      }

      flaggedCount++;
    }

    if (flaggedCount > 0) {
      console.log(`[reschedule-monitor] Auto-moved ${flaggedCount} unassigned overdue booking(s) to the reschedule queue.`);
    }
  } catch (err) {
    console.error('[reschedule-monitor] Error checking unassigned overdue bookings:', err.message);
  }
}

/**
 * Remind admins to verify bookings/orders BEFORE their scheduled time.
 *
 * Window: bookings scheduled within the next VERIFY_REMINDER_HOURS whose
 * payment is still pending verification or that are still in the assignment
 * queue. Fires exactly once per booking (guarded by verificationReminderAt).
 */
async function checkForUpcomingUnverifiedBookings() {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + VERIFY_REMINDER_HOURS * 3600 * 1000);

    const upcoming = await BookingService.find({
      status: {
        $in: [
          'pending',
          'payment_verified',
          'awaiting_assignment',
          'assigned',
          'pending_reassignment',
          'confirmed',
          'scheduled',
        ],
      },
      verificationReminderAt: null,
    }).select('bookingDate startTime serviceName customer customerId paymentStatus bookingReference');

    if (!upcoming.length) return;

    let remindedCount = 0;

    for (const booking of upcoming) {
      const scheduledDateTime = parseBookingDateTime(booking.bookingDate, booking.startTime);
      if (!scheduledDateTime) continue;
      if (scheduledDateTime <= now || scheduledDateTime > windowEnd) continue;

      const hoursAway = Math.round((scheduledDateTime - now) / 3600000 * 10) / 10;

      const issues = [];
      if (booking.status === 'pending' || ['pending', 'failed', 'partial'].includes(booking.paymentStatus)) {
        issues.push('Payment is not yet verified');
      }
      if (['awaiting_assignment', 'assigned', 'pending_reassignment'].includes(booking.status)) {
        issues.push('No confirmed technician assigned');
      }

      if (!issues.length) continue;

      const { name: customerName } = await resolveCustomer(booking.customer, booking.customerId);

      const dateLabel = booking.bookingDate
        ? new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const timeLabel = booking.startTime || 'TBD';

      try {
        booking.verificationReminderAt = now;
        await booking.save();
      } catch (_) {}

      const io = global.io;
      const { createNotification } = require('./notify');

      try {
        await createNotification({
          type: 'booking_verify_reminder',
          title: 'Verify Booking Before Schedule Time',
          message: `${booking.serviceName || 'Service'} for ${customerName} (${booking.bookingReference || ''}) is scheduled ${dateLabel} at ${timeLabel} (${hoursAway} hour(s) away). ${issues.join('. ')}. Please verify before the schedule.`,
          role: 'admin',
          referenceId: booking._id,
          referenceModel: 'BookingService',
          link: '/admin/appointments?tab=queue',
          priority: 'high',
          io,
        }).catch(() => {});
      } catch (_) {}

      remindedCount++;
    }

    if (remindedCount > 0) {
      console.log(`[verify-reminder] Sent pre-schedule verification reminders for ${remindedCount} booking(s).`);
    }
  } catch (err) {
    console.error('[verify-reminder] Error checking upcoming unverified bookings:', err.message);
  }
}

/**
 * Detect pre-service bookings where the technician hasn't departed
 * beyond the grace period. Emits notifications to admin, technician, and customer.
 *
 * Does NOT modify booking status — only creates notifications.
 */
async function checkForDelayedBookings() {
  try {
    const now = new Date();

    // Bookings that are assigned/scheduled but technician hasn't started travel
    const assignedBookings = await BookingService.find({
      status: { $in: ['assigned', 'confirmed', 'scheduled', 'awaiting_assignment'] },
    }).select('bookingDate startTime serviceName customer customerId technicianId bookingReference delayNotifiedAt delayedAt').lean();

    if (!assignedBookings.length) return;

    let delayedCount = 0;

    for (const booking of assignedBookings) {
      const scheduledDateTime = parseBookingDateTime(booking.bookingDate, booking.startTime);
      if (!scheduledDateTime) continue;

      // Check if we're past the grace period
      const graceEnd = new Date(scheduledDateTime.getTime() + DELAY_GRACE_MINUTES * 60000);
      if (now <= graceEnd) continue;

      // Technician hasn't departed and we're past the grace period
      const delayMinutes = Math.round((now - scheduledDateTime) / 60000);

      // Look up technician name and user ID if assigned
      let techName = 'Unassigned';
      let techId = null;
      let techUserId = null;
      if (booking.technicianId) {
        try {
          const tech = await Technician.findById(booking.technicianId).select('name user').lean();
          if (tech) {
            techName = tech.name;
            techId = tech._id;
            techUserId = tech.user;
          }
        } catch (_) {}
      }

      // Look up customer info
      let customerName = booking.customer?.name || 'Customer';
      let customerEmail = booking.customer?.email || null;
      let customerId = null;
      if (booking.customerId) {
        customerId = booking.customerId;
      } else if (booking.customer && booking.customer._id) {
        customerId = booking.customer._id;
      }

      if (customerId) {
        try {
          const cust = await User.findById(customerId).lean();
          if (cust) {
            customerName = cust.firstName && cust.lastName ? `${cust.firstName} ${cust.lastName}` : (cust.name || customerName);
            if (!customerEmail) customerEmail = cust.email || null;
          }
        } catch (_) {}
      }

      console.warn(
        `[delay-monitor] ⏰ Booking ${booking.bookingReference || booking._id} is ${delayMinutes}m past scheduled time. ` +
        `Technician (${techName}) has not departed. Status: ${booking.status}.`
      );

      const io = global.io;
      const { createNotification } = require('./notify');

      // -- Mark booking as delayed (idempotent) --------------------------------
      const isFirstDetection = !booking.delayNotifiedAt;
      try {
        const updateFields = { isDelayed: true };
        if (!booking.delayedAt) updateFields.delayedAt = now;
        if (isFirstDetection) updateFields.delayNotifiedAt = now;
        await BookingService.findByIdAndUpdate(booking._id, updateFields);
      } catch (_) { /* non-fatal */ }

      // -- Email customer on FIRST detection -----------------------------------
      if (isFirstDetection && customerEmail) {
        try {
          const { sendTechnicianLateEmail } = require('./mailer');
          const dateLabel = booking.bookingDate
            ? new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
            : 'TBD';
          const timeLabel = booking.startTime || 'TBD';
          sendTechnicianLateEmail({
            to: customerEmail,
            customerName,
            bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
            techName,
            serviceName: booking.serviceName || 'Service',
            dateLabel,
            timeLabel,
            delayMinutes,
          }).catch(err => console.error('[MAILER] Failed to send late email:', err.message));
        } catch (mailErr) {
          console.error('[MAILER] Late email error:', mailErr.message);
        }
      }

      // Emit admin notification
      try {
        await createNotification({
          type: 'booking_delay',
          title: 'Technician Departure Delayed',
          message: `${booking.serviceName || 'Service'} for ${customerName} — technician (${techName}) has not departed. ${delayMinutes} minute(s) past scheduled time.`,
          role: 'admin',
          referenceId: booking._id,
          referenceModel: 'BookingService',
          link: '/admin/appointments',
          priority: 'high',
          io,
        }).catch(() => {});
      } catch (_) { /* non-fatal */ }

      // Emit technician notification — "You're running late"
      if (techId && io) {
        try {
          io.to('tech:' + techId).emit('booking:technician-late', {
            bookingId: booking._id,
            bookingRef: booking.bookingReference,
            techId: techId,
            serviceName: booking.serviceName,
            customerName: customerName,
            scheduledTime: booking.startTime,
            delayMinutes: delayMinutes,
            message: `Your ${booking.serviceName || 'service'} for ${customerName} was scheduled at ${booking.startTime}. You are ${delayMinutes} minute(s) late. Please head to the location now.`,
          });
          console.log(`[delay-monitor] Notified technician (${techName}) about delay for booking ${booking.bookingReference || booking._id}`);
        } catch (_) {}
      }

      if (techUserId) {
        try {
          await createNotification({
            type: 'booking_delay_tech',
            title: 'Late Departure Warning',
            message: `Your ${booking.serviceName || 'service'} for ${customerName} was scheduled at ${booking.startTime}. You are ${delayMinutes} minute(s) late. Please head to the location now.`,
            userId: techUserId,
            referenceId: booking._id,
            referenceModel: 'BookingService',
            link: '/technician/assignments',
            priority: 'high',
            io,
          }).catch(() => {});
        } catch (_) {}
      }

      // Emit customer notification — "Your technician is running late"
      if (customerId && io) {
        try {
          io.to('customer:' + customerId).emit('booking:technician-late', {
            bookingId: booking._id,
            bookingRef: booking.bookingReference,
            technicianName: techName,
            serviceName: booking.serviceName,
            scheduledTime: booking.startTime,
            delayMinutes: delayMinutes,
            message: `Your technician (${techName}) for ${booking.serviceName || 'service'} is running ${delayMinutes} minute(s) late. They are on their way.`,
          });
          console.log(`[delay-monitor] Notified customer (${customerName}) about delay for booking ${booking.bookingReference || booking._id}`);
        } catch (_) {}
      }

      if (customerId) {
        try {
          await createNotification({
            type: 'booking_delay_customer',
            title: 'Technician Running Late',
            message: `Your technician (${techName}) for ${booking.serviceName || 'service'} is running ${delayMinutes} minute(s) late. They are on their way.`,
            userId: customerId,
            referenceId: booking._id,
            referenceModel: 'BookingService',
            link: '/tracking',
            priority: 'normal',
            io,
          }).catch(() => {});
        } catch (_) {}
      }

      delayedCount++;
    }

    if (delayedCount > 0) {
      console.log(`[delay-monitor] Flagged ${delayedCount} delayed booking(s) for admin review.`);
    }
  } catch (err) {
    console.error('[delay-monitor] Error checking delayed bookings:', err.message);
  }
}

/**
 * Detect in-progress services that are running beyond their estimated
 * duration plus operational buffer. Emits admin notifications.
 *
 * Does NOT modify the booking — purely informational.
 */
async function checkForServiceDelays() {
  try {
    const now = new Date();

    const inProgressBookings = await BookingService.find({
      status: { $in: ['in-progress', 'on-the-way'] },
    }).select('bookingDate startTime serviceDurationMinutes travelTime location address customer bookingReference').lean();

    if (!inProgressBookings.length) return;

    for (const booking of inProgressBookings) {
      const scheduledStart = parseBookingDateTime(booking.bookingDate, booking.startTime);
      if (!scheduledStart) continue;

      const estimatedDuration = (booking.serviceDurationMinutes || 60) + (booking.travelTime || 0);
      const bufferMinutes = 30;
      const expectedEnd = new Date(scheduledStart.getTime() + (estimatedDuration + bufferMinutes) * 60000);

      if (now > expectedEnd) {
        const overrunMinutes = Math.round((now - expectedEnd) / 60000);
        console.warn(
          `[delay-detection] ⏰ Booking ${booking.bookingReference || booking._id} is running ${overrunMinutes}m over estimated completion. ` +
          `Status: ${booking.status}, Scheduled: ${scheduledStart.toISOString()}, Expected end: ${expectedEnd.toISOString()}`
        );

        try {
          const { createNotification } = require('./notify');
          const io = global.io;
          await createNotification({
            type: 'service_delay',
            title: 'Service Delay Detected',
            message: `Booking ${booking.bookingReference || ''} is ${overrunMinutes} minute(s) over the estimated completion time.`,
            role: 'admin',
            referenceId: booking._id,
            referenceModel: 'BookingService',
            link: '/admin/appointments',
            priority: 'high',
            io,
          }).catch(() => {});
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (err) {
    console.error('[delay-detection] Error checking service delays:', err.message);
  }
}

/**
 * Start the scheduler (called from server startup)
 */
function startOverdueScheduler() {
  console.log('[booking-monitor] Starting booking delay monitor & service delay detector (every 5 minutes)');

  // Run immediately on startup (after a short delay to let DB connect)
  setTimeout(async () => {
    await checkForDelayedBookings();
    await checkForServiceDelays();
    await checkForUnassignedOverdueBookings();
    await checkForUpcomingUnverifiedBookings();
  }, 30 * 1000);

  // Then run every 5 minutes
  setInterval(async () => {
    await checkForDelayedBookings();
    await checkForServiceDelays();
    await checkForUnassignedOverdueBookings();
    await checkForUpcomingUnverifiedBookings();
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  startOverdueScheduler,
  checkForDelayedBookings,
  checkForServiceDelays,
  checkForUnassignedOverdueBookings,
  checkForUpcomingUnverifiedBookings,
  parseBookingDateTime,
};
