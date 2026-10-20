'use strict';

const mongoose = require('mongoose');
const LeaveRequest = require('../models/LeaveRequest');
const audit = require('../utils/audit');
const { createNotification } = require('../utils/notify');
const leaveRequests = require('../utils/technicianLeaveRequests').createService();

const reviewStatuses = ['approved', 'rejected'];

async function list(req, res, next) {
  try {
    const { status, technicianId } = req.query || {};
    if (status !== undefined && !['all', 'pending', ...reviewStatuses].includes(status)) {
      return res.status(400).json({ error: 'Choose a valid leave status.' });
    }
    if (technicianId !== undefined && !mongoose.isObjectIdOrHexString(technicianId)) {
      return res.status(400).json({ error: 'Choose a valid technician.' });
    }
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (technicianId) filter.technicianId = technicianId;
    const items = await LeaveRequest.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    res.set('Cache-Control', 'private, no-store');
    return res.json({ items, count: items.length });
  } catch (error) { next(error); }
}

async function review(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) return res.status(400).json({ error: 'Invalid leave request.' });
    const { status, adminNote = '', expectedStatus, expectedReviewedAt } = req.body || {};
    if (!reviewStatuses.includes(status)) {
      return res.status(400).json({ error: 'Choose Approve or Reject.' });
    }
    if (typeof adminNote !== 'string' || adminNote.length > 500) {
      return res.status(400).json({ error: 'Enter a review note up to 500 characters.' });
    }
    const target = await LeaveRequest.findById(id).select('technicianId').lean();
    if (!target) return res.status(404).json({ error: 'Leave request not found. It may have been cancelled by the technician.' });
    const result = await leaveRequests.withLock(target.technicianId, async () => {
      const original = await LeaveRequest.findById(id).lean();
      if (!original) throw Object.assign(new Error('Leave request not found. It may have been withdrawn by the technician.'), { status: 404 });
      if (expectedStatus !== undefined && (expectedStatus !== original.status
          || (expectedReviewedAt || null) !== (original.reviewedAt ? new Date(original.reviewedAt).toISOString() : null))) {
        throw Object.assign(new Error('This request was reviewed by someone else. Refresh and review the latest decision.'), { status: 409 });
      }
      const note = adminNote.trim();
      // Retrying the same decision must not create duplicate notifications or audit entries.
      if (original.status === status && (original.adminNote || '') === note) {
        return { unchanged: true, leave: original };
      }
      if (status === 'approved') await leaveRequests.assertNoOverlap(original.technicianId, original.startDate, original.endDate, original._id);
      const now = new Date();
      const leave = await LeaveRequest.findOneAndUpdate({
        _id: id, status: original.status, reviewedAt: original.reviewedAt || null,
      }, { $set: { status, adminNote: note, reviewedBy: req.user._id, reviewedAt: now, updatedAt: now } }, {
        new: true, runValidators: true,
      }).lean();
      if (!leave) throw Object.assign(new Error('This request changed while you were reviewing it. Refresh and try again.'), { status: 409 });
      return { leave, previousStatus: original.status };
    });
    if (result.unchanged) return res.json({ message: 'No changes detected.', leave: result.leave });
    const { leave } = result, note = adminNote.trim();

    const date = value => new Date(value).toLocaleDateString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
    });
    const approved = status === 'approved';
    await createNotification({
      type: approved ? 'leave_approved' : 'leave_rejected',
      title: approved ? 'Leave Approved' : 'Leave Rejected',
      message: `Your leave request from ${date(leave.startDate)} to ${date(leave.endDate)} was ${status}.${note ? ' Note: ' + note : ''}`,
      userId: leave.technicianId, role: 'technician', referenceId: leave._id,
      referenceModel: 'LeaveRequest', link: '/technician/attendance',
      priority: approved ? 'normal' : 'high', io: req.app.get('io'),
    });
    await audit.logEvent({
      actor: req.user._id, target: leave.technicianId, action: `leave.${status}`, module: 'technician', req,
      entityType: 'LeaveRequest', entityId: leave._id, outcome: 'success',
      details: { leaveId: id, previousStatus: result.previousStatus, status, adminNote: note },
    });
    return res.json({ message: `Leave request ${status}.`, leave });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
}

module.exports = { list, review };
