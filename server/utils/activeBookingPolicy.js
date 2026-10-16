'use strict';
const { BookingStatus: status, FlowStages } = require('../models/BookingStatus');

const groups = {
  confirmed: [status.CONFIRMED, status.SCHEDULED],
  'on-the-way': [status.ON_THE_WAY],
  arrived: [status.ARRIVED, status.WAITING_FOR_CUSTOMER, status.NO_SHOW_REPORTED],
  'in-progress': [status.IN_PROGRESS, status.INSPECTION_IN_PROGRESS, status.REPAIR_IN_PROGRESS],
  repair: [status.INSPECTION_SCHEDULED, status.INSPECTION_IN_PROGRESS, status.INSPECTION_COMPLETED,
    status.AWAITING_APPROVAL, status.REPAIR_APPROVED, status.WAITING_PARTS, status.PARTS_RESERVED,
    status.READY_FOR_REPAIR, status.REPAIR_SCHEDULED, status.REPAIR_IN_PROGRESS],
};

function activeBookingMatch(selected = '') {
  const active = FlowStages.ACTIVE_JOBS.statuses;
  const requested = String(selected).split(',').map(value => value.trim()).filter(Boolean);
  const statuses = requested.length ? [...new Set(requested.flatMap(value => groups[value] || [value]))].filter(value => active.includes(value)) : active;
  // Order installations and projects have their own workspaces. An unfinished
  // standard booking stays visible even if its original appointment is past.
  return { archivedAt: null, isProject: { $ne: true }, sourceOrderId: null, status: { $in: statuses } };
}

function activeBookingSummary(result = {}) {
  const counts = Object.fromEntries((result.statuses || []).map(row => [row._id, row.count]));
  const summary = { all: Object.values(counts).reduce((sum, count) => sum + count, 0), technicians: result.technicians?.[0]?.count || 0 };
  for (const [key, statuses] of Object.entries(groups)) summary[key] = statuses.reduce((sum, value) => sum + (counts[value] || 0), 0);
  return summary;
}

function activeBookingSummaryPipeline(match) {
  return [{ $match: match }, { $facet: {
    statuses: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
    technicians: [
      { $match: { technicianId: { $ne: null } } },
      { $project: { technicianIds: { $cond: [
        { $gt: [{ $size: { $ifNull: ['$technicianTeam', []] } }, 0] },
        '$technicianTeam.technicianId', ['$technicianId'],
      ] } } },
      { $unwind: '$technicianIds' }, { $match: { technicianIds: { $ne: null } } },
      { $group: { _id: '$technicianIds' } }, { $count: 'count' },
    ],
  } }];
}
module.exports = { activeBookingMatch, activeBookingSummary, activeBookingSummaryPipeline };
