const { capacityMinutes } = require('./bookingServiceItems');
const { strictManilaDateKey, manilaDateKey, manilaDateTime, parseAppointmentTime } = require('./bookingDateTime');
const engine = require('./enterpriseSchedulingEngine');

// serviceDurationMinutes is already the duration of the entire request.
function bookingWorkload(booking, thresholdHours = 8) {
  const services = Array.isArray(booking.services) ? booking.services : [];
  const totalUnits = services.length
    ? services.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0)
    : Math.max(1, Number(booking.quantity) || 1);
  const totalEstimatedMinutes = Math.max(1,
    Number(booking.serviceDurationMinutes) ||
    Number(booking.projectScheduling?.estimatedTotalHours) * 60 ||
    (services.length ? capacityMinutes(services) :
      Math.max(1, Number(booking.service?.duration) || (booking.serviceModel === 'RepairService' ? 90 : 60)) * totalUnits));
  return {
    totalUnits, totalEstimatedMinutes,
    isProject: booking.isProject === true || totalUnits >= engine.LARGE_SCALE_MIN_UNITS || totalEstimatedMinutes > thresholdHours * 60,
  };
}

function schedulingError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, schedulingError: true, ...extra });
}

async function resolutionWorkload(booking) {
  return bookingWorkload(booking, await engine.getProjectThresholdHours());
}

async function projectWindow(booking, input, workload) {
  const Project = require('../models/Project');
  const project = await Project.findOne({ bookingId: booking._id }).lean();
  const verdict = await engine.getProjectWindowAvailability({
    startDate: input.startDate, endDate: input.endDate,
    requiredHours: input.requiredHours ? Math.max(1, Math.round(workload.totalEstimatedMinutes / 6) / 10) : null,
    totalUnits: workload.totalUnits, excludeProjectId: project?._id || null,
  });
  return { verdict, project };
}

async function validateResolutionSchedule(booking, input, now = new Date()) {
  assertResolutionBookingSchedulable(booking);
  const workload = await resolutionWorkload(booking);
  if (workload.totalUnits > engine.MAX_BOOKING_UNITS) throw schedulingError('This request exceeds the supported unit count. Review the booking before rescheduling.');
  const date = strictManilaDateKey(input.date || input.newDate);
  if (!date) throw schedulingError('Choose a valid schedule date.');
  const dateObj = new Date(date + 'T00:00:00+08:00');
  if (workload.isProject) {
    if (date <= manilaDateKey(now)) throw schedulingError('Choose a future project start date.');
    const prefs = input.projectScheduling || {};
    const endDate = strictManilaDateKey(input.endDate || prefs.preferredCompletionDeadline);
    if (!endDate || endDate <= date) throw schedulingError('Choose a finish-by date after the project start date.');
    if (new Date(endDate) - new Date(date) > 366 * 86400000) throw schedulingError('Choose a project window within one year.');
    const { verdict, project } = await projectWindow(booking, { startDate: date, endDate, requiredHours: true }, workload);
    if (project && (project.scheduleLocked || project.schedulePlan?.status === 'confirmed' ||
      !['pending_project_scheduling', 'accepted', 'planning', 'cancelled'].includes(project.status))) {
      throw schedulingError('This project has a confirmed schedule. Use Operations project planning to revise its approved schedule.', 409);
    }
    if (verdict.error) throw schedulingError(verdict.error);
    if (verdict.sufficient !== true) throw schedulingError('This date range no longer has enough technician capacity. Choose a wider project window.', 409, { refreshSlots: true });
    const allowedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const sourceDays = prefs.preferredWorkingDays || booking.projectScheduling?.preferredWorkingDays || allowedDays.slice(0, 5);
    const projectScheduling = {
      preferredStartDate: dateObj,
      preferredCompletionDeadline: new Date(endDate + 'T00:00:00+08:00'),
      preferredWorkingDays: [...new Set((Array.isArray(sourceDays) ? sourceDays : []).filter(day => allowedDays.includes(day)))],
      preferredWorkingHours: {
        start: (prefs.preferredWorkingHours?.start || booking.projectScheduling?.preferredWorkingHours?.start) === 'afternoon' ? 'afternoon' : 'morning', end: '',
      },
      estimatedTotalHours: Math.max(1, Math.round(workload.totalEstimatedMinutes / 6) / 10),
    };
    return { ...workload, date, dateObj, endDate, time: '', endTime: '', projectScheduling, project };
  }
  const selectedMinutes = parseAppointmentTime(input.time || input.newTime);
  const scheduledAt = manilaDateTime(date, selectedMinutes);
  if (!scheduledAt || scheduledAt <= now) throw schedulingError('Choose a valid future date and time.');
  const result = await require('../routes/scheduleRoutes').getTimeSlotsForQuery({
    date, duration: String(workload.totalEstimatedMinutes), quantity: '1',
    travelTime: String(Math.max(0, Number(booking.travelTime) || 30)),
  }, { excludeBookingId: booking._id });
  if (result.statusCode >= 500) throw schedulingError('Availability could not be checked. Please try again.', 503);
  const slot = result.payload?.timeSlots?.find(row => row.available !== false && parseAppointmentTime(row.startTime) === selectedMinutes);
  if (!slot) throw schedulingError('That time slot is no longer available. Choose another available time.', 409, { code: 'SLOT_UNAVAILABLE', refreshSlots: true });
  return { ...workload, date, dateObj, time: slot.startTime,
    endTime: String(selectedMinutes + Math.max(workload.totalEstimatedMinutes, Number(result.payload?.capacityPerSlot) || 0)) };
}

