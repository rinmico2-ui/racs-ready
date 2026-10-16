'use strict';
const team = require('./standardJobTeam');
function repairWorkAccess(booking, technicianId, assignment) {
  if (booking.archivedAt || team.closed.has(booking.status)) return { canInspect: false, reason: 'This repair request is already closed.' };
  if (team.members(booking).length) {
    if (!team.isPrimary(booking, technicianId)) return { canInspect: false, reason: 'The primary technician records inspections and quotations. Supporting technicians can add work notes.' };
    if (!team.readiness(booking).ready) return { canInspect: false, reason: 'Every assigned technician must accept before on-site work starts.' };
  }
  const started = assignment?.status === 'in_progress' || ['in-progress', 'inspection_in_progress', 'repair_in_progress'].includes(booking.status);
  return { canInspect: started, reason: started ? '' : 'Start Work after arriving at the customer site to record findings and generate a quotation.' };
}
module.exports = { repairWorkAccess };
