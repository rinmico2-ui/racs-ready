/**
 * Assignment Response SLA Monitor
 *
 * Watches pending-acceptance assignments and marks them expired when the
 * technician does not respond before the acceptanceDeadline. It then updates
 * the parent booking to "pending_reassignment" and notifies admins.
 */

const Assignment = require('../models/Assignment');
const BookingService = require('../models/BookingService');
const Technician = require('../models/Technician');
const { createNotification } = require('./notify');

const CHECK_INTERVAL_MS = 1 * 60 * 1000; // check every minute

async function expirePendingAssignments() {
  try {
    const now = new Date();

    const overdue = await Assignment.find({
      status: 'pending_acceptance',
      acceptanceDeadline: { $lt: now },
      expiredAt: null,
    }).lean();

    if (!overdue.length) return;

    const io = global.io || null;

    for (const a of overdue) {
      try {
        // Mark assignment expired
        await Assignment.findByIdAndUpdate(a._id, {
          status: 'expired',
          expiredAt: now,
          expiredReason: `No response within ${a.responseSLAMinutes || 30} minutes`,
          $push: {
            notes: {
              text: `Assignment expired: no response within ${a.responseSLAMinutes || 30} minutes`,
              by: null,
              byName: 'System',
              createdAt: now,
            },
          },
        });

        // Return booking to pending reassignment
        const booking = await BookingService.findByIdAndUpdate(
          a.bookingId,
          {
            $set: {
              status: 'pending_reassignment',
              technicianId: null,
              assignmentId: null,
              notes: `Assignment expired — no response from technician within ${a.responseSLAMinutes || 30} minutes`,
            },
            $inc: { reassignmentCount: 1 },
            $push: {
              cancellationHistory: {
                technicianId: a.technicianId,
                technicianName: a.technicianName || 'Technician',
                action: 'auto_reschedule',
                reason: `No response within ${a.responseSLAMinutes || 30} minutes`,
                timestamp: now,
              },
            },
          },
          { returnDocument: "after", lean: true }
        );

        const tech = await Technician.findById(a.technicianId).select('name').lean();
        const techName = tech?.name || a.technicianName || 'Technician';
        const ref = booking?.bookingReference || booking?.workOrderNumber || `#${String(a.bookingId).slice(-6).toUpperCase()}`;

        // Real-time socket alert for admin dashboard
        if (io) {
          try {
            io.to('admin-room').emit('assignment:expired', {
              assignmentId: a._id,
              bookingId: a.bookingId,
              technicianName: techName,
              customerName: a.customerName,
              serviceName: a.serviceName,
              reason: `No response within ${a.responseSLAMinutes || 30} minutes`,
            });
          } catch (_) { /* non-fatal */ }
        }

        // Persist admin notification
        try {
          await createNotification({
            type: 'assignment_expired',
            title: 'Assignment Expired',
            message: `Booking ${ref} — technician ${techName} did not respond within ${a.responseSLAMinutes || 30} minutes. Reassignment required.`,
            role: 'admin',
            referenceId: a._id,
            referenceModel: 'Assignment',
            link: '/admin/appointments/queue',
            priority: 'high',
            io,
          }).catch(() => {});
        } catch (_) { /* non-fatal */ }

        console.log(`[assignment-expiry] Expired assignment ${a._id} (booking ${ref})`);
      } catch (innerErr) {
        console.error('[assignment-expiry] Error expiring assignment:', a._id, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[assignment-expiry] Monitor error:', err.message);
  }
}

function startAssignmentExpiryMonitor() {
  console.log('[assignment-expiry] Starting assignment SLA expiry monitor (every minute)');

  // Run shortly after startup once the DB is connected
  setTimeout(() => {
    expirePendingAssignments();
  }, 30 * 1000);

  // Then check every minute
  setInterval(() => {
    expirePendingAssignments();
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  startAssignmentExpiryMonitor,
  expirePendingAssignments,
};
