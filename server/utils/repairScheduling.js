'use strict';
const team = require('./standardJobTeam');
const { manilaDateKey, strictManilaDateKey, parseAppointmentTime } = require('./bookingDateTime');
function workload(booking) {
  const minutes = require('./standardRepairVisit').duration(undefined,
    Number(booking.repairExecution?.repairMinutes || booking.technicianAssistant?.estimatedDurationMinutes) || 90);
  const rawTravel = booking.travelDurationMinutes ?? booking.travelTime;
  return { minutes: Math.max(30, minutes), travel: rawTravel != null && Number.isFinite(Number(rawTravel)) ? Math.max(0, Number(rawTravel)) : 30 };
}
function crew(booking, primaryId) {
  return [...new Set([team.ref(primaryId), ...team.ids(booking).filter(id => id !== team.ref(booking.technicianId))])];
}
function createService(overrides = {}) {
  const deps = { slots: (...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args),
    roster: options => require('./technicianRoster').loadTechnicianRoster(options), now: () => new Date(), ...overrides };
  return async function availability(booking, primaryId, date) {
    if (!/^[a-f\d]{24}$/i.test(String(primaryId || ''))) throw team.failure('Choose a registered technician.', 400);
    if (booking.archivedAt || booking.isProject || booking.sourceOrderId) throw team.failure('Use the owning project or order to schedule this repair.');
    if (!['repair_approved','ready_for_repair','waiting_parts','repair_scheduled'].includes(booking.status)) throw team.failure('This repair cannot be scheduled from its current status.');
    const technicianIds = crew(booking, primaryId), { minutes, travel } = workload(booking);
    const roster = await deps.roster({ technicianIds });
    if (technicianIds.some(id => !roster.some(row => team.ref(row._id) === id && row.assignmentEligible))) throw team.failure('A member of the repair team is unavailable for assignment. Review the team first.');
    async function slotsForDay(day) {
      const results = await Promise.all(technicianIds.map(technicianId => deps.slots({ date: day, technicianId,
        duration: String(minutes), quantity: '1', travelTime: String(travel) }, { excludeBookingId: booking._id, existingAppointment: true })));
      const failed = results.find(result => result.statusCode >= 400);
      if (failed) throw team.failure(failed.payload?.error || 'Repair availability could not be checked. Try again.', failed.statusCode);
      const first = results[0].payload?.timeSlots || [];
      return first.filter(slot => slot.available === true && results.every(result => (result.payload?.timeSlots || [])
        .some(other => other.available === true && parseAppointmentTime(other.startTime) === parseAppointmentTime(slot.startTime))));
    }
    if (date) {
      const day = strictManilaDateKey(date);
      if (!day) throw team.failure('Choose a valid repair date.', 400);
      return { date: day, timeSlots: await slotsForDay(day), duration: minutes, travelTime: travel, technicianIds };
    }
    const today = manilaDateKey(deps.now()), days = [];
    for (let offset = 0; offset < 14; offset++) {
      const day = new Date(today + 'T00:00:00Z'); day.setUTCDate(day.getUTCDate() + offset);
      days.push(day.toISOString().slice(0, 10));
    }
    for (const preferred of booking.preferredSchedule?.dates || []) {
      const day = manilaDateKey(preferred); if (day && day >= today && !days.includes(day)) days.push(day);
    }
    const dates = [];
    for (let index = 0; index < days.length; index += 3) {
      dates.push(...await Promise.all(days.slice(index, index + 3).map(async day => {
        const slots = await slotsForDay(day);
        return { date: day, available: slots.length > 0, remainingSlots: slots.length, totalSlots: slots.length,
          reason: slots.length ? '' : 'No common team slots' };
      })));
    }
    return { dates: dates.sort((a, b) => a.date.localeCompare(b.date)), duration: minutes, travelTime: travel, technicianIds };
  };
}
module.exports = { createService, workload, crew };
