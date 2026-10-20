'use strict';
const { validateLeaveDates } = require('./leaveRequestValidation');
const fail = (message, status, code, fields) => Object.assign(new Error(message), { status, code, fields });
const dateLabel = value => new Date(value).toLocaleDateString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
});

function createService(overrides = {}) {
  const deps = { LeaveRequest: require('../models/LeaveRequest'),
    lock: require('./operationLock').withOperationLock, now: () => new Date(), ...overrides };
  async function withLock(technicianId, work) {
    try { return await deps.lock('technician-leave:' + String(technicianId), work); }
    catch (error) {
      if (error.code === 'OPERATION_LOCK_TIMEOUT') throw fail('Your leave requests are being updated. Refresh and try again.', 409, 'LEAVE_BUSY');
      throw error;
    }
  }
  async function assertNoOverlap(technicianId, start, end, excludeId) {
    const conflict = await deps.LeaveRequest.findOne({ technicianId, status: { $in: ['pending', 'approved'] },
      startDate: { $lte: end }, endDate: { $gte: start }, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).select('_id startDate endDate status').lean();
    if (!conflict) return;
    const range = dateLabel(conflict.startDate) + (new Date(conflict.startDate).getTime() === new Date(conflict.endDate).getTime() ? '' : ' to ' + dateLabel(conflict.endDate));
    const message = `These dates overlap with ${conflict.status} leave (${range}). Choose dates outside that request.`;
    throw fail(message, 409, 'LEAVE_OVERLAP', { startDate: message });
  }
  async function submit(technician, body = {}) {
    const { startDate, endDate, reason } = body;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      throw fail('Check your leave reason.', 400, 'INVALID_LEAVE', { reason: 'Enter a reason up to 500 characters.' });
    }
    const { start, end, fields } = validateLeaveDates(startDate, endDate, deps.now());
    if (Object.keys(fields).length) throw fail('Check your leave dates.', 400, 'INVALID_LEAVE', fields);
    return withLock(technician._id, async () => {
      await assertNoOverlap(technician._id, start, end);
      return deps.LeaveRequest.create({ technicianId: technician._id,
        technician: { name: technician.name || '', email: technician.email || '', phone: technician.phone || '' },
        startDate: start, endDate: end, reason: String(reason || '').trim(), status: 'pending',
      });
    });
  }
  async function cancel(technicianId, id) {
    return withLock(technicianId, async () => {
      // The pending state is part of the delete itself, so a late withdrawal
      // cannot remove an approval even if another reviewer was already active.
      const removed = await deps.LeaveRequest.findOneAndDelete({ _id: id, technicianId, status: 'pending' }).lean();
      if (removed) return removed;
      const existing = await deps.LeaveRequest.findOne({ _id: id, technicianId }).select('status').lean();
      throw existing ? fail('Only pending requests can be withdrawn. Contact admin about approved leave.', 409, 'LEAVE_ALREADY_REVIEWED')
        : fail('Leave request not found. Refresh your requests.', 404, 'LEAVE_NOT_FOUND');
    });
  }
  return { withLock, assertNoOverlap, submit, cancel };
}
module.exports = { createService, dateLabel };
