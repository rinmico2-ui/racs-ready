'use strict';
const { manilaDateTime } = require('./bookingDateTime');

async function technicianProjectIntervals(technicianId, date, { DailyAssignments = require('../models/DailyAssignment') } = {}) {
  require('../models/Project');
  const rows = await DailyAssignments.find({ technicianId, planningOnly: { $ne: true },
    date: { $gte: manilaDateTime(date, 0), $lt: manilaDateTime(date, 1440) }, status: { $in: ['pending', 'in_progress'] } })
    .select('startTime endTime allocatedMinutes projectId').populate('projectId', 'status archivedAt').lean();
  return rows.filter(row => !row.projectId?.archivedAt && !['completed', 'cancelled', 'rejected'].includes(row.projectId?.status))
    .map(row => ({ startTime: row.startTime || '00:00', endTime: row.endTime || '23:59', serviceDurationMinutes: row.allocatedMinutes }));
}
module.exports = { technicianProjectIntervals };
