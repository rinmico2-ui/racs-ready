'use strict';
const finance = require('./enterpriseRevenue');
const { bookingApprovedValue, normalizePaymentMethod, isRepairBooking } = require('./revenueRecognition');
const dates = require('./reportingDates');
const ref = value => String(value?._id || value || '');
const sum = (rows, field = 'amount') => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const money = finance.money;
const descending = rows => rows.sort((a,b) => new Date(b.date) - new Date(a.date) || String(a.id).localeCompare(String(b.id)));
const complete = row => finance.RECOGNIZED_BOOKING_STATUSES.has(row?.status);
const category = row => row.serviceType === 'mixed' || (row.services || []).some(item => item.type === 'repair') && (row.services || []).some(item => item.type !== 'repair') ? 'mix' : isRepairBooking(row) ? 'repair' : 'core';

function buildRevenueReconciliation({ bookings = [], orders = [], recognizedBookings = [], recognizedOrders = [], posSales = [], payments = [], cohortPayments = [], productRefunds = [], parentBookings = [], parentOrders = [], parentProjects = [], parentCounterSales = [], projectPricing = new Map(), startDate, endDate, methodFilter = null } = {}) {
  const bookingMap = new Map([...parentBookings,...bookings,...recognizedBookings].map(row => [ref(row._id),row]));
  const orderMap = new Map([...parentOrders,...orders,...recognizedOrders].map(row => [ref(row._id),row]));
  const projectMap = new Map(parentProjects.map(row => [ref(row._id),row]));
  const counterMap = new Map([...parentCounterSales,...posSales].map(row => [ref(row._id),row]));
  const completedKeys = new Set([
    ...recognizedBookings.map(row => 'service:'+ref(row._id)),
    ...recognizedOrders.map(row => 'order:'+ref(row._id)),
    ...posSales.map(row => 'pos:'+ref(row._id)),
  ]);
  function workRow(type, row, date) {
    return { id:type+':'+ref(row._id), type, reference:row.bookingReference || row.orderReference || row.invoiceNumber || row.workOrderNumber || 'Reference unavailable',
      customer:row.customer?.name || row.customerName || (type === 'pos' ? 'Walk-in customer' : 'Customer'),
      method:normalizePaymentMethod(row.paymentMethod), workStatus:row.status || 'unknown', status:row.paymentStatus || (type === 'pos' ? row.status : 'unknown'),
      date, monthKey:dates.dateKey(date).slice(0,7), fulfillment:row.fulfillmentType || (type === 'order' ? 'delivery_only' : ''),
      amount:type === 'service' ? bookingApprovedValue(row,projectPricing) : money(type === 'order' ? row.total ?? row.totalAmount : row.totalAmount) };
  }
  function target(payment) {
    if (payment.orderId) return { type:'order', row:orderMap.get(ref(payment.orderId)) };
    const project = projectMap.get(ref(payment.projectId));
    const booking = bookingMap.get(ref(payment.bookingId || project?.bookingId));
    return { type:'service', row:booking || (project ? { ...project, bookingReference:project.projectReference || 'Project', _id:project.bookingId || project._id } : null) };
  }
  function cashGroup(type,row) {
    if (!row) return 'unmatched_work';
    if (completedKeys.has(type+':'+ref(row._id))) return 'completed_in_period';
    if (row.archivedAt) return 'archived_work';
    if (['cancelled','rejected','repair_declined','no-show'].includes(row.status)) return 'cancelled_work';
    return complete(row) ? 'other_completed_work' : 'unfinished_work';
  }
  function event(type,row,payment,kind,amount,date,method) {
    return { ...workRow(type,row || {_id:'missing',status:'missing'},date), id:ref(payment._id)+':'+kind,
      reference:row ? workRow(type,row,date).reference : 'Payment #'+ref(payment._id).slice(-8).toUpperCase(),
      customer:row?.customer?.name || row?.customerName || (row ? 'Customer' : 'Work record unavailable'),
      kind, amount, method:normalizePaymentMethod(method), status:payment.status || 'completed', group:cashGroup(type,row),
      paymentRecordId:ref(payment._id) };
  }
  const completedRows = descending([
    ...recognizedBookings.map(row => workRow('service',row,finance.bookingCompletionDate(row))),
    ...recognizedOrders.map(row => workRow('order',row,finance.orderCompletionDate(row))),
    ...posSales.map(row => workRow('pos',row,row.completedAt || row.createdAt)),
  ]);
  const paymentEvents = [];
  for (const payment of payments) {
    const {type,row} = target(payment), amounts = finance.paymentAmounts(payment);
    if (amounts.gross > 0 && finance.inRange(finance.collectionDate(payment),startDate,endDate) && (!methodFilter || normalizePaymentMethod(payment.method) === methodFilter)) paymentEvents.push(event(type,row,payment,'collection',amounts.gross,finance.collectionDate(payment),payment.method));
    const method = payment.refundMethod || payment.method;
    if (amounts.refunded > 0 && finance.inRange(finance.refundDate(payment),startDate,endDate) && (!methodFilter || normalizePaymentMethod(method) === methodFilter)) paymentEvents.push(event(type,row,payment,'refund',-amounts.refunded,finance.refundDate(payment),method));
  }
  for (const sale of posSales) paymentEvents.push(event('pos',sale,{...sale,status:'completed'},'collection',money(sale.totalAmount),sale.completedAt || sale.createdAt,sale.paymentMethod));
  for (const refund of productRefunds) {
    if (refund.status !== 'completed' || !finance.inRange(refund.processedAt,startDate,endDate) || refund.testDataExcludedAt || refund.archivedAt || methodFilter && normalizePaymentMethod(refund.method) !== methodFilter) continue;
    const type = refund.sourceType === 'order' ? 'order' : 'pos';
    paymentEvents.push(event(type,type === 'order' ? orderMap.get(ref(refund.sourceId)) : counterMap.get(ref(refund.sourceId)),refund,'refund',-money(refund.amount),refund.processedAt,refund.method));
  }
  descending(paymentEvents);
  const byTarget = new Map();
  for (const payment of cohortPayments) {
    const destination = target(payment);
    if (!destination.row) continue;
    const key = destination.type+':'+ref(destination.row._id);
    if (!byTarget.has(key)) byTarget.set(key,[]);
    byTarget.get(key).push(payment);
  }
  const requestedRows = descending([
    ...bookings.map(row => workRow('service',row,row.createdAt)),
    ...orders.map(row => workRow('order',row,row.createdAt)),
    ...posSales.map(row => workRow('pos',row,row.completedAt || row.createdAt)),
  ]).map(row => {
    const received = row.type === 'pos' ? row.amount : finance.grossPaymentsThrough(byTarget.get(row.id) || [],endDate);
    return { ...row, received, appliedPayment:Math.min(received,row.amount), balance:Math.max(0,row.amount-received), paymentMismatch:row.status === 'paid' && row.amount-received > 0.01 };
  });
  const groupNames = {completed_in_period:'Completed in selected dates',unfinished_work:'Unfinished work',other_completed_work:'Other completed work outside this sales selection',cancelled_work:'Cancelled work',archived_work:'Archived work',unmatched_work:'Booking or order no longer found'};
  const cashBreakdown = Object.entries(groupNames).map(([key,label]) => {
    const rows = paymentEvents.filter(row => row.group === key);
    return { key,label,collections:sum(rows.filter(row => row.kind === 'collection')),refunds:Math.abs(sum(rows.filter(row => row.kind === 'refund'))),records:new Set(rows.map(row => row.paymentRecordId)).size };
  });
  const grossSales = sum(completedRows), grossCollections = sum(paymentEvents.filter(row => row.kind === 'collection'));
  const refunds = Math.abs(sum(paymentEvents.filter(row => row.kind === 'refund')));
  const requestedValue = sum(requestedRows), appliedPayments = sum(requestedRows,'appliedPayment'), unpaidBalance = sum(requestedRows,'balance');
  const serviceRows = completedRows.filter(row => row.type === 'service'), orderRows = completedRows.filter(row => row.type === 'order');
  const serviceRevenue = sum(serviceRows), orderRevenue = sum(orderRows), posRevenue = sum(completedRows.filter(row => row.type === 'pos'));
  const salesView = {
    totalRevenue:grossSales,serviceRevenue,orderRevenue,posRevenue,serviceTransactions:serviceRows.length,orderTransactions:orderRows.length,posTransactions:posSales.length,totalTransactions:completedRows.length,
    onlineOrderTransactions:recognizedOrders.filter(row => row.salesChannel !== 'walk_in').length,walkInOrderTransactions:recognizedOrders.filter(row => row.salesChannel === 'walk_in').length,
    onlineOrderRevenue:sum(recognizedOrders.filter(row => row.salesChannel !== 'walk_in').map(row => workRow('order',row,finance.orderCompletionDate(row)))),
    walkInOrderRevenue:sum(recognizedOrders.filter(row => row.salesChannel === 'walk_in').map(row => workRow('order',row,finance.orderCompletionDate(row)))),
    avgServiceTicket:serviceRevenue/(serviceRows.length||1),avgOrderValue:orderRevenue/(orderRows.length||1),avgPosSale:posRevenue/(posSales.length||1),
    serviceShare:grossSales ? serviceRevenue/grossSales*100 : 0,orderShare:grossSales ? orderRevenue/grossSales*100 : 0,posShare:grossSales ? posRevenue/grossSales*100 : 0,
    coreRevenue:sum(recognizedBookings.filter(row => category(row) === 'core').map(row => workRow('service',row,finance.bookingCompletionDate(row)))),
    repairRevenue:sum(recognizedBookings.filter(row => category(row) === 'repair').map(row => workRow('service',row,finance.bookingCompletionDate(row)))),
    mixRevenue:sum(recognizedBookings.filter(row => category(row) === 'mix').map(row => workRow('service',row,finance.bookingCompletionDate(row)))),
  };
  return { salesView, activity:{completed:completedRows,payments:paymentEvents,requested:requestedRows},
    reconciliation:{grossSales,grossCollections,refunds,netSales:grossSales-refunds,netCollections:grossCollections-refunds,requestedValue,appliedPayments,unpaidBalance,
      paidCoveragePercent:requestedValue > 0 ? appliedPayments/requestedValue*100 : 0,cashBreakdown,
      unmatchedPaymentRecords:cashBreakdown.find(row => row.key === 'unmatched_work').records,
      unmatchedCollections:cashBreakdown.find(row => row.key === 'unmatched_work').collections,
      paidStatusMismatchCount:requestedRows.filter(row => row.paymentMismatch).length,
    } };
}
module.exports = {buildRevenueReconciliation};
