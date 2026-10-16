'use strict';
const { manilaDateKey, parseAppointmentTime } = require('./bookingDateTime');

async function projectAllocations(technicianIds, minDate, maxDate) {
  require('../models/Project');
  const rows = await require('../models/DailyAssignment').find({ technicianId: { $in: technicianIds },
    planningOnly: { $ne: true }, date: { $gte: minDate, $lte: maxDate }, status: { $in: ['pending', 'in_progress'] } })
    .select('technicianId date startTime endTime projectId').populate('projectId', 'status archivedAt').lean();
  return rows.filter(row => !row.projectId?.archivedAt && !['completed', 'cancelled', 'rejected'].includes(row.projectId?.status))
    .map(row => ({ technicianId: String(row.technicianId), date: manilaDateKey(row.date),
      start: parseAppointmentTime(row.startTime || '00:00'), end: parseAppointmentTime(row.endTime || '23:59'), planned: false }));
}
module.exports = { projectAllocations };
