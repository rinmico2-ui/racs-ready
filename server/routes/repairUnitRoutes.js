'use strict';
const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/authenticate');
const Project = require('../models/Project');
const Booking = require('../models/BookingService');
const Technician = require('../models/Technician');
const Tool = require('../models/Tool');
const WorkOrder = require('../models/WorkOrder');
const DailyAssignment = require('../models/DailyAssignment');
const flow = require('../utils/repairUnitWorkflow');
const { getRepairLaborFees } = require('../utils/repairLaborPricing');
const { createNotification } = require('../utils/notify');
const router = express.Router();
router.use(auth.authenticate);

async function load(req, session) {
  if (!['booking', 'project'].includes(req.params.scope) || !mongoose.isValidObjectId(req.params.id)) flow.fail('Invalid repair reference.', 400);
  const query = req.params.scope === 'project' ? Project.findById(req.params.id) : Booking.findById(req.params.id);
  if (session) query.session(session);
  let document = await query;
  if (!document) flow.fail('Repair request not found.', 404);
  let booking = document;
  if (req.params.scope === 'project') {
    const linked = Booking.findById(document.bookingId); if (session) linked.session(session); booking = await linked;
  } else if (document.isProject) {
    const linked = Project.findOne({ bookingId: document._id, archivedAt: null }); if (session) linked.session(session);
    document = await linked;
    if (!document) flow.fail('This project has no linked repair plan. Ask staff to check it.');
  }
  if (!booking || String(document.customerId) !== String(booking.customerId)) flow.fail('Repair ownership could not be confirmed.');
  if (!flow.hasRepair(booking)) flow.fail('This booking has no repair appliances.', 400);
  if (document.unitGroups && !document.unitGroups.length) document.unitGroups = flow.buildUnitGroups(booking);
  if (!document.unitGroups && !document.services.length) document.services = flow.buildUnitGroups(booking).map(group => ({ ...group, name: group.serviceName, type: 'repair' }));
  flow.ensureUnits(document);
  let technician = null;
  if (req.user.role === 'customer') {
    if (String(booking.customerId) !== String(req.user._id)) flow.fail('This repair request is not yours.', 403);
  } else if (req.user.role === 'technician') {
    const techQuery = Technician.findOne({ user: req.user._id }); if (session) techQuery.session(session); technician = await techQuery;
    const allowed = technician && (document.unitGroups
      ? String(document.leadTechnicianId) === String(technician._id) || document.assignedTechnicians.some(member => String(member._id) === String(technician._id))
      : String(document.technicianId) === String(technician._id) || document.services.some(item => String(item.technicianId) === String(technician._id)));
    if (!allowed) flow.fail('This repair work is not assigned to you.', 403);
  } else if (!['admin', 'secretary'].includes(req.user.role)) flow.fail('Access denied.', 403);
  return { document, booking, technician };
}
function assertActive(document, booking) {
  if (document.archivedAt || ['cancelled', 'completed', 'closed', 'repair_completed', 'under_warranty'].includes(document.status) || ['cancelled', 'completed', 'repair_completed'].includes(booking.status)) flow.fail('This repair request is already closed.');
}
function view(document, req, technician) {
  return {
    scope: document.unitGroups ? 'project' : 'booking', id: document._id, version: document.__v || 0,
    phase: document.projectPhase, reviewStatus: document.quotationReview?.status,
    submitted: document.unitGroups ? !!document.inspectionReport?.submittedAt && document.projectPhase === 'quotation_review' : !!document.inspection?.completedAt,
    needsSetup: !!document.unitGroups && !document.repairUnitTracking && document.projectPhase === 'execution' && !document.completedUnits,
    closed: !!document.archivedAt || ['cancelled', 'completed', 'closed', 'repair_completed', 'under_warranty'].includes(document.status),
    role: req.user.role, canInspect: req.user.role === 'technician' && (!document.unitGroups || String(document.leadTechnicianId) === String(technician?._id)),
    units: flow.rows(document).map(({ key, group, unit }) => ({ key, label: unit.label, brand: group.brand, model: group.model, problemDescription: unit.problemDescription,
      inspection: unit.inspection, diagnosis: unit.diagnosis, quotation: unit.quotation, review: unit.repairReview, status: unit.status, completionNotes: unit.completionNotes, completedAt: unit.completedAt })),
  };
}
router.get('/:scope/:id', async (req, res, next) => {
  try {
    const { document, technician } = await load(req);
    const result = view(document, req, technician);
    if (result.canInspect) {
      result.laborFees = await getRepairLaborFees();
      result.parts = await Tool.find({ $and: [Tool.merchandiseFilter()], active: { $ne: false } }).select('_id itemName sellingPrice costPrice').limit(500).lean();
    }
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:scope/:id/:action', async (req, res, next) => {
  let session;
  try {
    if (!['prepare', 'inspect', 'submit', 'review', 'decide', 'complete'].includes(req.params.action)) flow.fail('Unknown repair action.', 404);
    session = await mongoose.startSession();
    let state;
    await session.withTransaction(async () => {
      state = await load(req, session);
      const { document, booking, technician } = state;
      assertActive(document, booking);
      if (!Number.isInteger(req.body.version) || req.body.version !== (document.__v || 0)) flow.fail('This repair record changed. Refresh it before saving.');
      const action = req.params.action;
      if (['inspect', 'submit', 'complete'].includes(action)) {
        if (req.user.role !== 'technician' || (document.unitGroups && String(document.leadTechnicianId) !== String(technician?._id))) flow.fail('Only the assigned technician or project lead can record this action.', 403);
        if (document.unitGroups && !['arrived', 'completed'].includes(document.assessmentVisit?.status)) flow.fail('Record arrival for the inspection visit first.');
        if (!document.unitGroups && !['arrived', 'in-progress', 'inspection_in_progress', 'inspection_completed', 'awaiting_approval', 'repair_approved', 'ready_for_repair', 'repair_in_progress'].includes(booking.status)) flow.fail('Arrive at the customer site before recording repair work.');
      }
      if (action === 'prepare') {
        if (!document.unitGroups || document.repairUnitTracking || document.completedUnits || (!['admin', 'secretary'].includes(req.user.role) && String(document.leadTechnicianId) !== String(technician?._id))) flow.fail('This repair plan cannot be restarted.');
        if (await WorkOrder.exists({ projectId: document._id, $or: [{ completedUnitCount: { $gt: 0 } }, { status: { $in: ['in_progress', 'partially_completed', 'awaiting_review', 'completed'] } }] }).session(session)) flow.fail('Some work has already started. Ask staff to review this existing project.');
        document.repairQuoteHistory.push({ recordedAt: new Date(), recordedBy: req.user._id, quotation: document.quotationReview?.toObject?.() || document.quotationReview });
        document.projectPhase = 'assessment'; document.quotationReview = { status: 'rejected', totalAmount: 0, items: [] };
      } else if (action === 'inspect') {
        if (document.unitGroups && document.projectPhase !== 'assessment') flow.fail('Staff must return this inspection for changes first.');
        if (!Array.isArray(req.body.parts) || req.body.parts.length > 50) flow.fail('Provide up to 50 parts.', 400);
        const unitRow = flow.rows(document).find(row => row.key === req.body.key);
        if (!document.unitGroups && unitRow?.group.technicianId && String(unitRow.group.technicianId) !== String(technician._id)) flow.fail('This appliance is assigned to another technician.', 403);
        const ids = req.body.parts.map(part => part.toolId).filter(Boolean);
        if (ids.some(id => !mongoose.isValidObjectId(id))) flow.fail('Invalid repair part.', 400);
        const catalog = await Tool.find({ _id: { $in: ids }, $and: [Tool.merchandiseFilter()] }).select('_id itemName sellingPrice costPrice').session(session).lean();
        flow.inspect(document, req.body.key, req.body, { technicianId: technician._id, catalog, laborFees: await getRepairLaborFees() });
      } else if (action === 'submit') {
        flow.submitInspection(document);
        if (document.unitGroups) document.assessmentVisit.status = 'completed';
        else document.inspection = { findings: 'Findings recorded for each appliance.', completedAt: new Date(), technicianId: technician._id };
        if (!document.unitGroups) document.status = booking.serviceType === 'repair' ? 'awaiting_approval' : document.status;
      } else if (action === 'review') {
        if (!['admin', 'secretary'].includes(req.user.role)) flow.fail('Only staff can review quotations.', 403);
        if (document.quotationReview?.status !== 'pending' || (document.unitGroups && (!document.inspectionReport?.submittedAt || document.projectPhase !== 'quotation_review'))) flow.fail('Submit the inspections before staff review.');
        flow.review(document, req.body.action, req.user._id, req.body.notes);
      } else if (action === 'decide') {
        if (req.user.role !== 'customer') flow.fail('Only the customer can approve or decline these repairs.', 403);
        const settled = flow.decide(document, req.body.decisions, req.user._id);
        if (settled && document.unitGroups) {
          document.repair.serviceType = 'repair';
          const approvedRecords = flow.rows(document).filter(row => row.unit.repairReview.state === 'approved');
          document.repair.quotation = {
            parts: approvedRecords.flatMap(row => row.unit.quotation.parts.map(part => part.toObject?.() || part)),
            laborCost: approvedRecords.reduce((sum, row) => sum + row.unit.quotation.laborCost, 0), laborCategory: 'standard',
            totalCost: approvedRecords.reduce((sum, row) => sum + row.unit.quotation.totalCost, 0), approvedAt: new Date(),
          };
          const declined = new Set(flow.rows(document).filter(row => row.unit.repairReview.state === 'declined').map(row => row.key));
          const orders = await WorkOrder.find({ projectId: document._id, status: { $ne: 'cancelled' } }).session(session);
          for (const order of orders) {
            const priorCount = order.unitCount;
            if (!order.units.length && (order.completedUnitCount > 0 || ['in_progress', 'partially_completed', 'awaiting_review', 'completed'].includes(order.status))) flow.fail('An existing work order has started without appliance records. Staff must review its unit plan before applying these choices.');
            if (!order.units.length) order.activity.push({ action: 'superseded_by_appliance_plan', actorId: req.user._id, actorName: 'Customer', details: { reason: 'Unstarted quantity-only work order replaced by the approved individual appliance scope.' } });
            for (const unit of order.units) if (declined.has(unit.unitKey)) unit.status = 'cancelled';
            order.unitCount = order.units.filter(unit => unit.status !== 'cancelled').length;
            if (!order.unitCount) order.status = 'cancelled';
            if (priorCount > 0) order.estimatedHours = order.estimatedHours * order.unitCount / priorCount;
            await order.save({ session });
            const allocations = await DailyAssignment.find({ workOrderId: order._id }).session(session);
            for (const allocation of allocations) {
              const hadKeys = (allocation.unitKeys || []).length > 0;
              allocation.unitKeys = (allocation.unitKeys || []).filter(key => !declined.has(key));
              allocation.targetUnits = hadKeys ? allocation.unitKeys.length : declined.size ? 0 : Math.min(allocation.targetUnits || 0, order.unitCount);
              if (!order.unitCount || !allocation.targetUnits) allocation.status = 'skipped';
              await allocation.save({ session });
            }
          }
          document.requestedUnitCount = document.requestedUnitCount || document.totalUnits;
          const activeGroups = document.unitGroups.map(group => ({
            ...group.toObject(), quantity: group.serviceType === 'repair' ? group.units.filter(unit => unit.repairReview.state !== 'declined').length : group.quantity,
          })).filter(group => group.quantity > 0);
          document.totalUnits = require('../public/js/appliance-services').unitCount(activeGroups);
          if (!document.totalUnits) { document.status = 'on_hold'; document.projectPhase = 'quotation_review'; }
        } else if (settled) {
          const approved = flow.rows(document).filter(row => row.unit.repairReview.state === 'approved');
          document.quotation = { parts: approved.flatMap(row => row.unit.quotation.parts.map(part => ({ ...part.toObject?.() || part }))), laborCost: approved.reduce((sum, row) => sum + row.unit.quotation.laborCost, 0), laborCategory: 'standard', totalCost: approved.reduce((sum, row) => sum + row.unit.quotation.totalCost, 0), createdAt: new Date() };
          document.approval = { status: approved.length ? 'approved' : 'declined', decidedAt: new Date(), decidedBy: req.user._id };
          document.balanceAmount = document.quotation.totalCost + (document.inspectionFeeCollected ? 0 : Math.max(0, Number(document.totalPrice || document.estimatedFee || 0) - Number(document.amountPaid || document.downpaymentAmount || 0)));
          if (document.serviceType === 'repair') document.status = approved.length ? 'repair_approved' : 'repair_declined';
          for (const item of document.services.filter(item => item.type === 'repair')) {
            const allowed = item.units.filter(unit => unit.repairReview.state === 'approved');
            item.status = allowed.length ? 'repair_approved' : 'repair_declined';
            item.quotation = { parts: allowed.flatMap(unit => unit.quotation.parts.map(part => ({ ...part.toObject?.() || part }))), laborCost: allowed.reduce((sum, unit) => sum + unit.quotation.laborCost, 0), laborCategory: 'standard', totalCost: allowed.reduce((sum, unit) => sum + unit.quotation.totalCost, 0), status: allowed.length ? 'approved' : 'declined', decidedAt: new Date() };
          }
        }
      } else if (action === 'complete') {
        if (document.unitGroups) flow.fail('Complete project appliances using the work submission with proof.');
        if (!['repair_in_progress', 'in-progress'].includes(document.status)) flow.fail('Start the approved repair work before marking appliances complete.');
        const row = flow.rows(document).find(row => row.key === req.body.key);
        if (!row || row.unit.repairReview.state !== 'approved') flow.fail('This appliance has no approved repair to complete.');
        if (row.group.technicianId && String(row.group.technicianId) !== String(technician._id)) flow.fail('This appliance is assigned to another technician.', 403);
        if (String(req.body.notes || '').trim().length < 10) flow.fail('Describe the repair and tests performed (at least 10 characters).', 400);
        row.unit.repairReview.state = 'completed'; row.unit.status = 'completed'; row.unit.completedAt = new Date(); row.unit.completedBy = technician._id; row.unit.completionNotes = String(req.body.notes).trim().slice(0, 1000);
      }
      document.repairUnitTracking = true;
      // Compare-and-set keeps edits and decisions from overwriting newer work.
      const model = document.unitGroups ? Project : Booking;
      const fields = document.unitGroups ? ['unitGroups', 'repair', 'repairQuoteHistory', 'assessmentVisit', 'repairUnitTracking', 'requestedUnitCount', 'totalUnits', 'projectPhase', 'quotationReview', 'inspectionReport', 'status'] : ['services', 'repairUnitTracking', 'quotationReview', 'inspection', 'quotation', 'approval', 'balanceAmount', 'status'];
      const changes = Object.fromEntries(fields.filter(key => document[key] !== undefined).map(key => [key, document[key]?.toObject?.() || document[key]]));
      changes.updatedAt = new Date();
      const versionFilter = document.__v == null ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: document.__v };
      const updated = await model.updateOne({ _id: document._id, ...versionFilter }, { $set: changes, $inc: { __v: 1 } }, { session, runValidators: true });
      if (updated.modifiedCount !== 1) flow.fail('This repair record changed. Refresh it before saving.');
      document.__v = (document.__v || 0) + 1;
    });
    const { document, booking, technician } = state;
    if (req.params.action === 'review' && req.body.action === 'approve') await createNotification({ type: 'system', title: 'Repair prices ready', message: 'Review the price for each appliance and choose which repairs to approve.', userId: booking.customerId, referenceId: booking._id, referenceModel: 'BookingService', link: '/book-history', io: req.app.get('io') }).catch(() => {});
    if (['submit', 'decide'].includes(req.params.action)) await createNotification({ type: 'system', title: req.params.action === 'submit' ? 'Repair inspections ready' : 'Repair decision received', message: `Appliance repair records updated for ${booking.bookingReference || booking._id}.`, role: 'admin', referenceId: booking._id, referenceModel: 'BookingService', link: document.unitGroups ? `/admin/projects/${document._id}` : `/admin/appointments?booking=${booking._id}`, io: req.app.get('io') }).catch(() => {});
    if (req.params.action === 'decide') {
      const ids = document.unitGroups ? [document.leadTechnicianId, ...document.assignedTechnicians.map(member => member._id)] : [document.technicianId, ...document.services.map(item => item.technicianId)];
      const recipients = await Technician.find({ _id: { $in: ids.filter(Boolean) } }).select('user').lean().catch(() => []);
      for (const technician of recipients) if (technician.user) await createNotification({ type: 'system', title: 'Customer repair decision', message: 'The customer updated their appliance repair choices. Check approved appliances before starting work.', userId: technician.user, referenceId: booking._id, referenceModel: 'BookingService', link: '/technician/assignments', io: req.app.get('io') }).catch(() => {});
    }
    await require('../utils/audit').logEvent({ actor: req.user._id, target: document._id, action: `repair.units.${req.params.action}`, module: 'bookings', req, details: { unitKey: req.body.key, decisions: req.body.decisions?.map(item => ({ key: item.key, approved: item.approved })) } }).catch(() => {});
    const io = req.app.get('io');
    io?.to(`customer:${booking.customerId}`).emit('booking:status-change', { bookingId: booking._id });
    io?.to('admin').emit('booking:updated', { bookingId: booking._id });
    res.json({ success: true, ...view(document, req, technician) });
  } catch (error) { next(error); }
  finally { if (session) await session.endSession(); }
});
module.exports = router;
