'use strict';
const team = require('./standardJobTeam');
module.exports = async function standardTeamMiddleware(req, res, next) {
  try {
    const id = req.params.id;
    if (!require('mongoose').isValidObjectId(id)) return next();
    const assignment = await require('../models/Assignment').findById(id).lean();
    if (!assignment || assignment.serviceType === 'project') return next();
    const job = await require('../models/BookingService').findById(assignment.bookingId).lean();
    if (!team.members(job).length) return next();
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).lean();
    const entry = tech && team.member(job, tech._id);
    if (!entry || team.ref(entry.assignmentId) !== team.ref(assignment._id)) return res.status(403).json({ error: 'This team assignment is no longer yours.' });
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const action = req.path.replace(/^\//, '');
    if (['accept', 'decline'].includes(action)) {
      const result = await require('./standardJobTeamService').createService().respond('booking', job._id, tech._id, action, req.body.reason);
      const current = await require('../models/Assignment').findById(assignment._id).lean();
      await require('./standardJobTeamService').publish({ source: 'booking', ...result }, req).catch(() => {});
      return res.json({ success: true, message: action === 'accept' ? 'Your team assignment is accepted.' : 'Operations has been notified of your decline.', assignment: current, booking: result.job });
    }
    if (action === 'note' || action === 'return') return next();
    if (!team.isPrimary(job, tech._id)) return res.status(403).json({ error: 'The primary technician manages job status, shared tools, payment and completion. You can add work notes to this team assignment.', code: 'PRIMARY_TECHNICIAN_REQUIRED' });
    if (action === 'status' && ['en_route', 'on_site', 'in_progress'].includes(req.body.status) || /collect-payment|proof-of-completion/.test(action)) team.assertReady(job);
    next();
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code }); next(error); }
};
module.exports.booking = async function bookingTeamGuard(req, res, next) {
  try {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !require('mongoose').isValidObjectId(req.params.id)) return next();
    const job = await require('../models/BookingService').findById(req.params.id).select('technicianId technicianTeam isProject').lean();
    if (!team.members(job).length || job.isProject) return next();
    const tech = await require('../models/Technician').findOne({ user: req.user._id }).select('_id').lean();
    if (!tech || !team.isPrimary(job, tech._id)) return res.status(403).json({ error: 'The primary technician manages this job. Supporting technicians can add assignment notes.', code: 'PRIMARY_TECHNICIAN_REQUIRED' });
    if (!/cancel|decline|note/.test(req.path)) team.assertReady(job);
    next();
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code }); next(error); }
};
