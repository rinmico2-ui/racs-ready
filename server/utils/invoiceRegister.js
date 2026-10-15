'use strict';
const { escapeRegex } = require('./stringSecurity');
const SOURCES = ['Service Booking', 'Large Project', 'Product Order', 'POS Sale'];
const settled = ['verified', 'paid'];
const number = (prefix, length = 8) => ({ $concat: [prefix, { $toUpper: { $substrBytes: [{ $toString: '$_id' }, 24 - length, length] } }] });
const identity = prefix => ({ $concat: [prefix, { $toString: '$_id' }] });

function invoicePipeline(collections, query = {}) {
  const page = Number(query.page || 0), limit = Number(query.limit || 10);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('Enter valid invoice pagination values.'), { status: 400 });
  if (query.source && !SOURCES.includes(query.source)) throw Object.assign(new Error('Select a valid invoice source.'), { status: 400 });
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 100)) throw Object.assign(new Error('Invoice search must be 100 characters or fewer.'), { status: 400 });
  const lookup = (field, from, as, fields) => ({ $lookup: { from, localField: field, foreignField: '_id', pipeline: [{ $project: fields }], as } });
  const unlinked = field => [
    { $lookup: { from: collections.payments, localField: '_id', foreignField: field, pipeline: [{ $match: { status: { $in: settled } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: '_payments' } },
    { $match: { '_payments.0': { $exists: false } } },
  ];
  const orderBreakdown = prefix => Object.fromEntries(['subtotal', 'deliveryFee', 'installationFee', 'transportationFee'].map(key => [key, `${prefix}${key}`]));
  const pipeline = [
    { $match: { status: { $in: settled } } },
    { $project: { bookingId: 1, orderId: 1, projectId: 1, amount: 1, method: 1, status: 1, verifiedAt: 1, completedAt: 1, submittedAt: 1, reference: 1 } },
    lookup('bookingId', collections.bookings, '_bookings', { bookingReference: 1, customer: 1, service: 1 }),
    lookup('orderId', collections.orders, '_orders', { orderReference: 1, customer: 1, items: 1, subtotal: 1, deliveryFee: 1, installationFee: 1, transportationFee: 1 }),
    lookup('projectId', collections.projects, '_projects', { projectReference: 1, customer: 1, service: 1 }),
    { $set: { _booking: { $arrayElemAt: ['$_bookings', 0] }, _order: { $arrayElemAt: ['$_orders', 0] }, _project: { $arrayElemAt: ['$_projects', 0] } } },
    { $project: {
      _id: identity('payment:'), invoiceNumber: number('INV-'),
      source: { $cond: ['$_order', 'Product Order', { $cond: ['$_project', 'Large Project', 'Service Booking'] }] },
      reference: { $ifNull: ['$_booking.bookingReference', { $ifNull: ['$_order.orderReference', { $ifNull: ['$_project.projectReference', number('PAY-')] }] }] },
      customer: { $ifNull: ['$_booking.customer', { $ifNull: ['$_order.customer', '$_project.customer'] }] },
      amount: '$amount', paymentMethod: '$method', status: '$status',
      issuedAt: { $ifNull: ['$verifiedAt', { $ifNull: ['$completedAt', '$submittedAt'] }] }, paymentReference: '$reference',
      items: { $ifNull: ['$_order.items', [{ description: { $ifNull: ['$_booking.service.name', { $ifNull: ['$_project.service.name', 'Service payment'] }] }, quantity: 1, totalPrice: '$amount' }]] },
      breakdown: orderBreakdown('$_order.'),
    } },
    { $unionWith: { coll: collections.bookings, pipeline: [
      { $match: { paymentStatus: { $in: settled } } }, ...unlinked('bookingId'),
      { $project: { _id: identity('booking:'), invoiceNumber: number('INV-B-', 7), source: { $literal: 'Service Booking' }, reference: '$bookingReference', customer: '$customer',
        amount: { $cond: [{ $gt: ['$amountPaid', 0] }, '$amountPaid', { $cond: [{ $gt: ['$totalPrice', 0] }, '$totalPrice', { $ifNull: ['$estimatedFee', 0] }] }] }, paymentMethod: '$paymentMethod', status: '$paymentStatus', issuedAt: { $ifNull: ['$completedAt', '$createdAt'] },
        items: [{ description: { $ifNull: ['$service.name', 'Service'] }, quantity: 1, totalPrice: { $cond: [{ $gt: ['$totalPrice', 0] }, '$totalPrice', { $ifNull: ['$estimatedFee', 0] }] } }] } },
    ] } },
    { $unionWith: { coll: collections.orders, pipeline: [
      { $match: { $or: [{ paymentStatus: { $in: settled } }, { status: 'completed' }] } }, ...unlinked('orderId'),
      { $project: { _id: identity('order:'), invoiceNumber: number('INV-O-', 7), source: { $literal: 'Product Order' }, reference: '$orderReference', customer: '$customer', amount: '$total', paymentMethod: '$paymentMethod', status: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'pending'] }, { $eq: ['$status', 'completed'] }] }, 'completed', '$paymentStatus'] }, issuedAt: { $ifNull: ['$updatedAt', '$createdAt'] }, items: '$items', breakdown: orderBreakdown('$') } },
    ] } },
    { $unionWith: { coll: collections.pos, pipeline: [
      { $match: { status: 'completed' } },
      { $project: { _id: identity('pos:'), invoiceNumber: '$invoiceNumber', source: { $literal: 'POS Sale' }, reference: '$invoiceNumber', customer: { name: '$customerName' }, amount: '$totalAmount', paymentMethod: '$paymentMethod', status: '$status', issuedAt: { $ifNull: ['$completedAt', '$createdAt'] }, items: '$items', breakdown: { subtotal: '$subtotal', discount: '$discount', tax: '$tax', amountPaid: '$amountPaid', change: '$change' } } },
    ] } },
  ];
  const filter = {};
  if (query.source) filter.source = query.source;
  if (query.q && query.q.trim()) filter.$or = ['invoiceNumber', 'reference', 'customer.name', 'source'].map(key => ({ [key]: { $regex: escapeRegex(query.q.trim()), $options: 'i' } }));
  if (Object.keys(filter).length) pipeline.push({ $match: filter });
  pipeline.push({ $facet: {
    invoices: [{ $sort: { issuedAt: -1, _id: -1 } }, { $skip: page * limit }, { $limit: limit }],
    counts: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
  } });
  return { pipeline, page, limit };
}

async function loadInvoiceRegister(query) {
  const Payment = require('../models/Payment');
  const collections = {
    payments: Payment.collection.name, bookings: require('../models/BookingService').collection.name,
    orders: require('../models/Order').collection.name, projects: require('../models/Project').collection.name,
    pos: require('../models/WalkInSale').collection.name,
  };
  const { pipeline, page, limit } = invoicePipeline(collections, query);
  const [result = {}] = await Payment.aggregate(pipeline).option({ maxTimeMS: 12000, allowDiskUse: true });
  const bySource = Object.fromEntries((result.counts || []).map(row => [row._id, row.count]));
  const total = Object.values(bySource).reduce((sum, count) => sum + count, 0);
  return { invoices: result.invoices || [], total, page, limit,
    counts: { total, bookings: (bySource['Service Booking'] || 0) + (bySource['Large Project'] || 0), orders: bySource['Product Order'] || 0, pos: bySource['POS Sale'] || 0 } };
}
module.exports = { invoicePipeline, loadInvoiceRegister };
