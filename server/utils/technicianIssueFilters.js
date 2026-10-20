'use strict';

// Match before counting and paging so an issue cannot disappear on later pages.
function technicianIssueMatch(source, value) {
  if (!value || value === 'all') return null;
  if (source === 'order') {
    if (value === 'declined') return { status: 'technician_declined' };
    if (value === 'emergency') return { status: 'technician_declined', technicianId: null, 'staffingEmergencies.0': { $exists: true } };
  } else {
    const status = 'pending_reassignment';
    if (value === 'needs_reassignment') return { status };
    if (value === 'emergency') return { status, technicianId: null, 'staffingEmergencies.0': { $exists: true } };
    const lastAction = action => ({ $expr: { $eq: [{ $arrayElemAt: ['$cancellationHistory.action', -1] }, action] } });
    if (value === 'declined') return { status, $or: [{ 'technicianTeam.status': 'declined' }, lastAction('declined')] };
    if (value === 'cancelled') return { status, ...lastAction('cancelled') };
  }
  throw Object.assign(new Error('Choose a valid technician issue filter.'), { status: 400 });
}

module.exports = { technicianIssueMatch };
