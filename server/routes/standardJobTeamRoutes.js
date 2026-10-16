'use strict';
const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/authenticate');
const team = require('../utils/standardJobTeam');
const service = () => require('../utils/standardJobTeamService').createService();
router.use(authenticate);
const staff = requireRole(['admin', 'secretary']);
router.use('/:source/:id', (req, res, next) => {
  if (req.user.role !== 'secretary') return next();
  if (!['booking', 'order'].includes(req.params.source)) return res.status(400).json({ error: 'Invalid job source.' });
  return require('../middleware/requirePermission').requirePermission(`${req.params.source === 'booking' ? 'appointments' : 'orders'}.${req.method === 'GET' ? 'view' : 'manage'}`)(req, res, next);
});
async function allowed(req, job) {
  if (['admin', 'secretary'].includes(req.user.role)) return true;
  if (req.user.role === 'customer') return team.ref(job.customerId || job.userId) === team.ref(req.user._id);
  if (req.user.role === 'technician') {
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).select('_id').lean();
    return tech && team.ids(job).includes(team.ref(tech._id));
  }
  return false;
}
router.get('/mine', requireRole('technician'), async (req, res, next) => {
  try {
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).select('_id').lean();
    if (!tech) return res.status(404).json({ error: 'Technician profile not found.' });
    const orders = await require('../models/Order').find({ 'technicianTeam.technicianId': tech._id, technicianId: { $nin: [tech._id, null] }, archivedAt: null, isProject: { $ne: true }, status: { $nin: ['completed', 'cancelled'] } })
      .select('_id orderReference customer.name delivery status technicianId technicianTeam timeSlot continuation').sort({ 'delivery.preferredDate': 1 }).limit(100).lean();
    res.json({ jobs: orders.map(job => ({ id: job._id, source: 'order', reference: job.orderReference, customer: job.customer?.name,
      address: job.delivery?.address, date: job.delivery?.preferredDate, time: job.timeSlot, status: job.status, team: team.publicTeam(job), myStatus: team.member(job, tech._id)?.status, myNotes: team.member(job, tech._id)?.workNotes, continuation: job.continuation?.status })) });
  } catch (error) { next(error); }
});
router.get('/:source/:id/candidates', staff, async (req, res, next) => {
  try { const manager = service(), job = await manager.load(req.params.source, req.params.id); res.json({ ...(await manager.candidates(req.params.source, job, req.query)), team: team.publicTeam(job), staffing: require('../utils/assignmentStaffing').staffingFor(req.params.source, job) }); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});
router.get('/:source/:id', async (req, res, next) => {
  try {
    const job = await service().load(req.params.source, req.params.id);
    if (!await allowed(req, job)) return res.status(403).json({ error: 'You cannot view this job team.' });
    res.json({ team: team.publicTeam(job), readiness: team.readiness(job) });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});
router.post('/:source/:id', staff, (req, res) => require('../utils/standardJobTeamService').assignmentResponse(req.params.source, req, res));
router.post('/:source/:id/respond', requireRole('technician'), async (req, res, next) => {
  try {
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).select('_id').lean();
    if (!tech) return res.status(404).json({ error: 'Technician profile not found.' });
    const result = await service().respond(req.params.source, req.params.id, tech._id, req.body.decision, req.body.reason);
    await require('../utils/standardJobTeamService').publish({ source: req.params.source, ...result }, req).catch(() => {});
    res.json({ success: true, team: team.publicTeam(result.job), readiness: team.readiness(result.job) });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});
router.post('/:source/:id/notes', requireRole('technician'), async (req, res, next) => {
  try {
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).select('_id').lean();
    if (!tech) return res.status(404).json({ error: 'Technician profile not found.' });
    const result = await service().addNote(req.params.source, req.params.id, tech._id, req.body.text);
    await require('../utils/standardJobTeamService').publish({ source: req.params.source, ...result }, req).catch(() => {});
    res.json({ success: true });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});
module.exports = router;
