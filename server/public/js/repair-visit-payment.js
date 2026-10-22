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
  function balance(booking) {
    const bill = summary(booking);
    const hasRepair = ['repair','mixed'].includes(booking?.serviceType) || (booking?.services || []).some(item => item.type === 'repair');
    const repairTotal = hasRepair ? amount(booking?.quotation?.totalCost) : 0;
    const total = hasRepair ? amount(bill.initialBookingTotal + repairTotal)
      : amount(booking?.totalPrice ?? booking?.estimatedFee ?? booking?.servicePrice ?? booking?.initialCost);
    const amountPaid = amount(booking?.amountPaid);
    const amountDue = amount(Math.max(0,total-amountPaid));
    return { total, amountPaid, amountDue, paidInFull: amountDue <= 0.01, repairTotal, firstVisitTotal: bill.initialBookingTotal };
  }
  function breakdown(booking) {
    const first = summary(booking), bill = balance(booking);
    const repairs = (booking?.services || []).filter(item => item.type === 'repair' && item.status !== 'cancelled');
    const units = repairs.flatMap(item => item.units || []);
    const decided = booking?.repairUnitTracking
      ? units.length > 0 && units.every(unit => ['approved', 'declined', 'completed'].includes(unit.repairReview?.state))
      : booking?.approval?.status ? ['approved', 'declined'].includes(booking.approval.status)
        : repairs.length > 0 && repairs.every(item => ['repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress', 'payment_pending', 'completed', 'repair_declined'].includes(item.status));
    const lines = [
      { key: 'core', label: 'Aircon services', amount: amount(first.initialBookingTotal - first.repairInspectionFee - first.distanceFare) },
      { key: 'inspection', label: 'Repair inspection', amount: first.repairInspectionFee },
      { key: 'repair', label: 'Approved repair', amount: bill.repairTotal },
      { key: 'travel', label: 'Travel fee', amount: first.distanceFare },
    ];
    const heldCore = (booking?.services || []).some(item => item.coreRepairHold?.state === 'on_hold');
    const refundReview = repairs.some(item => Number(item.discoveredDuringService?.refundReviewAmount) > 0.01);
    const blockedReason = heldCore ? 'Operations must review the paused core service before collecting the final payment.'
      : refundReview ? 'Operations must complete the recorded refund review before this booking is settled.' : '';
    return { ...bill, isMixedBooking: first.isMixedBooking, ready: !blockedReason && (!first.isMixedBooking || decided), quotationSettled: decided, blockedReason, lines };
  }
  function collection(booking) {
    const bill = breakdown(booking);
    const repairs = (booking?.services || []).filter(item => item.type === 'repair' && item.status !== 'cancelled');
    const hasRepair = ['repair','mixed'].includes(booking?.serviceType) || repairs.length > 0;
    const blocked = (code, reason) => ({ ...bill, allowed: false, code, reason });
    if (bill.blockedReason) return blocked('PAYMENT_REVIEW_REQUIRED', bill.blockedReason);
    if (!bill.ready) return blocked('QUOTATION_DECISION_REQUIRED', 'Finish the appliance quotation decisions before collecting one combined booking payment.');
    if (hasRepair && bill.repairTotal > 0) {
      const execution = booking?.repairExecution;
      const deferred = ['deferred','cancelled'].includes(execution?.status);
      const started = !deferred && (Boolean(execution?.startedAt) || booking?.status === 'repair_in_progress'
        || repairs.some(item => item.status === 'repair_in_progress')
        || ['repair_completed','under_warranty'].includes(booking?.status));
      const units = repairs.flatMap(item => item.units || []);
      const finished = repairs.length > 0 && repairs.every(item => item.status === 'completed');
      if (!started && !finished) return blocked('PHASE_TWO_NOT_STARTED', 'The quoted repair is not ready for collection. Start Phase 2 and finish the repair before collecting its payment. Inspection and completed core services can be settled separately when requesting a return visit.');
      if (booking?.repairUnitTracking && (!units.length || units.some(unit => !['completed','declined'].includes(unit.repairReview?.state) || unit.repairVerification?.outcome === 'follow_up_required'))) {
        return blocked('REPAIR_TESTS_REQUIRED', 'Record the repairs and test results for every approved appliance before collecting the quoted repair payment.');
      }
    }
    if (bill.isMixedBooking && summary(booking).corePending) return blocked('CORE_WORK_REQUIRED', 'Complete the remaining core services before collecting the final booking payment.');
    return { ...bill, allowed: true, code: '', reason: '' };
  }
  return { summary, balance, breakdown, collection };
});
