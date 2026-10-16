'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const Project = require('../models/Project');
const Technician = require('../models/Technician');
const finance = require('./enterpriseRevenue');
const dates = require('./reportingDates');
const { normalizePaymentMethod } = require('./revenueRecognition');
const { context } = require('./paymentPresentation');
const { reportableMatch } = require('./reportingScope');

function filters(query = {}) {
  const error = message => { throw Object.assign(Error(message), { status: 400 }); };
  const scalar = key => { const value = query[key]; if (value !== undefined && typeof value !== 'string') error('Choose valid payment filters.'); return value; };
  const exact = (key, allowed) => { const value = scalar(key); if (value && value !== 'all' && !allowed.includes(value)) error('Choose a valid payment ' + key + '.'); return value && value !== 'all' ? value : null; };
  const status = exact('status', [...Payment.schema.path('status').enumValues, 'completed']);
  const method = exact('method', Payment.schema.path('method').enumValues);
  const gateway = exact('gateway', Payment.schema.path('gateway').enumValues);
  const type = exact('type', Payment.schema.path('type').enumValues);
  const search = scalar('search') || '';
  if (search.length > 100) error('Search must be 100 characters or fewer.');
  const page = Number(scalar('page') || 1), pageSize = Number(scalar('pageSize') || 25);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || ![10, 25, 50, 100].includes(pageSize)) error('Choose a valid payment page.');
  const from = scalar('from') || scalar('startDate') || scalar('date');
  const to = scalar('to') || scalar('endDate') || scalar('date');
  const start = from ? dates.parseDate(from) : dates.startOfMonth(new Date(), -11), end = to ? dates.parseDate(to, true) : dates.endOfDay(new Date());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) error('Choose valid payment dates in chronological order.');
  const match = reportableMatch();
  for (const key of ['bookingId', 'orderId']) {
    const value = scalar(key);
    if (value) { if (!mongoose.isObjectIdOrHexString(value)) error('Choose a valid booking or order.'); match[key] = new mongoose.Types.ObjectId(value); }
  }
  if (status) match.status = status === 'paid' || status === 'completed' ? { $in: ['paid', 'completed'] } : status;
  if (method) {
    const aliases = method === 'cash' || method === 'cod' ? { $in: ['cash', 'cod'] } : method;
    match.$or = [{ method: aliases }, { refundMethod: aliases }];
  }
  if (gateway) match.gateway = gateway;
  if (type) match.type = type;
  const gatewayStatus = scalar('gatewayStatus');
  if (gatewayStatus && gatewayStatus !== 'all') { if (!/^[a-z_ -]{1,40}$/i.test(gatewayStatus)) error('Choose a valid gateway status.'); match.gatewayStatus = gatewayStatus; }
  return { match, search: search.trim(), page, pageSize, start, end, method: method ? normalizePaymentMethod(method) : null };
}

function pipeline(filter) {
  const projection = Object.fromEntries(['bookingId', 'orderId', 'projectId', 'amount', 'method', 'type', 'status', 'gateway', 'gatewayStatus',
    'reference', 'submittedAt', 'collectedAt', 'verifiedAt', 'completedAt', 'refundedAt', 'refundAmount', 'refundStatus', 'refundMethod',
    'collectedBy', 'collectedByName', 'testDataExcludedAt'].map(field => [field, 1]));
  const join = (model, localField, name, fields, foreignField = '_id') => ({ $lookup: { from: model.collection.name, localField, foreignField,
    pipeline: [{ $project: Object.fromEntries(fields.split(' ').map(field => [field, 1])) }], as: name } });
  return [
    { $match: filter.match },
    { $match: { $or: ['collectedAt', 'verifiedAt', 'completedAt', 'submittedAt', 'refundedAt'].map(field => ({ [field]: { $gte: filter.start, $lte: filter.end } })) } },
    { $project: { ...projection, hasProof: { $ne: [{ $ifNull: ['$proofUrl', ''] }, ''] } } },
    { $set: { activityAt: { $ifNull: ['$collectedAt', '$verifiedAt', '$completedAt', '$submittedAt'] } } },
    { $match: { $or: [{ activityAt: { $gte: filter.start, $lte: filter.end } }, { refundedAt: { $gte: filter.start, $lte: filter.end } }] } },
    join(Project, 'projectId', '_project', 'bookingId projectReference customer status createdAt title'),
    { $set: { _sourceBooking: { $ifNull: ['$bookingId', { $arrayElemAt: ['$_project.bookingId', 0] }] } } },
    join(Booking, '_sourceBooking', '_booking', 'bookingReference sourceOrderId customer status paymentMethod paymentChannel paymentStatus bookingDate createdAt service.name services.name'),
    { $lookup: { from: Order.collection.name, let: { booking: { $ifNull: ['$_sourceBooking', null] } },
      pipeline: [{ $match: { $expr: { $and: [{ $ne: ['$$booking', null] }, { $eq: ['$bookingId', '$$booking'] }] } } }, { $project: { _id: 1 } }, { $limit: 1 }], as: '_legacyOrder' } },
    { $set: { _sourceOrder: { $ifNull: ['$orderId', { $arrayElemAt: ['$_booking.sourceOrderId', 0] }, { $arrayElemAt: ['$_legacyOrder._id', 0] }] } } },
    join(Order, '_sourceOrder', '_order', 'orderReference customer status paymentMethod paymentStatus createdAt delivery.preferredDate pickupDate items.modelLine items.quantity'),
    join(Technician, 'collectedBy', '_collector', 'name'),
    { $sort: { activityAt: -1, _id: -1 } },
  ];
}

