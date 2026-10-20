'use strict';
const mongoose = require('mongoose');
const { manilaDateTime, manilaDateKey } = require('./bookingDateTime');
const { escapeRegex } = require('./stringSecurity');
const id = value => String(value?._id || value || '');
const fail = message => Object.assign(new Error(message), { status: 400 });
const number = value => Math.max(0, Number(value) || 0);
function normalizeQuery(query = {}) {
  const text = key => {
    if (query[key] != null && typeof query[key] !== 'string') throw fail('Choose a valid ' + key + ' filter.');
    return String(query[key] || '').trim();
  };
  const category = text('category') || 'all', status = text('status') || 'all', technicianId = text('technicianId'), date = text('date');
  if (!['all', 'equipment', 'repair_part', 'consumable'].includes(category)) throw fail('Choose a valid item category.');
  if (!['all', 'pending', 'overdue', 'check_balance'].includes(status)) throw fail('Choose a valid tracking status.');
  if (technicianId && !mongoose.isObjectIdOrHexString(technicianId)) throw fail('Choose a valid technician.');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || manilaDateKey(new Date(date + 'T00:00:00+08:00')) !== date)) throw fail('Choose a valid work date.');
  const integer = (value, fallback, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(1, Math.floor(Number(value)))) : fallback;
  return { category, status, technicianId, date, search: text('search').slice(0, 100),
    page: integer(query.page ?? 1, 1, 100000), limit: integer(query.limit ?? 8, 8, 25) };
}
const refs = (single, ...arrays) => ({ $setUnion: [
  { $filter: { input: [single], as: 'reference', cond: { $ne: ['$$reference', null] } } },
  ...arrays.map(field => ({ $ifNull: [field, []] })),
] });
const balance = (issued, fields) => ({ $max: [0, { $subtract: [{ $ifNull: [issued, 0] }, { $add: fields.map(field => ({ $ifNull: [field, 0] })) }] }] });

