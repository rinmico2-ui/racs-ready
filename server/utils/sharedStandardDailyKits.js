'use strict';

const team = require('./standardJobTeam');
const { dayBounds, ACTIVE_ASSIGNMENT_STATUSES } = require('./dailyKitService');
const { ACTIVE_INSTALLATION_ORDER_STATUSES } = require('./orderPreparation');
const { manilaDateKey } = require('./bookingDateTime');

// Shared kits are a projection of the primary's existing kit. This module
// never generates, checks, confirms, issues or transfers another person's kit.
function createService(deps = {}) {
  const Booking = deps.Booking || require('../models/BookingService');
  const Order = deps.Order || require('../models/Order');
  const Assignment = deps.Assignment || require('../models/Assignment');
  const Kit = deps.Kit || require('../models/DailyKit');
  async function read(technicianId, date) {
    const { start, end } = dayBounds(date);
    const dateKey = manilaDateKey(start);
    const scope = { isProject: { $ne: true }, archivedAt: null, technicianId: { $ne: null },
      'continuation.status': { $ne: 'pending' },
      technicianTeam: { $elemMatch: { technicianId, status: 'accepted' } } };
    const [assignments, orders] = await Promise.all([
      Assignment.find({ technicianId, status: { $in: ACTIVE_ASSIGNMENT_STATUSES },
        bookingDate: { $gte: start, $lt: end } }).select('_id bookingId technicianId serviceItemId serviceType status bookingDate startTime').lean(),
      Order.find({ ...scope, fulfillmentType: 'delivery_installation', status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES },
        'delivery.preferredDate': { $gte: start, $lt: end } })
        .select('_id technicianId technicianTeam orderReference timeSlot delivery.preferredDate').lean(),
    ]);
    const bookings = assignments.length ? await Booking.find({ ...scope, _id: { $in: assignments.map(row => row.bookingId) },
      sourceOrderId: null, bookingDate: { $gte: start, $lt: end },
      status: { $nin: [...team.closed, 'pending_reassignment', 'reschedule-required', 'no-show'] } })
      .select('_id technicianId technicianTeam assignmentId bookingDate startTime status services sourceOrderId isProject archivedAt bookingReference serviceName repairSchedule').lean() : [];
    const groups = new Map();
    function add(source, job) {
      const member = team.member(job, technicianId);
      if (!member || member.status !== 'accepted' || team.isPrimary(job, technicianId) || !job.technicianId) return;
      const owner = team.ref(job.technicianId);
      const group = groups.get(owner) || { owner, primaryName: team.member(job, job.technicianId)?.name || 'Primary technician', jobs: [] };
      group.jobs.push({ source, id: team.ref(job._id), reference: job.bookingReference || job.orderReference || team.ref(job._id).slice(-6).toUpperCase(),
        serviceName: source === 'order' ? 'Delivery & Installation' : job.serviceName || 'Service appointment' });
      groups.set(owner, group);
    }
    for (const booking of bookings) {
      const current = assignments.some(row => team.ref(row.bookingId) === team.ref(booking._id)
        && require('./technicianWorkSync').assignmentWorkDecision(row, booking).current);
      if (current) add('booking', booking);
    }
    orders.forEach(order => add('order', order));
    if (!groups.size) return [];
    const kits = await Kit.find({ technicianId: { $in: [...groups.keys()] }, workDate: { $gte: start, $lt: end } })
      .select('technicianId workDate status confirmedAt hasDelta items deltaItems').lean();
    return [...groups.values()].map(group => {
      const kit = kits.find(row => team.ref(row.technicianId) === group.owner);
      const belongs = item => group.jobs.some(job => (job.source === 'booking'
        ? [...(item.bookingIds || []), ...(item.issuedBookingIds || [])]
        : [...(item.orderIds || []), ...(item.issuedOrderIds || [])]).some(id => team.ref(id) === job.id));
      const present = item => ({ name: item.name, category: item.category, quantity: item.quantity, unit: item.unit || 'pcs',
        preparedChecked: Boolean(item.preparedChecked), checkoutStatus: item.checkoutStatus,
        resolutionStatus: item.resolution?.status || null });
      return { readOnly: true, primaryName: group.primaryName, workDate: dateKey, jobs: group.jobs,
        status: kit?.status || 'pending', confirmedAt: kit?.confirmedAt || null, hasDelta: Boolean(kit?.hasDelta),
        items: (kit?.items || []).filter(belongs).map(present), deltaItems: (kit?.deltaItems || []).filter(belongs).map(present) };
    });
  }
  return { read };
}

module.exports = { createService };
