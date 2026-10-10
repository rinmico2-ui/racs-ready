const { bookingWorkload, resolutionWorkload, validateResolutionSchedule, syncResolutionProject, commitResolutionSchedule } = require('./resolutionScheduling');

function orderSchedulingSource(order, linkedBooking) {
  const units = Math.max(1, (order.items || []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0));
  const installation = order.fulfillmentType === 'delivery_installation';
  const linked = linkedBooking || (order.bookingId?._id ? order.bookingId : null);
  const totalMinutes = installation
    ? Number(linked?.serviceDurationMinutes) || Number(linked?.projectScheduling?.estimatedTotalHours || order.projectScheduling?.estimatedTotalHours) * 60 || units * 60
    : 60;
  return {
    _id: linked?._id || order.bookingId || order._id,
    customerId: order.userId, customer: order.customer, sourceOrderId: order._id,
    quantity: installation ? units : 1,
    isProject: installation && (order.isProject === true || linked?.isProject === true),
    serviceDurationMinutes: totalMinutes,
    projectScheduling: linked?.projectScheduling || order.projectScheduling,
    serviceType: 'core', service: { name: 'Air Conditioner Installation', description: `Installation for ${order.orderReference || 'product order'}` },
    servicePrice: Number(order.installationFee) || 0,
    travelTime: Number(order.routeDurationMin) || 30,
    location: order.delivery ? { address: order.delivery.address, coordinates: order.delivery.coordinates } : undefined,
    services: installation ? (order.items || []).map(item => ({
      name: `${item.brand || 'Air Conditioner'} ${item.modelLine || ''} Installation`.trim(),
      type: 'core', quantity: Math.max(1, Number(item.quantity) || 1), duration: totalMinutes / units,
      brand: item.brand || '', airconTypeName: item.modelLine || 'Air Conditioner',
      hpDescription: item.capacity ? `${item.capacity} ${item.capacityUnit || 'HP'}` : '',
      unitPrice: Number(order.installationFee || 0) / units, status: 'pending',
    })) : [],
  };
}

function orderWorkload(order, thresholdHours = 8) {
  const workload = bookingWorkload(orderSchedulingSource(order), thresholdHours);
  if (order.fulfillmentType !== 'delivery_installation') workload.isProject = false;
  return workload;
}

async function loadOrderScheduling(order) {
  const linkedBooking = order.fulfillmentType === 'delivery_installation' && order.bookingId
    ? await require('../models/BookingService').findById(order.bookingId?._id || order.bookingId) : null;
  const source = orderSchedulingSource(order, linkedBooking);
  const workload = order.fulfillmentType === 'delivery_installation'
    ? await resolutionWorkload(source) : bookingWorkload(source, Infinity);
  if (order.fulfillmentType !== 'delivery_installation') workload.isProject = false;
  return { source, workload, linkedBooking };
}

async function saveOrderProjectWindow(order, input, user) {
  const { source, workload, linkedBooking } = await loadOrderScheduling(order);
  if (!workload.isProject) throw Object.assign(new Error('This order requires an available delivery date and time.'), { status: 400 });
  const schedule = await validateResolutionSchedule(source, { ...input, date: input.scheduledDate });
  require('./orderRescheduleInvitation').finishOrderRescheduleInvitation(order, user);
  const BookingService = require('../models/BookingService');
  // The order owns payment collection; its planning mirror is not a second
  // cash-on-delivery reservation requiring another downpayment.
  const booking = linkedBooking || new BookingService({ ...source, _id: undefined, bookingDate: schedule.dateObj,
    paymentMethod: 'other', paymentStatus: order.paymentStatus || 'pending' });
  booking.isProject = true;
  booking.quantity = workload.totalUnits;
  booking.serviceDurationMinutes = workload.totalEstimatedMinutes;
  booking.projectScheduling = schedule.projectScheduling;
  booking.bookingDate = schedule.dateObj;
  booking.preferredDate = schedule.dateObj;
  booking.startTime = undefined;
  booking.endTime = undefined;
  booking.selectedTimeLabel = undefined;
  booking.preferredTime = undefined;
  booking.status = 'pending_project_scheduling';
  booking.technicianId = null;
  booking.technician = null;
  booking.assignmentId = null;
  booking.autoReschedulePending = false;
  for (const service of booking.services || []) {
    service.technicianId = undefined;
    service.technicianName = undefined;
    service.status = 'pending';
    service.schedule = { date: schedule.dateObj, durationMinutes: Number(service.duration) || 60, kind: 'service' };
  }
  order.isProject = true;
  order.projectScheduling = schedule.projectScheduling;
  order.bookingId = booking._id;
  order.delivery.preferredDate = schedule.dateObj;
  order.timeSlot = null;
  order.technicianId = null;
  order.technician = {};
  order.technicianAcceptance = { status: 'pending' };
  order.rescheduleRequest = {
    requested: true, requestedDate: schedule.date, requestedTime: '', requestedEndDate: schedule.endDate,
    reason: input.reason || 'Project window updated from Resolution Center', requestedBy: user._id,
    requestedAt: new Date(), status: 'approved', processedBy: user._id, processedAt: new Date(),
  };
  order.pushStatus(order.status === 'pending_payment' ? 'pending_payment' : 'preparing_unit',
    `Preferred project window: ${schedule.date} through ${schedule.endDate}. Operations will confirm the final schedule. ${input.reason || ''}`,
    { actor: user._id, actorRole: user.role, actorName: user.name || user.email || 'Admin' });
  await commitResolutionSchedule(schedule, async session => {
    await require('../models/Assignment').updateMany({ bookingId: booking._id, status: { $nin: ['completed', 'cancelled', 'expired'] } },
      { $set: { status: 'cancelled' } }, { session });
    await booking.save({ session });
    await syncResolutionProject(booking, schedule, session);
    await order.save({ session });
  });
  return schedule;
}

module.exports = { orderSchedulingSource, orderWorkload, loadOrderScheduling, saveOrderProjectWindow };