function buildPipeline(query, aliases, names, collections, now = new Date()) {
  const quantity = { $ifNull: ['$quantity', 1] };
  const equipment = [
    { $match: { status: { $in: ['checked_out', 'in_use'] },
      $or: [{ consumable: { $ne: true } }, { dailyKitId: null }] } },
    { $lookup: { from: collections.tools, localField: 'equipmentId', foreignField: '_id', as: 'catalog', pipeline: [{ $project: { type: 1, itemType: 1, unit: 1 } }] } },
    { $project: { _id: { $concat: ['equipment:', { $toString: '$_id' }] }, recordId: '$_id', source: 'equipment_assignment',
      technicianId: 1, name: '$equipmentName', code: { $ifNull: ['$equipmentCode', ''] },
      category: { $cond: ['$consumable', { $cond: [{ $in: ['part', [{ $arrayElemAt: ['$catalog.itemType', 0] }, { $arrayElemAt: ['$catalog.type', 0] }]] }, 'repair_part', 'consumable'] }, 'equipment'] },
      unit: { $ifNull: [{ $arrayElemAt: ['$catalog.unit', 0] }, 'pcs'] }, quantity,
      quantityIssued: quantity, quantityUsed: { $cond: ['$consumable', { $ifNull: ['$consumableUsed', 0] }, null] },
      quantityReturned: { $cond: ['$consumable', { $ifNull: ['$consumableReturned', 0] }, 0] },
      quantityDamaged: { $ifNull: ['$consumableDamaged', 0] }, quantityMissing: { $ifNull: ['$consumableMissing', 0] },
      remaining: { $cond: ['$consumable', balance('$quantity', ['$consumableUsed', '$consumableReturned', '$consumableDamaged', '$consumableMissing']), quantity] },
      pendingQuantity: { $cond: ['$returnPending', quantity, 0] }, checkBalance: { $literal: false },
      workDate: 1, issuedAt: { $ifNull: ['$checkedOutAt', '$issuedAt'] }, expectedReturnAt: 1,
      bookingIds: refs('$bookingId'), orderIds: refs(null, '$orderIds'), projectIds: refs('$projectId', '$projectIds'),
      reference: { $ifNull: ['$bookingReference', ''] }, dailyKitId: 1,
    } },
  ];
  const materials = [
    { $project: { technicianId: 1, workDate: 1, confirmedAt: 1, item: { $concatArrays: [{ $ifNull: ['$items', []] }, { $ifNull: ['$deltaItems', []] }] } } },
    { $unwind: '$item' },
    { $match: { 'item.category': { $in: ['repair_part', 'consumable'] }, 'item.quantityIssued': { $gt: 0 } } },
    { $project: { _id: { $concat: ['kit:', { $toString: '$_id' }, ':', { $toString: '$item._id' }] }, source: 'daily_kit', recordId: '$item._id', dailyKitId: '$_id',
      technicianId: 1, workDate: 1, name: '$item.name', code: '$item.toolCode', category: '$item.category', unit: '$item.unit',
      quantity: '$item.quantityIssued', quantityIssued: '$item.quantityIssued', quantityUsed: { $ifNull: ['$item.quantityUsed', 0] },
      quantityReturned: { $ifNull: ['$item.quantityReturned', 0] }, quantityDamaged: { $ifNull: ['$item.quantityDamaged', 0] }, quantityMissing: { $ifNull: ['$item.quantityMissing', 0] },
      remaining: balance('$item.quantityIssued', ['$item.quantityUsed', '$item.quantityReturned', '$item.quantityDamaged', '$item.quantityMissing']),
      pendingQuantity: { $ifNull: ['$item.returnPendingQuantity', 0] }, checkBalance: { $literal: false },
      issuedAt: { $ifNull: ['$item.checkedOutAt', '$confirmedAt'] }, expectedReturnAt: { $literal: null },
      bookingIds: refs(null, '$item.bookingIds', '$item.issuedBookingIds'), orderIds: refs(null, '$item.orderIds', '$item.issuedOrderIds'), projectIds: refs(null, '$item.projectIds'),
    } },
  ];
  const legacy = [
    { $match: { status: 'assigned', returnedDate: null } },
    { $project: { _id: { $concat: ['general:', { $toString: '$_id' }] }, source: 'general_issue', recordId: '$_id', technicianId: 1,
      name: '$toolName', code: '$toolBarcode', category: { $switch: { branches: [{ case: { $eq: ['$itemType', 'part'] }, then: 'repair_part' }, { case: { $eq: ['$itemType', 'consumable'] }, then: 'consumable' }], default: 'equipment' } },
      quantity, quantityIssued: quantity, quantityUsed: { $literal: null }, quantityReturned: { $literal: null }, quantityDamaged: { $literal: null }, quantityMissing: { $literal: null },
      remaining: { $cond: [{ $in: ['$itemType', ['part', 'consumable']] }, null, quantity] },
      pendingQuantity: { $literal: 0 }, checkBalance: { $in: ['$itemType', ['part', 'consumable']] }, unit: 'pcs', workDate: '$assignedDate', issuedAt: '$assignedDate',
      bookingIds: { $literal: [] }, orderIds: { $literal: [] }, projectIds: { $literal: [] }, expectedReturnAt: { $literal: null },
    } },
  ];
  const pipeline = [...equipment, { $unionWith: { coll: collections.kits, pipeline: materials } }, { $unionWith: { coll: collections.legacy, pipeline: legacy } },
    { $match: { $or: [{ remaining: { $gt: 0 } }, { checkBalance: true, quantity: { $gt: 0 } }] } },
  ];
  if (query.technicianId) pipeline.push({ $match: { technicianId: { $in: aliases.map(value => new mongoose.Types.ObjectId(value)) } } });
  if (query.date) pipeline.push({ $match: { workDate: { $gte: manilaDateTime(query.date + 'T00:00:00+08:00', 0), $lt: manilaDateTime(query.date + 'T00:00:00+08:00', 1440) } } });
  pipeline.push({ $set: { overdue: { $and: [{ $eq: ['$source', 'equipment_assignment'] }, { $eq: ['$category', 'equipment'] },
    { $cond: [{ $ne: [{ $ifNull: ['$expectedReturnAt', null] }, null] }, { $lt: ['$expectedReturnAt', now] }, { $and: [{ $ne: [{ $ifNull: ['$workDate', null] }, null] }, { $lt: ['$workDate', manilaDateTime(now, 0)] }] }] },
  ] } } });
  if (query.status === 'pending') pipeline.push({ $match: { pendingQuantity: { $gt: 0 } } });
  if (query.status === 'overdue') pipeline.push({ $match: { overdue: true } });
  if (query.status === 'check_balance') pipeline.push({ $match: { checkBalance: true } });
  for (const [as, from, field, projection] of [
    ['bookings', collections.bookings, 'bookingIds', { bookingReference: 1, status: 1, 'service.name': 1 }],
    ['orders', collections.orders, 'orderIds', { orderReference: 1, status: 1 }],
    ['projects', collections.projects, 'projectIds', { bookingId: 1, status: 1, 'service.name': 1 }],
    ['projectBookings', collections.bookings, 'projects.bookingId', { bookingReference: 1, status: 1 }],
  ]) pipeline.push({ $lookup: { from, localField: field, foreignField: '_id', pipeline: [{ $project: projection }], as } });
  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), 'i');
    pipeline.push({ $match: { $or: ['name', 'code', 'reference', 'bookings.bookingReference', 'orders.orderReference', 'projectBookings.bookingReference'].map(field => ({ [field]: regex }))
      .concat(names.length ? [{ technicianId: { $in: names.map(value => new mongoose.Types.ObjectId(value)) } }] : []) } });
  }
  const category = query.category === 'all' ? [] : [{ $match: { category: query.category } }];
  pipeline.push({ $facet: {
    summary: [{ $group: { _id: null, equipment: { $sum: { $cond: [{ $eq: ['$category', 'equipment'] }, 1, 0] } },
      repair_part: { $sum: { $cond: [{ $eq: ['$category', 'repair_part'] }, 1, 0] } }, consumable: { $sum: { $cond: [{ $eq: ['$category', 'consumable'] }, 1, 0] } },
      pending: { $sum: { $cond: [{ $gt: ['$pendingQuantity', 0] }, 1, 0] } }, overdue: { $sum: { $cond: ['$overdue', 1, 0] } },
      holders: { $addToSet: '$technicianId' },
    } }],
    total: [...category, { $count: 'count' }],
    rows: [...category, { $sort: { overdue: -1, pendingQuantity: -1, workDate: -1, _id: 1 } }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
  } });
  return pipeline;
}

