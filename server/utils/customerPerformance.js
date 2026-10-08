'use strict';
const mongoose = require('mongoose');
const User = require('../models/User');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const ProductRefund = require('../models/ProductRefund');
const summary = require('./customerPerformanceSummary');
const { evaluateHistory, completedHistory, loadPolicy } = require('./loyaltyRewards');
const { ACCEPTED_PAYMENT_STATUSES } = require('./enterpriseRevenue');
const { parsePeriod, customerSummaryPipeline, presentRow, bookingCompletion, orderCompletion, bookingSuccess, orderSuccess, between, INACTIVE_WINDOWS, COMPLETED_BOOKINGS, HISTORY_NOTE } = summary;
const money = value => Math.max(0, Number(value) || 0);
const round = value => Math.round((Number(value) || 0) * 100) / 100;
const pageNumber = value => Math.min(100000, Math.max(1, parseInt(value, 10) || 1));
const itemRefundLookup = () => ({ $lookup: { from: ProductRefund.collection.name, localField: '_id', foreignField: 'sourceId', pipeline: [
  { $match: { sourceType: 'order', status: 'completed' } }, { $group: { _id: null, amount: { $sum: '$amount' } } },
], as: 'itemReturns' } });

function historyPeriod(query, selected, now) {
  if (!query.fromDate && !query.toDate) return selected;
  const dateKey = date => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  return parsePeriod({ range: 'custom', from: query.fromDate || (selected.range === 'all' ? '1970-01-01' : dateKey(selected.start)), to: query.toDate || dateKey(selected.end) }, now);
}

function historyPipeline(customerId, query, period, booking) {
  const status = query[booking ? 'bookingStatus' : 'orderStatus'] || 'successful';
  const statuses = (booking ? Booking : Order).schema.path('status').enumValues;
  if (!['successful', 'all', 'refunded', ...statuses].includes(status)) throw new Error('Choose a valid history status.');
  const pipeline = [{ $match: { [booking ? 'customerId' : 'userId']: customerId } }];
  if (booking) pipeline.push({ $lookup: { from: Order.collection.name, localField: '_id', foreignField: 'bookingId', pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: 'linkedOrders' } });
  else pipeline.push(itemRefundLookup(), { $set: { itemRefunds: { $ifNull: [{ $arrayElemAt: ['$itemReturns.amount', 0] }, 0] }, productNet: { $max: [0, { $subtract: [
    { $cond: [{ $gt: [{ $ifNull: ['$subtotal', 0] }, 0] }, '$subtotal', { $sum: '$items.totalPrice' }] }, { $ifNull: ['$discount', 0] } ] }] } } });
  const complete = booking ? { $in: ['$status', COMPLETED_BOOKINGS] } : { $eq: ['$status', 'completed'] };
  pipeline.push({ $set: { completion: booking ? bookingCompletion : orderCompletion, successful: booking ? bookingSuccess : orderSuccess } },
    { $set: { historyDate: { $cond: [complete, '$completion', '$createdAt'] } } });
  if (status === 'successful') pipeline.push({ $match: { successful: true, ...(booking ? { sourceOrderId: null, 'linkedOrders.0': { $exists: false } } : {}) } });
  else if (status === 'refunded') pipeline.push({ $match: { $expr: { $and: [complete, { $not: ['$successful'] }] } } });
  else if (status !== 'all') pipeline.push({ $match: { status } });
  pipeline.push({ $match: { $expr: between('$historyDate', period) } });
  return pipeline;
}

async function paginatedHistory(model, pipeline, projection, requestedPage, direction) {
  let page = pageNumber(requestedPage);
  const rowStages = () => [{ $sort: { historyDate: direction, _id: direction } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: projection }];
  const result = (await model.aggregate([...pipeline, { $facet: { count: [{ $count: 'total' }], rows: rowStages() } }]).allowDiskUse(true))[0];
  const total = result?.count[0]?.total || 0, lastPage = Math.max(1, Math.ceil(total / 20));
  let rows = result?.rows || [];
  if (page > lastPage) { page = lastPage; rows = await model.aggregate([...pipeline, ...rowStages()]).allowDiskUse(true); }
  return { total, page, pageSize: 20, rows };
}

