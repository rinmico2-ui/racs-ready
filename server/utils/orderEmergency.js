'use strict';
const team = require('./standardJobTeam');
const { manilaDateKey } = require('./bookingDateTime');
const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function schema(mongoose) {
  return new mongoose.Schema({ reportedAt: { type: Date, required: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician', required: true },
    reporterName: String, reporterRole: { type: String, enum: ['primary', 'support'] },
    reason: { type: String, required: true, maxlength: 650 }, previousStatus: String, previousPreparation: mongoose.Schema.Types.Mixed,
    team: [{ _id: false, technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'Technician' },
      name: String, role: { type: String, enum: ['primary', 'support'] }, previousStatus: String }],
  });
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Order: require('../models/Order'), Booking: require('../models/BookingService'),
    Assignment: require('../models/Assignment'), lock: withOperationLock,
    write: require('./atomicWorkflowChanges').atomicWorkflowChanges, now: () => new Date(), ...overrides };
  async function report(id, technician, input) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid order reference.', 400);
    const explanation = require('./bookingEmergency').reason(input);
    const initial = await deps.Order.findById(id).lean();
    if (!initial) throw fail('Order not found.', 404);
    return deps.lock(bookingCapacityLockKey(manilaDateKey(initial.delivery?.preferredDate)), () => deps.lock(`job-team:order:${id}`, async () => {
      const order = await deps.Order.findById(id).lean();
      if (!order) throw fail('Order not found.', 404);
      const latest = order.staffingEmergencies?.at(-1);
      if (order.status === 'technician_declined' && !order.technicianId && latest?.team?.some(row => team.ref(row.technicianId) === team.ref(technician._id))) return { order, incident: latest, duplicate: true };
      if (!team.ids(order).includes(team.ref(technician._id))) throw fail('This order is no longer assigned to you.', 403);
      const member = team.member(order, technician._id);
      if (order.isProject || order.archivedAt || order.fulfillmentType === 'customer_pickup' || order.continuation?.status === 'pending') throw fail('Use the owning project or continuation workflow for this visit.');
      if (!['technician_assigned', 'technician_accepted', 'out_for_delivery', 'arrived'].includes(order.status)
        || (member ? member.status !== 'accepted' : order.technicianAcceptance?.status !== 'accepted')) throw fail('Report an emergency after accepting and before installation starts. For work underway, use Continue on another visit.');
      if ((order.staffingEmergencies || []).length >= 50) throw fail('Operations must review this order before another emergency report.');
      const now = deps.now(), crew = team.members(order).length ? team.members(order) : [{ technicianId: order.technicianId, name: order.technician?.name || technician.name, status: 'accepted' }];
      const incident = { _id: new deps.mongoose.Types.ObjectId(), reportedAt: now, reportedBy: technician._id,
        reporterName: technician.name, reporterRole: team.isPrimary(order, technician._id) ? 'primary' : 'support',
        reason: explanation, previousStatus: order.status, previousPreparation: order.preparation, team: crew.map(row => ({ technicianId: row.technicianId, name: row.name,
          role: team.ref(row.technicianId) === team.ref(order.technicianId) ? 'primary' : 'support', previousStatus: row.status })) };
      const note = `${technician.name} reported ${explanation}. The visit is paused; admin must contact the customer and arrange the replacement team. Issued tools and aircon units remain with their recorded holders.`;
      const changes = [{ Model: deps.Order, before: order, set: { status: 'technician_declined', technicianId: null,
        technician: {}, technicianTeam: [], staffingEmergencies: [...order.staffingEmergencies || [], incident],
        technicianAcceptance: { status: 'declined', respondedAt: now, declineReason: explanation },
        'preparation.dispatch': { status: 'pending', readyAt: null, readyBy: null,
          note: 'Emergency recovery: staff must confirm the units and handover to the replacement technician before departure.' },
        ...(order.fulfillmentType === 'delivery_installation' ? { 'preparation.installation.status': 'pending', 'preparation.installation.confirmedAt': null, 'preparation.installation.dailyKitId': null } : {}),
        statusHistory: [...order.statusHistory || [], { status: 'technician_declined', timestamp: now, note }] }, unset: { technicianTeamSchedule: '' } }];
      if (order.bookingId) {
        const booking = await deps.Booking.findById(order.bookingId).lean();
        if (!booking || team.ref(booking.sourceOrderId) !== team.ref(order._id)) throw fail('The linked installation needs Operations review.');
        const assignments = await deps.Assignment.find({ bookingId: booking._id, status: { $nin: ['completed', 'cancelled', 'expired', 'declined'] } }).lean();
        if (['in-progress', 'in_progress', 'installing', 'completed'].includes(booking.status) || assignments.some(row => row.startedAt || row.status === 'in_progress')) throw fail('Installation has started. Use Continue on another visit.');
        changes.push({ Model: deps.Booking, before: booking, set: { status: 'pending_reassignment', technicianId: null,
          technician: null, assignmentId: null, technicianTeam: [], 'servicePreparation.confirmed': false,
          statusHistory: [...booking.statusHistory || [], { fromStatus: booking.status, toStatus: 'pending_reassignment', timestamp: now, reason: note }] },
        unset: { technicianTeamSchedule: '' } });
        changes.push(...assignments.map(row => ({ Model: deps.Assignment, before: row, set: { status: 'cancelled', cancelledAt: now, cancellationReason: note } })));
      }
      const saved = await deps.write(changes, deps.mongoose);
      return { order: saved[0], incident, duplicate: false };
    }));
  }
  return { report };
}
async function publish(result, req, overrides = {}) {
  if (result.duplicate) return;
  const deps = { Technician: require('../models/Technician'), notify: require('./notify').createNotification,
    syncEquipment: result => require('./bookingEmergencyEquipment').releaseDemand({ booking: result.order, incident: result.incident }, req.user?._id, {}, 'order'), ...overrides };
  const { order, incident } = result, io = req.app.get('io'), label = order.orderReference || 'Order';
  const common = { type: 'assignment_update', referenceId: order._id, referenceModel: 'Order', io };
  const deliveries = [deps.notify({ ...common, role: 'admin', priority: 'high', title: 'Order technician emergency',
    message: `${label}: ${incident.reporterName} reported ${incident.reason}. Contact the customer and arrange a replacement team. Review tools and units with the previous team.`,
    link: `/admin/operations/resolution-center?issue=emergency&focus=order:${order._id}&open=resolve` }),
  deps.notify({ ...common, userId: order.userId, title: 'Your order visit needs an update',
    message: `${label}: an unexpected technician issue interrupted the visit. Our team will contact you before arranging a later visit or another schedule. Your order and payments remain on file.`, link: '/my-orders' }),
  deps.syncEquipment(result), (async () => {
    const technicians = await deps.Technician.find({ _id: { $in: incident.team.map(row => row.technicianId) } }).select('user').lean();
    await Promise.allSettled(technicians.filter(row => row.user).map(row => deps.notify({ ...common, userId: row.user,
      title: 'Order visit paused', message: `${label}: the current team has been released after an emergency report. Wait for admin’s replacement assignment. Keep issued tools and units under recorded custody until a return or handover is confirmed.`, link: '/technician/orders' })));
  })()];
  const payload = { orderId: order._id, status: order.status, emergencyReported: true };
  io?.to('admin-room').emit('order:status-change', payload);
  for (const row of incident.team) io?.to(`tech:${row.technicianId}`).emit('order:status-change', payload);
  if (order.userId) io?.to(`user:${order.userId}`).emit('order:status-change', payload);
  const results = await Promise.allSettled(deliveries);
  if (results.some(row => row.status === 'rejected')) console.warn('[order-emergency] Report saved; a notification or preparation refresh needs retry.');
}
module.exports = { schema, createService, publish };
