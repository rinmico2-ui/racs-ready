const Booking = require('../models/BookingService');
const { rows } = require('./repairUnitWorkflow');
module.exports = async function repairUnitLegacyGuard(req, res, next) {
  try {
    if (!['POST', 'PATCH'].includes(req.method)) return next();
    const assignmentMatch = req.path.match(/^\/assignments\/([a-f\d]{24})\/(status|proof-of-completion)$/i);
    if (assignmentMatch && (assignmentMatch[2] === 'proof-of-completion' || req.body.status === 'completed')) {
      const assignment = await require('../models/Assignment').findById(assignmentMatch[1]).select('bookingId');
      const parent = assignment?.bookingId ? await Booking.findById(assignment.bookingId) : null;
      if (parent?.repairUnitTracking && !parent.isProject && rows(parent).some(row => !['completed', 'declined'].includes(row.unit.repairReview?.state))) return res.status(409).json({ error: 'Complete each approved appliance repair before closing this job.' });
    }
    const match = req.path.match(/^\/(?:appointments\/)?([a-f\d]{24})\/(complete-inspection|submit-diagnosis|submit-quotation|approve-quotation|decline-quotation|onsite-approve|technician-schedule-later|schedule-later|repair-today-choice|start-repair|complete-repair|local-purchase-repair|local-purchase-receipt|local-purchase\/customer-verify|service-items\/[^/]+\/(?:quotation|status))$/i);
    if (!match) return next();
    const booking = await Booking.findById(match[1]);
    if (!booking?.repairUnitTracking || booking.isProject) return next();
    const units = rows(booking), action = match[2];
    if (action.endsWith('/status') && booking.services.id(action.split('/')[1])?.type !== 'repair') return next();
    if (['complete-inspection', 'submit-diagnosis', 'submit-quotation', 'approve-quotation', 'decline-quotation'].includes(action) || action.endsWith('/quotation')) return res.status(409).json({ error: 'Use Appliance repairs to record findings and decide on each appliance quotation.', code: 'REPAIR_UNIT_WORKFLOW_REQUIRED' });
    const settled = units.length && units.every(row => ['approved', 'declined', 'completed'].includes(row.unit.repairReview?.state));
    if (!settled && ['onsite-approve', 'technician-schedule-later', 'schedule-later', 'repair-today-choice', 'start-repair', 'complete-repair'].includes(action)) return res.status(409).json({ error: 'The customer must decide on each appliance quote before repair work can proceed.' });
    if (['onsite-approve', 'technician-schedule-later', 'schedule-later', 'repair-today-choice', 'start-repair', 'local-purchase-repair', 'local-purchase-receipt', 'local-purchase/customer-verify'].includes(action)) return res.status(409).json({ error: 'Open the repair work plan to check approved parts, the team schedule and nearby purchases.', code: 'REPAIR_WORK_PLAN_REQUIRED' });
    if (action.endsWith('/status') && ['repair_in_progress', 'in_progress', 'in-progress'].includes(req.body.status) && booking.repairExecution?.status !== 'in_progress') return res.status(409).json({ error: 'Start the approved repair from the repair work plan first.', code: 'REPAIR_WORK_PLAN_REQUIRED' });
    if ((action === 'complete-repair' || (action.endsWith('/status') && req.body.status === 'completed')) && units.some(row => !['completed', 'declined'].includes(row.unit.repairReview?.state))) return res.status(409).json({ error: 'Record the repairs and tests for each approved appliance in Appliance repairs before completing the booking.' });
    next();
  } catch (error) { next(error); }
};
