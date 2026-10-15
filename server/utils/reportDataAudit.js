'use strict';
const financial = require('./enterpriseRevenue');
const { bookingApprovedValue } = require('./revenueRecognition');
const { stockSnapshot } = require('./stockReportData');
const { isReportable } = require('./reportingScope');
const round = number => Math.round((Number(number) || 0) * 100) / 100;
const id = value => String(value?._id || value || '');
function auditReportRecords({ bookings=[], orders=[], payments=[], posSales=[], productRefunds=[], products=[], inventory=[], tools=[], ratings=[], projectPricing=new Map(), startDate, endDate }) {
  const linked = new Set(orders.map(row=>id(row.bookingId)).filter(Boolean));
  const services = bookings.filter(row=>isReportable(row)&&!row.sourceOrderId&&!linked.has(id(row._id)));
  const purchases = orders.filter(isReportable);
  const periodServices=services.filter(row=>financial.isRecognizedBooking(row,startDate,endDate));
  const periodOrders=purchases.filter(row=>financial.isRecognizedOrder(row,startDate,endDate));
  const periodPos=posSales.filter(row=>isReportable(row)&&row.status==='completed'&&financial.inRange(row.completedAt||row.createdAt,startDate,endDate));
  const cash=financial.summarizePaymentLedger(payments.filter(isReportable),{startDate,endDate,productRefunds});
  const posValue=periodPos.reduce((sum,row)=>sum+financial.money(row.totalAmount),0);
  const completedSales=periodServices.reduce((sum,row)=>sum+bookingApprovedValue(row,projectPricing),0)+periodOrders.reduce((sum,row)=>sum+financial.money(row.total),0)+posValue;
  const bookingIds=new Set(bookings.map(row=>id(row._id))), orderIds=new Set(orders.map(row=>id(row._id)));
  const completedWork=new Map([...bookings,...orders].map(row=>[id(row._id),row]));
  const pendingRefunds=payments.filter(row=>Number(row.refundAmount)>0&&!financial.completedRefund(row));
  const duplicates=new Map();
  ratings.forEach(row=>{const key=row.targetType+':'+id(row.targetId);duplicates.set(key,(duplicates.get(key)||0)+1);});
  const variants=products.flatMap(row=>row.variants||[]);
  return {
    mode:'read-only',timeZone:'Asia/Manila',period:{from:startDate.toISOString(),to:endDate.toISOString()},
    totals:{completedServiceBookings:periodServices.length,completedOrders:periodOrders.length,completedCounterSales:periodPos.length,
      completedSalesBeforeRefunds:round(completedSales),completedRefunds:round(cash.refunds),completedSalesAfterPeriodRefunds:round(completedSales-cash.refunds),
      paymentsReceived:round(cash.grossCollections+posValue),paymentsAfterRefunds:round(cash.netCollections+posValue)},
    stock:stockSnapshot(inventory,products,tools),
    findings:{
      excludedBookings:bookings.filter(row=>!isReportable(row)).length,excludedOrders:orders.filter(row=>!isReportable(row)).length,
      linkedInstallationsExcluded:bookings.filter(row=>row.sourceOrderId||linked.has(id(row._id))).length,
      completedBookingsUsingLegacyDate:services.filter(row=>financial.RECOGNIZED_BOOKING_STATUSES.has(row.status)&&!row.completedAt&&!row.repairCompletion?.completedAt&&!row.slaTracking?.resolutionAt).length,
      completedOrdersWithoutCompletionTimestamp:purchases.filter(row=>row.status==='completed'&&!row.completedAt).length,
      pendingRefundRequests:pendingRefunds.length,pendingRefundAmountNotCounted:round(pendingRefunds.reduce((sum,row)=>sum+financial.money(row.refundAmount),0)),
      orphanBookingPayments:payments.filter(row=>row.bookingId&&!bookingIds.has(id(row.bookingId))).length,
      orphanOrderPayments:payments.filter(row=>row.orderId&&!orderIds.has(id(row.orderId))).length,
      completedOrderLinesMissingSavedCost:periodOrders.flatMap(row=>row.items||[]).filter(row=>Number(row.quantity)>0&&!(Number(row.costPrice)>0)).length,
      stockRowsWithNegativeQuantity:[...inventory,...tools,...variants].filter(row=>Number(row.quantity)<0||Number(row.reservedQuantity)<0).length,
      stockRowsWithReservationsAboveOnHand:[...inventory,...tools,...variants].filter(row=>Number(row.reservedQuantity)>Number(row.quantity)).length,
      duplicateReviewTargets:[...duplicates.values()].filter(count=>count>1).length,
      unlinkedLegacyTechnicianReviews:ratings.filter(row=>row.targetType==='technician').length,
      orphanWorkReviews:ratings.filter(row=>['booking','order'].includes(row.targetType)&&!completedWork.has(id(row.targetId))).length,
      reviewsOnUnfinishedWork:ratings.filter(row=>['booking','order'].includes(row.targetType)&&completedWork.has(id(row.targetId))&&!financial.RECOGNIZED_BOOKING_STATUSES.has(completedWork.get(id(row.targetId)).status)).length,
    },
    notes:[
      'Counts describe the inspected records; no records, statuses, money, or inventory were changed.',
      'Completion-based sales and cash-event totals use different dates and need not equal creation-based Service, Order, or Customer Activity cohorts.',
      'Period refunds can exceed period sales when older transactions are refunded. Negative net sales alone do not prove corrupt data.',
      'Missing historical completion dates or saved costs require checking original business records; this audit does not invent replacements.',
    ],
  };
}
module.exports={auditReportRecords};
