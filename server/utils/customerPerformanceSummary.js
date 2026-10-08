'use strict';
const User = require('../models/User');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const ProductRefund = require('../models/ProductRefund');
const { manilaDateParts, manilaDateTime, strictManilaDateKey } = require('./bookingDateTime');
const { remember } = require('./reportCache');
const DAY = 86400000;
const COMPLETED_BOOKINGS = ['completed', 'repair_completed', 'closed'];
const INACTIVE_WINDOWS = [30, 60, 90, 180];
const PAGE_SIZE = 25;
const round = value => Math.round((Number(value) || 0) * 100) / 100;
const money = value => Math.max(0, Number(value) || 0);
const between = (field, period) => {
  const dated = { $and: [{ $gte: [field, period.start] }, { $lte: [field, period.end] }] };
  return period.range === 'all' ? { $or: [dated, { $eq: [{ $ifNull: [field, null] }, null] }] } : dated;
};
const ifSum = (test, value = 1) => ({ $sum: { $cond: [test, value, 0] } });
const lastIf = (test, field) => ({ $max: { $cond: [test, field, null] } });
const HISTORY_NOTE = 'Completed activity uses completion dates, with the recorded last update as the fallback for older records. Pending and cancelled records do not count. Fully refunded transactions are separate from successful engagement. Linked installation bookings are excluded to avoid counting an order twice. Spending is completed transaction value after recorded discounts and completed refunds, including applicable fulfillment fees; cash collections are a separate measure. Anonymous counter sales cannot be assigned to a customer account.';

function parsePeriod(query = {}, now = new Date()) {
  const range = ['all', 'month', '3months', '6months', 'year', 'custom'].includes(query.range) ? query.range : 'all';
  const parts = manilaDateParts(now);
  let start = new Date(0), end = new Date(now);
  if (range === 'month') start = new Date(Date.UTC(parts.year, parts.month, 1) - 8 * 3600000);
  if (range === 'year') start = new Date(Date.UTC(parts.year, 0, 1) - 8 * 3600000);
  if (range === '3months' || range === '6months') {
    const target = new Date(Date.UTC(parts.year, parts.month - (range === '3months' ? 3 : 6), 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(parts.day, lastDay)) - 8 * 3600000);
  }
  if (range === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')
      || strictManilaDateKey(query.from) !== query.from || strictManilaDateKey(query.to) !== query.to) throw new Error('Choose valid start and end dates.');
    start = new Date(query.from + 'T00:00:00+08:00');
    end = new Date(query.to + 'T23:59:59.999+08:00');
    if (start > end || end > new Date(manilaDateTime(now, 0).getTime() + DAY - 1)) throw new Error('Choose a valid date range ending today or earlier.');
    if (end > now) end = new Date(now);
  }
  return { range, start, end };
}

function transactionBreakdown(booking = {}, order = {}, itemRefund = 0) {
  const serviceValue = round(money(booking.serviceValue)), orderValue = round(money(order.orderValue));
  const productValue = round(money(order.productValue));
  const discounts = round(money(order.productDiscounts) + money(booking.serviceDiscounts));
  const refunds = round(money(booking.serviceRefunds) + money(order.productRefunds) + money(itemRefund));
  return { serviceValue, orderValue, productValue, orderFees: round(Math.max(0, orderValue - productValue)), discounts, refunds,
    recordedSpending: round(Math.max(0, serviceValue + orderValue - refunds)), grossTransactionValue: round(serviceValue + orderValue + discounts) };
}

