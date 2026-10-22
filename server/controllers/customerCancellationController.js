'use strict';
const policy = require('../utils/customerCancellationPolicy');
const service = require('../utils/customerCancellationService').createService();
function failure(res, error) {
  if (!error.status) console.error('Customer cancellation request failed:', error.name);
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update this cancellation request. Please try again.', ...(error.code ? { code: error.code } : {}) });
}
async function publish(req, result, customerSubmitted) {
  if (result.duplicate) return;
  const booking = result.booking, reference = booking.bookingReference || String(booking._id).slice(-8).toUpperCase();
  const io = req.app?.get('io'), { createNotification } = require('../utils/notify');
  const tasks = [];
  if (customerSubmitted && !result.cancelled) tasks.push(Promise.resolve().then(() => createNotification({ type: 'booking_cancellation_requested', title: 'Customer requested cancellation',
    message: `${reference}: ${policy.REASONS[booking.customerCancellation.reasonCode]}. Review the customer request before assigning technicians.`, role: 'admin',
    referenceId: booking._id, referenceModel: 'BookingService', priority: 'high',
    link: `/admin/operations/resolution-center?issue=customer_cancellation&focus=booking:${booking._id}&open=resolve`, io })));
  if (!customerSubmitted || result.cancelled) tasks.push(Promise.resolve().then(() => createNotification({ type: 'booking_cancellation_decided', title: result.cancelled ? 'Booking cancelled' : 'Cancellation request updated',
    message: `${reference}: ${booking.customerCancellation.decisionNote || 'Staff started reviewing your cancellation request.'}`,
    userId: booking.customerId, referenceId: booking._id, referenceModel: 'BookingService', link: '/book-history', io })));
  if (result.cancelled) {
    tasks.push(Promise.resolve().then(() => require('../utils/equipmentAssignmentLifecycle').releaseReservedEquipment({ filter: { bookingId: booking._id }, actorId: req.user._id,
      reason: booking.cancellationReason, moduleName: 'customer cancellation' })));
  }
  tasks.push(Promise.resolve().then(() => require('../utils/technicianWorkSync').publishBookingWorkUpdate({ io, booking, reason: 'customer-cancellation' })));
  tasks.push(Promise.resolve().then(() => require('../utils/audit').logEvent({ actor: req.user._id, target: booking._id, action: customerSubmitted ? 'booking.cancellation_requested' : 'booking.cancellation_reviewed',
    module: 'bookings', req, details: { bookingId: booking._id, requestId: booking.customerCancellation.requestId, revision: booking.customerCancellation.revision, state: booking.customerCancellation.status } })));
  const results = await Promise.allSettled(tasks);
  results.forEach((value, index) => { if (value.status === 'rejected') console.warn('Cancellation follow-up failed', { task: index, error: value.reason?.name }); });
}
async function read(req, res) {
  try { res.set('Cache-Control', 'private, no-store'); return res.json(await service.read(req.params.id, req.user)); }
  catch (error) { return failure(res, error); }
}
async function submit(req, res) {
  try {
    const result = await service.submit(req.params.id, req.user, req.body);
    await publish(req, result, true).catch(error => console.warn('Cancellation request follow-up failed:', error.name));
    return res.status(result.duplicate ? 200 : 201).json({ success: true, cancelled: result.cancelled, duplicate: result.duplicate,
      request: policy.publicRequest(result.booking.customerCancellation), message: result.cancelled ? 'Your booking has been cancelled.' : 'Your cancellation request was sent to staff. Technician assignment is paused while it is reviewed.' });
  } catch (error) { return failure(res, error); }
}
async function decide(req, res) {
  try {
    const result = await service.decide(req.params.id, req.user, req.body);
    await publish(req, result, false).catch(error => console.warn('Cancellation decision follow-up failed:', error.name));
    return res.json({ success: true, duplicate: result.duplicate, cancelled: result.cancelled, request: policy.publicRequest(result.booking.customerCancellation),
      message: result.cancelled ? 'Booking cancelled. Any approved refund is pending payment processing.' : 'The customer request was updated.' });
  } catch (error) { return failure(res, error); }
}
module.exports = { read, submit, decide };
