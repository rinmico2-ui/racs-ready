'use strict';

const { manilaDateKey, manilaDateTime, parseAppointmentTime } = require('./bookingDateTime');
const { orderDispatchWindow } = require('./orderAttention');
const team = require('./standardJobTeam');

function fail(message, code, status = 409) {
  return Object.assign(new Error(message), { status, code });
}

async function departureCapacity(order, options = {}) {
  const now = options.now || new Date();
  const window = orderDispatchWindow(order, now);
  if (!window.deadline || window.expired) throw fail('The departure window has ended. Ask operations to confirm a new customer schedule.', 'ORDER_SCHEDULE_PASSED');
  if (order.status !== 'technician_accepted' || !order.technicianId || !team.readiness(order, now).ready) {
    throw fail('Every team member must accept before departure.', 'TEAM_REVIEW_REQUIRED');
  }
  const date = manilaDateKey(order.delivery?.preferredDate);
  const midnight = manilaDateTime(date, 0);
  const start = midnight ? Math.ceil((new Date(now) - midnight) / 60000) : NaN;
  if (!Number.isInteger(start) || start < 0 || start >= 1440) {
    throw fail('Departure must be on the confirmed delivery date. Ask operations to review the schedule.', 'ORDER_DISPATCH_DATE_REQUIRED');
  }
  const units = (order.items || []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
  const remaining = Number(order.continuation?.remainingMinutes);
  const work = order.continuation?.status === 'scheduled' && remaining >= 15 && remaining <= 480
    ? remaining : order.fulfillmentType === 'delivery_installation' ? Math.max(1, units) * 60 : 60;
  const travel = order.routeDurationMin != null && Number.isFinite(Number(order.routeDurationMin)) ? Math.max(0, Number(order.routeDurationMin)) : 30;
  const buffer = options.bufferMinutes ?? require('./bookingPolicy').getBufferMinutesSync();
  const previousEnd = require('./orderScheduleCapacity').orderCapacityInterval(order, buffer).endTime;
  const duration = Math.max(work, previousEnd - start - travel - buffer);
  const slots = options.slots || ((...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args));
  for (const technicianId of team.ids(order)) {
    const result = await slots({ date, technicianId, duration: String(duration), quantity: '1', travelTime: String(travel) }, {
      excludeOrderId: order._id, excludeBookingId: order.bookingId, existingAppointment: true, assignmentStartMinutes: start,
    });
    if (result.statusCode >= 500) throw fail('The departure schedule could not be checked. Try again.', 'ORDER_DISPATCH_CHECK_FAILED', 503);
    if (!(result.payload?.timeSlots || []).some(slot => slot.available === true && parseAppointmentTime(slot.startTime) === start)) {
      throw fail('The full delivery visit no longer fits the team schedule or working hours. Ask operations to review the schedule.', 'ORDER_DISPATCH_CAPACITY_UNAVAILABLE');
    }
  }
  return { scheduleKey: team.scheduleKey('order', order), startMinutes: start, endMinutes: start + duration + travel + buffer };
}

async function commitOrderDeparture({ order, actor, note, kit, syncLinked }, options = {}) {
  const mongoose = options.mongoose || require('mongoose');
  const Order = options.Order || require('../models/Order');
  const { withOperationLock, bookingCapacityLockKey } = require('./operationLock');
  const lock = options.lock || withOperationLock;
  const clock = options.clock || (() => new Date());
  if (require('./bookingSubmissionWrite').isKnownStandalone(mongoose.connection)) {
    throw fail('Departure requires the configured MongoDB replica set.', 'ORDER_DATABASE_SETUP_REQUIRED', 503);
  }
  const expectedSchedule = team.scheduleKey('order', order);
  const expectedCrew = team.ids(order).sort().join(',');
  const expectedPrimary = team.ref(order.technicianId);
  const result = await lock(bookingCapacityLockKey(order.delivery?.preferredDate), async () => {
    const session = await mongoose.startSession();
    try {
      let saved;
      await session.withTransaction(async () => {
        const current = await Order.findById(order._id).session(session);
        if (!current || current.status !== 'technician_accepted' || current.archivedAt || current.isProject
          || team.scheduleKey('order', current) !== expectedSchedule || team.ids(current).sort().join(',') !== expectedCrew
          || team.ref(current.technicianId) !== expectedPrimary) {
          throw fail('The order assignment changed. Refresh the order before departure.', 'ORDER_DISPATCH_CHANGED');
        }
        if (current.continuation?.status === 'pending') throw fail('Operations must schedule the next visit before departure.', 'CONTINUATION_PENDING');
        const currentKit = current.fulfillmentType === 'delivery_installation' && kit?._id
          ? await (options.DailyKit || require('../models/DailyKit')).findById(kit._id).session(session).lean() : null;
        const readiness = require('./orderPreparation').orderDepartureReadiness(current, currentKit);
        if (!readiness.ready) throw fail(readiness.blockers.join(' '), 'ORDER_PREPARATION_REQUIRED');
        current.assignmentCapacity = await departureCapacity(current, { ...options, now: clock() });
        const departedAt = clock();
        if (orderDispatchWindow(current, departedAt).expired) throw fail('The departure window has ended. Ask operations to confirm a new customer schedule.', 'ORDER_SCHEDULE_PASSED');
        current.status = 'out_for_delivery';
        current.enRouteAt = departedAt;
        current.statusHistory ||= [];
        current.statusHistory.push({ status: 'out_for_delivery', timestamp: departedAt, note: note || '' });
        await current.save({ session });
        await syncLinked(current, session);
        saved = current;
      });
      return saved;
    } finally { await session.endSession(); }
  }, { leaseMs: 120000 });
  const audit = options.audit || require('./audit').logEvent;
  await audit({ actor: actor?._id, action: 'order.status_change', entityId: result._id, entityType: 'Order',
    actorRole: actor?.role, actorName: actor?.name || actor?.email || 'System',
    details: { toStatus: 'out_for_delivery', note: note || '', orderReference: result.orderReference, assignmentCapacity: result.assignmentCapacity } });
  return result;
}

module.exports = { departureCapacity, commitOrderDeparture };