async function syncResolutionProject(booking, schedule, session) {
  if (!schedule.isProject) return;
  const Project = require('../models/Project');
  const fields = {
    ...schedule.projectScheduling, status: 'pending_project_scheduling',
    estimatedTotalHours: schedule.projectScheduling.estimatedTotalHours,
    totalUnits: schedule.totalUnits, quantity: schedule.totalUnits, isLargeScale: true,
    plannedStartDate: schedule.dateObj,
  };
  if (schedule.project) {
    const updated = await Project.findOneAndUpdate({
      _id: schedule.project._id, scheduleLocked: { $ne: true },
      'schedulePlan.status': { $ne: 'confirmed' },
      status: { $in: ['pending_project_scheduling', 'accepted', 'planning', 'cancelled'] },
    }, { $set: fields, $unset: { plannedCompletionDate: 1, schedulePlan: 1 } }, { session });
    if (!updated) throw schedulingError('The project schedule changed while you were selecting dates. Refresh the queue before rescheduling.', 409);
  } else {
    const source = typeof booking.toObject === 'function' ? booking.toObject() : booking;
    const details = source.services?.length
      ? require('./projectServiceChange').prepareProjectServiceChange(JSON.parse(JSON.stringify(source)), {
        startDate: schedule.dateObj, endDate: schedule.projectScheduling.preferredCompletionDeadline, inspectionDurationMinutes: 90,
      })
      : { customer: booking.customer, service: booking.service, location: booking.location };
    delete details.plannedCompletionDate;
    const document = { ...details, ...fields, bookingId: booking._id, customerId: booking.customerId || booking.customer?._id,
      projectPhase: booking.serviceType === 'repair' ? 'assessment' : 'execution', reservedTechnicians: 1 };
    await Project.create([document], { session });
  }
}

async function commitResolutionSchedule(schedule, commit) {
  if (!schedule.isProject) return commit(undefined);
  const session = await require('mongoose').startSession();
  try { return await session.withTransaction(() => commit(session)); }
  finally { await session.endSession(); }
}

function assertResolutionBookingSchedulable(booking) {
  if (['cancelled', 'completed', 'closed', 'repair_completed'].includes(booking?.status)) {
    throw schedulingError('This booking is already cancelled or finished. Create a new booking if the customer needs another service.', 409);
  }
}

module.exports = { assertResolutionBookingSchedulable, bookingWorkload, resolutionWorkload, projectWindow, validateResolutionSchedule, syncResolutionProject, commitResolutionSchedule };
