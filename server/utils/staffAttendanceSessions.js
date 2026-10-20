'use strict';
const { attendanceDay, attendanceShift } = require('./attendanceTime');
const ACTIVE = ['Present', 'Late'];
const fail = (message, code, status = 409) => Object.assign(new Error(message), { status, code });
const openRecord = record => !!record?.checkInTime && !record.checkOutTime && ACTIVE.includes(record.status);
function sessionState(record, now = new Date()) {
  const today = attendanceDay(now), workDay = record ? attendanceDay(record.date) : today;
  const isOpen = openRecord(record), isOvernight = isOpen && workDay.start < today.start;
  return { record, workDay, isOvernight,
    needsAdminReview: isOpen && workDay.start.getTime() < today.start.getTime() - 86400000,
  };
}
function readFilter(owner, day) {
  return { ...owner, $or: [{ date: day.start }, { date: { $lt: day.start }, status: { $in: ACTIVE }, checkInTime: { $ne: null }, checkOutTime: null }] };
}
function chooseRecord(records, now) {
  const day = attendanceDay(now);
  const sorted = [...records].sort((a, b) => new Date(b.date) - new Date(a.date));
  return sorted.find(openRecord) || sorted.find(record => new Date(record.date).getTime() === day.start.getTime()) || null;
}
function createService(overrides = {}) {
  const deps = { TechnicianAttendance: require('../models/TechnicianAttendance'), SecretaryAttendance: require('../models/SecretaryAttendance'),
    TechnicianSchedule: require('../models/TechnicianSchedule'), Secretary: require('../models/Secretary'),
    lock: require('./operationLock').withOperationLock, now: () => new Date(), ...overrides };
  function context(type, staffId) {
    if (!['technician', 'secretary'].includes(type)) throw fail('Choose a valid staff role.', 'INVALID_STAFF_ROLE', 400);
    return { Model: deps[type === 'technician' ? 'TechnicianAttendance' : 'SecretaryAttendance'], owner: { [type === 'technician' ? 'technicianId' : 'userId']: staffId } };
  }
  async function withLock(type, staffId, work) {
    context(type, staffId);
    try { return await deps.lock(`staff-attendance:${type}:${staffId}`, work); }
    catch (error) {
      if (error.code === 'OPERATION_LOCK_TIMEOUT') throw fail('Attendance is being updated. Refresh and try again.', 'ATTENDANCE_BUSY');
      throw error;
    }
  }
  async function read(type, staffId, now = deps.now()) {
    const { Model, owner } = context(type, staffId);
    const records = await Model.find(readFilter(owner, attendanceDay(now)))
      .select('date status checkInTime checkOutTime qrVerified method remarks noExpensesTodayConfirmed noExpensesTodayConfirmedAt securityVersion userId technicianId createdAt updatedAt').lean();
    return sessionState(chooseRecord(records, now), now);
  }
  async function shift(type, staffId, now) {
    const saved = type === 'technician'
      ? await deps.TechnicianSchedule.findOne({ technicianId: staffId }).select('workingDays restDates nonWorkingWeekdays').lean()
      : await deps.Secretary.findOne({ user: staffId }).select('shift').lean();
    return attendanceShift(attendanceDay(now), type === 'technician' ? { schedule: saved } : { shift: saved?.shift });
  }
  async function checkIn(type, staffId, { fields = {}, now = deps.now(), onSaved } = {}) {
    return withLock(type, staffId, async () => {
      const { Model, owner } = context(type, staffId);
      // A request received just before midnight may acquire the lock after a
      // newer request. Check the latest calendar day before creating its row.
      const latest = new Date(Math.max(new Date(now).getTime(), new Date(deps.now()).getTime()));
      const current = await read(type, staffId, latest);
      if (openRecord(current.record)) throw fail(current.isOvernight ? 'Finish your previous shift before checking in again. Contact admin if that record needs correction.' : 'You have already checked in today.', current.needsAdminReview ? 'OPEN_SHIFT_REVIEW_REQUIRED' : 'ALREADY_CHECKED_IN');
      if (current.record?.checkInTime) throw fail('Attendance has already been recorded for today.', 'ALREADY_CHECKED_IN');
      if (['On Leave', 'Sick Leave'].includes(current.record?.status)) throw fail('Leave is recorded for today. Contact admin before checking in.', 'LEAVE_RECORDED');
      const timings = await shift(type, staffId, now), day = attendanceDay(now);
      const status = now > timings.checkInDueAt ? 'Late' : 'Present';
      let record;
      try {
        record = await Model.findOneAndUpdate({ ...owner, date: day.start, checkInTime: null }, {
          $set: { ...fields, status, checkInTime: now, checkOutTime: null, qrVerified: true, method: 'qr_scan' }, $unset: { token: 1 },
        }, { upsert: true, returnDocument: 'after', runValidators: true });
      } catch (error) {
        if (error.code === 11000) throw fail('Attendance has already been recorded for today.', 'ALREADY_CHECKED_IN');
        throw error;
      }
      await onSaved?.(record);
      return record;
    });
  }
  async function checkOut(type, staffId, { record, fields = {}, now = deps.now(), onSaved } = {}) {
    return withLock(type, staffId, async () => {
      const { Model, owner } = context(type, staffId), state = sessionState(record, now);
      if (!openRecord(record)) throw fail('Check in before checking out, or refresh your attendance.', 'SHIFT_NOT_OPEN');
      if (state.needsAdminReview) throw fail('This older shift needs an admin correction. Ask admin to record the verified finish time.', 'OPEN_SHIFT_REVIEW_REQUIRED');
      if (new Date(record.checkInTime) > now) throw fail('The recorded check-in time needs admin review.', 'INVALID_SHIFT_TIME');
      const saved = await Model.findOneAndUpdate({ ...owner, _id: record._id, checkInTime: record.checkInTime, status: record.status, checkOutTime: null },
        { $set: { ...fields, checkOutTime: now } }, { returnDocument: 'after', runValidators: true });
      if (!saved) throw fail('This shift has already changed. Refresh your attendance.', 'SHIFT_CHANGED');
      await onSaved?.(saved);
      return saved;
    });
  }
  async function closeByAdmin(type, staffId, { recordId, checkOutLocal, reason, userId, now = deps.now(), onSaved } = {}) {
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) throw fail('Enter a correction reason between 5 and 500 characters.', 'INVALID_REASON', 400);
    if (typeof checkOutLocal !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(checkOutLocal)) throw fail('Enter the verified finish date and time in Philippine time.', 'INVALID_SHIFT_TIME', 400);
    const finish = new Date(checkOutLocal + ':00+08:00');
    if (!Number.isFinite(finish.getTime()) || attendanceDay(finish).key !== checkOutLocal.slice(0, 10) || finish > now) throw fail('Enter a valid finish time that is not in the future.', 'INVALID_SHIFT_TIME', 400);
    return withLock(type, staffId, async () => {
      const { Model, owner } = context(type, staffId);
      const record = await Model.findOne({ ...owner, _id: recordId }).lean();
      if (!openRecord(record)) throw fail('This shift has already changed. Refresh the roster.', 'SHIFT_CHANGED');
      if (finish < new Date(record.checkInTime)) throw fail('The finish time cannot be before check-in.', 'INVALID_SHIFT_TIME', 400);
      const saved = await Model.findOneAndUpdate({ ...owner, _id: record._id, status: record.status, checkInTime: record.checkInTime, checkOutTime: null },
        { $set: { checkOutTime: finish, method: 'manual', qrVerified: false, updatedBy: userId, remarks: reason.trim() }, $unset: { token: 1, checkOutEvidence: 1 } },
        { returnDocument: 'after', runValidators: true });
      if (!saved) throw fail('This shift has already changed. Refresh the roster.', 'SHIFT_CHANGED');
      await onSaved?.(saved);
      return saved;
    });
  }
  return { withLock, read, checkIn, checkOut, closeByAdmin };
}
module.exports = { createService, openRecord, sessionState, readFilter, chooseRecord };