function classifyCustomer(row, period, inactiveDays, now = new Date()) {
  const lifetimeTransactions = money(row.lifetimeBookings) + money(row.lifetimeOrders);
  const lastActivity = [row.lifetimeLastBooking, row.lifetimeLastOrder].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const daysSinceLastActivity = lastActivity ? Math.max(0, Math.floor((now - new Date(lastActivity)) / DAY)) : null;
  const recentlyActive = Boolean(lastActivity && new Date(lastActivity) >= new Date(now.getTime() - inactiveDays * DAY));
  const previouslyActiveNowInactive = lifetimeTransactions >= 5 && Boolean(lastActivity) && !recentlyActive;
  const engagement = !lifetimeTransactions ? 'Never Engaged' : !lastActivity ? 'Activity date unavailable'
    : previouslyActiveNowInactive ? 'Previously Active / Now Inactive' : !recentlyActive ? 'Inactive'
      : lifetimeTransactions <= 2 ? 'Very Low Engagement' : lifetimeTransactions < 5 ? 'Low Engagement' : 'Active';
  const customerType = row.completedBookings && row.completedOrders ? 'Bookings + orders' : row.completedBookings ? 'Service customer' : row.completedOrders ? 'Product customer' : 'No period activity';
  return { engagement, customerType, lifetimeTransactions, lastActivity, daysSinceLastActivity, recentlyActive, previouslyActiveNowInactive,
    newAccount: Boolean(row.createdAt && new Date(row.createdAt) >= new Date(now.getTime() - inactiveDays * DAY)) };
}

const completionExpression = booking => ({ $ifNull: ['$completedAt', booking
  ? { $ifNull: ['$repairCompletion.completedAt', { $ifNull: ['$slaTracking.resolutionAt', { $ifNull: [historyCompletion(true), '$updatedAt'] }] }] }
  : { $ifNull: [historyCompletion(false), '$updatedAt'] }] });
function historyCompletion(booking) {
  return { $max: { $map: { input: { $filter: { input: { $ifNull: ['$statusHistory', []] }, as: 'event', cond: booking
    ? { $in: [{ $ifNull: ['$$event.toStatus', '$$event.status'] }, COMPLETED_BOOKINGS] } : { $eq: ['$$event.status', 'completed'] } } },
    as: 'event', in: { $ifNull: ['$$event.timestamp', '$$event.changedAt'] } } } };
}
const bookingCompletion = completionExpression(true), orderCompletion = completionExpression(false);
const bookingSuccess = { $and: [{ $in: ['$status', COMPLETED_BOOKINGS] }, { $ne: [{ $ifNull: ['$refundStatus', 'none'] }, 'completed'] }] };
const orderSuccess = { $and: [{ $eq: ['$status', 'completed'] }, { $ne: [{ $ifNull: ['$refundStatus', 'none'] }, 'completed'] },
  { $or: [{ $lte: ['$itemRefunds', 0] }, { $lt: ['$itemRefunds', '$productNet'] }] } ] };

function sourceSummaryPipeline(period, booking, now) {
  const complete = booking ? { $in: ['$status', COMPLETED_BOOKINGS] } : { $eq: ['$status', 'completed'] };
  const success = booking ? bookingSuccess : orderSuccess;
  const selected = { $and: [success, between('$completion', period)] };
  const valued = { $and: [complete, between('$completion', period)] };
  const lifetime = { $and: [complete, { $or: [{ $lte: ['$completion', now] }, { $eq: [{ $ifNull: ['$completion', null] }, null] }] }] };
  const refunds = { $add: [{ $cond: [{ $in: ['$refundStatus', ['completed', 'partial']] }, { $ifNull: ['$refundAmount', 0] }, 0] }, booking ? 0 : '$itemRefunds'] };
  const stages = booking ? [
    { $match: { sourceOrderId: null } },
    { $lookup: { from: Order.collection.name, localField: '_id', foreignField: 'bookingId', pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: 'linkedOrders' } },
    { $match: { 'linkedOrders.0': { $exists: false } } },
    { $project: { status: 1, completion: bookingCompletion, cancelledDate: { $ifNull: ['$cancelledAt', '$updatedAt'] }, noShowDate: { $ifNull: ['$noShowAt', '$updatedAt'] }, amount: { $ifNull: ['$totalPrice', { $ifNull: ['$estimatedFee', 0] }] }, discount: 1, refundStatus: 1, refundAmount: 1 } },
  ] : [
    { $lookup: { from: ProductRefund.collection.name, localField: '_id', foreignField: 'sourceId', pipeline: [{ $match: { sourceType: 'order', status: 'completed' } }, { $group: { _id: null, amount: { $sum: '$amount' } } }], as: 'itemReturns' } },
    { $project: { status: 1, completion: orderCompletion, cancelledDate: { $ifNull: ['$cancelledAt', '$updatedAt'] }, amount: { $ifNull: ['$total', 0] }, discount: 1, refundStatus: 1, refundAmount: 1,
      itemRefunds: { $ifNull: [{ $arrayElemAt: ['$itemReturns.amount', 0] }, 0] },
      productNet: { $max: [0, { $subtract: [{ $cond: [{ $gt: [{ $ifNull: ['$subtotal', 0] }, 0] }, '$subtotal', { $sum: '$items.totalPrice' }] }, { $ifNull: ['$discount', 0] }] }] },
      itemsPurchased: { $sum: '$items.quantity' } } },
  ];
  const group = { _id: null, completed: ifSum(selected), lifetime: ifSum({ $and: [success, lifetime] }),
    value: ifSum(valued, '$amount'), lifetimeValue: ifSum(lifetime, '$amount'),
    refunds: ifSum(valued, refunds), lifetimeRefunds: ifSum(lifetime, refunds), discounts: ifSum(valued, { $ifNull: ['$discount', 0] }),
    last: lastIf(selected, '$completion'), lifetimeLast: lastIf({ $and: [success, lifetime] }, '$completion'),
    cancelled: ifSum({ $and: [{ $in: ['$status', booking ? ['cancelled', 'rejected', 'repair_declined'] : ['cancelled']] }, between('$cancelledDate', period)] }),
    refunded: ifSum({ $and: [complete, { $not: [success] }, between('$completion', period)] }),
  };
  if (booking) group.noShows = ifSum({ $and: [{ $eq: ['$status', 'no-show'] }, between('$noShowDate', period)] });
  else { group.productValue = ifSum(valued, '$productNet'); group.itemsPurchased = ifSum(selected, '$itemsPurchased'); }
  return [...stages, { $group: group }];
}

