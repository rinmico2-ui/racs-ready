const { manilaDateTime, manilaDateKey } = require('./bookingDateTime');

function listSortStages(kind, key = 'date_desc') {
  const scheduled = kind === 'order'
    ? { $cond: [{ $eq: ['$fulfillmentType', 'customer_pickup'] }, '$pickupDate', '$delivery.preferredDate'] }
    : { $ifNull: ['$preferredDate', '$bookingDate'] };
  const date = { $ifNull: [scheduled, null] };
  const fields = {
    _listDate: date,
    _listUndated: { $cond: [{ $eq: [date, null] }, 1, 0] },
    _listAmount: { $ifNull: [kind === 'order' ? '$total' : { $ifNull: ['$totalPrice', '$estimatedFee'] }, 0] },
  };
  const presets = {
    date_desc: { _listUndated: 1, _listDate: -1, createdAt: -1, _id: -1 },
    date_asc: { _listUndated: 1, _listDate: 1, createdAt: 1, _id: 1 },
    newest: { createdAt: -1, _id: -1 },
    oldest: { createdAt: 1, _id: 1 },
    amount_high: { _listAmount: -1, createdAt: -1, _id: -1 },
    amount_low: { _listAmount: 1, createdAt: -1, _id: -1 },
  };
  return [{ $addFields: fields }, { $sort: Object.hasOwn(presets, key) ? presets[key] : presets.date_desc }];
}

function bookingPendingFilters(params, now = new Date()) {
  const conditions = [];
  if (['pending', 'partial', 'paid'].includes(params.paymentStatus)) conditions.push({ paymentStatus: params.paymentStatus });
  if (params.paymentMethod) conditions.push({ paymentMethod: String(params.paymentMethod).toLowerCase() });
  const core = { $gt: [{ $size: { $filter: {
    input: { $ifNull: ['$services', []] }, as: 'item',
    cond: { $ne: [{ $toLower: { $ifNull: ['$$item.type', 'core'] } }, 'repair'] },
  } } }, 0] };
  const repair = { $or: [
    { $in: ['repair', { $map: { input: { $ifNull: ['$services', []] }, as: 'item', in: { $toLower: { $ifNull: ['$$item.type', ''] } } } }] },
    { $eq: ['$serviceType', 'repair'] }, { $eq: ['$serviceModel', 'RepairService'] },
  ] };
  const mixed = { $or: [{ $and: [core, repair] }, { $eq: ['$serviceType', 'mixed'] }] };
  if (params.serviceType === 'mixed') conditions.push({ $expr: mixed });
  if (params.serviceType === 'repair') conditions.push({ $expr: { $and: [repair, { $not: [mixed] }] } });
  if (params.serviceType === 'core') conditions.push({ $expr: { $and: [{ $not: [repair] }, { $not: [mixed] }] } });
  const today = manilaDateTime(now, 0);
  const tomorrow = manilaDateTime(now, 24 * 60);
  const key = manilaDateKey(now);
  let start, end;
  switch (params.dateRange) {
    case 'today': start = today; end = tomorrow; break;
    case 'yesterday': start = new Date(today.getTime() - 86400000); end = today; break;
    case 'this_week': {
      const day = new Date(key + 'T00:00:00Z').getUTCDay();
      start = new Date(today.getTime() - day * 86400000); end = new Date(start.getTime() + 7 * 86400000); break;
    }
    case 'this_month': case 'last_month': {
      const month = new Date(key.slice(0, 7) + '-01T00:00:00+08:00');
      const parts = key.split('-').map(Number);
      const offset = params.dateRange === 'last_month' ? -1 : 0;
      start = new Date(Date.UTC(parts[0], parts[1] - 1 + offset, 1) - 8 * 3600000);
      end = offset === -1 ? month : new Date(Date.UTC(parts[0], parts[1], 1) - 8 * 3600000);
      break;
    }
  }
  if (start) conditions.push({ $expr: { $and: [
    { $gte: [{ $ifNull: ['$preferredDate', '$bookingDate'] }, start] },
    { $lt: [{ $ifNull: ['$preferredDate', '$bookingDate'] }, end] },
  ] } });
  return conditions;
}

module.exports = { listSortStages, bookingPendingFilters };
