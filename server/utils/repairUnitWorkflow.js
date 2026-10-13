'use strict';

function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function plain(value) { return value?.toObject ? value.toObject() : value; }
function unitKey(groupIndex, unitIndex) { return `G${groupIndex + 1}-U${String(unitIndex).padStart(3, '0')}`; }
function hasRepair(document) {
  return ['repair', 'mixed'].includes(document.serviceType) || document.repair?.serviceType === 'repair' || (document.services || document.unitGroups || []).some(g => (g.type || g.serviceType) === 'repair');
}
function initialUnits(item) {
  const quantity = Number(item.quantity || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40) fail('Enter a whole number of appliances from 1 to 40.', 400);
  const supplied = Array.isArray(item.units) ? item.units : [];
  return Array.from({ length: quantity }, (_, index) => {
    const prior = supplied.find(u => Number(u.unitIndex) === index + 1);
    return prior ? plain(prior) : {
      unitIndex: index + 1, label: `${item.name || item.serviceName || item.unitType || 'Appliance'} #${index + 1}`,
      problemDescription: item.problemDescription || item.repairIssue || '', status: 'pending',
      repairReview: { state: 'pending', revision: 0 },
    };
  });
}
function customerUnits(item) {
  const supplied = Array.isArray(item.units) ? item.units : [];
  if (supplied.length && supplied.length !== Number(item.quantity)) fail('Record details for each appliance, matching the quantity.', 400);
  return initialUnits({ ...item, units: [] }).map((unit, index) => {
    const label = String(supplied[index]?.label || unit.label).trim();
    const problem = String(supplied[index]?.problemDescription || unit.problemDescription).trim();
    if (!label || label.length > 100 || problem.length < 10 || problem.length > 2000) fail('Each appliance needs a label and a problem description of 10–2000 characters.', 400);
    return { ...unit, label, problemDescription: problem };
  });
}
function buildUnitGroups(booking) {
  const items = booking.services?.length ? booking.services : [{
    name: booking.service?.name || 'Repair', type: booking.serviceType,
    quantity: booking.quantity || 1, brand: booking.unitInfo?.brand || booking.brand,
    model: booking.unitInfo?.model, unitType: booking.unitInfo?.unitType,
    problemDescription: booking.unitInfo?.problemDescription || booking.issueDescription,
    unitPrice: booking.servicePrice, duration: (booking.serviceDurationMinutes || 90) / Math.max(1, booking.quantity || 1),
  }];
  return items.map((item, groupIndex) => ({
    groupIndex, applianceGroupId: item.applianceGroupId, applianceKind: item.applianceKind, serviceId: item.serviceId, serviceName: item.name, serviceType: item.type || 'core',
    unitType: item.unitType || item.applianceTypeName || item.airconTypeName || item.name || 'Appliance',
    brand: item.brand || '', model: item.model || '', applianceType: item.applianceType || item.airconType || '',
    applianceTypeName: item.applianceTypeName || item.airconTypeName || '', hp: item.hp, hpDescription: item.hpDescription,
    problemDescription: item.problemDescription || item.repairIssue || '', repairIssue: item.repairIssue || item.problemDescription || '',
    quantity: Number(item.quantity || 1), unitPrice: Number(item.unitPrice || 0), totalPrice: Number(item.totalPrice || 0),
    duration: Number(item.duration || 90), units: initialUnits(item),
  }));
}
function ensureUnits(document) {
  const groups = document.unitGroups || document.services || [];
  for (const group of groups) {
    if ((group.serviceType || group.type) !== 'repair') continue;
    group.units = initialUnits(group);
    for (const unit of group.units) {
      if (!unit.problemDescription) unit.problemDescription = group.problemDescription || group.repairIssue || '';
      if (!unit.repairReview?.state) unit.repairReview = { state: 'pending', revision: 0 };
    }
  }
  return rows(document);
}
function rows(document) {
  return (document.unitGroups || document.services || []).flatMap((group, position) => {
    const groupIndex = group.groupIndex ?? position;
    if ((group.serviceType || group.type) !== 'repair') return [];
    return (group.units || []).map(unit => ({ key: unitKey(groupIndex, unit.unitIndex), groupIndex, group, unit }));
  });
}
function money(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000) fail(`${label} must be a valid amount.`, 400);
  return Math.round(number * 100) / 100;
}
function inspect(document, key, input, { technicianId, catalog = [], laborFees }) {
  const row = ensureUnits(document).find(row => row.key === key);
  if (!row) fail('Appliance not found.', 404);
  if (!['pending', 'staff_review'].includes(row.unit.repairReview.state)) fail('This quote is already under review or decided. Staff must return it for changes.');
  const findings = String(input.findings || '').trim(), diagnosis = String(input.diagnosis || '').trim();
  if (findings.length < 10 || findings.length > 2000 || diagnosis.length < 5 || diagnosis.length > 2000) fail('Add inspection findings (10–2000 characters) and a diagnosis (5–2000 characters).', 400);
  if (!Array.isArray(input.parts) || input.parts.length > 50) fail('Provide up to 50 parts for this appliance.', 400);
  const parts = input.parts.map(part => {
    const quantity = Number(part.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) fail('Part quantities must be whole numbers from 1 to 999.', 400);
    const stored = part.toolId ? catalog.find(tool => String(tool._id) === String(part.toolId)) : null;
    if (part.toolId && !stored) fail('A selected repair part is unavailable.', 400);
    const name = String(stored?.itemName || part.name || '').trim();
    if (!name || name.length > 200) fail('Enter a part name of up to 200 characters.', 400);
    return { name, quantity, toolId: stored?._id || null, cost: money(stored ? stored.sellingPrice ?? stored.costPrice ?? 0 : part.cost, 'Part price') };
  });
  const category = String(input.laborCategory || 'standard');
  if (!Object.hasOwn(laborFees, category)) fail('Choose a valid labor category.', 400);
  const laborCost = money(laborFees[category], 'Labor price');
  row.unit.inspection = { findings, completedAt: new Date(), photos: row.unit.inspection?.photos || [] };
  row.unit.diagnosis = { summary: diagnosis, completedAt: new Date() };
  row.unit.quotation = { parts, laborCategory: category, laborCost, totalCost: money(parts.reduce((sum, part) => sum + part.cost * part.quantity, laborCost), 'Repair total'), notes: String(input.notes || '').slice(0, 2000) };
  row.unit.repairReview = { state: 'staff_review', revision: Number(row.unit.repairReview.revision || 0) + 1, inspectedBy: technicianId };
  row.unit.status = 'inspected';
  document.repairUnitTracking = true;
  return row;
}
function summary(document, state) {
  const selected = rows(document).filter(row => !state || state.includes(row.unit.repairReview?.state));
  const items = selected.map(({ key, unit }) => ({ description: `${key} · ${unit.label}`, quantity: 1, unitPrice: Number(unit.quotation?.totalCost || 0), total: Number(unit.quotation?.totalCost || 0) }));
  if (document.unitGroups) for (const group of document.unitGroups.filter(group => group.serviceType !== 'repair')) {
    const unitPrice = Number(group.unitPrice) || Number(group.totalPrice || 0) / Math.max(1, group.quantity);
    items.push({ description: group.serviceName || group.unitType || 'Service', quantity: group.quantity, unitPrice, total: unitPrice * group.quantity });
  }
  return { items, totalAmount: money(items.reduce((sum, item) => sum + item.total, 0), 'Quotation total') };
}
function submitInspection(document) {
  const units = ensureUnits(document);
  if (!units.length || units.some(row => row.unit.repairReview.state !== 'staff_review')) fail('Inspect and quote every appliance before submitting for staff review.');
  document.repairUnitTracking = true;
  document.inspectionReport = { findings: `Individual inspections recorded for ${units.length} appliances.`, submittedAt: new Date() };
  document.quotationReview = { ...summary(document), status: 'pending' };
  document.projectPhase = 'quotation_review';
}
function review(document, action, actorId, notes) {
  const units = rows(document);
  if (!units.length || units.some(row => row.unit.repairReview.state !== 'staff_review')) fail('All appliances must have an inspection and quote awaiting staff review.');
  if (!['approve', 'reject'].includes(action)) fail('Choose approve or return for changes.', 400);
  if (action === 'reject' && !String(notes || '').trim()) fail('Explain which changes are needed.', 400);
  for (const { unit } of units) {
    unit.repairReview.state = action === 'approve' ? 'customer_review' : 'pending';
    unit.repairReview.reviewedBy = actorId; unit.repairReview.reviewedAt = new Date();
    unit.repairReview.decisionNotes = String(notes || '').slice(0, 1000);
  }
  document.quotationReview = { ...summary(document), status: action === 'approve' ? 'awaiting_customer' : 'rejected', reviewedBy: actorId, reviewedAt: new Date(), rejectionReason: action === 'reject' ? notes : '' };
  if (document.unitGroups) document.projectPhase = action === 'approve' ? 'quotation_review' : 'assessment';
}
function decide(document, decisions, actorId) {
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 40) fail('Choose at least one appliance.', 400);
  const units = rows(document), seen = new Set();
  // Validate the whole request before changing any unit.
  const changes = decisions.map(decision => {
    const row = units.find(row => row.key === decision.key);
    if (!row || seen.has(decision.key) || typeof decision.approved !== 'boolean') fail('Choose distinct appliances and valid decisions.', 400);
    seen.add(decision.key);
    if (row.unit.repairReview.state !== 'customer_review' || Number(decision.revision) !== row.unit.repairReview.revision) fail('This quotation changed or was already decided. Refresh it before deciding.');
    return { row, decision };
  });
  for (const { row, decision } of changes) {
    row.unit.repairReview.state = decision.approved ? 'approved' : 'declined';
    row.unit.repairReview.decidedBy = actorId; row.unit.repairReview.decidedAt = new Date();
    row.unit.repairReview.decisionNotes = String(decision.notes || '').slice(0, 1000);
    if (!decision.approved) row.unit.status = 'skipped';
  }
  const settled = units.every(row => ['approved', 'declined', 'completed'].includes(row.unit.repairReview.state));
  if (settled) {
    document.quotationReview = { ...plain(document.quotationReview), ...summary(document, ['approved', 'completed']), status: 'approved' };
    if (document.unitGroups) document.projectPhase = 'execution';
  }
  return settled;
}
function selectCompletedUnits(project, workOrder, line) {
  const available = (workOrder.units || []).filter(unit => !['completed', 'cancelled', 'on_hold'].includes(unit.status));
  const repair = hasRepair(project) || workOrder.serviceType === 'repair';
  if (repair && !line.unitKeys?.length) fail('Select the exact appliances that were repaired.');
  const selected = line.unitKeys ? line.unitKeys.map(key => available.find(unit => unit.unitKey === key)) : available.slice(0, line.completedUnits);
  if (selected.length !== line.completedUnits || selected.some(unit => !unit) || new Set(selected.map(unit => unit.unitKey)).size !== selected.length) fail('One or more selected appliances are unavailable or already completed.');
  for (const unit of selected) {
    if (unit.serviceType !== 'repair' && workOrder.serviceType !== 'repair') continue;
    const record = rows(project).find(row => row.key === unit.unitKey);
    if (!record || record.unit.repairReview?.state !== 'approved') fail('Only customer-approved appliances can be marked repaired.');
  }
  return selected;
}
module.exports = { unitKey, hasRepair, initialUnits, customerUnits, buildUnitGroups, ensureUnits, rows, inspect, summary, submitInspection, review, decide, selectCompletedUnits, fail };