function newSummary(now = new Date()) {
  const end = dates.endOfDay(now), start = dates.addDays(dates.startOfDay(now), -29);
  const trend = Array.from({ length: 30 }, (_, index) => ({ date: dates.dateKey(dates.addDays(start, index)), amount: 0 }));
  return { total: 0, grossCollections: 0, refunds: 0, netCollections: 0, collectedRecords: 0,
    monthlyCollections: 0, awaitingRemittance: 0, highest: 0, lowest: null,
    statuses: {}, methods: {}, trend, trendStart: start, trendEnd: end, monthStart: dates.startOfMonth(now) };
}
function add(summary, payment, filter) {
  summary.total++;
  const status = payment.status === 'completed' ? 'paid' : payment.status;
  const group = summary.statuses[status] ||= { count: 0, amount: 0 };
  group.count++; group.amount += finance.money(payment.amount);
  const ledger = finance.summarizePaymentLedger([payment], { startDate: filter.start, endDate: filter.end, normalizeMethod: normalizePaymentMethod, methodFilter: filter.method });
  summary.grossCollections += ledger.grossCollections;
  summary.refunds += ledger.refunds;
  summary.netCollections += ledger.netCollections;
  if (ledger.grossCollections > 0) {
    summary.collectedRecords++;
    summary.highest = Math.max(summary.highest, ledger.grossCollections);
    summary.lowest = summary.lowest === null ? ledger.grossCollections : Math.min(summary.lowest, ledger.grossCollections);
    const method = normalizePaymentMethod(payment.method);
    summary.methods[method] = (summary.methods[method] || 0) + ledger.grossCollections;
    if (finance.inRange(finance.collectionDate(payment), summary.monthStart, summary.trendEnd)) summary.monthlyCollections += ledger.grossCollections;
    if (['payment_collected', 'waiting_for_remittance', 'remitted', 'partial', 'unaccounted', 'rejected'].includes(payment.status) && payment.collectedBy) summary.awaitingRemittance += ledger.grossCollections;
    const row = summary.trend.find(row => row.date === dates.dateKey(finance.collectionDate(payment)));
    if (row) row.amount += ledger.grossCollections;
  }
}

async function buildPaymentLedgerView(query = {}) {
  const filter = filters(query), summary = newSummary();
  const rows = [], offset = (filter.page - 1) * filter.pageSize;
  const cursor = Payment.aggregate(pipeline(filter)).option({ maxTimeMS: 20000 }).cursor({ batchSize: 250 });
  // Stream narrow metadata so neither evidence blobs nor an arbitrary 1,000-row
  // cutoff can change the dashboard totals. Only one page is retained in memory.
  try {
    for await (const payment of cursor) {
      const row = { ...payment, ...context(payment, { booking: payment._booking?.[0], order: payment._order?.[0], project: payment._project?.[0], collector: payment._collector?.[0] }) };
      if (filter.search && ![row._id, row.bookingReference, row.customerName, row.customerEmail, row.serviceName, row.reference, row.collectedByName]
        .some(value => String(value || '').toLowerCase().includes(filter.search.toLowerCase()))) continue;
      const index = summary.total;
      add(summary, row, filter);
      if (index >= offset && rows.length < filter.pageSize) {
        for (const key of Object.keys(row)) if (key.startsWith('_') && key !== '_id') delete row[key];
        rows.push(row);
      }
    }
  } finally { await cursor.close(); }
  return { payments: rows, summary, pagination: { page: filter.page, pageSize: filter.pageSize, total: summary.total, totalPages: Math.max(1, Math.ceil(summary.total / filter.pageSize)) },
    period: { from: filter.start, to: filter.end, timeZone: dates.TIME_ZONE },
    basis: 'Payment ledger only. Collected amounts include technician-held payments; completed POS counter sales are reported separately in Sales and Payments.' };
}

module.exports = { buildPaymentLedgerView, filters, pipeline, newSummary, add };
