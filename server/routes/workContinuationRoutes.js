"use strict";
const router = require('express').Router();
const auth = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/requirePermission');
const Technician = require('../models/Technician');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const service = require('../utils/workContinuation').createService();
router.use(auth.authenticate);
async function staffPermission(req, res, next) {
  if (!['admin', 'secretary'].includes(req.user.role)) return res.status(403).json({ error: 'Staff access required.' });
  const source = req.params.source || req.query.source;
  if (!['booking', 'order'].includes(source)) return res.status(400).json({ error: 'Choose bookings or orders.' });
  if (req.user.role === 'admin') return next();
  return requirePermission(`${source === 'booking' ? 'appointments' : 'orders'}.${req.method === 'GET' ? 'view' : 'manage'}`)(req, res, next);
}
async function notify(req, source, job, scheduled) {
  const { createNotification } = require('../utils/notify');
  const userId = source === 'booking' ? job.customerId : job.userId;
  const reference = job.bookingReference || job.orderReference || String(job._id).slice(-8);
  const date = scheduled ? require('../utils/bookingDateTime').manilaDateKey(job.continuation.scheduledDate) : null;
  const message = scheduled ? `The next visit for ${reference} is scheduled on ${date} at ${job.continuation.startTime} PHT. Your existing payments and completed work remain recorded.` : `${reference} needs another visit. Reason: ${job.continuation.reason}`;
  const io = req.app.get('io');
  if (userId) await createNotification({ type: 'work_continuation', userId, role: 'customer', title: scheduled ? 'Your next visit is scheduled' : 'Another visit is being arranged', message, referenceId: job._id, referenceModel: source === 'booking' ? 'BookingService' : 'Order', link: source === 'booking' ? '/book-history' : `/my-orders/${job._id}`, io }).catch(() => {});
  if (!scheduled) await createNotification({ type: 'work_continuation_requested', role: 'admin', title: 'Unfinished work needs scheduling', message, referenceId: job._id, referenceModel: source === 'booking' ? 'BookingService' : 'Order', link: source === 'booking' ? '/admin/appointments?tab=active' : '/admin/appointments/orders?tab=active', priority: 'high', io }).catch(() => {});
  if (scheduled) {
    const technician = await Technician.findById(job.technicianId).select('user').lean().catch(() => null);
    if (technician?.user) await createNotification({ type: 'work_continuation_scheduled', userId: technician.user, role: 'technician', title: 'Continuation visit scheduled', message, link: source === 'booking' ? '/technician/assignments' : '/technician/orders', io }).catch(() => {});
  }
  io?.to('admin-room').emit('work:continuation', { source, id: job._id });
  if (userId) io?.to(`customer:${userId}`).emit(source === 'booking' ? 'booking:updated' : 'order:status-updated', { bookingId: job._id, orderId: job._id });
}
const errorResponse = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update this visit. Refresh and try again.' });

router.get('/pending', staffPermission, async (req, res) => {
  try {
    const source = req.query.source, Model = source === 'booking' ? Booking : Order;
    const jobs = await Model.find({ 'continuation.status': 'pending', archivedAt: null }).sort({ 'continuation.requestedAt': 1 }).limit(100)
      .select('_id bookingReference orderReference customer customerId userId technicianId continuation service.name items.modelLine').lean();
    res.set('Cache-Control', 'private, no-store').json({ jobs, source });
  } catch (error) { errorResponse(res, error); }
});
router.get('/technicians', staffPermission, async (req, res) => {
  try {
    const technicians = await Technician.find({ active: { $ne: false }, archivedAt: null }).select('_id name user').populate('user', 'active blocked role').lean();
    res.set('Cache-Control', 'private, no-store').json({ technicians: technicians.filter(tech => tech.user?.role === 'technician' && tech.user.active !== false && !tech.user.blocked).map(tech => ({ _id: tech._id, name: tech.name })) });
  } catch (error) { errorResponse(res, error); }
});
router.post('/:source/:id/request', auth.requireRole('technician'), async (req, res) => {
  try {
    const technician = await Technician.findOne({ user: req.user._id }).select('_id').lean();
    if (!technician) return res.status(404).json({ error: 'Technician profile not found.' });
    const result = await service.request(req.params.source, req.params.id, technician._id, req.body || {});
    if (!result.duplicate) await notify(req, req.params.source, result.job, false);
    res.json({ success: true, message: 'This visit is closed. Operations will confirm the next schedule.', continuation: result.job.continuation });
  } catch (error) { errorResponse(res, error); }
});
router.post('/:source/:id/availability', staffPermission, async (req, res) => {
  try {
    const result = await service.availability(req.params.source, req.params.id, req.body || {});
    res.json({ date: result.date, technicianId: result.technicianId, timeSlots: result.timeSlots });
  } catch (error) { errorResponse(res, error); }
});
router.post('/:source/:id/schedule', staffPermission, async (req, res) => {
  try {
    const result = await service.schedule(req.params.source, req.params.id, req.user._id, req.body || {});
    await notify(req, req.params.source, result.job, true);
    res.json({ success: true, message: 'Continuation scheduled. Customer and technician notifications were requested.', job: result.job });
  } catch (error) { errorResponse(res, error); }
});
module.exports = router;
