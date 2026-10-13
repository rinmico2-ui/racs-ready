"use strict";

const BOOKING_ACTIVE = ["pending", "payment_verified", "awaiting_assignment", "assigned", "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress"];

async function projectTeamEligibility(project, technicians, { Project, LeaveRequest, BookingService }) {
  const spanStart = project.plannedStartDate || project.preferredStartDate;
  const spanEnd = project.plannedCompletionDate || project.preferredCompletionDeadline;
  const projectDays = [];
  if (spanStart && spanEnd) {
    const cursor = new Date(spanStart), end = new Date(spanEnd);
    cursor.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999);
    while (cursor <= end) {
      // Preserve the existing company weekday policy used by this picker.
      if ([1, 3, 4, 5].includes(cursor.getDay())) projectDays.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  const projectSpan = spanStart && spanEnd ? { start: spanStart, end: spanEnd, workingDays: projectDays.length } : null;
  if (!projectDays.length || !technicians.length) return {
    technicians: technicians.map(tech => ({ ...tech, availableDuringProject: true, availabilityChecked: false, conflictReason: '' })), projectSpan,
  };
  const ids = technicians.map(tech => tech._id), dayStart = projectDays[0], dayEnd = new Date(projectDays.at(-1));
  dayEnd.setHours(23, 59, 59, 999);
  const ranges = projectDays.map(day => {
    const start = new Date(day), end = new Date(day);
    start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999);
    return { bookingDate: { $gte: start, $lte: end } };
  });
  // Three bounded queries replace up to three sequential queries per tech.
  const [projects, leaves, bookings] = await Promise.all([
    Project.find({ _id: { $ne: project._id }, "assignedTechnicians._id": { $in: ids },
      status: { $in: ["planning", "in_progress", "on_hold", "accepted"] },
      $or: [{ plannedStartDate: { $lte: dayEnd }, plannedCompletionDate: { $gte: dayStart } },
        { preferredStartDate: { $lte: dayEnd }, preferredCompletionDeadline: { $gte: dayStart } }],
    }).select('assignedTechnicians._id').lean(),
    LeaveRequest.find({ technicianId: { $in: ids }, status: 'approved', startDate: { $lte: dayEnd }, endDate: { $gte: dayStart } })
      .select('technicianId').lean(),
    BookingService.aggregate([
      { $match: { technicianId: { $in: ids }, $or: ranges, status: { $in: BOOKING_ACTIVE } } },
      { $group: { _id: '$technicianId', count: { $sum: 1 } } },
    ]),
  ]);
  const reserved = new Set(projects.flatMap(row => (row.assignedTechnicians || []).map(tech => String(tech._id))));
  const onLeave = new Set(leaves.map(row => String(row.technicianId)));
  const fixedBookings = new Map(bookings.map(row => [String(row._id), Number(row.count) || 0]));
  return { projectSpan, technicians: technicians.map(tech => {
    const id = String(tech._id), count = fixedBookings.get(id) || 0;
    const conflictReason = reserved.has(id) ? 'Reserved by another project on overlapping dates'
      : onLeave.has(id) ? 'On approved leave during the project span'
        : count ? `${count} fixed booking(s) on project working day(s)` : '';
    return { ...tech, availabilityChecked: true, availableDuringProject: !conflictReason, conflictReason };
  }) };
}

module.exports = { projectTeamEligibility };
