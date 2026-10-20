'use strict';
const team = require('./standardJobTeam');
const { bookingCapacityLockKey, withOperationLock } = require('./operationLock');
const { manilaDateKey } = require('./bookingDateTime');
const ACTIVE = ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'waiting_for_customer', 'in_progress'];
const REPORTABLE = ['accepted', 'en_route', 'on_site'];
const STARTED = ['in_progress', 'inspection_in_progress', 'repair_in_progress', 'payment_pending'];
const REASONS = { emergency: 'Emergency', vehicle_breakdown: 'Vehicle breakdown', personal: 'Personal emergency',
  weather: 'Weather conditions', overlapping_job: 'Overlapping job conflict', other: 'Other' };
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function reason(input = {}) {
  if (!Object.hasOwn(REASONS, input.reason)) throw fail('Choose a reason for the emergency report.', 400);
  const details = input.details ?? input.customReason ?? '';
  if (typeof details !== 'string' || details.trim().length > 500 || input.reason === 'other' && details.trim().length < 5) {
    throw fail('Enter up to 500 characters of details; Other requires at least 5 characters.', 400);
  }
  return REASONS[input.reason] + (details.trim() ? `: ${details.trim()}` : '');
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Assignment: require('../models/Assignment'),
    write: require('./atomicWorkflowChanges').atomicWorkflowChanges, lock: withOperationLock, now: () => new Date(), ...overrides };
  async function report(id, technician, input, actorId) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid assignment reference.', 400);
    const explanation = reason(input);
    const initial = await deps.Assignment.findOne({ _id: id, technicianId: technician._id }).lean();
    if (!initial) throw fail('Assignment not found.', 404);
    return deps.lock(bookingCapacityLockKey(manilaDateKey(initial.bookingDate)), () => deps.lock(`job-team:booking:${team.ref(initial.bookingId)}`, async () => {
      const assignment = await deps.Assignment.findOne({ _id: id, technicianId: technician._id }).lean();
      const booking = assignment && await deps.Booking.findById(assignment.bookingId).lean();
      if (!assignment || !booking) throw fail('Assignment not found.', 404);
      if (booking.archivedAt || booking.isProject || booking.sourceOrderId || assignment.serviceType === 'project') throw fail('Use the owning order or project workflow for this visit.');
      const latest = booking.staffingEmergencies?.at(-1);
      if (booking.status === 'pending_reassignment' && !booking.technicianId && latest?.team?.some(row => team.ref(row.assignmentId) === team.ref(id)
        && team.ref(row.technicianId) === team.ref(technician._id))) return { booking, incident: latest, duplicate: true };
      if (team.closed.has(booking.status) || !REPORTABLE.includes(assignment.status)) throw fail('Report an emergency after accepting and before starting work. For work already underway, ask the primary technician to request Continue on another visit.');
      const entry = team.member(booking, technician._id);
      if (team.members(booking).length ? !entry || team.ref(entry.assignmentId) !== team.ref(id)
        : team.ref(booking.technicianId) !== team.ref(technician._id) || team.ref(booking.assignmentId) !== team.ref(id)) {
        throw fail('This visit is no longer assigned to you.', 403);
      }
      const currentIds = new Set([booking.assignmentId, ...team.members(booking).map(row => row.assignmentId)].filter(Boolean).map(team.ref));
      const assignments = (await deps.Assignment.find({ bookingId: booking._id, status: { $in: ACTIVE } }).lean())
        .filter(row => currentIds.has(team.ref(row._id)));
      if (!assignments.some(row => team.ref(row._id) === team.ref(id))) throw fail('The current assignment changed. Refresh your work list.');
      if (['in-progress', 'in_progress', 'ongoing', ...STARTED].includes(booking.status)
        || assignments.some(row => row.status === 'in_progress' || row.startedAt)
        || (booking.services || []).some(row => STARTED.includes(row.status))) {
        throw fail('Work has already started. Ask the primary technician to use Continue on another visit so progress is preserved.');
      }
      if ((booking.staffingEmergencies || []).length >= 50) throw fail('This booking needs direct Operations review before another emergency report.');
      const now = deps.now();
      const incident = { _id: new deps.mongoose.Types.ObjectId(), reportedAt: now, reportedBy: technician._id,
        reporterName: technician.name, reporterRole: team.isPrimary(booking, technician._id) ? 'primary' : 'support',
        assignmentId: assignment._id, reason: explanation, previousStatus: booking.status,
        team: assignments.map(row => ({ technicianId: row.technicianId, assignmentId: row._id,
          name: team.members(booking).find(member => team.ref(member.technicianId) === team.ref(row.technicianId))?.name
            || (team.ref(row.technicianId) === team.ref(technician._id) ? technician.name : booking.technician?.name || 'Technician'),
          role: team.ref(row.technicianId) === team.ref(booking.technicianId) ? 'primary' : 'support',
          previousStatus: row.status, equipmentCheckedOut: Boolean(row.equipmentCheckedOut) })) };
      const note = `${technician.name} reported ${explanation}. All ${assignments.length} current assignment(s) were released for admin team review.`;
      const services = (booking.services || []).map(row => {
        // Closed services and all per-appliance inspection/quotation evidence
        // belong to the recorded work. Only unstarted staffing links change.
        if (team.closed.has(row.status) || !team.serviceReadyForVisit(booking, row)) return row;
        const repairVisit = row.type === 'repair' && team.repairVisit(booking, row);
        return { ...row, technicianId: null, technicianName: '', assignmentId: null,
          status: row.type === 'repair' ? repairVisit ? 'ready_for_repair' : 'inspection_pending' : 'awaiting_assignment',
          statusHistory: [...row.statusHistory || [], { status: row.type === 'repair' ? repairVisit ? 'ready_for_repair' : 'inspection_pending' : 'awaiting_assignment',
            changedAt: now, changedBy: actorId, changedByName: technician.name, reason: note }] };
      });
      const changes = [{ Model: deps.Booking, before: booking,
        set: { status: 'pending_reassignment', technicianId: null, technician: null, assignmentId: null, technicianTeam: [], services,
          staffingEmergencies: [...booking.staffingEmergencies || [], incident],
          cancellationReason: note, reassignmentCount: Number(booking.reassignmentCount || 0) + 1,
          notes: [booking.notes, note].filter(Boolean).join('\n'),
          'servicePreparation.confirmed': false, 'repairPreparation.confirmed': false, 'technicianAssistant.verifiedByTechnician': false,
          cancellationHistory: [...booking.cancellationHistory || [], { technicianId: technician._id, technicianName: technician.name,
            action: 'emergency_reported', reason: explanation, timestamp: now }],
          statusHistory: [...booking.statusHistory || [], { fromStatus: booking.status, toStatus: 'pending_reassignment', changedBy: actorId,
            changedByModel: 'User', changedByName: technician.name, reason: note, timestamp: now }] },
        unset: { technicianTeamSchedule: '' } },
      ...assignments.map(row => ({ Model: deps.Assignment, before: row, set: { status: 'cancelled', cancelledAt: now,
        cancellationReason: team.ref(row._id) === team.ref(id) ? explanation : `Visit paused after ${technician.name}'s emergency report. Admin is reviewing the team.`,
        notes: [...row.notes || [], { text: note, by: actorId, byName: technician.name, createdAt: now }] } }))];
      const saved = await deps.write(changes, deps.mongoose);
      return { booking: saved[0], incident, duplicate: false };
    }));
  }
  return { report };
}
async function publish(result, req, overrides = {}) {
  if (result.duplicate) return;
  const deps = { Technician: require('../models/Technician'), notify: require('./notify').createNotification,
    publishWork: require('./technicianWorkSync').publishBookingWorkUpdate,
    syncEquipment: result => require('./bookingEmergencyEquipment').releaseDemand(result, req.user?._id), ...overrides };
  const { booking, incident } = result;
  const io = req.app.get('io');
  const reference = { referenceId: booking._id, referenceModel: 'BookingService', io };
  const label = booking.bookingReference || 'Service booking';
  const deliveries = [deps.notify({ ...reference, role: 'admin', type: 'assignment_update', title: 'Technician emergency — team review needed',
    message: `${label}: ${incident.reporterName} (${incident.reporterRole === 'support' ? 'supporting' : 'primary'}) reported ${incident.reason}. The visit is paused; review all ${incident.team.length} technicians.`,
    priority: 'high', link: `/admin/operations/resolution-center?issue=technician_issue&focus=booking:${booking._id}` })];
  deliveries.push((async () => {
    const technicians = await deps.Technician.find({ _id: { $in: incident.team.map(row => row.technicianId) } }).select('user').lean();
    const teamResults = await Promise.allSettled(technicians.filter(technician => technician.user).map(technician => deps.notify({ ...reference, userId: technician.user, type: 'assignment_update',
      title: 'Visit paused — wait for admin', message: `${label}: an emergency was reported. Your current assignment has been released. Wait for a new assignment from admin before travelling or starting work.`,
      priority: 'high', link: '/technician/assignments' })));
    const failure = teamResults.find(row => row.status === 'rejected');
    if (failure) throw failure.reason;
  })());
  if (booking.customerId) deliveries.push(deps.notify({ ...reference, userId: booking.customerId, type: 'assignment_update',
    title: 'Your service visit needs an update', message: `${label}: an unexpected technician issue interrupted the visit. Our team will arrange a replacement team or contact you about a new schedule. Your booking and recorded payments remain on file.`,
    link: '/book-history' }));
  deliveries.push(deps.publishWork({ io, booking, technicianIds: incident.team.map(row => row.technicianId), reason: 'technician_emergency' }));
  deliveries.push(deps.syncEquipment(result));
  const results = await Promise.allSettled(deliveries);
  const failure = results.find(row => row.status === 'rejected');
  if (failure) throw failure.reason;
}
module.exports = { createService, publish, reason };
