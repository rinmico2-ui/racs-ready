'use strict';

const line = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, field, max = 12) => (Array.isArray(value) ? value : []).slice(0, max)
  .map(item => line(typeof item === 'string' ? item : item?.[field])).filter(Boolean);

// Acceptance reports can contain several service analyses. Never use a different
// service's causes as choices for the appliance currently being inspected.
function repairPreVisitAssessment(document, row) {
  const report = document.technicianAssistant;
  if (!report?.summary || !row) return null;
  const analyses = Array.isArray(report.serviceAnalyses) ? report.serviceAnalyses : [];
  const repairGroups = (document.services || []).filter(group => group.type === 'repair');
  const matching = item => Number.isInteger(item?.serviceIndex) && item.serviceIndex === row.groupIndex
    && (!item.serviceId || !row.group.serviceId || String(item.serviceId) === String(row.group.serviceId));
  let selected;
  if (analyses.length) {
    const matches = analyses.filter(matching);
    if (matches.length !== 1) return null;
    selected = matches[0];
  } else if (repairGroups.length === 1) selected = report;
  else {
    const causes = (report.probableCauses || []).filter(matching);
    if (!causes.length) return null;
    selected = { summary:'Earlier suggestions for this repair service. Confirm them against this appliance’s checks.', probableCauses:causes,
      possibleParts:(report.possibleParts || []).filter(matching) };
  }
  return {
    summary:line(selected.summary, 4000),
    probableCauses:[...new Set(list(selected.probableCauses, 'cause'))].filter(cause => cause.length >= 5).map(cause => ({cause})),
    inspectionChecklist:list(selected.inspectionChecklist, 'action').map(action => ({action})),
    suggestedTools:list(selected.suggestedTools, 'name', 20),
    possibleParts:(Array.isArray(selected.possibleParts) ? selected.possibleParts : []).slice(0, 50).map(part => ({
      name:line(typeof part === 'string' ? part : part?.name, 200),
      quantity:Number.isInteger(part?.quantity) && part.quantity > 0 && part.quantity <= 999 ? part.quantity : 1,
    })).filter(part => part.name),
    repairComplexity:line(selected.repairComplexity, 30),
    reviewed:report.verifiedByTechnician === true,
  };
}

module.exports = {repairPreVisitAssessment};
