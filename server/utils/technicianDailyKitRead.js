'use strict';

const { dayBounds, ACTIVE_ASSIGNMENT_STATUSES } = require('./dailyKitService');
const { ACTIVE_INSTALLATION_ORDER_STATUSES } = require('./orderPreparation');
const { assignmentWorkDecision, BOOKING_WORK_SELECT } = require('./technicianWorkSync');
const team = require('./standardJobTeam');
const sameIds = (left = [], right = []) => {
  const a = new Set((left || []).map(team.ref)), b = new Set((right || []).map(team.ref));
  return a.size === b.size && [...a].every(id => b.has(id));
};

function createService(deps = {}) {
  const Kit = deps.Kit || require('../models/DailyKit');
  const Assignment = deps.Assignment || require('../models/Assignment');
  const Order = deps.Order || require('../models/Order');
  const DailyAssignment = deps.DailyAssignment || require('../models/DailyAssignment');
  const shared = deps.shared || require('./sharedStandardDailyKits').createService();
  const refresh = deps.refresh || require('./dailyKitRefresh').requestDailyKitRefresh;
  const now = deps.now || (() => new Date());

  async function read(technicianId, date = now(), measure = (_stage, work) => work()) {
    const { start, end } = dayBounds(date);
    const [kit, assignments, orders, dailyAssignments, sharedKits] = await measure('kitRead', () => Promise.all([
      Kit.findOne({ technicianId, workDate: { $gte: start, $lt: end } }).sort({ workDate: 1 }).lean(),
      Assignment.find({ technicianId, crewRole: { $ne: 'support' }, 'continuation.status': { $ne: 'pending' },
        status: { $in: ACTIVE_ASSIGNMENT_STATUSES }, bookingDate: { $gte: start, $lt: end } })
        .select('_id bookingId technicianId serviceItemId serviceType status bookingDate startTime serviceName crewRole')
        .populate('bookingId', BOOKING_WORK_SELECT + ' bookingReference serviceName serviceType technicianAssistant servicePreparation continuation')
        .sort({ startTime: 1 }).lean(),
      Order.find({ ...team.scope(technicianId), isProject: { $ne: true }, 'continuation.status': { $ne: 'pending' },
        fulfillmentType: 'delivery_installation', status: { $in: ACTIVE_INSTALLATION_ORDER_STATUSES },
        'delivery.preferredDate': { $gte: start, $lt: end } })
        .select('_id technicianId technicianTeam orderReference timeSlot status customer.name').lean(),
      DailyAssignment.find({ technicianId, planningOnly: { $ne: true }, status: { $in: ['pending', 'in_progress'] },
        date: { $gte: start, $lt: end } })
        .select('_id projectId workOrderId startTime status')
        .populate('projectId', 'projectNumber customer.name status').populate('workOrderId', 'workOrderNumber title status')
        .sort({ startTime: 1 }).lean(),
      shared.read(technicianId, start),
    ]));
    const current = assignments.filter(row => row.bookingId
      && row.bookingId.continuation?.status !== 'pending'
      && (!row.bookingId.technicianId || team.isPrimary(row.bookingId, technicianId))
      && assignmentWorkDecision(row, row.bookingId).current);
    const installations = orders.filter(row => team.isPrimary(row, technicianId));
    const projects = dailyAssignments.filter(row => row.projectId && row.workOrderId
      && !['cancelled', 'completed', 'closed'].includes(row.projectId.status)
      && !['cancelled', 'completed', 'declined', 'rescheduled'].includes(row.workOrderId.status));
    const jobDetails = current.map(row => ({ assignmentId: row._id, bookingId: row.bookingId._id,
      serviceName: row.serviceName || row.bookingId.serviceName || 'Service', serviceType: row.serviceType || row.bookingId.serviceType || 'core',
      startTime: row.startTime || '', status: row.status }));
    installations.forEach(row => jobDetails.push({ orderId: row._id, serviceName: `Delivery & Installation · ${row.orderReference || team.ref(row._id).slice(-6).toUpperCase()}`,
      serviceType: 'order_installation', startTime: row.timeSlot || '', status: row.status, customerName: row.customer?.name || 'Customer' }));
    projects.forEach(row => jobDetails.push({ projectId: row.projectId._id, workOrderId: row.workOrderId._id, dailyAssignmentId: row._id,
      serviceName: `Project · ${row.workOrderId.workOrderNumber || row.workOrderId.title || row.projectId.projectNumber || 'Work Order'}`,
      serviceType: 'project', startTime: row.startTime || '', status: row.status, customerName: row.projectId.customer?.name || 'Project customer' }));
    const coverageChanged = !!kit && (!sameIds(kit.assignmentIds, current.map(row => row._id))
      || !sameIds(kit.orderIds, installations.map(row => row._id)) || !sameIds(kit.dailyAssignmentIds, projects.map(row => row._id)));
    const preparationPending = !kit && jobDetails.length > 0 || coverageChanged;
    const refreshedAt = Math.max(...[kit?.automaticSyncedAt, kit?.updatedAt, kit?.createdAt].map(value => new Date(value || 0).getTime()).filter(Number.isFinite));
    const needsRefresh = preparationPending || kit && now().getTime() - refreshedAt > 60000;
    const refreshPending = Boolean(needsRefresh && refresh(technicianId, start) !== false);
    const aiContingencySuggestions = [];
    for (const row of current) {
      const booking = row.bookingId, assistant = booking.technicianAssistant;
      if (!assistant?.verifiedByTechnician || !['repair', 'mixed'].includes(row.serviceType || booking.serviceType)) continue;
      const confirmed = new Set((booking.servicePreparation?.aiContingencyParts || []).map(part => String(part.name || '').toLowerCase()));
      for (const part of assistant.possibleParts || []) {
        const name = typeof part === 'string' ? part : part?.name;
        if (name) aiContingencySuggestions.push({ name, serviceName: part?.serviceName || row.serviceName || 'Repair',
          bookingId: team.ref(booking._id), assignmentId: team.ref(row._id), alreadyConfirmed: confirmed.has(name.toLowerCase()) });
      }
    }
    return { success: true, kit: kit || { workDate: start, status: 'draft', items: [], deltaItems: [], hasDelta: false,
      assignmentIds: [], orderIds: [], dailyAssignmentIds: [] }, jobDetails, sharedKits, aiContingencySuggestions,
      preparationPending: Boolean(preparationPending), refreshPending };
  }
  return { read };
}

module.exports = { createService, sameIds };
