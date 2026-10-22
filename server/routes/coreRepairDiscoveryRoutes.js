'use strict';
const router = require('express').Router({ mergeParams: true });
const auth = require('../middleware/authenticate');
const discovery = require('../utils/coreRepairDiscovery');
router.use(auth.authenticate, auth.requireRole(['admin', 'secretary', 'technician']));
router.use((req, res, next) => req.user.role === 'secretary'
  ? require('../middleware/requirePermission').requirePermission(['GET', 'HEAD'].includes(req.method) ? 'appointments.view' : 'appointments.manage')(req, res, next) : next());
async function actor(req) {
  const result = { role: req.user.role, userId: req.user._id, name: req.user.name || req.user.email };
  if (result.role === 'technician') {
    result.technician = await require('../models/Technician').findOne({ user: req.user._id }).select('_id name').lean();
    if (!result.technician) throw Object.assign(Error('Technician profile not found.'), { status: 403 });
  }
  return result;
}
router.get('/', async (req, res, next) => {
  try { res.set('Cache-Control', 'private, no-store'); res.json(await discovery.createService().read(req.params.id, await actor(req))); }
  catch (error) { if (error.status) return res.status(error.status).json({ error:error.message, code:error.code }); next(error); }
});
router.post('/:action', async (req, res, next) => {
  try {
    if (req.params.action === 'queue-refund') {
      if (!await require('../middleware/requirePermission').hasPermission(req.user, 'payments.manage')) return res.status(403).json({ error: 'Payment management permission is required to queue a refund.' });
    }
    const result = await discovery.createService().act(req.params.id, await actor(req), req.params.action, req.body || {});
    if (!result.alreadyRecorded) {
      try {
      const booking = await require('../models/BookingService').findById(req.params.id).select('customerId technicianId');
      const io = req.app.get('io'), finding = result.findings.find(row => row.id === result.findingId);
      for (const recipient of [{ role: 'admin', link: `/admin/appointments?booking=${req.params.id}` },
        { role: 'secretary', link: `/secretary/appointments?booking=${req.params.id}` }, { userId: booking.customerId, link: '/book-history' }]) {
        await require('../utils/notify').createNotification({ type: 'system', title: req.params.action === 'report' ? 'Repair found during service' : 'Core service finding reviewed',
          message: req.params.action === 'report'
            ? `${result.reference}: a repair finding was recorded. ${finding?.coreDisposition === 'on_hold' ? 'Affected core work is paused for Operations review.' : 'The original service can continue.'} No repair charge is added without the customer quotation decision.`
            : `${result.reference}: Operations reviewed the affected core work. Check the service details and any payment review.`,
          referenceId: req.params.id, referenceModel: 'BookingService', ...recipient, io }).catch(() => {});
      }
      io?.to('admin-room').emit('booking:updated', { bookingId: req.params.id });
      io?.to(`customer:${booking.customerId}`).emit('booking:updated', { bookingId: req.params.id });
      io?.to(`tech:${booking.technicianId}`).emit('booking:updated', { bookingId: req.params.id });
      await require('../utils/audit').logEvent({ actor: req.user._id, target: req.params.id, action: `booking.repair-finding.${req.params.action}`,
        module: 'bookings', req, details: { findingId: result.findingId || req.body.findingId, noAdditionalInspectionFee: true } }).catch(() => {});
      } catch (error) { console.warn('Repair finding saved; notification refresh needs a retry:', error.message); }
    }
    res.json({ success: true, ...result });
  } catch (error) { if (error.status) return res.status(error.status).json({ error:error.message, code:error.code }); next(error); }
});
module.exports = router;
