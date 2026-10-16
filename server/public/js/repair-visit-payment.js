(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepairVisitPayment = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const amount = value => Number.isFinite(Number(value)) ? Math.round(Math.max(0, Number(value)) * 100) / 100 : 0;
  const saved = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  function linePrice(item) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    if (saved(item.initialCost)) return amount(Number(item.initialCost) * quantity);
    if (saved(item.unitPrice)) return amount(Number(item.unitPrice) * quantity);
    return amount(item.totalPrice);
  }
  function summary(booking) {
    const services = Array.isArray(booking?.services) ? booking.services : [];
    const coreItems = services.filter(item => item.type === 'core' && item.status !== 'cancelled');
    const repairItems = services.filter(item => item.type === 'repair' && item.status !== 'cancelled');
    const isMixedBooking = booking?.serviceType === 'mixed' || coreItems.length > 0 && repairItems.length > 0;
    const allCoreCompleted = coreItems.length > 0 && coreItems.every(item => item.status === 'completed');
    const corePending = coreItems.some(item => item.status !== 'completed');
    const pricedRepairItems = repairItems.some(item => saved(item.initialCost) || saved(item.unitPrice) || saved(item.totalPrice));
    const repairInspectionFee = pricedRepairItems ? amount(repairItems.reduce((sum, item) => sum + linePrice(item), 0)) : amount(booking?.initialCost || booking?.servicePrice);
    const distanceFare = amount(booking?.travelFare);
    const inspectionTarget = amount(repairInspectionFee + distanceFare);
    const originalCore = coreItems.reduce((sum, item) => sum + linePrice(item), 0);
    const discount = Math.min(originalCore, amount(booking?.discount ?? booking?.loyaltyDiscount?.amount));
    // totalPrice/finalCost can already contain the later repair quotation.
    // The first visit uses original service prices, never the repair price.
    const hasCancelledCore = services.some(item => item.type === 'core' && item.status === 'cancelled');
    const legacyMixedTotal = isMixedBooking && !services.some(item => item.type === 'core')
      ? amount(booking?.totalPrice || booking?.estimatedFee) : 0;
    const initialBookingTotal = saved(booking?.totalInitialCost) && !hasCancelledCore
      ? Math.max(inspectionTarget, amount(booking.totalInitialCost))
      : Math.max(legacyMixedTotal, amount(inspectionTarget + originalCore - discount));
    const phaseOneTarget = corePending ? inspectionTarget : initialBookingTotal;
    const amountPaid = amount(booking?.amountPaid);
    const amountDue = amount(Math.max(0, phaseOneTarget - amountPaid));
    return { isMixedBooking, allCoreCompleted, corePending, repairInspectionFee, distanceFare, inspectionTarget,
      initialBookingTotal, phaseOneTarget, amountPaid, amountDue, credited: Math.min(amountPaid, phaseOneTarget),
      coreServiceAmount: corePending ? 0 : amount(Math.max(0, initialBookingTotal - inspectionTarget)), settled: amountDue <= 0.01 };
  }
  return { summary };
});
