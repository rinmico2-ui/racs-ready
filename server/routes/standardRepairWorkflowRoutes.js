'use strict';
const router = require('express').Router({ mergeParams: true });
const Technician = require('../models/Technician');
const visit = require('../utils/standardRepairVisit');
async function technician(req) {
  const tech = await Technician.findOne({ user: req.user._id }).select('_id name user').lean();
  if (!tech) throw Object.assign(Error('Technician profile not found.'), { status: 404 });
  return tech;
}
router.get('/', async (req, res, next) => {
  try { const tech = await technician(req); res.json(visit.present(await visit.createService().read(req.params.id, tech._id, req.query))); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code }); next(error); }
});
router.post('/:action', async (req, res, next) => {
  try {
    const tech = await technician(req);
    const result = await visit.createService().act(req.params.id, tech, req.user._id, req.params.action, req.body || {});
    const io = req.app.get('io');
    await require('../utils/notify').createNotification({ role: 'admin', type: 'system', title: 'Repair visit updated', message: result.message,
      referenceId: result.bookingId, referenceModel: 'BookingService', link: req.params.action === 'defer' ? '/admin/appointments/repair-scheduling' : '/admin/appointments?tab=active', io }).catch(() => {});
    await require('../utils/notify').createNotification({ userId: result.customerId, type: 'system', title: 'Repair visit update', message: result.message,
      referenceId: result.bookingId, referenceModel: 'BookingService', link: '/book-history', io }).catch(() => {});
    io?.to('admin-room').emit('booking:updated', { bookingId: result.bookingId });
    io?.to(`customer:${result.customerId}`).emit('booking:updated', { bookingId: result.bookingId });
    await require('../utils/audit').logEvent({ actor: req.user._id, target: result.bookingId, action: `repair.visit.${req.params.action}`, module: 'bookings', req }).catch(() => {});
    res.json({ success: true, message: result.message });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code }); next(error); }
});
module.exports = router;
