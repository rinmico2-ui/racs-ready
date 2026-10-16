'use strict';

const { ids, members, failure } = require('./standardJobTeam');

// Company-approved planning defaults. Use catalog/service fields, never customer
// instructions or AI-generated text, to decide the recommendation.
function staffingFor(source, job = {}) {
  const services = job.services?.length ? job.services.filter(row => !['cancelled', 'completed', 'repair_declined', 'repair_completed'].includes(row.status)) : [job.service];
  const names = services.map(row => [row?.name, row?.serviceName, row?.category].filter(value => typeof value === 'string').join(' '));
  const pairedService = names.find(name => /\b(re[-\s]?)?(install(?:ation|ing)?|dismantl(?:e|ing)|relocat(?:e|ion|ing)|uninstall(?:ation)?)\b/i.test(name));
  const installation = source === 'order' && job.fulfillmentType === 'delivery_installation';
  const existing = ids(job).length || (job.status === 'pending_reassignment' ? members(job).length : 0);
  const recommendedCount = Math.max(installation || pairedService ? 2 : 1, existing);
  const reason = existing > (installation || pairedService ? 2 : 1)
    ? `Keep the existing ${existing}-technician team when reassigning this job.`
    : installation || pairedService
      ? 'Company recommendation: two technicians for aircon installation, dismantling or relocation.'
      : 'Company recommendation: one technician for routine service or inspection.';
  return { recommendedCount, reason, policy: 'company-crew-20261016-v1', manualReview: job.isProject === true };
}

function recommendTeam(source, job, candidates) {
  const staffing = staffingFor(source, job);
  const complete = !staffing.manualReview && candidates.length >= staffing.recommendedCount;
  const recommendedTeam = complete ? candidates.slice(0, staffing.recommendedCount) : [];
  return { staffing, recommendedTeam, recommended: recommendedTeam[0] || null,
    issue: staffing.manualReview ? 'Use project resource planning for this job.' : complete ? null
      : `${staffing.recommendedCount} technicians recommended; only ${candidates.length} available together. Review staffing or choose another schedule.` };
}

function assertRecommendedCrew(source, job, input, technicianIds) {
  if (!['reviewed_plan', 'automatic'].includes(input.assignmentSource)) return;
  const staffing = staffingFor(source, job);
  if (staffing.manualReview) throw failure('Use project resource planning for this job.', 409, 'PROJECT_STAFFING_REQUIRED');
  if (technicianIds.length < staffing.recommendedCount) throw failure(
    `This recommendation needs ${staffing.recommendedCount} technicians. Refresh AI Assist or use Assign technicians to review staffing manually.`, 409, 'INCOMPLETE_RECOMMENDED_TEAM');
}

module.exports = { staffingFor, recommendTeam, assertRecommendedCrew };
