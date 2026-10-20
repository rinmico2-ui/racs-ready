'use strict';
const team = require('./standardJobTeam');
const { manilaDateKey, manilaDateTime, parseAppointmentTime, bookingAssignmentWindow } = require('./bookingDateTime');
const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');

function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Order: require('../models/Order'),
    Assignment: require('../models/Assignment'), Technician: require('../models/Technician'),
    roster: options => require('./technicianRoster').loadTechnicianRoster(options),
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
    const assignmentWindow = source === 'booking' ? bookingAssignmentWindow(job) : null;
    if (assignmentWindow && !assignmentWindow.allowed) throw team.failure(assignmentWindow.valid
      ? 'The 30-minute assignment window has ended. Confirm a new schedule with the customer before assigning technicians.'
      : 'Confirm a valid appointment date and time before assigning technicians.', 409,
      assignmentWindow.valid ? 'BOOKING_ASSIGNMENT_WINDOW_EXPIRED' : 'BOOKING_SCHEDULE_REQUIRED');
    if (!assignmentWindow && (!date || !Number.isFinite(start) || manilaDateTime(date, start) <= new Date())) throw team.failure('Choose a future appointment before assigning technicians.', 409, 'ORDER_SCHEDULE_PASSED');
    return { date, start, time, minutes, travel: Math.max(0, Number(job.travelDuration || job.travelTime || job.routeDurationMin) || 30),
      capacityStart: assignmentWindow?.capacityStartMinutes ?? start, assignmentWindow };
  }
  function responseSchedule(source, job) {
    if (source !== 'order') return schedule(source, job);
    if (job.continuation?.status === 'pending') throw team.failure('Operations must schedule the continuation before work resumes.', 409, 'CONTINUATION_PENDING');
    // Existing invitations stay actionable during the delivery's dispatch grace.
    const timing = require('./orderAttention').orderAttentionState(job);
    if (!job.delivery?.preferredDate || !timing.scheduledStartAt) throw team.failure('Operations must confirm the delivery date and time before you can respond.', 409, 'ORDER_SCHEDULE_REQUIRED');
    if (timing.isPastDate) throw team.failure('This delivery schedule has passed. Operations must confirm a new customer schedule before acceptance.', 409, 'ORDER_SCHEDULE_PASSED');
  }
  async function candidates(source, job, input = {}) {
    const visit = schedule(source, job, input);
    const savedEnd = source === 'booking' ? parseAppointmentTime(job.endTime) : NaN;
    const checkedMinutes = visit.capacityStart > visit.start && Number.isFinite(savedEnd)
      ? Math.max(visit.minutes, savedEnd - visit.capacityStart - visit.travel - require('./bookingPolicy').getBufferMinutesSync()) : visit.minutes;
    const technicians = await deps.roster({ Technician: deps.Technician });
    const rows = [];
    // Bounded batches avoid opening one database-heavy slot calculation for
    // every staff account at once.
    for (let offset = 0; offset < technicians.length; offset += 4) {
      rows.push(...await Promise.all(technicians.slice(offset, offset + 4).map(async technician => {
        const eligible = technician.assignmentEligible;
        let available = false, reason = eligible ? 'Unavailable for this appointment' : technician.assignmentReason;
        if (eligible) {
          const result = await deps.slots({ date: visit.date, technicianId: team.ref(technician._id), duration: String(checkedMinutes), quantity: '1', travelTime: String(visit.travel) },
            { excludeBookingId: source === 'booking' ? job._id : job.bookingId, excludeOrderId: source === 'order' ? job._id : null, existingAppointment: true,
              ...(visit.capacityStart > visit.start ? { assignmentStartMinutes: visit.capacityStart } : {}) });
          if (result.statusCode >= 500) throw team.failure('Availability could not be checked. Try again.', 503);
          available = (result.payload?.timeSlots || []).some(slot => slot.available === true && parseAppointmentTime(slot.startTime) === visit.capacityStart);
          if (available) reason = 'Available for the full appointment';
          else if (result.payload?.message) reason = result.payload.message;
        }
        return { technicianId: team.ref(technician._id), name: technician.name || 'Technician', available, reason };
      })));
    }
    visit.capacityEnd = Math.max(Number.isFinite(savedEnd) ? savedEnd : 0, visit.capacityStart + visit.minutes + visit.travel + require('./bookingPolicy').getBufferMinutesSync());
    return { visit, candidates: rows };
  }
  async function transaction(work) {
    if (require('./bookingSubmissionWrite').isKnownStandalone(deps.mongoose.connection)) throw team.failure('Team assignment requires the configured MongoDB replica set.', 503, 'TEAM_DATABASE_SETUP_REQUIRED');
    const session = await deps.mongoose.startSession();
    try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
    finally { await session.endSession(); }
  }
  async function assign(source, id, input, actor, options = {}) {
    function repairSchedule(job) {
      if (!options.repairVisit) return job;
      if (source !== 'booking' || !require('./standardRepairVisit').approvalReady(job)) throw team.failure('The customer must approve the repair quotation before scheduling another visit.');
      const minutes = require('./standardRepairVisit').duration(input.repairMinutes, Number(job.repairExecution?.repairMinutes || job.technicianAssistant?.estimatedDurationMinutes) || 90);
      return { ...(job.toObject?.() || job), bookingDate: manilaDateTime(input.scheduledDate, 0), startTime: input.timeSlot, endTime: '', serviceDurationMinutes: minutes };
    }
    if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 1000)) throw team.failure('Assignment notes must be text of up to 1,000 characters.', 400);
    const technicianIds = team.normalize(input);
    const initial = await load(source, id);
    const visit = schedule(source, repairSchedule(initial), input);
    return deps.lock(bookingCapacityLockKey(visit.date), async () => {
      // Recheck while holding the same date lease as order and customer booking
      // capacity writes; the candidate list shown in the browser is advisory.
      const current = await load(source, id);
      require('./visitRecovery').assertContact(source, current);
      require('./visitRecovery').assertRecoverySchedule(source, current, input);
      if (input.expectedSchedule && input.expectedSchedule !== team.scheduleKey(source, current)) throw team.failure('The appointment schedule changed. Refresh the assignment plan.', 409, 'ASSIGNMENT_SCHEDULE_CHANGED');
      require('./assignmentStaffing').assertRecommendedCrew(source, current, input, technicianIds);
      const reviewed = ['reviewed_plan', 'automatic'].includes(input.assignmentSource);
      if (reviewed && !(source === 'booking' ? ['awaiting_assignment', 'pending_reassignment'] : ['preparing_unit', 'technician_declined']).includes(current.status)) throw team.failure('This job has already been assigned or changed. Refresh the plan.');
      const currentIds = team.ids(current);
      if (!options.repairVisit && currentIds.length === technicianIds.length && team.ref(current.technicianId) === technicianIds[0] && technicianIds.every(id => currentIds.includes(id))
        && team.members(current).length && team.scheduleKey(source, current) === team.scheduleKey(source, { ...current.toObject?.() || current,
          ...(source === 'order' ? { delivery: { ...current.delivery, preferredDate: manilaDateTime(visit.date, 0) }, timeSlot: visit.time } : {}) })
        && team.members(current).every(row => row.status === 'accepted' || row.status === 'pending' && row.deadlineAt > new Date()) && !input.notes?.trim()) {
        return { source, job: current, duplicate: true, assignment: source === 'booking' ? await deps.Assignment.findById(current.assignmentId) : null };
      }
      const availability = await candidates(source, repairSchedule(current), input);
      if (availability.visit.date !== visit.date || availability.visit.start !== visit.start || availability.visit.minutes !== visit.minutes) throw team.failure('The appointment schedule changed. Refresh before assigning.');
      for (const technicianId of technicianIds) if (!availability.candidates.some(row => row.technicianId === technicianId && row.available)) throw team.failure('A selected technician is no longer available. Refresh the team list.');
      return transaction(async session => {
        const job = await load(source, id, session);
        require('./visitRecovery').assertContact(source, job);
        if (source === 'booking' && schedule(source, repairSchedule(job), input).capacityStart > availability.visit.capacityStart) throw team.failure('The dispatch time changed while checking the crew. Refresh availability before assigning.', 409, 'TEAM_AVAILABILITY_CHANGED');
        if (reviewed && !(source === 'booking' ? ['awaiting_assignment', 'pending_reassignment'] : ['preparing_unit', 'technician_declined']).includes(job.status)) throw team.failure('This job has already been assigned or changed. Refresh the plan.');
        if (Number(new Date(job.updatedAt || 0)) !== Number(new Date(current.updatedAt || 0))) throw team.failure('This appointment changed. Refresh before assigning.');
        const allowed = source === 'booking' ? ['awaiting_assignment', 'pending_reassignment', 're-scheduled', 'assigned', 'confirmed', 'scheduled', 'inspection_scheduled', 'repair_scheduled', 'repair_approved', ...(options.repairVisit ? ['ready_for_repair', 'waiting_parts'] : [])] : ['preparing_unit', 'technician_declined', 'technician_assigned', 'technician_accepted'];
        if (!allowed.includes(job.status)) throw team.failure('The team can only be changed before work starts.');
        if (source === 'order' && !['paid', 'partial', 'verified', 'remitted'].includes(job.paymentStatus)) throw team.failure('Verify payment before assigning the installation team.');
        const technicians = (await deps.roster({ Technician: deps.Technician, technicianIds, session })).filter(technician => technician.assignmentEligible);
        require('./assignmentStaffing').assertRecommendedCrew(source, job, input, technicianIds);
        const responseMinutes = Math.min(720, Math.max(5, Number(input.responseMinutes) || 30));
        const deadlineAt = new Date(Math.min(Date.now() + responseMinutes * 60000,
          source === 'booking' ? Number(new Date(availability.visit.assignmentWindow.assignmentCutoffAt)) : Infinity));
        const entries = technicianIds.map(technicianId => ({ technicianId, name: technicians.find(row => team.ref(row._id) === technicianId)?.name || 'Technician', status: 'pending', deadlineAt }));
        const primary = technicians.find(row => team.ref(row._id) === technicianIds[0]);
        if (!primary || technicians.length !== technicianIds.length) throw team.failure('A selected technician account changed. Refresh the list.');
        const previous = source === 'booking' ? await deps.Assignment.find({ bookingId: id, status: { $nin: ['completed', 'cancelled', 'declined', 'expired'] } }).session(session).lean() : [];
        if (previous.some(row => ['en_route', 'on_site', 'in_progress'].includes(row.status))) throw team.failure('Work has started. Operations must review staffing changes.');
        if (options.repairVisit) {
          repairSchedule(job);
          const end = visit.start + visit.minutes + visit.travel + require('./bookingPolicy').getBufferMinutesSync();
          job.bookingDate = manilaDateTime(visit.date, 0); job.startTime = visit.time;
          job.endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
          job.serviceDurationMinutes = visit.minutes; job.status = 'repair_approved';
          job.repairExecution = { repairMinutes: visit.minutes, workDate: visit.date };
          job.schedulingRequest = { ...(job.schedulingRequest?.toObject?.() || job.schedulingRequest || {}), status: 'confirmed', scheduledDate: job.bookingDate, scheduledTime: job.startTime, scheduledBy: actor._id, notes: input.notes || '' };
        }
        job.technicianId = primary._id;
        job.technician = { _id: primary._id, name: primary.name, phone: primary.phone || '', email: primary.userEmail || '' };
        if (source === 'booking') {
          // Late dispatch still reserves the complete service, travel and
          // buffer interval so a later job cannot overlap its actual finish.
          if (availability.visit.capacityStart > availability.visit.start) {
            const end = Math.max(parseAppointmentTime(job.endTime) || 0, availability.visit.capacityEnd);
            job.endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
          }
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
          job.status = team.bookingAssignmentStatus(options.repairVisit ? job : current);
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
      if (entry.status !== 'pending' || team.closed.has(job.status)) throw team.failure('This assignment response is no longer available. Ask Operations to review the team.');
      if (source === 'order' && !['technician_assigned', 'technician_declined'].includes(job.status)) throw team.failure('This order is no longer waiting for team responses. Refresh your orders.');
      responseSchedule(source, job);
      if (entry.deadlineAt && entry.deadlineAt <= new Date()) throw team.failure('Your assignment response deadline has passed. Ask Operations to extend the deadline or review the team.', 409, 'TEAM_RESPONSE_EXPIRED');
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
  async function extend(source, id, minutes, assignmentId) {
    return deps.lock(`job-team:${source}:${id}`, () => transaction(async session => {
      const job = await load(source, id, session); responseSchedule(source, job);
      if (!['assigned', 'confirmed', 'inspection_scheduled', 'repair_scheduled', 'technician_assigned'].includes(job.status)) throw team.failure('This job is no longer waiting for acceptance.');
      const pending = team.members(job).filter(row => row.status === 'pending' && (source === 'order' || team.ref(row.assignmentId) === String(assignmentId)));
      if (!pending.length) throw team.failure('This assignment has already been answered. Refresh the page.');
      for (const entry of pending) {
        entry.deadlineAt = require('./acceptanceDeadline').extendAcceptanceDeadline(entry.deadlineAt, minutes);
        if (source === 'booking') {
          const result = await deps.Assignment.updateOne({ _id: entry.assignmentId, bookingId: job._id, technicianId: entry.technicianId, status: 'pending_acceptance' }, { $set: { acceptanceDeadline: entry.deadlineAt } }, { session });
          if (!result.matchedCount) throw team.failure('This assignment changed. Refresh before trying again.');
        }
      }
      if (source === 'order') job.technicianAcceptance.deadlineAt = new Date(Math.min(...pending.map(row => Number(row.deadlineAt))));
      await job.save({ session }); return { source, job, response: true };
    }));
  }
  async function releaseBooking(id, reason = '', actor = {}) {
    return deps.lock(`job-team:booking:${id}`, () => transaction(async session => {
      const job = await load('booking', id, session); schedule('booking', job);
      if (!['assigned', 'inspection_scheduled', 'repair_scheduled', 'pending_reassignment'].includes(job.status) || !team.members(job).some(row => row.status === 'pending')) throw team.failure('This job is no longer waiting for acceptance.');
      const assignments = await deps.Assignment.find({ bookingId: id, status: { $nin: ['completed', 'cancelled', 'declined', 'expired'] } }).session(session).lean();
      if (assignments.some(row => ['en_route', 'on_site', 'in_progress'].includes(row.status))) throw team.failure('Work has started. Operations must review the team.');
      for (const row of assignments) await deps.Assignment.updateOne({ _id: row._id }, { $set: { status: row.status === 'pending_acceptance' ? 'expired' : 'cancelled', expiredAt: new Date(), expiredReason: 'Returned to assignment queue by staff' } }, { session });
      for (const row of team.members(job)) if (row.status === 'pending') { row.status = 'expired'; row.respondedAt = new Date(); row.reason = 'Returned to assignment queue by staff'; }
      const before = job.status; job.status = 'pending_reassignment'; job.technicianId = null; job.assignmentId = null; job.reassignmentCount = (job.reassignmentCount || 0) + 1;
      job.recordStatusHistory?.({ fromStatus: before, toStatus: job.status, changedBy: actor._id, changedByName: actor.name || actor.email || 'Staff', reason: String(reason || 'Staff returned the technician team to the assignment queue').slice(0, 500) });
      await job.save({ session }); return { source: 'booking', job, response: true };
    }));
  }
  return { load, candidates, assign, respond, schedule, addNote, extend, releaseBooking };
}
async function publish(result, req) {
  const { source, job } = result, io = req.app.get('io') || global.io;
  if (result.duplicate) return;
  const reference = { referenceId: job._id, referenceModel: source === 'booking' ? 'BookingService' : 'Order' };
  for (const row of team.members(job)) {
    if (!result.response) {
      await require('./notify').createNotification({ type: 'assignment_new', ...reference,
        role: 'technician', userId: row.technicianId, title: 'Job team assigned', message: `${job.bookingReference || job.orderReference || 'Your job'}: please accept your ${team.isPrimary(job, row.technicianId) ? 'primary' : 'supporting'} assignment.`, link: source === 'booking' ? '/technician/assignments' : '/technician/orders', io });
    }
    io?.to(`tech:${row.technicianId}`).emit(source === 'booking' ? 'assignment:new' : 'order:assigned', { bookingId: source === 'booking' ? job._id : undefined, orderId: source === 'order' ? job._id : undefined });
  }
  io?.to('admin-room').emit(source === 'booking' ? 'booking:updated' : 'order:status-change', { bookingId: source === 'booking' ? job._id : undefined, orderId: source === 'order' ? job._id : undefined, status: job.status });
  const owner = source === 'booking' ? job.customerId : job.userId;
  if (result.response && result.decision === 'decline') await require('./notify').createNotification({ type: 'assignment_declined', ...reference,
    role: 'admin', title: 'Technician team needs review', message: `${job.bookingReference || job.orderReference}: a technician declined. Review the team before dispatch.`, link: source === 'booking' ? '/admin/appointments?tab=queue' : '/admin/appointments/orders', io });
  if (owner && !result.response) await require('./notify').createNotification({ type: 'assignment_update', ...reference,
    userId: owner, title: 'Your service team', message: `${job.bookingReference || job.orderReference}: ${team.members(job).map(row => row.name).join(', ')}.`, link: source === 'booking' ? '/book-history' : '/my-orders', io });
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
