"use strict";
const BookingService = require('../models/BookingService');
const { buildAssignmentPlan } = require('./assignmentPlanner');
const { createService, publish } = require('./standardJobTeamService');
const { isAssignmentWindowExpired } = require('./bookingDateTime');
const { ids } = require('./standardJobTeam');
const AUTO_ASSIGN_WINDOW_MINUTES = 60;

async function findVacantTechnicians(booking) {
  return (await buildAssignmentPlan([booking], { reservePlan: false }))[0]?.candidates || [];
}

async function autoAssignBooking(bookingId, options = {}) {
  const booking = await BookingService.findById(bookingId);
  if (!booking) return { success: false, error: 'Booking not found' };
  if (booking.status !== 'pending_reassignment') return { success: false, error: 'Booking is no longer awaiting reassignment.' };
  if (isAssignmentWindowExpired(booking)) return { success: false, error: 'Reschedule this booking to a future date and time first.', code: 'PAST_DATE_BOOKING' };
  const plan = (await buildAssignmentPlan([booking], { reservePlan: false }))[0];
  if (!plan?.recommendedTeam?.length) return { success: false, error: plan?.issue || 'No complete team is available for this schedule.', staffing: plan?.staffing, code: 'NO_COMPLETE_TEAM' };
  try {
    const result = await createService().assign('booking', bookingId, {
      technicianId: plan.recommended.technicianId,
      technicianIds: plan.recommendedTeam.map(row => row.technicianId),
      assignmentSource: 'automatic', responseMinutes: 120,
      expectedSchedule: plan.scheduleKey,
      notes: 'Automatically reassigned. ' + plan.staffing.reason,
    }, options.actor || { name: 'System Auto-Assignment' });
    await publish(result, options.req || { app: { get: () => global.io } }).catch(error => console.warn('[AutoAssign] Notification follow-up failed:', error.message));
    return { success: true, booking: result.job, assignment: result.assignment,
      technician: { _id: result.job.technicianId, name: result.job.technician?.name },
      technicianIds: ids(result.job), staffing: plan.staffing,
      message: `Assigned ${ids(result.job).length} technicians. Every member must accept.` };
  } catch (error) {
    if (error.status) return { success: false, error: error.message, code: error.code || 'TEAM_AVAILABILITY_CHANGED' };
    throw error;
  }
}

async function autoAssignAllPendingReassignments(options = {}) {
  const cutoff = new Date(Date.now() - AUTO_ASSIGN_WINDOW_MINUTES * 60000);
  const rows = await BookingService.find({ status: 'pending_reassignment', archivedAt: null, isProject: { $ne: true }, sourceOrderId: null,
    $or: [{ updatedAt: { $lt: cutoff } }, { reassignmentCount: { $gte: 3 } }] }).select('_id').limit(200).lean();
  const results = [];
  // Commit/recheck one complete job at a time. A preview never substitutes for
  // the shared date lock and transaction used by the assignment writer.
  for (const row of rows) {
    try { results.push(await autoAssignBooking(row._id, options)); }
    catch (error) { results.push({ success: false, bookingId: row._id, error: 'The assignment could not be completed. Try again.' }); }
  }
  return results;
}
module.exports = { autoAssignBooking, autoAssignAllPendingReassignments, findVacantTechnicians, AUTO_ASSIGN_WINDOW_MINUTES };
