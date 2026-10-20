'use strict';
const team = require('./standardJobTeam');
const { manilaDateKey, manilaDateTime, parseAppointmentTime, strictManilaDateKey } = require('./bookingDateTime');
const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');
const fail = (message, status = 409, code = 'VISIT_RECOVERY_REQUIRED') => Object.assign(new Error(message), { status, code });
const BOOKING_STATES = ['awaiting_assignment', 'pending_reassignment', 'assigned', 'confirmed', 'scheduled', 'inspection_scheduled', 'repair_scheduled', 're-scheduled', 'reschedule-required'];
const ORDER_STATES = ['preparing_unit', 'technician_declined', 'technician_assigned', 'technician_accepted'];
function emergency(source, job) {
  return !job.technicianId && (source === 'booking' ? job.status === 'pending_reassignment' : job.status === 'technician_declined')
    ? job.staffingEmergencies?.at(-1) || null : null;
}
function eligible(source, job) {
  return !!job && !job.archivedAt && !job.isProject && (source === 'booking' ? !job.sourceOrderId && BOOKING_STATES.includes(job.status)
    : job.fulfillmentType !== 'customer_pickup' && ORDER_STATES.includes(job.status));
}
function assertContact(source, job) {
  const incident = emergency(source, job);
  if (!incident) return;
  const contact = job.visitRecoveryHistory?.at(-1);
  const date = source === 'booking' ? job.bookingDate : job.delivery?.preferredDate;
  const time = source === 'booking' ? job.startTime : job.timeSlot;
  if (!contact || team.ref(contact.incidentId) !== team.ref(incident._id) || contact.customerConfirmed !== true
    || manilaDateKey(contact.date) !== manilaDateKey(date) || parseAppointmentTime(contact.time) !== parseAppointmentTime(time)) {
    throw fail('Contact the customer and confirm the replacement visit in the Resolution Center before assigning technicians.', 409, 'CUSTOMER_CONTACT_REQUIRED');
  }
}
function assertRecoverySchedule(source, job, input = {}) {
  if (source !== 'order' || !job.visitRecoveryHistory?.length) return;
  if (input.scheduledDate && manilaDateKey(input.scheduledDate) !== manilaDateKey(job.delivery?.preferredDate)
    || input.timeSlot && parseAppointmentTime(input.timeSlot) !== parseAppointmentTime(job.timeSlot)) {
    throw fail('Confirm a changed arrival time with the customer in the Resolution Center before assigning the replacement.', 409, 'CUSTOMER_CONTACT_REQUIRED');
  }
}
function fields(mongoose) {
  return { visitRecoveryHistory: { type: [new mongoose.Schema({
    requestId: { type: String, required: true, maxlength: 64 }, incidentId: mongoose.Schema.Types.ObjectId,
    decision: { type: String, enum: ['late_visit', 'new_schedule'], required: true },
    contactMethod: { type: String, enum: ['call', 'message', 'in_person', 'customer_portal'], required: true },
    customerConfirmed: { type: Boolean, required: true }, date: { type: Date, required: true }, time: { type: String, required: true },
    previousDate: Date, previousTime: String, notes: { type: String, maxlength: 1000 },
    recordedAt: { type: Date, required: true }, recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, recordedByName: String,
  }, { _id: false })], default: undefined } };
}
function customerOrder(job) {
  const value = { ...job }, internalTimes = [...job.staffingEmergencies || [], ...job.visitRecoveryHistory || []]
    .map(row => Number(new Date(row.reportedAt || row.recordedAt)));
  if (internalTimes.length) value.statusHistory = (job.statusHistory || []).map(row => internalTimes.includes(Number(new Date(row.timestamp)))
    ? { ...row, note: row.status === 'technician_declined' ? 'An unexpected technician issue interrupted the visit. Our team will contact you about the replacement schedule.' : 'The replacement visit schedule was confirmed with the customer.' } : row);
  delete value.staffingEmergencies; delete value.visitRecoveryHistory;
  delete value.cancellationStockReview;
  if (job.staffingEmergencies?.length) value.technicianAcceptance = { ...job.technicianAcceptance, declineReason: undefined };
  return value;
}
function clearServices(job, schedule) {
  return (job.services || []).map(row => {
    if (!team.serviceReadyForVisit(job, row)) return row;
    if (['in_progress', 'inspection_in_progress', 'repair_in_progress', 'payment_pending'].includes(row.status)) throw fail('Work has started. Use Continue on another visit to preserve progress.');
    const repair = row.type === 'repair', phase2 = repair && team.repairVisit(job, row);
    return { ...row, technicianId: null, technicianName: '', assignmentId: null,
      status: repair ? phase2 ? 'ready_for_repair' : 'inspection_pending' : 'awaiting_assignment',
      schedule: { ...row.schedule, date: schedule.dateObj, startTime: schedule.time, endTime: schedule.endTime } };
  });
}
async function orderSchedule(job, input, now) {
  const { source, workload } = await require('./orderResolutionScheduling').loadOrderScheduling(job);
  if (workload.isProject) throw fail('Use project planning to arrange this installation.');
  const date = strictManilaDateKey(input.date), start = parseAppointmentTime(input.time);
  if (!date || !Number.isFinite(start) || manilaDateTime(date, start) <= now) throw fail('Choose an available future date and time.', 400);
  const result = await require('../routes/scheduleRoutes').getTimeSlotsForQuery({ date,
    duration: String(workload.totalEstimatedMinutes), quantity: '1', mode: 'manual', travelTime: String(source.travelTime) },
  { excludeOrderId: job._id, excludeBookingId: job.bookingId });
  if (result.statusCode >= 500) throw fail('Availability could not be checked. Try again.', 503);
  const slot = result.payload?.timeSlots?.find(row => row.available === true && parseAppointmentTime(row.startTime) === start);
  if (!slot) throw fail('That time is no longer available. Choose another time.', 409, 'SLOT_UNAVAILABLE');
  return { date, dateObj: manilaDateTime(date, 0), time: slot.startTime,
    endTime: String(start + Math.max(workload.totalEstimatedMinutes, Number(result.payload?.capacityPerSlot) || 0)) };
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Order: require('../models/Order'),
    Assignment: require('../models/Assignment'), lock: withOperationLock, write: require('./atomicWorkflowChanges').atomicWorkflowChanges,
    bookingSchedule: require('./resolutionScheduling').validateResolutionSchedule, orderSchedule, now: () => new Date(), ...overrides };
  async function recover(source, id, input, actor = {}) {
    if (!['booking', 'order'].includes(source) || !deps.mongoose.isValidObjectId(id)) throw fail('Invalid visit reference.', 400);
    if (input.customerConfirmed !== true || !['late_visit', 'new_schedule'].includes(input.decision)
      || !['call', 'message', 'in_person'].includes(input.contactMethod)) throw fail('Record the customer’s agreement and how you contacted them.', 400);
    if (typeof input.notes !== 'string' || input.notes.trim().length < 5 || input.notes.length > 1000) throw fail('Record the customer’s reply in 5 to 1,000 characters.', 400);
    if (typeof input.requestId !== 'string' || !/^[\w-]{8,64}$/.test(input.requestId)) throw fail('Refresh the recovery form and try again.', 400);
    const date = strictManilaDateKey(input.date);
    if (!date || !input.expectedUpdatedAt || !Number.isFinite(Number(new Date(input.expectedUpdatedAt)))) throw fail('Refresh the case before choosing a new visit.', 400);
    return deps.lock(bookingCapacityLockKey(date), () => deps.lock(`job-team:${source}:${id}`, async () => {
      const Model = source === 'booking' ? deps.Booking : deps.Order;
      const job = await Model.findById(id).lean();
      if (!job) throw fail('Visit not found.', 404);
      const last = job.visitRecoveryHistory?.at(-1);
      if (last?.requestId === input.requestId && last.decision === input.decision && last.contactMethod === input.contactMethod
        && last.notes === input.notes.trim() && manilaDateKey(last.date) === date && parseAppointmentTime(last.time) === parseAppointmentTime(input.time)) {
        return { source, job, duplicate: true, previousTechnicianIds: [] };
      }
      if (!eligible(source, job)) throw fail('This visit has changed or work has started. Refresh the case; use Continue on another visit for work already underway.');
      if (Number(new Date(job.updatedAt)) !== Number(new Date(input.expectedUpdatedAt))) throw fail('This case changed. Refresh it before recording a customer decision.', 409, 'VISIT_CHANGED');
      const now = deps.now(), incident = emergency(source, job);
      const schedule = await (source === 'booking' ? deps.bookingSchedule : deps.orderSchedule)(job, input, now);
      if (schedule.isProject) throw fail('Use project planning to confirm this visit.');
      if (manilaDateTime(schedule.date, parseAppointmentTime(schedule.time)) <= deps.now()) throw fail('This time has passed. Choose another available time.', 409, 'SLOT_UNAVAILABLE');
      if (input.decision === 'late_visit' && schedule.date !== manilaDateKey(now)) throw fail('A later visit today must use today’s date. Choose another schedule for a different day.', 400);
      if ((job.visitRecoveryHistory || []).length >= 100) throw fail('Operations must review this visit’s recovery history.');
      const previousDate = source === 'booking' ? job.bookingDate : job.delivery?.preferredDate;
      const previousTime = source === 'booking' ? job.startTime : job.timeSlot;
      const record = { requestId: input.requestId, incidentId: incident?._id, decision: input.decision, contactMethod: input.contactMethod,
        customerConfirmed: true, date: schedule.dateObj, time: schedule.time, previousDate, previousTime,
        notes: input.notes.trim(), recordedAt: now, recordedBy: actor._id, recordedByName: actor.name || 'Staff' };
      const note = `Customer agreed to ${input.decision === 'late_visit' ? 'a later visit today' : 'a new schedule'} (${input.contactMethod}): ${record.notes}. Confirmed ${schedule.date} ${schedule.time} PHT; replacement assignment required.`;
      const previousTechnicianIds = [...new Set([...team.ids(job), ...incident?.team?.map(row => team.ref(row.technicianId)) || []])];
      const changes = [];
      const booking = source === 'booking' ? job : job.bookingId ? await deps.Booking.findById(job.bookingId).lean() : null;
      if (booking && source === 'order' && team.ref(booking.sourceOrderId) !== team.ref(job._id)) throw fail('The linked installation needs Operations review.');
      if (booking) {
        const assignments = await deps.Assignment.find({ bookingId: booking._id, status: { $nin: ['completed', 'cancelled', 'declined', 'expired'] } }).lean();
        if (assignments.some(row => row.status === 'in_progress' || row.startedAt)) throw fail('Work has started. Use Continue on another visit.');
        const status = source === 'booking' && incident ? 'pending_reassignment' : 'awaiting_assignment';
        changes.push({ Model: deps.Booking, before: booking, set: {
          status, bookingDate: schedule.dateObj, preferredDate: schedule.dateObj, startTime: schedule.time, endTime: schedule.endTime,
          preferredTime: schedule.time, selectedTimeLabel: schedule.time, autoReschedulePending: false,
          technicianId: null, technician: null, assignmentId: null, technicianTeam: [], services: clearServices(booking, schedule),
          'servicePreparation.confirmed': false, 'repairPreparation.confirmed': false, 'technicianAssistant.verifiedByTechnician': false,
          visitRecoveryHistory: [...booking.visitRecoveryHistory || [], record], rescheduleReason: note,
          ...(booking.proposedReschedule?.status === 'pending' ? { proposedReschedule: { ...booking.proposedReschedule, status: 'accepted', date: schedule.dateObj, time: schedule.time } } : {}),
          ...(booking.rescheduleRequest?.status === 'pending' ? { 'rescheduleRequest.status': 'superseded' } : {}),
          ...(booking.rescheduleAccessStatus === 'allowed' ? { rescheduleAccessStatus: 'submitted' } : {}),
          statusHistory: [...booking.statusHistory || [], { fromStatus: booking.status, toStatus: status, changedBy: actor._id,
            changedByModel: 'User', changedByName: actor.name || 'Staff', reason: note, timestamp: now }],
        }, unset: { technicianTeamSchedule: '', rescheduleAccessToken: '', rescheduleAccessExpiry: '' } });
        changes.push(...assignments.map(row => ({ Model: deps.Assignment, before: row, set: { status: 'expired', expiredAt: now, expiredReason: note } })));
      }
      if (source === 'order') changes.unshift({ Model: deps.Order, before: job, set: {
        status: 'preparing_unit', 'delivery.preferredDate': schedule.dateObj, timeSlot: schedule.time,
        technicianId: null, technician: {}, technicianTeam: [], technicianAcceptance: { status: 'pending' },
        visitRecoveryHistory: [...job.visitRecoveryHistory || [], record],
        rescheduleRequest: { requested: true, requestedDate: schedule.date, requestedTime: schedule.time, reason: note,
          requestedBy: actor._id, requestedAt: now, status: 'approved', processedBy: actor._id, processedAt: now },
        statusHistory: [...job.statusHistory || [], { status: 'preparing_unit', timestamp: now, note }],
      }, unset: { technicianTeamSchedule: '', enRouteAt: '', arrivedAt: '' } });
      const saved = await deps.write(changes, deps.mongoose);
      return { source, job: saved[0], previousTechnicianIds, schedule, record, duplicate: false, previousDate };
    }));
  }
  return { recover };
}
async function publish(result, req, overrides = {}) {
  if (result.duplicate) return;
  const deps = { notify: require('./notify').createNotification,
    publishBooking: require('./technicianWorkSync').publishBookingWorkUpdate, audit: require('./audit').logEvent,
    releaseEquipment: (result, actorId) => require('./bookingEmergencyEquipment').releaseDemand({
      booking: { ...result.job.toObject?.() || result.job, bookingDate: result.previousDate,
        delivery: { preferredDate: result.previousDate } },
      incident: { reportedAt: result.record.recordedAt, team: result.previousTechnicianIds.map(technicianId => ({ technicianId })) },
    }, actorId, {}, result.source), ...overrides };
  const { source, job, schedule, previousTechnicianIds } = result, io = req.app.get('io');
  const reference = job.bookingReference || job.orderReference || 'Your visit';
  const tasks = [deps.audit({ actor: req.user?._id, target: job._id, module: source === 'booking' ? 'bookings' : 'orders',
    action: `${source}.visit_recovery.confirmed`, req, details: result.record })];
  const owner = source === 'booking' ? job.customerId : job.userId;
  if (owner) tasks.push(deps.notify({ type: 'assignment_update', title: 'Replacement visit schedule confirmed',
    message: `${reference}: as agreed, your visit is scheduled for ${schedule.date} at ${schedule.time} PHT. We are arranging the replacement technician team and will notify you when assigned.`,
    userId: owner, referenceId: job._id,
    referenceModel: source === 'booking' ? 'BookingService' : 'Order', link: source === 'booking' ? '/book-history' : '/my-orders', io }));
  if (previousTechnicianIds.length) tasks.push(deps.releaseEquipment(result, req.user?._id));
  if (source === 'booking') tasks.push(deps.publishBooking({ io, booking: job, technicianIds: previousTechnicianIds, reason: 'visit_recovery' }));
  else {
    const payload = { orderId: job._id, status: job.status, scheduleUpdated: true };
    io?.to('admin-room').emit('order:status-change', payload);
    for (const id of previousTechnicianIds) io?.to(`tech:${id}`).emit('order:status-change', payload);
  }
  const results = await Promise.allSettled(tasks);
  if (results.some(row => row.status === 'rejected')) console.warn('[visit-recovery] Schedule saved; a notification or preparation refresh needs retry.');
}
module.exports = { fields, emergency, eligible, assertContact, assertRecoverySchedule, createService, publish, clearServices, customerOrder };