function customerSummaryPipeline(period, inactiveDays, now, customerId = null) {
  const value = (source, field) => ({ $ifNull: [`$${source}.${field}`, 0] });
  return [
    { $match: { role: 'customer', ...(customerId ? { _id: customerId } : {}) } },
    { $project: { firstName: 1, lastName: 1, email: 1, createdAt: 1, accountStatus: 1, blocked: 1, vip: 1 } },
    { $lookup: { from: Booking.collection.name, localField: '_id', foreignField: 'customerId', pipeline: sourceSummaryPipeline(period, true, now), as: 'booking' } },
    { $lookup: { from: Order.collection.name, localField: '_id', foreignField: 'userId', pipeline: sourceSummaryPipeline(period, false, now), as: 'order' } },
    { $set: { booking: { $arrayElemAt: ['$booking', 0] }, order: { $arrayElemAt: ['$order', 0] } } },
    { $set: { name: { $trim: { input: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] } } },
      completedBookings: value('booking', 'completed'), completedOrders: value('order', 'completed'),
      lifetimeBookings: value('booking', 'lifetime'), lifetimeOrders: value('order', 'lifetime'),
      serviceValue: value('booking', 'value'), orderValue: value('order', 'value'), productValue: value('order', 'productValue'),
      discounts: { $add: [value('booking', 'discounts'), value('order', 'discounts')] }, refunds: { $add: [value('booking', 'refunds'), value('order', 'refunds')] },
      lifetimeValue: { $add: [value('booking', 'lifetimeValue'), value('order', 'lifetimeValue')] }, lifetimeRefunds: { $add: [value('booking', 'lifetimeRefunds'), value('order', 'lifetimeRefunds')] },
      lastBooking: { $ifNull: ['$booking.last', null] }, lastOrder: { $ifNull: ['$order.last', null] },
      lifetimeLastBooking: { $ifNull: ['$booking.lifetimeLast', null] }, lifetimeLastOrder: { $ifNull: ['$order.lifetimeLast', null] },
      itemsPurchased: value('order', 'itemsPurchased'), cancelledBookings: value('booking', 'cancelled'), noShows: value('booking', 'noShows'),
      refundedBookings: value('booking', 'refunded'), cancelledOrders: value('order', 'cancelled'), refundedOrders: value('order', 'refunded') } },
    { $set: { completedTransactions: { $add: ['$completedBookings', '$completedOrders'] }, lifetimeTransactions: { $add: ['$lifetimeBookings', '$lifetimeOrders'] },
      recordedSpending: { $round: [{ $max: [0, { $subtract: [{ $add: ['$serviceValue', '$orderValue'] }, '$refunds'] }] }, 2] },
      lifetimeSpending: { $round: [{ $max: [0, { $subtract: ['$lifetimeValue', '$lifetimeRefunds'] }] }, 2] },
      lastActivity: { $max: ['$lifetimeLastBooking', '$lifetimeLastOrder'] }, periodLastActivity: { $max: ['$lastBooking', '$lastOrder'] } } },
    { $set: { newAccount: { $gte: ['$createdAt', new Date(now - inactiveDays * DAY)] }, recentlyActive: { $and: [{ $ne: ['$lastActivity', null] }, { $gte: ['$lastActivity', new Date(now - inactiveDays * DAY)] }] },
      daysSinceLastActivity: { $cond: [{ $ne: ['$lastActivity', null] }, { $max: [0, { $floor: { $divide: [{ $subtract: [now, '$lastActivity'] }, DAY] } }] }, null] } } },
    { $set: { previouslyActiveNowInactive: { $and: [{ $gte: ['$lifetimeTransactions', 5] }, { $ne: ['$lastActivity', null] }, { $not: ['$recentlyActive'] }] },
      engagement: { $switch: { branches: [
        { case: { $eq: ['$lifetimeTransactions', 0] }, then: 'Never Engaged' },
        { case: { $eq: ['$lastActivity', null] }, then: 'Activity date unavailable' },
        { case: { $and: [{ $gte: ['$lifetimeTransactions', 5] }, { $not: ['$recentlyActive'] }] }, then: 'Previously Active / Now Inactive' },
        { case: { $not: ['$recentlyActive'] }, then: 'Inactive' },
        { case: { $lte: ['$lifetimeTransactions', 2] }, then: 'Very Low Engagement' },
        { case: { $lt: ['$lifetimeTransactions', 5] }, then: 'Low Engagement' },
      ], default: 'Active' } } } },
    { $project: { booking: 0, order: 0, firstName: 0, lastName: 0, lifetimeValue: 0 } },
  ];
}

