/**
 * One-time migration: Move stale bookings from past dates
 * to reschedule-required so they route to the attention center.
 *
 * Handles both:
 *   - confirmed/scheduled bookings from past dates
 *   - pending_reassignment bookings from past dates (previously mis-routed)
 *
 * Run: node scripts/expire-stale-bookings.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: require('path').join(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/appointment_scheduler';

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const BookingService = require('../models/BookingService');
  const Assignment = require('../models/Assignment');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Find all stale bookings from past dates that need fixing:
  // 1. confirmed/scheduled (never should have stayed active past their date)
  // 2. pending_reassignment (previously mis-routed by the first migration)
  const stale = await BookingService.find({
    status: { $in: ['confirmed', 'scheduled', 'pending_reassignment'] },
    bookingDate: { $lt: todayStart },
  }).select('bookingDate startTime status technicianId assignmentId bookingReference serviceName customer reassignmentCount cancellationHistory');

  console.log(`Found ${stale.length} stale booking(s) from past dates.`);

  if (!stale.length) {
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let updated = 0;

  for (const booking of stale) {
    const prevStatus = booking.status;
    const reason = `Past-date booking (${new Date(booking.bookingDate).toLocaleDateString()}) needs a new date/time.`;

    console.log(`  → ${booking.bookingReference || booking._id} | ${prevStatus} | ${new Date(booking.bookingDate).toLocaleDateString()}`);

    // Cancel stale assignment
    if (booking.assignmentId) {
      try {
        await Assignment.findByIdAndUpdate(booking.assignmentId, {
          status: 'cancelled',
          cancelledAt: now,
        });
      } catch (e) {
        console.warn(`    Failed to cancel assignment: ${e.message}`);
      }
    }

    booking.status = 'reschedule-required';
    booking.technicianId = null;
    booking.assignmentId = null;
    booking.autoReschedulePending = true;
    booking.autoRescheduleAt = now;
    booking.autoRescheduleReason = reason;
    booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;

    if (!Array.isArray(booking.cancellationHistory)) booking.cancellationHistory = [];
    booking.cancellationHistory.push({
      technicianId: null,
      technicianName: 'System',
      action: 'auto_reschedule',
      reason,
      timestamp: now,
    });

    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: 'reschedule-required',
      changedByModel: 'System',
      changedByName: 'Migration Script',
      reason,
      metadata: { auto: true, migratedFrom: prevStatus },
    });

    await booking.save();
    updated++;
  }

  console.log(`Done. Updated ${updated} booking(s) to reschedule-required.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
