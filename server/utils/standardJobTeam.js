'use strict';
const ref = value => String(value?._id || value || '');
const closed = new Set(['completed', 'repair_completed', 'cancelled', 'rejected', 'closed', 'expired', 'repair_declined']);
const progress = { 'on-the-way': 'en_route', arrived: 'on_site', 'in-progress': 'in_progress', ongoing: 'in_progress', inspection_in_progress: 'in_progress', repair_in_progress: 'in_progress', out_for_delivery: 'en_route', installing: 'in_progress' };
function members(job) { return Array.isArray(job?.technicianTeam) ? job.technicianTeam : []; }
function ids(job) { return job?.technicianId ? [...new Set([job.technicianId, ...members(job).map(member => member.technicianId)].filter(Boolean).map(ref))] : []; }
function member(job, technicianId) { return job?.technicianId ? members(job).find(row => ref(row.technicianId) === ref(technicianId)) : undefined; }
function isPrimary(job, technicianId) { return ref(job?.technicianId) === ref(technicianId); }
function scope(technicianId) { return { $or: [{ technicianId }, { 'technicianTeam.technicianId': technicianId, technicianId: { $ne: null } }] }; }
function normalize(input) {
  const lead = ref(input.technicianId).toLowerCase();
  const inputValues = input.technicianIds == null ? [lead] : input.technicianIds;
  if (!Array.isArray(inputValues) || inputValues.length < 1 || inputValues.length > 10 || inputValues.some(value => typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value))) throw failure('Choose one to ten registered technicians.', 400);
  const values = inputValues.map(value => value.toLowerCase());
  if (new Set(values).size !== values.length || !values.includes(lead)) throw failure('Choose a primary technician from the selected team, without duplicate members.', 400);
  return [lead, ...values.filter(value => value !== lead)];
}
function failure(message, status = 409, code = 'TEAM_REVIEW_REQUIRED') { return Object.assign(new Error(message), { status, code }); }
function readiness(job, now = new Date()) {
  if (!members(job).length) return { ready: true, blockers: [] };
  const blockers = members(job).filter(row => row.status !== 'accepted' || row.deadlineAt && !row.respondedAt && new Date(row.deadlineAt) < now)
    .map(row => `${row.name || 'Technician'}: ${row.status === 'accepted' ? 'response expired' : row.status || 'awaiting acceptance'}`);
  return { ready: blockers.length === 0, blockers };
}
function assertReady(job) { const state = readiness(job); if (!state.ready) throw failure('The whole team must accept before work can start. ' + state.blockers.join('; ')); }
function publicTeam(job) { return members(job).map(row => ({ technicianId: ref(row.technicianId), name: row.name, role: isPrimary(job, row.technicianId) ? 'primary' : 'support', status: row.status, respondedAt: row.respondedAt, deadlineAt: row.deadlineAt })); }
function fields(mongoose) {
  return { technicianTeamSchedule: String, technicianTeam: { type: [new mongoose.Schema({
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', required: true },
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
    name: { type: String, maxlength: 160 },
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired'], default: 'pending' },
    deadlineAt: Date, respondedAt: Date, reason: { type: String, maxlength: 500 },
    notes: { type: String, maxlength: 1000 },
    workNotes: [{ text: { type: String, required: true, maxlength: 1000 }, createdAt: { type: Date, default: Date.now } }],
  }, { _id: false })], default: undefined } };
}
// Expand only scheduling records, never financial or customer transaction rows.
function capacityRows(rows) { return rows.flatMap(row => ids(row).length ? ids(row).map(technicianId => ({ ...row, technicianId })) : [row]); }
function scheduleKey(source, job) {
  const { manilaDateKey } = require('./bookingDateTime');
  return source === 'booking' ? `${manilaDateKey(job.bookingDate)}|${job.startTime}|${job.endTime || job.serviceDurationMinutes || ''}`
    : `${manilaDateKey(job.delivery?.preferredDate)}|${job.timeSlot}|${job.continuation?.status === 'scheduled' ? job.continuation.remainingMinutes : ''}`;
}
async function prepareSchedule(source, job, slots = (...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args)) {
  if (!members(job).length || source === 'booking' && job.sourceOrderId || closed.has(job.status) || !job.technicianId || job.archivedAt) return;
  const key = scheduleKey(source, job);
  if (!job.technicianTeamSchedule || key === job.technicianTeamSchedule) return;
  if (!member(job, job.technicianId)) throw failure('Review the technician team before replacing its primary technician.');
  const { manilaDateKey, parseAppointmentTime } = require('./bookingDateTime');
  const date = manilaDateKey(source === 'booking' ? job.bookingDate : job.delivery?.preferredDate);
  const start = parseAppointmentTime(source === 'booking' ? job.startTime : job.timeSlot);
  const minutes = source === 'booking' ? Number(job.serviceDurationMinutes) || parseAppointmentTime(job.endTime) - start
    : job.continuation?.status === 'scheduled' ? Number(job.continuation.remainingMinutes) : Math.max(1, (job.items || []).reduce((sum, row) => sum + Number(row.quantity || 1), 0)) * 60;
  for (const technicianId of ids(job)) {
    const check = await slots({ date, technicianId, duration: String(Math.max(30, minutes || 60)), quantity: '1', travelTime: String(job.travelTime || job.routeDurationMin || 30) },
      { excludeBookingId: source === 'booking' ? job._id : job.bookingId, excludeOrderId: source === 'order' ? job._id : null });
    if (check.statusCode >= 400) throw failure('The team schedule could not be checked. Try again.', 503);
    if (!check.payload?.timeSlots?.some(slot => slot.available === true && parseAppointmentTime(slot.startTime) === start)) throw failure('A member of this technician team is unavailable at the new time. Choose a time available to the whole team.');
  }
  job.technicianTeam = members(job).map(row => ({ ...(row.toObject?.() || row), status: 'pending', deadlineAt: new Date(Date.now() + 30 * 60000), respondedAt: null, reason: '' }));
  job.technicianTeamSchedule = key;
  if (source === 'order') { job.status = 'technician_assigned'; job.technicianAcceptance = { status: 'pending', deadlineAt: job.technicianTeam[0].deadlineAt }; }
  else if (['confirmed', 'scheduled'].includes(job.status)) job.status = 'assigned';
}
function installHooks(schema, source) {
  schema.add(fields(require('mongoose')));
  schema.index({ 'technicianTeam.technicianId': 1, status: 1, [source === 'booking' ? 'bookingDate' : 'delivery.preferredDate']: 1 });
  schema.path('technicianTeam').validate(value => !value || value.length <= 10 && new Set(value.map(row => ref(row.technicianId))).size === value.length, 'A technician team must contain at most ten distinct technicians.');
  async function synchronize(document, session) {
    if (!document || !members(document).length || source === 'booking' && document.sourceOrderId) return;
    const Assignment = require('../models/Assignment');
    const terminal = closed.has(document.status) || !document.technicianId || document.archivedAt;
    const date = source === 'booking' ? document.bookingDate : document.delivery?.preferredDate;
    const time = source === 'booking' ? document.startTime : document.timeSlot;
    const key = scheduleKey(source, document);
    if (source === 'order') {
      if (document.bookingId) await require('../models/BookingService').updateOne({ _id: document.bookingId, sourceOrderId: document._id }, { $set: {
        technicianTeam: members(document), technicianTeamSchedule: key, technicianId: document.technicianId, technician: document.technician,
        bookingDate: date, startTime: time, endTime: require('./orderScheduleCapacity').orderCapacityEndTime(document), continuation: document.continuation,
        serviceDurationMinutes: document.continuation?.status === 'scheduled' ? document.continuation.remainingMinutes : Math.max(1, (document.items || []).reduce((sum, row) => sum + Number(row.quantity || 1), 0)) * 60,
        status: terminal ? ['completed', 'cancelled'].includes(document.status) ? document.status : 'pending_reassignment'
          : ({ technician_assigned: 'scheduled', technician_accepted: 'confirmed', out_for_delivery: 'on-the-way', arrived: 'arrived', installing: 'in-progress' }[document.status] || 'scheduled'),
      } }, session ? { session } : {});
      return;
    }
    for (const row of members(document)) {
      if (!row.assignmentId) continue;
      // Primary actions already save their own assignment. Updating it again
      // would invalidate the version/timestamp guard used by continuations.
      if (isPrimary(document, row.technicianId) && !terminal && row.status !== 'pending') continue;
      const set = { bookingDate: document.bookingDate, startTime: document.startTime, endTime: document.endTime, continuation: document.continuation };
      if (terminal) { set.status = ['completed', 'repair_completed'].includes(document.status) ? 'completed' : 'cancelled'; if (set.status === 'completed') set.completedAt = document.completedAt || new Date(); }
      else if (row.status === 'pending') { set.status = 'pending_acceptance'; set.acceptanceDeadline = row.deadlineAt; set.acceptedAt = null; }
      else if (!isPrimary(document, row.technicianId) && progress[document.status] && row.status === 'accepted') set.status = progress[document.status];
      await Assignment.updateOne({ _id: row.assignmentId, bookingId: document._id, technicianId: row.technicianId, status: { $nin: ['declined', 'expired', 'cancelled', 'completed'] } }, { $set: set }, session ? { session } : {});
    }
  }
  schema.pre('save', async function() { await prepareSchedule(source, this); });
  schema.pre('findOneAndUpdate', async function() {
    const update = this.getUpdate(), set = update?.$set || update;
    const changed = source === 'booking' ? ['bookingDate', 'startTime', 'endTime', 'serviceDurationMinutes'] : ['delivery', 'delivery.preferredDate', 'timeSlot'];
    if (!set || !changed.some(key => Object.prototype.hasOwnProperty.call(set, key))) return;
    const before = await this.model.findOne(this.getFilter()).session(this.getOptions().session || null).lean();
    if (!members(before).length || source === 'booking' && before.sourceOrderId) return;
    const proposed = { ...before, ...set, ...(set['delivery.preferredDate'] ? { delivery: { ...before.delivery, preferredDate: set['delivery.preferredDate'] } } : {}) };
    await prepareSchedule(source, proposed);
    if (proposed.technicianTeamSchedule !== before.technicianTeamSchedule) {
      Object.assign(set, { technicianTeam: proposed.technicianTeam, technicianTeamSchedule: proposed.technicianTeamSchedule, status: proposed.status,
        ...(source === 'order' ? { technicianAcceptance: proposed.technicianAcceptance } : {}) });
    }
  });
  schema.post('save', async function(document) { await synchronize(document, document.$session?.()); });
  schema.post('findOneAndUpdate', async function(result) {
    if (!result?._id || !members(result).length) return;
    const document = await this.model.findById(result._id).session(this.getOptions().session || null).lean();
    if (document) await synchronize(document, this.getOptions().session);
  });
}
module.exports = { ref, members, ids, member, isPrimary, scope, normalize, readiness, assertReady, publicTeam, fields, capacityRows, scheduleKey, prepareSchedule, installHooks, failure, closed };