function present(row, profiles) {
  const profile = profiles.get(id(row.technicianId));
  const jobs = new Map();
  for (const [type, rows, reference, href] of [
    ['booking', row.bookings || [], value => value.bookingReference, value => '/admin/appointments?booking=' + id(value)],
    ['order', row.orders || [], value => value.orderReference, value => '/admin/appointments/orders?order=' + id(value)],
    ['project', row.projects || [], value => (row.projectBookings || []).find(booking => id(booking) === id(value.bookingId))?.bookingReference, value => '/admin/projects/' + id(value)],
  ]) for (const job of rows) jobs.set(type + ':' + id(job), { id: id(job), type, reference: reference(job) || type.charAt(0).toUpperCase() + type.slice(1) + ' #' + id(job).slice(-6).toUpperCase(), status: job.status || '', href: href(job) });
  const remaining = row.checkBalance ? null : number(row.remaining);
  return { id: row._id, recordId: id(row.recordId), source: row.source, name: String(row.name || 'Inventory item'), code: String(row.code || ''), category: row.category,
    technician: { id: profile?.id || id(row.technicianId), name: profile?.name || 'Technician record unavailable', archived: profile?.archived || false },
    unit: row.unit || 'pcs', quantityIssued: number(row.quantityIssued), quantityUsed: row.quantityUsed == null ? null : number(row.quantityUsed),
    quantityReturned: row.quantityReturned == null ? null : number(row.quantityReturned), quantityDamaged: row.quantityDamaged == null ? null : number(row.quantityDamaged),
    quantityMissing: row.quantityMissing == null ? null : number(row.quantityMissing), remaining,
    pendingQuantity: remaining == null ? 0 : Math.min(remaining, number(row.pendingQuantity)), checkBalance: !!row.checkBalance, overdue: !!row.overdue,
    workDate: row.workDate || null, issuedAt: row.issuedAt || null,
    expectedReturnAt: row.category === 'equipment' && row.source === 'equipment_assignment' ? row.expectedReturnAt || (row.workDate ? manilaDateTime(row.workDate, 1440, -1) : null) : null,
    dailyKitId: id(row.dailyKitId), jobs: [...jobs.values()],
  };
}
function createService(overrides = {}) {
  const deps = { EquipmentAssignment: require('../models/EquipmentAssignment'), DailyKit: require('../models/DailyKit'), ToolAssignment: require('../models/ToolAssignment'),
    Technician: require('../models/Technician'), Tool: require('../models/Tool'), BookingService: require('../models/BookingService'), Order: require('../models/Order'), Project: require('../models/Project'), ...overrides };
  async function list(input = {}, now = new Date()) {
    const query = normalizeQuery(input);
    const technicians = await deps.Technician.find({}).select('_id name user archivedAt active').populate({ path: 'user', select: 'firstName lastName', transform: (document, reference) => document || { _id: reference } }).sort({ name: 1 }).lean();
    const profiles = new Map(), options = [];
    for (const tech of technicians) {
      const fullName = [tech.user?.firstName, tech.user?.lastName].filter(Boolean).join(' ');
      const entry = { id: id(tech), name: fullName || tech.name || 'Technician', archived: !!tech.archivedAt || tech.active === false,
        aliases: [...new Set([id(tech), id(tech.user)].filter(value => mongoose.isObjectIdOrHexString(value)))] };
      options.push(entry); for (const alias of entry.aliases) profiles.set(alias, entry);
    }
    const aliases = profiles.get(query.technicianId)?.aliases || (query.technicianId ? [query.technicianId] : []);
    const names = [...new Set(options.filter(tech => tech.name.toLowerCase().includes(query.search.toLowerCase())).flatMap(tech => tech.aliases))];
    const collections = Object.fromEntries([['tools', 'Tool'], ['kits', 'DailyKit'], ['legacy', 'ToolAssignment'], ['bookings', 'BookingService'], ['orders', 'Order'], ['projects', 'Project']].map(([key, model]) => [key, deps[model].collection.name]));
    const [snapshot = {}] = await deps.EquipmentAssignment.aggregate(buildPipeline(query, aliases, names, collections, now)).allowDiskUse(true);
    const summary = snapshot.summary?.[0] || {}, total = snapshot.total?.[0]?.count || 0;
    return { items: (snapshot.rows || []).map(row => present(row, profiles)),
      summary: { equipment: summary.equipment || 0, repair_part: summary.repair_part || 0, consumable: summary.consumable || 0,
        pending: summary.pending || 0, overdue: summary.overdue || 0, technicians: new Set((summary.holders || []).filter(Boolean).map(value => profiles.get(id(value))?.id || id(value))).size },
      technicians: options.map(({ aliases: _aliases, ...tech }) => tech),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)) } };
  }
  return { list };
}
module.exports = { createService, normalizeQuery, buildPipeline, present };
