'use strict';

const mongoose = require('mongoose');
const { manilaDateTime, strictManilaDateKey } = require('./bookingDateTime');
const { escapeRegex } = require('./stringSecurity');
const fail = message => Object.assign(new Error(message), { status: 400 });
const MAX_ITEMS = 100;

function historyQuery(technicianIds, input = {}) {
  const ids = [...new Set(technicianIds.map(String))].filter(id => mongoose.isValidObjectId(id));
  if (!ids.length) throw fail('A technician profile is required.');
  const source = input.source || 'all', type = input.type || 'all';
  if (!['all', 'booking', 'order', 'project', 'unlinked'].includes(source)) throw fail('Choose a valid work type.');
  if (!['all', 'part', 'consumable'].includes(type)) throw fail('Choose repair parts or consumables.');
  if (input.q != null && (typeof input.q !== 'string' || input.q.length > 100)) throw fail('Keep the search within 100 characters.');
  const date = key => {
    if (!input[key]) return null;
    if (typeof input[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input[key]) || !strictManilaDateKey(input[key])) throw fail('Choose valid history dates.');
    return manilaDateTime(input[key], 0);
  };
  const from = date('from'), to = date('to');
  if (from && to && from > to) throw fail('The end date must be on or after the start date.');
  const page = Number(input.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw fail('Choose a valid history page.');
  const match = { technicianId: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
    lifecycleStatus: { $ne: 'voided' }, itemType: type === 'all' ? { $in: ['part', 'consumable'] } : type, quantityUsed: { $gt: 0 } };
  if (from || to) match.usedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + 86400000) } : {}) };
  const workSource = { $cond: ['$orderId', 'order', { $cond: ['$projectId', 'project', { $cond: ['$bookingId', 'booking', 'unlinked'] }] }] };
  const workId = { $ifNull: ['$orderId', { $ifNull: ['$projectId', { $ifNull: ['$bookingId', '$_id'] }] }] };
  const pipeline = [{ $match: match }, { $set: { workSource, workId } }];
  if (source !== 'all') pipeline.push({ $match: { workSource: source } });
  pipeline.push({ $sort: { usedAt: -1, _id: -1 } }, { $group: {
    _id: { source: '$workSource', id: '$workId' }, lastUsedAt: { $max: '$usedAt' }, recordCount: { $sum: 1 },
    items: { $push: { name: '$itemName', type: '$itemType', quantity: '$quantityUsed', unit: '$unit', usedAt: '$usedAt', stage: '$completionStage' } },
  } });
  // Join only reference labels. Financial data and customer contact details
  // never enter the technician's usage-history response.
  for (const [collection, field, projection] of [
    ['orders', 'order', { orderReference: 1 }],
    ['bookingservices', 'booking', { bookingReference: 1, workOrderNumber: 1 }],
    ['projects', 'project', { 'service.name': 1 }],
  ]) {
    pipeline.push({ $lookup: { from: collection, let: { id: '$_id.id', source: '$_id.source' },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$id'] }, { $eq: ['$$source', field] }] } } }, { $project: projection }], as: field } });
  }
  pipeline.push({ $set: { reference: { $ifNull: [{ $arrayElemAt: ['$order.orderReference', 0] },
    { $ifNull: [{ $arrayElemAt: ['$booking.bookingReference', 0] }, { $arrayElemAt: ['$booking.workOrderNumber', 0] }] }] },
    projectName: { $arrayElemAt: ['$project.service.name', 0] } } });
  if (input.q?.trim()) {
    const regex = { $regex: escapeRegex(input.q.trim()), $options: 'i' };
    pipeline.push({ $match: { $or: [{ reference: regex }, { projectName: regex }, { 'items.name': regex }] } });
  }
  pipeline.push({ $sort: { lastUsedAt: -1, '_id.id': -1 } }, { $facet: {
    total: [{ $count: 'count' }],
    jobs: [{ $skip: (page - 1) * 8 }, { $limit: 8 }, { $project: { _id: 1, reference: 1, projectName: 1, lastUsedAt: 1, recordCount: 1, items: { $slice: ['$items', MAX_ITEMS] } } }],
  } });
  return { pipeline, page, pageSize: 8 };
}

async function materialHistory(technicianIds, input = {}, { Usage = require('../models/ServiceToolUsage') } = {}) {
  const { pipeline, page, pageSize } = historyQuery(technicianIds, input);
  const [result = {}] = await Usage.aggregate(pipeline).allowDiskUse(true).option({ maxTimeMS: 10000 });
  const total = Number(result.total?.[0]?.count || 0);
  const items = (result.jobs || []).map(job => ({
    id: String(job._id.id), source: job._id.source,
    reference: job.reference || (job._id.source === 'project' ? job.projectName : '') ||
      (job._id.source === 'unlinked' ? 'Work reference not recorded' : `${job._id.source === 'order' ? 'Order' : 'Booking'} #${String(job._id.id).slice(-6).toUpperCase()}`),
    lastUsedAt: job.lastUsedAt, recordCount: job.recordCount,
    items: (job.items || []).map(item => ({ name: item.name, type: item.type, quantity: item.quantity,
      unit: item.unit || 'pcs', usedAt: item.usedAt, stage: item.stage === 'repair' ? 'repair' : 'final' })),
  }));
  return { items, pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } };
}

module.exports = { historyQuery, materialHistory };
