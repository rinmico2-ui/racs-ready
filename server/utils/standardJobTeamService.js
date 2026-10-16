'use strict';
const team = require('./standardJobTeam');
const { manilaDateKey, manilaDateTime, parseAppointmentTime } = require('./bookingDateTime');
const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');

function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Order: require('../models/Order'),
    Assignment: require('../models/Assignment'), Technician: require('../models/Technician'),
    slots: (...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args), lock: withOperationLock, ...overrides };
  const model = source => source === 'booking' ? deps.Booking : deps.Order;
  async function load(source, id, session) {
    if (!['booking', 'order'].includes(source) || !deps.mongoose.isValidObjectId(id)) throw team.failure('Invalid job reference.', 400);
    const job = await model(source).findById(id).session(session || null);
    if (!job) throw team.failure('Job not found.', 404);
    if (job.archivedAt) throw team.failure('This job is archived.');
    if (job.isProject || source === 'booking' && job.sourceOrderId) throw team.failure('Use the owning order or project to manage this work.');
    if (source === 'order' && job.fulfillmentType !== 'delivery_installation') throw team.failure('Team assignment is available for delivery and installation orders.');
    return job;
  }
  function schedule(source, job, input = {}) {
    const date = manilaDateKey(source === 'booking' ? job.bookingDate : input.scheduledDate || job.delivery?.preferredDate);
    const rawTime = source === 'booking' ? job.startTime : input.timeSlot || job.timeSlot;
    const start = parseAppointmentTime(String(rawTime || '').split(/\s+-\s+/)[0]);
    const time = Number.isFinite(start) ? `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}` : '';
    const end = source === 'booking' ? parseAppointmentTime(job.endTime) : NaN;
    const minutes = source === 'booking' ? Math.max(30, Number(job.serviceDurationMinutes) || (Number.isFinite(end) ? end - start : 60))
      : job.continuation?.status === 'scheduled' ? Number(job.continuation.remainingMinutes) : Math.max(1, (job.items || []).reduce((sum, row) => sum + Math.max(1, Number(row.quantity) || 1), 0)) * 60;
    if (source === 'booking' && (input.scheduledDate && manilaDateKey(input.scheduledDate) !== date || input.timeSlot && parseAppointmentTime(input.timeSlot) !== start)) throw team.failure('Save the new appointment date and time before assigning the team.');
    if (!date || !Number.isFinite(start) || manilaDateTime(date, start) <= new Date()) throw team.failure('Choose a future appointment before assigning technicians.');
    return { date, start, time, minutes, travel: Math.max(0, Number(job.travelDuration || job.travelTime || job.routeDurationMin) || 30) };
  }
  async function candidates(source, job, input = {}) {
    const visit = schedule(source, job, input);
    const technicians = await deps.Technician.find({ active: { $ne: false }, archivedAt: null })
      .populate('user', 'active blocked role').select('_id name user phone userEmail').lean();
    const rows = [];
    // Bounded batches avoid opening one database-heavy slot calculation for
    // every staff account at once.
    for (let offset = 0; offset < technicians.length; offset += 4) {
      rows.push(...await Promise.all(technicians.slice(offset, offset + 4).map(async technician => {
        const eligible = technician.user && technician.user.active !== false && !technician.user.blocked && technician.user.role === 'technician';
        let available = false, reason = eligible ? 'Unavailable for this appointment' : 'No active technician account';
        if (eligible) {
          const result = await deps.slots({ date: visit.date, technicianId: team.ref(technician._id), duration: String(visit.minutes), quantity: '1', travelTime: String(visit.travel) },
            { excludeBookingId: source === 'booking' ? job._id : job.bookingId, excludeOrderId: source === 'order' ? job._id : null });
          if (result.statusCode >= 500) throw team.failure('Availability could not be checked. Try again.', 503);
          available = (result.payload?.timeSlots || []).some(slot => slot.available === true && parseAppointmentTime(slot.startTime) === visit.start);
          if (available) reason = 'Available for the full appointment';
        }
        return { technicianId: team.ref(technician._id), name: technician.name || 'Technician', available, reason };
      })));
    }
    return { visit, candidates: rows };
  }
  async function transaction(work) {
    if (require('./bookingSubmissionWrite').isKnownStandalone(deps.mongoose.connection)) throw team.failure('Team assignment requires the configured MongoDB replica set.', 503, 'TEAM_DATABASE_SETUP_REQUIRED');
    const session = await deps.mongoose.startSession();
    try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
    finally { await session.endSession(); }
  }
  async function assign(source, id, input, actor) {
    if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 1000)) throw team.failure('Assignment notes must be text of up to 1,000 characters.', 400);
    const technicianIds = team.normalize(input);
    const initial = await load(source, id);
    const visit = schedule(source, initial, input);
    return deps.lock(bookingCapacityLockKey(visit.date), async () => {
      // Recheck while holding the same date lease as order and customer booking
      // capacity writes; the candidate list shown in the browser is advisory.
      const current = await load(source, id);
      if (input.expectedSchedule && input.expectedSchedule !== team.scheduleKey(source, current)) throw team.failure('The appointment schedule changed. Refresh the assignment plan.', 409, 'ASSIGNMENT_SCHEDULE_CHANGED');
      require('./assignmentStaffing').assertRecommendedCrew(source, current, input, technicianIds);
      const reviewed = ['reviewed_plan', 'automatic'].includes(input.assignmentSource);
      if (reviewed && !(source === 'booking' ? ['awaiting_assignment', 'pending_reassignment'] : ['preparing_unit', 'technician_declined']).includes(current.status)) throw team.failure('This job has already been assigned or changed. Refresh the plan.');
      const currentIds = team.ids(current);
      if (currentIds.length === technicianIds.length && team.ref(current.technicianId) === technicianIds[0] && technicianIds.every(id => currentIds.includes(id))
        && team.members(current).length && team.scheduleKey(source, current) === team.scheduleKey(source, { ...current.toObject?.() || current,
          ...(source === 'order' ? { delivery: { ...current.delivery, preferredDate: manilaDateTime(visit.date, 0) }, timeSlot: visit.time } : {}) })
        && team.members(current).every(row => row.status === 'accepted' || row.status === 'pending' && row.deadlineAt > new Date()) && !input.notes?.trim()) {
        return { source, job: current, duplicate: true, assignment: source === 'booking' ? await deps.Assignment.findById(current.assignmentId) : null };
      }
      const availability = await candidates(source, current, input);
      if (availability.visit.date !== visit.date || availability.visit.start !== visit.start || availability.visit.minutes !== visit.minutes) throw team.failure('The appointment schedule changed. Refresh before assigning.');
      for (const technicianId of technicianIds) if (!availability.candidates.some(row => row.technicianId === technicianId && row.available)) throw team.failure('A selected technician is no longer available. Refresh the team list.');
      return transaction(async session => {
        const job = await load(source, id, session);
        if (reviewed && !(source === 'booking' ? ['awaiting_assignment', 'pending_reassignment'] : ['preparing_unit', 'technician_declined']).includes(job.status)) throw team.failure('This job has already been assigned or changed. Refresh the plan.');
        if (Number(new Date(job.updatedAt || 0)) !== Number(new Date(current.updatedAt || 0))) throw team.failure('This appointment changed. Refresh before assigning.');
        const allowed = source === 'booking' ? ['awaiting_assignment', 'pending_reassignment', 're-scheduled', 'assigned', 'confirmed', 'scheduled', 'inspection_scheduled', 'repair_scheduled', 'repair_approved'] : ['preparing_unit', 'technician_declined', 'technician_assigned', 'technician_accepted'];
        if (!allowed.includes(job.status)) throw team.failure('The team can only be changed before work starts.');
        if (source === 'order' && !['paid', 'partial', 'verified', 'remitted'].includes(job.paymentStatus)) throw team.failure('Verify payment before assigning the installation team.');
        const technicians = await deps.Technician.find({ _id: { $in: technicianIds }, active: { $ne: false }, archivedAt: null }).session(session).lean();
        require('./assignmentStaffing').assertRecommendedCrew(source, job, input, technicianIds);
        const responseMinutes = Math.min(720, Math.max(5, Number(input.responseMinutes) || 30));
        const deadlineAt = new Date(Date.now() + responseMinutes * 60000);
        const entries = technicianIds.map(technicianId => ({ technicianId, name: technicians.find(row => team.ref(row._id) === technicianId)?.name || 'Technician', status: 'pending', deadlineAt }));
        const primary = technicians.find(row => team.ref(row._id) === technicianIds[0]);
        if (!primary || technicians.length !== technicianIds.length) throw team.failure('A selected technician account changed. Refresh the list.');
        const previous = source === 'booking' ? await deps.Assignment.find({ bookingId: id, status: { $nin: ['completed', 'cancelled', 'declined', 'expired'] } }).session(session).lean() : [];
        if (previous.some(row => ['en_route', 'on_site', 'in_progress'].includes(row.status))) throw team.failure('Work has started. Operations must review staffing changes.');
        job.technicianId = primary._id;
        job.technician = { _id: primary._id, name: primary.name, phone: primary.phone || '', email: primary.userEmail || '' };
        if (source === 'booking') {
          for (const row of previous) await deps.Assignment.updateOne({ _id: row._id }, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { session });
          const repaired = job.serviceModel === 'RepairService' || job.serviceType === 'repair' || (job.services || []).some(row => row.type === 'repair');
          if (repaired && job.serviceModel === 'RepairService') job.serviceType = 'repair';
          for (const entry of entries) {
            const assignment = new deps.Assignment({ bookingId: job._id, technicianId: entry.technicianId, crewRole: entry === entries[0] ? 'primary' : 'support',
              customerName: job.customer?.name || '', customerPhone: job.customer?.phone || '', customerEmail: job.customer?.email || '',
              serviceName: job.service?.name || (job.services || []).map(row => row.name).join(', ') || 'Service', serviceType: job.serviceType || 'core',
              servicePrice: entry === entries[0] ? job.totalPrice || 0 : 0, estimatedFee: entry === entries[0] ? job.totalPrice || 0 : 0,
              bookingDate: job.bookingDate, startTime: job.startTime, endTime: job.endTime, address: job.location?.address || '',
              acceptanceDeadline: deadlineAt, responseSLAMinutes: responseMinutes, status: 'pending_acceptance', notes: [{ text: String(input.notes || 'Assigned by staff').slice(0, 1000), by: actor?._id, byName: actor?.name || actor?.email || 'System' }] });
            await assignment.save({ session }); entry.assignmentId = assignment._id;
          }
          job.assignmentId = entries[0].assignmentId;
          job.status = team.bookingAssignmentStatus(current);
          job.assignedAt = new Date(); job.assignedBy = actor?._id;
          job.autoReschedulePending = false; job.autoRescheduleAt = undefined; job.autoRescheduleReason = undefined;
          if (input.assignmentSource === 'automatic') job.reassignmentCount = (job.reassignmentCount || 0) + 1;
          team.assignServiceItems(job, primary);
          job.recordStatusHistory?.({ fromStatus: current.status, toStatus: job.status, changedBy: actor?._id, changedByModel: 'User', changedByName: actor?.name || actor?.email || 'System', reason: `Assigned ${entries.length} technician(s); primary: ${primary.name}. ${require('./assignmentStaffing').staffingFor(source, current).reason}` });
        } else {
          job.delivery ||= {}; job.delivery.preferredDate = manilaDateTime(availability.visit.date, 0); job.timeSlot = availability.visit.time;
          job.technicianAcceptance = { status: 'pending', deadlineAt };
          job.pushStatus('technician_assigned', `Assigned ${entries.length} technicians; primary: ${primary.name}`, { actor: actor._id, actorRole: actor.role, actorName: actor.name || actor.email });
          let booking = job.bookingId ? await deps.Booking.findById(job.bookingId).session(session) : null;
          const values = { sourceOrderId: job._id, customerId: job.userId, customer: job.customer, technicianId: primary._id, technician: job.technician,
            bookingDate: manilaDateTime(visit.date, 0), startTime: String(visit.time).split(/\s+-\s+/)[0], endTime: require('./orderScheduleCapacity').orderCapacityEndTime(job),
            status: 'scheduled', serviceType: 'core', serviceDurationMinutes: visit.minutes, service: { name: 'Air Conditioner Installation', basePrice: Number(job.installationFee || 0) },
            servicePrice: Number(job.installationFee || 0), paymentMethod: job.paymentMethod === 'gcash' ? 'gcash' : 'other', technicianTeam: entries, location: { address: job.delivery?.address, coordinates: job.delivery?.coordinates } };
          if (!booking) booking = new deps.Booking(values); else Object.assign(booking, values);
          await booking.save({ session }); job.bookingId = booking._id;
        }
        job.technicianTeam = entries;
        job.technicianTeamSchedule = team.scheduleKey(source, job);
        await job.save({ session });
        return { source, job, assignment: source === 'booking' ? await deps.Assignment.findById(job.assignmentId).session(session) : null };
      });
    }, { leaseMs: 120000 });
  }
  async function respond(source, id, technicianId, decision, reason = '') {
    return deps.lock(`job-team:${source}:${id}`, () => transaction(async session => {
      const job = await load(source, id, session), entry = team.member(job, technicianId);
      if (!entry) throw team.failure('You are no longer assigned to this team.', 403);
      if (!['accept', 'decline'].includes(decision)) throw team.failure('Choose accept or decline.', 400);
      if (typeof reason !== 'string' || reason.length > 500) throw team.failure('The response reason must be text of up to 500 characters.', 400);
      if (entry.status === (decision === 'accept' ? 'accepted' : 'declined')) return { job, duplicate: true, response: true };
      if (entry.status !== 'pending' || entry.deadlineAt && entry.deadlineAt <= new Date() || team.closed.has(job.status)) throw team.failure('This assignment response is no longer available. Ask Operations to review the team.');
      schedule(source, job);
      entry.status = decision === 'accept' ? 'accepted' : 'declined'; entry.respondedAt = new Date(); entry.reason = String(reason).trim().slice(0, 500);
      if (entry.assignmentId) await deps.Assignment.updateOne({ _id: entry.assignmentId, technicianId, status: 'pending_acceptance' }, { $set: { status: decision === 'accept' ? 'accepted' : 'declined', ...(decision === 'accept' ? { acceptedAt: entry.respondedAt } : { declinedAt: entry.respondedAt, declineReason: entry.reason }) } }, { session });
      if (decision === 'decline') job.status = source === 'booking' ? 'pending_reassignment' : 'technician_declined';
      if (decision === 'accept' && team.readiness(job).ready) {
        if (source === 'booking') team.acceptServiceItems(job);
        if (source === 'booking' && job.status === 'assigned') job.status = 'confirmed';
        if (source === 'order') { job.technicianAcceptance = { status: 'accepted', respondedAt: new Date() }; job.pushStatus('technician_accepted', 'All assigned technicians accepted'); }
      }
      await job.save({ session }); return { job, response: true, decision, technicianId };
    }));
  }
  async function addNote(source, id, technicianId, text) {
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) throw team.failure('Enter a work note of 1 to 1,000 characters.', 400);
    return deps.lock(`job-team:${source}:${id}`, () => transaction(async session => {
      const job = await load(source, id, session), entry = team.member(job, technicianId);
      if (!entry || entry.status !== 'accepted' || team.closed.has(job.status)) throw team.failure('Only accepted team members can add notes to an active job.', 403);
      if ((entry.workNotes || []).length >= 50) throw team.failure('This assignment has reached its note limit. Contact Operations.');
      entry.workNotes ||= []; entry.workNotes.push({ text: text.trim(), createdAt: new Date() });
      await job.save({ session }); return { job, response: true };
    }));
  }
  return { load, candidates, assign, respond, schedule, addNote };
}
async function publish(result, req) {
  const { source, job } = result, io = req.app.get('io') || global.io;
  if (result.duplicate) return;
  for (const row of team.members(job)) {
    if (!result.response) {
      const tech = await require('../models/Technician').findById(row.technicianId).select('user').lean();
      await require('./notify').createNotification({ role: 'technician', userId: tech?.user || row.technicianId, title: 'Job team assigned', message: `${job.bookingReference || job.orderReference || 'Your job'}: please accept your ${team.isPrimary(job, row.technicianId) ? 'primary' : 'supporting'} assignment.`, link: source === 'booking' ? '/technician/assignments' : '/technician/orders', io });
    }
    io?.to(`tech:${row.technicianId}`).emit(source === 'booking' ? 'assignment:new' : 'order:assigned', { bookingId: source === 'booking' ? job._id : undefined, orderId: source === 'order' ? job._id : undefined });
  }
  io?.to('admin-room').emit(source === 'booking' ? 'booking:updated' : 'order:status-change', { bookingId: source === 'booking' ? job._id : undefined, orderId: source === 'order' ? job._id : undefined, status: job.status });
  const owner = source === 'booking' ? job.customerId : job.userId;
  if (result.response && result.decision === 'decline') await require('./notify').createNotification({ role: 'admin', title: 'Technician team needs review', message: `${job.bookingReference || job.orderReference}: a technician declined. Review the team before dispatch.`, link: source === 'booking' ? '/admin/appointments?tab=queue' : '/admin/appointments/orders', io });
  if (owner && !result.response) await require('./notify').createNotification({ role: 'customer', userId: owner, title: 'Your service team', message: `${job.bookingReference || job.orderReference}: ${team.members(job).map(row => row.name).join(', ')}.`, link: source === 'booking' ? '/book-history' : '/my-orders', io });
}
async function assignmentResponse(source, req, res) {
  try {
    if (req.user.role === 'secretary' && !await require('../middleware/requirePermission').hasPermission(req.user, `${source === 'booking' ? 'appointments' : 'orders'}.manage`)) return res.status(403).json({ error: 'You do not have permission to assign this job.' });
    const result = await createService().assign(source, req.params.id, req.body, req.user);
    if (!result.duplicate) await require('./audit').logEvent({ actor: req.user._id, action: `${source}.team_assigned`, target: result.job._id, req,
      details: { primaryTechnicianId: team.ref(result.job.technicianId), technicianIds: team.ids(result.job) } }).catch(() => {});
    await publish(result, req).catch(error => console.warn('[job-team] Follow-up pending:', error.message));
    return res.json({ success: true, booking: source === 'booking' ? result.job : undefined, order: source === 'order' ? result.job : undefined, assignment: result.assignment, message: 'Technician team assigned. Each member must accept.' });
  } catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : 'The technician team could not be assigned. Try again.', code: error.code }); }
}
module.exports = { createService, publish, assignmentResponse };
