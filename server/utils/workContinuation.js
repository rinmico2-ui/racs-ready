"use strict";
const { randomUUID } = require('crypto');
const { manilaDateKey, manilaDateTime, strictManilaDateKey, parseAppointmentTime } = require('./bookingDateTime');
const { atomicWorkflowChanges } = require('./atomicWorkflowChanges');
const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const plain = doc => doc?.toObject ? doc.toObject() : doc;

function continuationRequest(input) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const remainingWork = typeof input.remainingWork === 'string' ? input.remainingWork.trim() : '';
  const remainingMinutes = Number(input.remainingMinutes);
  if (reason.length < 5 || reason.length > 500 || remainingWork.length < 10 || remainingWork.length > 1500) throw fail('Explain the reason and remaining work (at least 10 characters).', 400);
  if (!Number.isInteger(remainingMinutes) || remainingMinutes < 15 || remainingMinutes > 480) throw fail('Remaining visit duration must be 15 to 480 minutes.', 400);
  return { reason, remainingWork, remainingMinutes };
}
function visitIsPaused(job) { return ['pending', 'scheduled'].includes(job?.continuation?.status); }
function assertVisitActive(job) {
  if (job?.continuation?.status === 'pending') throw fail('This visit has ended. Operations must schedule the continuation before work resumes.');
}

