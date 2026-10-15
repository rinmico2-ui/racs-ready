"use strict";
const { strictManilaDateKey, manilaDateKey, manilaDateTime, parseAppointmentTime } = require('./bookingDateTime');
const { buildSchedulingContext, subtractIntervals, normalizeWorkingDays } = require('./enterpriseProjectScheduling');
const fail = message => Object.assign(new Error(message), { status: 400 });
function calendarWindow(input, now = new Date()) {
  const start = strictManilaDateKey(input.startDate), end = strictManilaDateKey(input.endDate);
  if (!start || !end || start < manilaDateKey(now) || end < start || manilaDateTime(end, 0) - manilaDateTime(start, 0) > 180 * 86400000) throw fail('Choose a current or future project window within 180 days.');
  const startMinutes = parseAppointmentTime(input.startTime || '09:00'), endMinutes = parseAppointmentTime(input.endTime || '17:00');
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) throw fail('Choose valid daily working hours.');
  const workingDays = normalizeWorkingDays(input.workingDays || [1,2,3,4,5], []);
  if (!workingDays.length) throw fail('Choose at least one working day.');
  const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { start, end, startMinutes, endMinutes, startTime: clock(startMinutes), endTime: clock(endMinutes), workingDays };
}
async function projectCrewCalendar(project, input, { Technician = require('../models/Technician'), contextBuilder = buildSchedulingContext, now = new Date() } = {}) {
  const window = calendarWindow(input, now);
  const ids = (project.assignedTechnicians || []).map(member => member._id || member);
  const crew = await Technician.find({ active: { $ne: false }, archivedAt: null, ...(ids.length ? { _id: { $in: ids } } : {}) }).select('_id name user').populate('user', 'active blocked role').lean();
  const technicians = crew.filter(member => member.user && member.user.active !== false && !member.user.blocked && member.user.role === 'technician');
  const context = await contextBuilder({ ...project, assignedTechnicians: technicians }, { startDate: manilaDateTime(window.start, 0), targetEndDate: manilaDateTime(window.end, 0) });
  const days = [];
  for (let day = manilaDateTime(window.start, 0); manilaDateKey(day) <= window.end; day = new Date(day.getTime() + 86400000)) {
    const date = manilaDateKey(day), dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const holiday = context.holidays.some(row => manilaDateKey(row.date) === date);
    const rows = technicians.map(technician => {
      const id = String(technician._id), schedule = context.schedules.find(row => String(row.technicianId) === id);
      const leave = context.leaves.some(row => String(row.technicianId) === id && manilaDateKey(row.startDate) <= date && manilaDateKey(row.endDate) >= date);
      const rest = schedule?.restDates?.some(row => manilaDateKey(row.date) === date);
      const periods = schedule ? (schedule.workingDays || []).filter(row => Number(row.dayOfWeek) === dow) : [{ startMinutes:window.startMinutes, endMinutes:window.endMinutes }];
      const closed = holiday || leave || rest || !window.workingDays.includes(dow) || !periods.length;
      const conflicts = [];
      const busy = [];
      for (const booking of context.bookings.filter(row => String(row.technicianId) === id && (!project.bookingId || String(row._id) !== String(project.bookingId)) && manilaDateKey(row.bookingDate) === date)) {
        const start = parseAppointmentTime(booking.startTime), end = parseAppointmentTime(booking.endTime);
        busy.push([Number.isFinite(start) ? start : window.startMinutes, Number.isFinite(end) ? end + Number(booking.travelDurationMinutes || 0) : Number.isFinite(start) ? start + Number(booking.serviceDurationMinutes || 60) + Number(booking.travelDurationMinutes || 0) : window.endMinutes]);
        conflicts.push('Customer booking');
      }
      for (const allocation of context.otherAssignments.filter(row => String(row.technicianId) === id && manilaDateKey(row.date) === date)) {
        const start = parseAppointmentTime(allocation.startTime), end = parseAppointmentTime(allocation.endTime);
        busy.push([Number.isFinite(start) ? start : window.startMinutes, Number.isFinite(end) ? end : window.endMinutes]);
        conflicts.push('Another project');
      }
      let free = closed ? [] : periods.flatMap(period => subtractIntervals(Math.max(window.startMinutes, period.startMinutes), Math.min(window.endMinutes, period.endMinutes), [...busy]));
      free = free.filter(([start,end]) => end > start).sort((a,b) => a[0]-b[0]);
      const merged=[];for(const interval of free){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push(interval);}
      const availableMinutes = merged.reduce((sum,[start,end]) => sum + end-start,0);
      return { technicianId:id, name:technician.name, availableMinutes, conflicts:closed ? [holiday?'Non-working day':leave?'Approved leave':rest?'Rest date':'Outside working days'] : [...new Set(conflicts)] };
    });
    days.push({ date, technicians:rows, availableCount:rows.filter(row=>row.availableMinutes>0).length, availableHours:rows.reduce((sum,row)=>sum+row.availableMinutes,0)/60 });
  }
  const unavailableTechnicianIds = [...new Set(ids.map(String))].filter(id => !technicians.some(technician => String(technician._id) === id));
  return { startDate:window.start, endDate:window.end, scope:ids.length?'assigned_crew':'available_pool', unavailableTechnicianIds, technicians:technicians.map(row=>({technicianId:String(row._id),name:row.name})), days,
    availableHours:days.reduce((sum,row)=>sum+row.availableHours,0), hasAvailability:days.some(row=>row.availableCount>0) };
}
module.exports = { calendarWindow, projectCrewCalendar };
