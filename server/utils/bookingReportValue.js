'use strict';
const { serviceLineValue } = require('./transactionDiscounts');
const positive = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
function hasRepair(booking) {
  const items = booking?.services || [];
  if (items.some(item => item.type === 'repair')) return true;
  if (booking?.serviceType === 'core' || booking?.serviceModel === 'CoreService') return false;
  return ['repair','mixed'].includes(booking?.serviceType) || booking?.serviceModel === 'RepairService'
    || Boolean(booking && (booking.workOrderNumber || booking.repairIssues || booking.issueDescription || booking.unitInfo?.problemDescription || booking.inspection?.completedAt || booking.diagnosis?.completedAt || booking.quotation?.createdAt || booking.repairPaymentCollected || positive(booking.repairPaymentAmount) || positive(booking.inspectionFeeTotalCollected)));
}
function bookingReportValue(booking) {
  if (!booking || booking.sourceOrderId || booking.archivedAt || booking.testDataExcludedAt) return 0;
  if (!hasRepair(booking) || booking.isProject) return positive(booking.totalPrice ?? booking.estimatedFee ?? booking.servicePrice);
  const items = booking.services || [];
  const repairs = items.filter(item => item.type === 'repair');
  const core = items.filter(item => item.type !== 'repair').reduce((sum, item) => sum + serviceLineValue(item), 0);
  const inspection = positive(booking.inspectionFeeAmount) + positive(booking.inspectionFeeDistanceFare)
    || positive(booking.inspectionFeeTotalCollected)
    || repairs.reduce((sum, item) => sum + positive(item.initialCost ?? item.unitPrice) * Math.max(1, Number(item.quantity) || 1), 0)
    || positive(booking.initialCost);
  const itemQuotes = repairs.filter(item => item.approval?.status === 'approved' || (!item.approval?.status && booking.approval?.status === 'approved'))
    .reduce((sum, item) => sum + positive(item.quotation?.totalCost), 0);
  const quotation = itemQuotes || (booking.approval?.status === 'approved' ? positive(booking.quotation?.totalCost) : 0);
  const finalRepair = positive(booking.totalFinalCost) || positive(booking.finalCost) || quotation;
  // Legacy inspectionFeeDistanceFare already contains the visit's travel charge.
  const travel = positive(booking.inspectionFeeDistanceFare) ? 0 : positive(booking.travelFare);
  const calculated = Math.max(0, core - positive(booking.discount)) + inspection + finalRepair + travel;
  return calculated || positive(booking.totalPrice ?? booking.estimatedFee ?? booking.servicePrice);
}

// The customer aggregation uses the same approved-value rules without loading
// every customer's transaction history into application memory.
function bookingValueExpression() {
  const value = path => ({ $max: [0, { $ifNull: [path, 0] }] });
  const firstPositive = (...values) => values.reduceRight((fallback, item) => ({ $cond: [{ $gt: [item, 0] }, item, fallback] }), 0);
  const qty = { $max: [1, { $ifNull: ['$$item.quantity', 1] }] };
  const repairs = { $filter: { input: { $ifNull: ['$services', []] }, as: 'item', cond: { $eq: ['$$item.type', 'repair'] } } };
  const core = { $filter: { input: { $ifNull: ['$services', []] }, as: 'item', cond: { $ne: ['$$item.type', 'repair'] } } };
  const coreAmount = { $sum: { $map: { input: core, as: 'item', in: { $max: [0, { $cond: [
    { $and: [{ $eq: ['$$item.costUpdatedByTechnician', true] }, { $ne: [{ $ifNull: ['$$item.finalCost', null] }, null] }] },
    { $multiply: [value('$$item.finalCost'), qty] },
    { $ifNull: ['$$item.totalPrice', { $multiply: [value('$$item.unitPrice'), qty] }] },
  ] }] } } } };
  const inspectionItems = { $sum: { $map: { input: repairs, as: 'item', in: { $multiply: [value({ $ifNull: ['$$item.initialCost', '$$item.unitPrice'] }), qty] } } } };
  const inspections = firstPositive({ $add: [value('$inspectionFeeAmount'), value('$inspectionFeeDistanceFare')] }, value('$inspectionFeeTotalCollected'), inspectionItems, value('$initialCost'));
  const quotes = { $sum: { $map: { input: repairs, as: 'item', in: { $cond: [{ $or: [
    { $eq: ['$$item.approval.status', 'approved'] },
    { $and: [{ $eq: [{ $ifNull: ['$$item.approval.status', null] }, null] }, { $eq: ['$approval.status', 'approved'] }] },
  ] }, value('$$item.quotation.totalCost'), 0] } } } };
  const approved = firstPositive(value('$totalFinalCost'), value('$finalCost'), quotes, { $cond: [{ $eq: ['$approval.status', 'approved'] }, value('$quotation.totalCost'), 0] });
  const legacyRepair = { $or: ['workOrderNumber','repairIssues','issueDescription','unitInfo.problemDescription','inspection.completedAt','diagnosis.completedAt','quotation.createdAt','repairPaymentCollected','repairPaymentAmount','inspectionFeeTotalCollected'].map(field => ({ $not: [{ $in: [{ $ifNull: ['$' + field, null] }, [null, '', false, 0]] }] })) };
  const repair = { $or: [{ $gt: [{ $size: repairs }, 0] }, { $and: [{ $ne: ['$serviceType', 'core'] }, { $ne: ['$serviceModel', 'CoreService'] }, { $or: [{ $in: ['$serviceType', ['repair','mixed']] }, { $eq: ['$serviceModel', 'RepairService'] }, legacyRepair] }] }] };
  const saved = value({ $ifNull: ['$totalPrice', { $ifNull: ['$estimatedFee', '$servicePrice'] }] });
  const calculated = { $add: [{ $max: [0, { $subtract: [coreAmount, value('$discount')] }] }, inspections, approved, { $cond: [{ $gt: [value('$inspectionFeeDistanceFare'), 0] }, 0, value('$travelFare')] }] };
  return { $cond: [{ $or: ['sourceOrderId','archivedAt','testDataExcludedAt'].map(field => ({ $ne: [{ $ifNull: ['$' + field, null] }, null] })) }, 0, { $cond: [
    { $and: [repair, { $ne: ['$isProject', true] }] }, firstPositive(calculated, saved), saved,
  ] }] };
}
module.exports = { bookingReportValue, bookingValueExpression, hasRepair };