function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Assignment: require('../models/Assignment'), Order: require('../models/Order'), Technician: require('../models/Technician'),
    slots: (...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args), write: atomicWorkflowChanges, lock: withOperationLock, ...overrides };
  async function load(source, id, { technicianId, byBooking = false } = {}) {
    if (!['booking', 'order'].includes(source) || !deps.mongoose.isValidObjectId(id)) throw fail('Invalid work reference.', 400);
    let job, assignment, booking;
    if (source === 'booking') {
      if (byBooking) {
        booking = plain(await deps.Booking.findById(id));
        assignment = booking?.assignmentId ? plain(await deps.Assignment.findById(booking.assignmentId)) : null;
      } else {
        assignment = plain(await deps.Assignment.findById(id));
        booking = assignment ? plain(await deps.Booking.findById(assignment.bookingId)) : null;
      }
      job = booking;
      if (!assignment || !booking) throw fail('Current booking assignment not found.', 404);
      if (booking.sourceOrderId || booking.isProject || assignment.serviceType === 'project') throw fail('Use the order or project workflow for this job.');
      if (String(booking.assignmentId) !== String(assignment._id) || String(booking.technicianId) !== String(assignment.technicianId)) throw fail('This job was reassigned. Refresh your work list.');
    } else {
      job = plain(await deps.Order.findById(id));
      if (!job) throw fail('Order not found.', 404);
      if (job.isProject || job.fulfillmentType !== 'delivery_installation') throw fail('Use the project workflow for large installations.');
      booking = job.bookingId ? plain(await deps.Booking.findById(job.bookingId)) : null;
    }
    const owner = source === 'booking' ? assignment.technicianId : job.technicianId;
    if (technicianId && String(owner) !== String(technicianId)) throw fail('This job is not assigned to you.', 403);
    return { job, assignment, booking, owner };
  }

  async function request(source, id, technicianId, input, now = new Date()) {
    const details = continuationRequest(input);
    return deps.lock(`continuation:${source}:${id}`, async () => {
      const state = await load(source, id, { technicianId });
      if (state.job.archivedAt || ['completed', 'cancelled', 'repair_completed'].includes(state.job.status)) throw fail('This job is already closed.');
      if (state.job.continuation?.status === 'pending') return { ...state, duplicate: true };
      if (source === 'booking' ? state.assignment.status !== 'in_progress' : state.job.status !== 'installing') throw fail('Start the work before requesting a continuation.');
      if ((state.job.continuation?.history || []).length >= 50) throw fail('This job needs an Operations review before another visit can be requested.');
      const previous = state.job.continuation?.history || [];
      const visit = { date: source === 'booking' ? state.assignment.bookingDate : state.job.delivery?.preferredDate,
        startTime: source === 'booking' ? state.assignment.startTime : state.job.timeSlot,
        endTime: state.assignment?.endTime, technicianId, endedAt: now, previousStatus: state.job.status,
        arrivalProofUrl: state.assignment?.arrivalProofUrl || state.job.arrivalProofUrl,
        startProofUrl: state.assignment?.startProofUrl || state.job.startProofUrl, ...details };
      const continuation = { status: 'pending', requestId: randomUUID(), requestedBy: technicianId, requestedAt: now,
        previousStatus: state.job.status, history: [...previous, visit], ...details };
      const changes = [{ Model: source === 'booking' ? deps.Booking : deps.Order, before: state.job, set: { continuation } }];
      if (state.assignment) changes.push({ Model: deps.Assignment, before: state.assignment, set: { continuation } });
      if (source === 'order' && state.booking) changes.push({ Model: deps.Booking, before: state.booking, set: { continuation } });
      const saved = await deps.write(changes, deps.mongoose);
      return { ...state, job: saved[0], continuation };
    });
  }

  async function availability(source, id, input) {
    const state = await load(source, id, { byBooking: true });
    if (state.job.continuation?.status !== 'pending') throw fail('This job is not awaiting a continuation schedule.');
    const date = strictManilaDateKey(input.date);
    if (!date || date < manilaDateKey(new Date())) throw fail('Choose today or a future work date.', 400);
    const technicianId = input.technicianId || state.owner;
    if (!deps.mongoose.isValidObjectId(technicianId)) throw fail('Choose a technician.', 400);
    const technician = await deps.Technician.findById(technicianId).populate('user', 'active blocked role').lean();
    if (!technician || technician.active === false || !technician.user || technician.user.active === false || technician.user.blocked || technician.user.role !== 'technician') throw fail('Choose an active technician.', 400);
    const minutes = Number(input.remainingMinutes || state.job.continuation.remainingMinutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) throw fail('Visit duration must be 15 to 480 minutes.', 400);
    const result = await deps.slots({ date, technicianId: String(technicianId), duration: String(minutes), quantity: '1', travelTime: String(state.job.travelTime || state.job.routeDurationMin || 30) },
      { excludeBookingId: state.booking?._id, excludeOrderId: source === 'order' ? state.job._id : null });
    if (result.statusCode >= 400) throw fail(result.payload?.message || result.payload?.error || 'Could not check this technician schedule.', result.statusCode);
    return { ...state, date, technicianId, technician, minutes, timeSlots: result.payload?.timeSlots || [] };
  }

  async function schedule(source, id, actorId, input) {
    return deps.lock(`continuation:${source}:${id}`, async () => deps.lock(bookingCapacityLockKey(input.date), async () => {
      const state = await availability(source, id, input);
      if (input.requestId !== state.job.continuation.requestId) throw fail('This continuation request changed. Refresh before scheduling.');
      const start = parseAppointmentTime(input.startTime);
      const slot = state.timeSlots.find(row => row.available === true && parseAppointmentTime(row.startTime) === start);
      if (!slot) throw fail('That time is no longer available. Check the schedule again.');
      const startTime = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      const endMinutes = start + state.minutes;
      const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
      const date = manilaDateTime(state.date, 0);
      const reassigned = String(state.technicianId) !== String(state.owner);
      const technician = { _id: state.technicianId, name: state.technician.name, phone: state.technician.phone || '', email: state.technician.userEmail || '' };
      const acceptanceDeadline = new Date(Date.now() + (Number(state.assignment?.responseSLAMinutes) || 30) * 60000);
      const continuation = { ...state.job.continuation, status: 'scheduled', scheduledDate: date, startTime, endTime, remainingMinutes: state.minutes, decidedBy: actorId, decidedAt: new Date() };
      const changes = [];
      if (source === 'booking') {
        const phaseTwo = state.job.continuation.previousStatus === 'repair_in_progress' || state.job.services?.some(row => row.type === 'repair' && row.status === 'repair_in_progress');
        const status = phaseTwo ? 'repair_scheduled' : state.assignment.serviceType === 'repair' ? 'inspection_scheduled' : reassigned ? 'assigned' : 'confirmed';
        const services = (state.job.services || []).map(row => ['completed', 'repair_completed', 'cancelled', 'repair_declined'].includes(row.status) ? row : { ...row,
          technicianId: state.technicianId, technicianName: state.technician.name, schedule: { ...(row.schedule || {}), date, startTime, endTime },
          status: row.type === 'repair' ? (phaseTwo ? 'repair_scheduled' : 'inspection_scheduled') : 'assigned' });
        changes.push({ Model: deps.Booking, before: state.job, guard: { 'continuation.requestId': input.requestId, 'continuation.status': 'pending' },
          set: { status, bookingDate: date, startTime, endTime, serviceDurationMinutes: state.minutes, technicianId: state.technicianId, technician, services, continuation,
            ...(phaseTwo ? { 'repairSchedule.date': date, 'repairSchedule.startTime': startTime, 'repairSchedule.time': startTime } : {}) } });
        changes.push({ Model: deps.Assignment, before: state.assignment, set: { status: reassigned ? 'pending_acceptance' : 'accepted', bookingDate: date, startTime, endTime, technicianId: state.technicianId, continuation,
          ...(reassigned ? { acceptanceDeadline, assignedAt: new Date() } : {}), equipmentCheckedOut: false, preparationStatus: 'pending' }, unset: { ...(reassigned ? { acceptedAt: '', expiryProcessedAt: '' } : {}), arrivedAt: '', enRouteAt: '', startedAt: '', arrivalProofUrl: '', startProofUrl: '' } });
      } else {
        changes.push({ Model: deps.Order, before: state.job, guard: { 'continuation.requestId': input.requestId, 'continuation.status': 'pending' },
          set: { status: reassigned ? 'technician_assigned' : 'technician_accepted', 'delivery.preferredDate': date, timeSlot: startTime, technicianId: state.technicianId,
            ...(reassigned ? { technicianAcceptance: { status: 'pending', deadlineAt: acceptanceDeadline } } : {}), technician, continuation }, unset: { arrivedAt: '', enRouteAt: '', startedAt: '', arrivalProofUrl: '', startProofUrl: '' } });
        if (state.booking) changes.push({ Model: deps.Booking, before: state.booking, set: { status: 'scheduled', bookingDate: date, startTime, endTime, serviceDurationMinutes: state.minutes, technicianId: state.technicianId, technician, continuation } });
      }
      const saved = await deps.write(changes, deps.mongoose);
      return { ...state, job: saved[0] };
    }));
  }
  return { load, request, availability, schedule };
}
module.exports = { continuationRequest, visitIsPaused, assertVisitActive, createService };