function normalizeQuery(query = {}) {
  return { list: ['frequent', 'records', 'lowest'].includes(query.list) ? query.list : 'frequent',
    search: String(query.search || '').trim().slice(0, 100), segment: String(query.segment || 'all'),
    sort: ['bookings', 'orders', 'transactions', 'spending', 'last', 'least', 'days'].includes(query.sort) ? query.sort : query.list === 'lowest' ? 'least' : 'transactions',
    page: Math.min(100000, Math.max(1, parseInt(query.page, 10) || 1)) };
}
function tableMatch(query) {
  const clauses = [];
  if (query.list === 'frequent') clauses.push({ completedTransactions: { $gt: 0 } });
  if (query.list === 'lowest') clauses.push({ $or: [{ lifetimeTransactions: { $lt: 5 } }, { recentlyActive: false }] });
  if (query.search) {
    const regex = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clauses.push({ $or: [{ name: { $regex: regex, $options: 'i' } }, { email: { $regex: regex, $options: 'i' } }] });
  }
  const segments = { service: { completedBookings: { $gt: 0 } }, product: { completedOrders: { $gt: 0 } },
    both: { completedBookings: { $gt: 0 }, completedOrders: { $gt: 0 } }, frequent: { completedTransactions: { $gte: 5 } },
    never: { lifetimeTransactions: 0 }, veryLow: { lifetimeTransactions: { $gte: 1, $lte: 2 } },
    inactive: { lifetimeTransactions: { $gt: 0 }, recentlyActive: false }, previous: { previouslyActiveNowInactive: true },
    rareBookings: { lifetimeBookings: { $lte: 1 } }, rareOrders: { lifetimeOrders: { $lte: 1 } }, active: { recentlyActive: true } };
  if (segments[query.segment]) clauses.push(segments[query.segment]);
  return clauses.length ? { $and: clauses } : {};
}
function tableSort(query) {
  const selected = query.list === 'lowest' ? 'lifetimeTransactions' : 'completedTransactions';
  const low = query.list === 'lowest';
  const primary = { bookings: { [low ? 'lifetimeBookings' : 'completedBookings']: -1 }, orders: { [low ? 'lifetimeOrders' : 'completedOrders']: -1 }, transactions: { [selected]: -1 },
    spending: { [low ? 'lifetimeSpending' : 'recordedSpending']: -1 }, last: { [low ? 'lastActivity' : 'periodLastActivity']: -1 }, least: { lifetimeTransactions: 1 }, days: { daysSinceLastActivity: -1 } };
  return { ...(primary[query.sort] || primary.transactions), [selected]: query.sort === 'least' ? 1 : -1, recordedSpending: -1, lastActivity: -1, _id: 1 };
}
function presentRow(row) {
  return { ...row, id: String(row._id), name: row.name || 'Unnamed customer', email: row.email || '',
    accountStatus: row.blocked ? 'Blocked account' : row.accountStatus === 'invited' ? 'Invited account' : 'Active account',
    orderFees: round(Math.max(0, row.orderValue - row.productValue)), grossTransactionValue: round(row.serviceValue + row.orderValue + row.discounts),
    averageBookingValue: row.completedBookings ? round(row.serviceValue / row.completedBookings) : 0,
    averageOrderValue: row.completedOrders ? round(row.orderValue / row.completedOrders) : 0 };
}