async function customerCollections(customerId, period) {
  // Cash follows event dates; unknown payment dates never imply a collection.
  const cashRange = { ...period, range: 'custom' };
  const collection = { $ifNull: ['$verifiedAt', { $ifNull: ['$completedAt', { $ifNull: ['$collectedAt', '$submittedAt'] }] }] };
  const [payments, returns] = await Promise.all([
    Payment.aggregate([
      { $match: { $or: ['verifiedAt', 'completedAt', 'collectedAt', 'submittedAt', 'refundedAt'].map(field => ({ [field]: { $gte: period.start, $lte: period.end } })) } },
      { $lookup: { from: Booking.collection.name, localField: 'bookingId', foreignField: '_id', pipeline: [{ $match: { customerId } }, { $project: { _id: 1 } }], as: 'booking' } },
      { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', pipeline: [{ $match: { userId: customerId } }, { $project: { _id: 1 } }], as: 'order' } },
      { $match: { $or: [{ 'booking.0': { $exists: true } }, { 'order.0': { $exists: true } }] } },
      { $project: { collected: collection, refunded: { $ifNull: ['$refundedAt', collection] }, refundAmount: 1,
        gross: { $cond: [{ $in: ['$status', [...ACCEPTED_PAYMENT_STATUSES]] }, { $max: [0, { $ifNull: ['$amount', 0] }] }, 0] } } },
      { $group: { _id: null, gross: { $sum: { $cond: [between('$collected', cashRange), '$gross', 0] } }, refunds: { $sum: { $cond: [between('$refunded', cashRange), { $min: ['$gross', { $max: [0, { $ifNull: ['$refundAmount', 0] }] }] }, 0] } } } },
    ]).allowDiskUse(true),
    ProductRefund.aggregate([
      { $match: { sourceType: 'order', status: 'completed', processedAt: { $gte: period.start, $lte: period.end } } },
      { $lookup: { from: Order.collection.name, localField: 'sourceId', foreignField: '_id', pipeline: [{ $match: { userId: customerId } }, { $project: { _id: 1 } }], as: 'order' } },
      { $match: { 'order.0': { $exists: true } } }, { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]).allowDiskUse(true),
  ]);
  const gross = round(payments[0]?.gross), paymentRefunds = round(payments[0]?.refunds), itemRefunds = round(returns[0]?.amount), refunds = round(paymentRefunds + itemRefunds);
  return { gross, paymentRefunds, itemRefunds, refunds, net: round(gross - refunds) };
}

async function customerProfile(id, query = {}, now = new Date()) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const customerId = new mongoose.Types.ObjectId(id), period = parsePeriod(query, now);
  const inactiveDays = INACTIVE_WINDOWS.includes(Number(query.inactiveDays)) ? Number(query.inactiveDays) : 90;
  const recordPeriod = historyPeriod(query, period, now);
  // Validate history controls before running database queries.
  const bookingBase = historyPipeline(customerId, query, recordPeriod, true), orderBase = historyPipeline(customerId, query, recordPeriod, false);
  const [customers, policy] = await Promise.all([User.aggregate(customerSummaryPipeline(period, inactiveDays, now, customerId)).allowDiskUse(true), loadPolicy()]);
  if (!customers.length) return null;
  const customer = presentRow(customers[0]);
  customer.loyalty = evaluateHistory(policy, policy.enabled ? await completedHistory(customerId) : undefined);
  const bookingProjection = { bookingReference: 1, sourceOrderId: 1, linkedOrders: 1, 'service.name': 1,
    'services.name': 1, 'services.quantity': 1, 'services.applianceTypeName': 1, 'services.airconTypeName': 1, 'services.hp': 1, 'services.brand': 1, 'services.model': 1,
    applianceTypeName: 1, hp: 1, brand: 1, 'unitInfo.brand': 1, 'unitInfo.model': 1, quantity: 1, bookingDate: 1, 'schedule.scheduledDate': 1,
    status: 1, paymentStatus: 1, totalPrice: 1, estimatedFee: 1, discount: 1, loyaltyDiscount: 1, refundStatus: 1, refundAmount: 1, historyDate: 1, completion: 1, createdAt: 1 };
  const orderProjection = { orderReference: 1, 'items.modelLine': 1, 'items.brand': 1, 'items.capacity': 1, 'items.capacityUnit': 1, 'items.quantity': 1,
    status: 1, paymentStatus: 1, refundStatus: 1, refundAmount: 1, itemRefunds: 1, fulfillmentType: 1, subtotal: 1, discount: 1, loyaltyDiscount: 1, total: 1, historyDate: 1, completion: 1, createdAt: 1 };
  const [bookings, orders, services, products, collections] = await Promise.all([
    paginatedHistory(Booking, bookingBase, bookingProjection, query.bookingPage, query.historySort === 'oldest' ? 1 : -1),
    paginatedHistory(Order, orderBase, orderProjection, query.orderPage, query.historySort === 'oldest' ? 1 : -1),
    Booking.aggregate([...historyPipeline(customerId, {}, period, true),
      { $project: { lines: { $cond: [{ $gt: [{ $size: { $ifNull: ['$services', []] } }, 0] }, '$services', [{ name: '$service.name' }]] } } },
      { $unwind: '$lines' }, { $group: { _id: { booking: '$_id', name: { $ifNull: ['$lines.name', 'Unspecified service'] } } } },
      { $group: { _id: '$_id.name', bookings: { $sum: 1 } } }, { $sort: { bookings: -1, _id: 1 } }, { $limit: 20 },
    ]).allowDiskUse(true),
    Order.aggregate([...historyPipeline(customerId, {}, period, false), { $unwind: '$items' },
      { $group: { _id: { name: { $ifNull: ['$items.modelLine', 'Unspecified catalog item'] }, brand: '$items.brand', capacity: '$items.capacity', capacityUnit: '$items.capacityUnit' }, units: { $sum: '$items.quantity' }, orders: { $addToSet: '$_id' } } },
      { $project: { units: 1, orders: { $size: '$orders' } } }, { $sort: { units: -1, '_id.name': 1, '_id.brand': 1, '_id.capacity': 1, '_id.capacityUnit': 1 } }, { $limit: 20 },
    ]).allowDiskUse(true), customerCollections(customerId, period),
  ]);
  const refundAmount = record => ['completed', 'partial'].includes(record.refundStatus) ? money(record.refundAmount) : 0;
  bookings.rows = bookings.rows.map(booking => ({ id: String(booking._id), reference: booking.bookingReference || String(booking._id).slice(-8).toUpperCase(),
    linkedOrder: Boolean(booking.sourceOrderId || booking.linkedOrders?.length), services: (booking.services?.length ? booking.services : [booking.service || {}]).map(service => ({
      name: service.name || 'Service', unit: service.applianceTypeName || service.airconTypeName || booking.applianceTypeName || '', hp: service.hp || booking.hp || null,
      brand: service.brand || booking.unitInfo?.brand || booking.brand || '', model: service.model || booking.unitInfo?.model || '', quantity: service.quantity || booking.quantity || 1 })),
    requestedDate: booking.createdAt, scheduledDate: booking.schedule?.scheduledDate || booking.bookingDate || null, completedDate: COMPLETED_BOOKINGS.includes(booking.status) ? booking.completion : null,
    status: booking.status, paymentStatus: booking.paymentStatus, amount: money(booking.totalPrice ?? booking.estimatedFee), discount: money(booking.discount), loyaltyDiscount: booking.loyaltyDiscount || null,
    refundStatus: booking.refundStatus || 'none', refundAmount: refundAmount(booking) }));
  orders.rows = orders.rows.map(order => ({ id: String(order._id), reference: order.orderReference || String(order._id).slice(-8).toUpperCase(), date: order.createdAt, completedDate: order.status === 'completed' ? order.completion : null,
    items: (order.items || []).map(item => ({ name: [item.brand, item.modelLine].filter(Boolean).join(' ') || 'Catalog item', capacity: item.capacity ? `${item.capacity}${item.capacityUnit || ' HP'}` : '', quantity: item.quantity || 1 })),
    subtotal: money(order.subtotal), discount: money(order.discount), loyaltyDiscount: order.loyaltyDiscount || null, total: money(order.total), status: order.status, paymentStatus: order.paymentStatus,
    fulfillmentType: order.fulfillmentType, refundStatus: order.refundStatus || 'none', refundAmount: round(refundAmount(order) + money(order.itemRefunds)) }));
  return { customer, period: { range: period.range, from: period.start, to: period.end, inactiveDays }, asOf: now, bookings, orders, collections,
    servicePreferences: services.map(item => ({ name: item._id, bookings: item.bookings })),
    productPreferences: products.map(item => ({ name: [item._id.brand, item._id.name, item._id.capacity && `${item._id.capacity}${item._id.capacityUnit || ' HP'}`].filter(Boolean).join(' '), units: item.units, orders: item.orders })),
    note: HISTORY_NOTE + ' Service and product summaries show the top 20 in the analysis period; each booking counts once per service. History filters affect the record lists only. Loyalty uses lifetime qualifying completions and the existing Customer Privileges rules; checkout checks eligible items.' };
}

module.exports = { ...summary, customerProfile, historyPipeline, paginatedHistory };