async function computeReport(query, period, inactiveDays, now) {
  const normalized = normalizeQuery(query), match = tableMatch(normalized);
  const summary = { _id: null, totalCustomers: { $sum: 1 }, frequentCustomers: ifSum({ $gte: ['$completedTransactions', 5] }),
    neverEngaged: ifSum({ $eq: ['$lifetimeTransactions', 0] }), inactive: ifSum('$previouslyActiveNowInactive') };
  const facets = () => ({ summary: [{ $group: summary }],
    topBooker: [{ $match: { completedBookings: { $gt: 0 } } }, { $sort: { completedBookings: -1, completedTransactions: -1, lastBooking: -1, _id: 1 } }, { $limit: 1 }],
    topBuyer: [{ $match: { completedOrders: { $gt: 0 } } }, { $sort: { completedOrders: -1, completedTransactions: -1, lastOrder: -1, _id: 1 } }, { $limit: 1 }],
    count: [{ $match: match }, { $count: 'total' }],
    rows: [{ $match: match }, { $sort: tableSort(normalized) }, { $skip: (normalized.page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }] });
  const base = customerSummaryPipeline(period, inactiveDays, now);
  let result = (await User.aggregate([...base, { $facet: facets() }]).allowDiskUse(true))[0];
  const total = result?.count[0]?.total || 0;
  const page = Math.min(normalized.page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  if (page !== normalized.page) {
    normalized.page = page;
    const rows = await User.aggregate([...base, ...facets().rows]).allowDiskUse(true);
    result = { ...result, rows };
  }
  return { period: { range: period.range, from: period.start, to: period.end, inactiveDays }, asOf: now,
    summary: result?.summary[0] || { totalCustomers: 0, frequentCustomers: 0, neverEngaged: 0, inactive: 0 },
    leaders: { booker: result?.topBooker[0] ? presentRow(result.topBooker[0]) : null, buyer: result?.topBuyer[0] ? presentRow(result.topBuyer[0]) : null },
    customers: { list: normalized.list, filters: { search: normalized.search, segment: normalized.segment, sort: normalized.sort }, total, page, pageSize: PAGE_SIZE, rows: (result?.rows || []).map(presentRow) }, methodology: HISTORY_NOTE };
}
function buildCustomerPerformance(query = {}, now = new Date()) {
  const period = parsePeriod(query, now), inactiveDays = INACTIVE_WINDOWS.includes(Number(query.inactiveDays)) ? Number(query.inactiveDays) : 90;
  return remember('customer-performance', { ...normalizeQuery(query), range: period.range, from: period.start.toISOString(), to: period.range === 'custom' ? period.end.toISOString() : Math.floor(now / 60000), inactiveDays },
    () => computeReport(query, period, inactiveDays, now), { ttlMs: 60000, maxEntries: 30 });
}
module.exports = { buildCustomerPerformance, parsePeriod, classifyCustomer, transactionBreakdown, customerSummaryPipeline, sourceSummaryPipeline,
  bookingCompletion, orderCompletion, bookingSuccess, orderSuccess, between, presentRow, normalizeQuery, tableMatch, tableSort, COMPLETED_BOOKINGS, INACTIVE_WINDOWS, HISTORY_NOTE };
