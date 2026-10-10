const BookingService = require('../models/BookingService');
const CoreService = require('../models/CoreService');
const RepairService = require('../models/RepairService');
const Order = require('../models/Order');
const WalkInSale = require('../models/WalkInSale');
const ServiceToolUsage = require('../models/ServiceToolUsage');
const Inventory = require('../models/Inventory');
const HVACProduct = require('../models/HVACProduct');
const Tool = require('../models/Tool');
const User = require('../models/User');
const ProductRefund = require('../models/ProductRefund');
const { evaluateHistory, completionHistories, loadPolicy } = require('./loyaltyRewards');
const { attendanceDay } = require('./attendanceTime');
const { remember } = require('./reportCache');

const completedBookingStatuses = ['completed', 'repair_completed', 'closed'];
const cancelledBookingStatuses = ['cancelled', 'rejected', 'repair_declined', 'no-show'];
const productActionPriority = { 'Restock now': 0, 'Restock soon': 1, 'Hold purchasing': 2, 'Promote before restocking': 3, 'Review margin': 4, 'Consider a special offer': 5 };
const number = value => Math.max(0, Number(value) || 0);
const round = value => Math.round((Number(value) || 0) * 100) / 100;

function parsePeriod(query = {}, now = new Date()) {
  const range = ['today', 'week', 'month', 'quarter', 'year', 'custom'].includes(query.range) ? query.range : 'month';
  const end = new Date(now);
  const [year, month, day] = attendanceDay(now).key.split('-').map(Number);
  const manilaStart = (y, m, d) => new Date(Date.UTC(y, m - 1, d) - 8 * 3600000);
  let start = manilaStart(year, month, day);
  if (range === 'week') {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    start = new Date(start.getTime() - ((weekday + 6) % 7) * 86400000);
  }
  if (range === 'month') start = manilaStart(year, month, 1);
  if (range === 'quarter') start = manilaStart(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
  if (range === 'year') start = manilaStart(year, 1, 1);
  if (range === 'custom') {
    const valid = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(value + 'T00:00:00Z');
      return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === Number(value.slice(0, 4)) && date.getUTCMonth() + 1 === Number(value.slice(5, 7)) && date.getUTCDate() === Number(value.slice(8, 10));
    };
    if (!valid(query.from) || !valid(query.to)) throw new Error('Choose valid start and end dates.');
    const [fromYear, fromMonth, fromDay] = query.from.split('-').map(Number);
    const [toYear, toMonth, toDay] = query.to.split('-').map(Number);
    start = manilaStart(fromYear, fromMonth, fromDay);
    end.setTime(manilaStart(toYear, toMonth, toDay).getTime() + 86400000 - 1);
    if (start > end || end > attendanceDay(now).end) throw new Error('Choose a valid date range ending today or earlier.');
  }
  if (now - start > 366 * 3 * 86400000) throw new Error('Limit reports to three years.');
  return { range, start, end };
}

function demandLabel(count, total, days) {
  if (total < 10 || days < 14) return 'Insufficient data';
  if (count === 0) return 'No demand';
  const share = count / total;
  if (share >= 0.2) return 'High demand';
  if (share >= 0.06) return 'Medium demand';
  return 'Low demand';
}

function serviceDemandLabel(row, totals, days) {
  if (totals.bookings < 10 || days < 14) return 'Insufficient data';
  if (!row.bookings) return 'No demand';
  const bookingShare = row.bookings / totals.bookings;
  const valueShare = totals.value > 0 ? row.completedValue / totals.value : 0;
  const previousHalf = Math.max(0, row.bookings - row.recentBookings);
  const recentSupport = row.recentBookings >= Math.max(1, previousHalf * 0.5);
  if (row.bookings >= 3 && row.completed >= 2 && recentSupport && (bookingShare >= 0.2 || valueShare >= 0.2)) return 'High demand';
  if (row.bookings >= 2 && row.completed >= 1 && (bookingShare >= 0.06 || valueShare >= 0.06)) return 'Medium demand';
  return 'Low demand';
}

function decision(row) {
  if (row.demand === 'Insufficient data') return 'Continue monitoring';
  if (row.demand === 'No demand') return 'Check if customers can find it';
  if (row.costCoverage < 1) return row.demand === 'High demand' ? 'Check technician availability and cost data' : 'Complete cost data';
  if (row.margin < 15 && row.demand === 'High demand') return 'Review pricing';
  if (row.margin >= 25 && row.demand === 'High demand') return 'Keep and promote';
  if (row.margin >= 25 && row.demand === 'Low demand') return 'Consider a special offer';
  if (row.margin < 15 && row.demand === 'Low demand') return 'Review offering';
  return 'Monitor';
}

function productDecision(row) {
  const { demand, stock, reorder, stockCoverDays, margin, costCoverage, days, units, consumed, type } = row;
  const observed = number(units) + number(consumed);
  if (days < 14 || demand === 'Insufficient data') return 'Continue monitoring';
  if (stock !== null && stock !== undefined && days >= 30 && (demand === 'No demand' || demand === 'Low demand') && stock > 0 && (observed === 0 || stockCoverDays >= 60)) {
    return margin !== null && margin >= 25 ? 'Promote before restocking' : 'Hold purchasing';
  }
  if (stock !== null && stock !== undefined && (demand === 'High demand' || demand === 'Medium demand')) {
    const stockRisk = stock <= number(reorder) || (stockCoverDays !== null && stockCoverDays < 15);
    if (stockRisk) return type === 'part' || type === 'consumable' ? (stockCoverDays !== null && stockCoverDays <= 7 ? 'Restock now' : 'Restock soon') : 'Restock soon';
  }
  if (observed === 0) return stock === null ? 'Check stock and demand' : 'Check if customers can find it';
  if (costCoverage < 1 && number(units) > 0) return 'Complete cost data';
  if (margin !== null && margin < 15 && demand === 'High demand') return 'Review margin';
  if (margin !== null && margin >= 25 && demand === 'Low demand') return 'Consider a special offer';
  return 'Monitor';
}

function mergeProductRows(list) {
  const byId = new Map();
  for (const row of list) {
    const previous = byId.get(row.id);
    if (!previous) { byId.set(row.id, { ...row }); continue; }
    const priorUnits = previous.units;
    const units = priorUnits + row.units;
    previous.source = previous.source === row.source ? row.source : 'mixed';
    previous.units = units;
    previous.revenue = round(previous.revenue + row.revenue);
    previous.gross = round(previous.gross + row.gross);
    previous.discounts = round(previous.discounts + row.discounts);
    previous.contribution = previous.contribution === null || row.contribution === null ? null : round(previous.contribution + row.contribution);
    previous.costCoverage = units ? round((previous.costCoverage * priorUnits + row.costCoverage * row.units) / units) : 0;
    previous.consumed = Math.max(number(previous.consumed), number(row.consumed));
    previous.completedServices = Math.max(number(previous.completedServices), number(row.completedServices));
    previous.lastSale = [previous.lastSale, row.lastSale].filter(Boolean).sort((a, b) => b - a)[0] || null;
    previous.lastMovement = [previous.lastMovement, row.lastMovement].filter(Boolean).sort((a, b) => b - a)[0] || null;
    if (previous.stock === null) previous.stock = row.stock;
    if (previous.reorder === null) previous.reorder = row.reorder;
  }
  return [...byId.values()];
}

// The service cohort is based on booking creation. Its monetary column is the
// completed booking's recorded service price, not cash collections or the
// authoritative finance report's project-aware completed sales.
async function serviceDemand(period) {
  const midpoint = new Date((period.start.getTime() + period.end.getTime()) / 2);
  const [rows, coreCatalog, repairCatalog] = await Promise.all([BookingService.aggregate([
    { $match: { sourceOrderId: null, createdAt: { $gte: period.start, $lte: period.end } } },
    { $project: {
      status: 1, createdAt: 1, serviceType: 1, service: 1, services: 1, applianceTypeName: 1,
      applianceType: 1, hp: 1, totalPrice: 1, estimatedFee: 1,
    } },
    { $set: { lines: { $cond: [{ $gt: [{ $size: { $ifNull: ['$services', []] } }, 0] }, '$services', [{ name: '$service.name', type: '$serviceType', applianceTypeName: '$applianceTypeName', applianceType: '$applianceType', hp: '$hp', quantity: 1 }] ] } } },
    { $set: { lineCount: { $size: '$lines' } } },
    { $unwind: '$lines' },
    { $group: {
      _id: { name: { $ifNull: ['$lines.name', 'Unspecified service'] }, category: { $ifNull: ['$lines.type', '$serviceType'] }, unit: { $ifNull: ['$lines.applianceTypeName', { $ifNull: ['$lines.airconTypeName', { $ifNull: ['$lines.applianceType', 'Unspecified unit'] }] }] }, hp: { $ifNull: ['$lines.hp', 0] } },
      bookingIds: { $addToSet: '$_id' }, units: { $sum: { $ifNull: ['$lines.quantity', 1] } },
      completedIds: { $addToSet: { $cond: [{ $in: ['$status', completedBookingStatuses] }, '$_id', null] } },
      cancelledIds: { $addToSet: { $cond: [{ $in: ['$status', cancelledBookingStatuses] }, '$_id', null] } },
      recentIds: { $addToSet: { $cond: [{ $gte: ['$createdAt', midpoint] }, '$_id', null] } },
      completedValue: { $sum: { $cond: [{ $in: ['$status', completedBookingStatuses] }, { $divide: [{ $ifNull: ['$totalPrice', { $ifNull: ['$estimatedFee', 0] }] }, '$lineCount'] }, 0] } },
    } },
    { $set: { bookings: { $size: '$bookingIds' }, completed: { $size: { $setDifference: ['$completedIds', [null]] } }, cancelled: { $size: { $setDifference: ['$cancelledIds', [null]] } }, recentBookings: { $size: { $setDifference: ['$recentIds', [null]] } } } },
    { $unset: ['bookingIds', 'completedIds', 'cancelledIds', 'recentIds'] },
    { $sort: { bookings: -1, completedValue: -1 } },
  ]).allowDiskUse(true), CoreService.find({ active: true }).select('name').lean(), RepairService.find({ active: true }).select('name').lean()]);
  const seen = new Set(rows.map(row => `${String(row._id.name).toLowerCase()}|${row._id.category || 'core'}`));
  for (const [category, catalog] of [['core', coreCatalog], ['repair', repairCatalog]]) {
    for (const service of catalog) {
      if (seen.has(`${service.name.toLowerCase()}|${category}`)) continue;
      rows.push({ _id: { name: service.name, category, unit: 'All units', hp: 0 }, bookings: 0, units: 0, completed: 0, cancelled: 0, recentBookings: 0, completedValue: 0 });
    }
  }
  const totals = rows.reduce((sum, row) => ({ bookings: sum.bookings + row.bookings, value: sum.value + number(row.completedValue) }), { bookings: 0, value: 0 });
  const days = Math.max(1, Math.ceil((period.end - period.start) / 86400000));
  return rows.map(row => ({
    name: row._id.name, category: row._id.category || 'core', unit: row._id.unit, hp: row._id.hp,
    bookings: row.bookings, units: round(row.units), completed: row.completed, cancelled: row.cancelled,
    completedValue: round(row.completedValue), averageCompletedValue: row.completed ? round(row.completedValue / row.completed) : 0, recentBookings: row.recentBookings, demand: serviceDemandLabel(row, totals, days),
    frequencyPer30Days: round(row.bookings * 30 / days),
  })).sort((a, b) => b.bookings - a.bookings || b.completedValue - a.completedValue);
}

async function productDemand(period) {
  const [orderRows, posRows, refunds, catalog, hvacCatalog, tools, consumption, lifetimeSales] = await Promise.all([
    Order.aggregate([
      { $match: { status: 'completed', $or: [{ completedAt: { $gte: period.start, $lte: period.end } }, { completedAt: null, updatedAt: { $gte: period.start, $lte: period.end } }] } },
      { $project: { items: 1, discount: 1, subtotal: 1, completionDate: { $ifNull: ['$completedAt', '$updatedAt'] } } },
      { $unwind: '$items' },
      { $match: { 'items.inventoryId': { $ne: null } } },
      { $group: { _id: '$items.inventoryId', units: { $sum: '$items.quantity' }, gross: { $sum: '$items.totalPrice' }, discount: { $sum: { $ifNull: ['$items.discountAmount', { $cond: [{ $gt: ['$subtotal', 0] }, { $multiply: [{ $ifNull: ['$discount', 0] }, { $divide: ['$items.totalPrice', '$subtotal'] }] }, 0] }] } }, orders: { $addToSet: '$_id' }, lastSale: { $max: '$completionDate' } } },
      { $set: { orders: { $size: '$orders' } } },
      { $sort: { units: -1 } },
    ]).allowDiskUse(true),
    WalkInSale.aggregate([
      { $match: { status: 'completed', completedAt: { $gte: period.start, $lte: period.end } } },
      { $project: { items: 1, discount: 1, subtotal: 1, completedAt: 1 } },
      { $unwind: '$items' },
      { $match: { 'items.toolId': { $ne: null } } },
      { $group: { _id: { productId: '$items.toolId', source: '$items.source' }, name: { $first: '$items.itemName' }, itemType: { $first: '$items.itemType' }, units: { $sum: '$items.quantity' }, gross: { $sum: '$items.totalPrice' }, cost: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.costPrice', 0] }] } }, costedUnits: { $sum: { $cond: [{ $gt: ['$items.costPrice', 0] }, '$items.quantity', 0] } }, discount: { $sum: { $cond: [{ $gt: ['$subtotal', 0] }, { $multiply: [{ $ifNull: ['$discount', 0] }, { $divide: ['$items.totalPrice', '$subtotal'] }] }, 0] } }, lastSale: { $max: '$completedAt' } } },
      { $sort: { units: -1 } },
    ]).allowDiskUse(true),
    ProductRefund.aggregate([{ $match: { status: 'completed', processedAt: { $gte: period.start, $lte: period.end } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
    Inventory.find({ active: true, status: { $nin: ['discontinued', 'coming_soon'] } }).select('modelLine sku capacity type quantity minStockLevel costPrice brand').populate('brand', 'name').lean(),
    HVACProduct.find({ active: true, status: { $nin: ['discontinued', 'coming_soon'] } }).select('modelLine brand type variants').populate('brand', 'name').lean(),
    Tool.find({ status: { $ne: 'discontinued' } }).select('itemName type itemType quantity minStockLevel costPrice inventoryClass').lean(),
    ServiceToolUsage.aggregate([
      { $match: { lifecycleStatus: { $ne: 'voided' }, usedAt: { $gte: period.start, $lte: period.end }, itemType: { $in: ['part', 'consumable'] }, bookingId: { $ne: null } } },
      { $lookup: { from: BookingService.collection.name, localField: 'bookingId', foreignField: '_id', as: 'booking' } },
      { $match: { 'booking.status': { $in: completedBookingStatuses }, 'booking.sourceOrderId': null } },
      { $group: { _id: { $ifNull: ['$toolItemId', '$inventoryItemId'] }, units: { $sum: '$quantityUsed' }, bookingIds: { $addToSet: '$bookingId' }, lastMovement: { $max: '$usedAt' } } },
      { $set: { completedServices: { $size: '$bookingIds' } } },
      { $unset: 'bookingIds' },
    ]),
    remember('product-last-recorded-sale', { bucket: Math.floor(Date.now() / 300000) }, () => Promise.all([
      Order.aggregate([
        { $match: { status: 'completed' } },
        { $project: { items: 1, saleDate: { $ifNull: ['$completedAt', '$updatedAt'] } } },
        { $unwind: '$items' },
        { $match: { 'items.inventoryId': { $ne: null } } },
        { $group: { _id: '$items.inventoryId', lastSale: { $max: '$saleDate' } } },
      ]).allowDiskUse(true),
      WalkInSale.aggregate([
        { $match: { status: 'completed' } },
        { $project: { items: 1, saleDate: { $ifNull: ['$completedAt', '$createdAt'] } } },
        { $unwind: '$items' },
        { $match: { 'items.toolId': { $ne: null } } },
        { $group: { _id: '$items.toolId', lastSale: { $max: '$saleDate' } } },
      ]).allowDiskUse(true),
    ]), { ttlMs: 300000, maxEntries: 5 }),
  ]);
  const lastRecordedSale = new Map();
  for (const row of lifetimeSales.flat()) {
    const key = String(row._id);
    const previous = lastRecordedSale.get(key);
    if (!previous || new Date(row.lastSale) > new Date(previous)) lastRecordedSale.set(key, row.lastSale);
  }
  const inventoryById = new Map(catalog.map(item => [String(item._id), item]));
  const variantById = new Map();
  for (const product of hvacCatalog) {
    for (const variant of product.variants || []) {
      if (variant.active === false || ['discontinued', 'coming_soon'].includes(variant.status)) continue;
      variantById.set(String(variant._id), { ...variant, modelLine: product.modelLine, brand: product.brand, type: product.type });
    }
  }
  const toolById = new Map(tools.map(item => [String(item._id), item]));
  const consumedById = new Map(consumption.map(item => [String(item._id), item]));
  // Refunds are shown separately because historical item-level allocations can
  // differ from current catalog costs; never present a false net margin.
  const refundTotal = refunds.reduce((sum, row) => sum + number(row.amount), 0);
  const aircon = orderRows.map(row => {
    const item = inventoryById.get(String(row._id)) || variantById.get(String(row._id));
    const cost = number(item?.costPrice) * number(row.units);
    return { id: String(row._id), source: 'order', name: item?.modelLine || 'Archived aircon', brand: item?.brand?.name || '', type: item?.type || '', hp: item?.capacity || '', units: number(row.units), revenue: round(number(row.gross) - number(row.discount)), gross: round(row.gross), discounts: round(row.discount), contribution: item?.costPrice > 0 ? round(row.gross - row.discount - cost) : null, costCoverage: item?.costPrice > 0 ? 1 : 0, stock: item?.quantity ?? null, reorder: item?.minStockLevel ?? null, lastSale: row.lastSale };
  });
  const merchandise = posRows.map(row => {
    const item = toolById.get(String(row._id.productId));
    const isAircon = row._id.source === 'aircon' || row._id.source === 'aircon_legacy' || row.itemType === 'aircon';
    const airconItem = isAircon ? inventoryById.get(String(row._id.productId)) || variantById.get(String(row._id.productId)) : null;
    const units = number(row.units);
    const consumption = consumedById.get(String(row._id.productId));
    return { id: String(row._id.productId), source: 'pos', name: row.name || airconItem?.modelLine || item?.itemName || 'Archived item', type: isAircon ? 'aircon' : (item?.type || row.itemType || 'part'), hp: airconItem?.capacity || '', units, revenue: round(number(row.gross) - number(row.discount)), gross: round(row.gross), discounts: round(row.discount), contribution: row.costedUnits >= units && units > 0 ? round(row.gross - row.discount - row.cost) : null, costCoverage: units ? round(row.costedUnits / units) : 0, stock: airconItem?.quantity ?? item?.quantity ?? null, reorder: airconItem?.minStockLevel ?? item?.minStockLevel ?? null, consumed: number(consumption?.units), completedServices: number(consumption?.completedServices), lastMovement: consumption?.lastMovement || row.lastSale, lastSale: row.lastSale };
  });
  const allAircon = [...aircon, ...merchandise.filter(row => row.type === 'aircon')];
  const toolsSold = merchandise.filter(row => ['equipment', 'tool'].includes(row.type));
  const partsSold = merchandise.filter(row => !['aircon', 'equipment', 'tool'].includes(row.type));
  for (const item of catalog) {
    if (allAircon.some(row => row.id === String(item._id))) continue;
    allAircon.push({ id: String(item._id), source: 'order', name: item.modelLine, brand: item.brand?.name || '', type: item.type || '', hp: item.capacity || '', units: 0, revenue: 0, gross: 0, discounts: 0, contribution: null, costCoverage: 0, stock: item.quantity, reorder: item.minStockLevel, lastSale: null });
  }
  for (const item of variantById.values()) {
    if (allAircon.some(row => row.id === String(item._id))) continue;
    allAircon.push({ id: String(item._id), source: 'order', name: item.modelLine, brand: item.brand?.name || '', type: item.type || '', hp: item.capacity || '', units: 0, revenue: 0, gross: 0, discounts: 0, contribution: null, costCoverage: 0, stock: item.quantity, reorder: item.minStockLevel, lastSale: null });
  }
  for (const item of tools) {
    const id = String(item._id);
    const target = ['equipment', 'tool'].includes(item.type) ? toolsSold : partsSold;
    if (target.some(row => row.id === id)) continue;
    if (target === toolsSold && item.inventoryClass === 'operational_asset') continue;
    const usage = consumedById.get(id);
    target.push({ id, source: 'pos', name: item.itemName, type: item.type, units: 0, revenue: 0, gross: 0, discounts: 0, contribution: null, costCoverage: 0, stock: item.quantity, reorder: item.minStockLevel, consumed: number(usage?.units), completedServices: number(usage?.completedServices), lastMovement: usage?.lastMovement || null, lastSale: null });
  }
  const decorate = list => {
    list = mergeProductRows(list);
    const totalSales = list.reduce((sum, row) => sum + row.units, 0);
    const totalConsumption = list.reduce((sum, row) => sum + (row.consumed || 0), 0);
    const total = totalSales + totalConsumption;
    const days = Math.max(1, Math.ceil((period.end - period.start) / 86400000));
    const ranked = list.map(row => {
      const demand = demandLabel(row.units + (row.consumed || 0), total, days);
      const salesDemand = demandLabel(row.units, totalSales, days);
      const consumptionDemand = totalConsumption ? demandLabel(row.consumed || 0, totalConsumption, days) : 'No usage recorded';
      const margin = row.contribution === null || row.revenue <= 0 ? null : round(row.contribution * 100 / row.revenue);
      const stockRunRate = (row.units + (row.consumed || 0)) / days;
      const stockCoverDays = row.stock === null || !stockRunRate ? null : round(row.stock / stockRunRate);
      const lastMovement = [row.lastSale, row.lastMovement].filter(Boolean).map(value => new Date(value)).sort((a, b) => b - a)[0] || null;
      const recordedSale = lastRecordedSale.get(row.id) || row.lastSale || null;
      const result = { ...row, demand, salesDemand, consumptionDemand, margin, salesPer30Days: round(row.units * 30 / days), consumptionPer30Days: round((row.consumed || 0) * 30 / days), stockCoverDays, lastMovement, lastRecordedSale: recordedSale, daysSinceLastSale: recordedSale ? Math.max(0, Math.floor((Date.now() - new Date(recordedSale)) / 86400000)) : null, lowStock: row.stock !== null && row.reorder !== null && row.stock <= row.reorder };
      result.action = productDecision({ ...result, days });
      return result;
    }).sort((a, b) => b.units + (b.consumed || 0) - a.units - (a.consumed || 0));
    return ranked;
  };
  return { aircon: decorate(allAircon), tools: decorate(toolsSold), parts: decorate(partsSold), refundTotal: round(refundTotal), caveat: 'Items without an item ID are left out of this list. Older orders do not save the original product cost, so current stock costs are used. Item refunds are shown as a total and are not split between items. Days of stock left uses the average sold or used per day during these dates. It is an estimate.' };
}

async function customerDemand(period, policy) {
  const [bookings, orders, users, lifetimeRows] = await Promise.all([
    BookingService.aggregate([{ $match: { sourceOrderId: null, createdAt: { $gte: period.start, $lte: period.end }, customerId: { $ne: null } } }, { $group: { _id: '$customerId', bookings: { $sum: 1 }, completedBookings: { $sum: { $cond: [{ $in: ['$status', completedBookingStatuses] }, 1, 0] } }, cancelledBookings: { $sum: { $cond: [{ $in: ['$status', cancelledBookingStatuses] }, 1, 0] } }, noShows: { $sum: { $cond: [{ $eq: ['$status', 'no-show'] }, 1, 0] } }, lastBooking: { $max: { $cond: [{ $in: ['$status', completedBookingStatuses] }, { $ifNull: ['$completedAt', '$updatedAt'] }, null] } }, serviceValue: { $sum: { $cond: [{ $in: ['$status', completedBookingStatuses] }, { $ifNull: ['$totalPrice', { $ifNull: ['$estimatedFee', 0] }] }, 0] } } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: period.start, $lte: period.end } } }, { $group: { _id: '$userId', orders: { $sum: 1 }, completedOrders: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }, lastPurchase: { $max: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$completedAt', '$updatedAt'] }, null] } }, productValue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$total', 0] }, 0] } } } }]),
    User.find({ role: 'customer' }).select('firstName lastName createdAt').limit(10000).lean(),
    remember('customer-lifetime-activity', { bucket: Math.floor(Date.now() / 300000) }, () => Promise.all([
      BookingService.aggregate([{ $match: { sourceOrderId: null, status: { $in: completedBookingStatuses }, customerId: { $ne: null } } }, { $group: { _id: '$customerId', count: { $sum: 1 }, last: { $max: { $ifNull: ['$completedAt', '$updatedAt'] } } } }]),
      Order.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: '$userId', count: { $sum: 1 }, last: { $max: { $ifNull: ['$completedAt', '$updatedAt'] } } } }]),
    ]), { ttlMs: 300000, maxEntries: 5 }),
  ]);
  const [lifetimeBookings, lifetimeOrders] = lifetimeRows;
  const rewardHistories = policy.enabled && policy.rules.some(rule => rule.enabled) ? await completionHistories(users.map(user => user._id)) : new Map();
  const byId = new Map();
  const get = id => { const key = String(id); if (!byId.has(key)) byId.set(key, { id: key, bookings: 0, completedBookings: 0, cancelledBookings: 0, noShows: 0, orders: 0, completedOrders: 0, serviceValue: 0, productValue: 0 }); return byId.get(key); };
  bookings.forEach(row => Object.assign(get(row._id), row));
  orders.forEach(row => Object.assign(get(row._id), row));
  users.forEach(user => Object.assign(get(user._id), { name: [user.firstName, user.lastName].filter(Boolean).join(' '), joinedAt: user.createdAt }));
  lifetimeBookings.forEach(row => Object.assign(get(row._id), { lifetimeBookings: row.count, lifetimeLastBooking: row.last }));
  lifetimeOrders.forEach(row => Object.assign(get(row._id), { lifetimeOrders: row.count, lifetimeLastPurchase: row.last }));
  const today = new Date();
  const rows = [...byId.values()].filter(row => row.name).map(row => {
    const transactions = row.completedBookings + row.completedOrders;
    const spend = round(number(row.serviceValue) + number(row.productValue));
    const last = [row.lastBooking, row.lastPurchase].filter(Boolean).sort((a, b) => b - a)[0] || null;
    const ageDays = last ? Math.floor((today - new Date(last)) / 86400000) : null;
    const recency = ageDays === null ? 0 : ageDays <= 30 ? 3 : ageDays <= 90 ? 2 : ageDays <= 180 ? 1 : 0;
    const frequency = transactions >= 5 ? 3 : transactions >= 3 ? 2 : transactions >= 1 ? 1 : 0;
    const monetary = spend >= 50000 ? 3 : spend >= 20000 ? 2 : spend > 0 ? 1 : 0;
    const score = recency + frequency + monetary;
    const lifetimeLast = [row.lifetimeLastBooking, row.lifetimeLastPurchase].filter(Boolean).sort((a, b) => b - a)[0] || null;
    const inactivityDays = lifetimeLast ? Math.floor((today - new Date(lifetimeLast)) / 86400000) : null;
    const lifetimeTransactions = number(row.lifetimeBookings) + number(row.lifetimeOrders);
    const joinedDaysAgo = row.joinedAt ? Math.floor((today - new Date(row.joinedAt)) / 86400000) : null;
    const segment = lifetimeTransactions === 0 ? (joinedDaysAgo !== null && joinedDaysAgo <= 30 ? 'New' : 'No completed activity')
      : inactivityDays > 180 ? 'Long-term inactive'
        : inactivityDays > 90 ? 'Recently inactive'
          : score >= 8 ? 'VIP' : score >= 6 ? 'Loyal' : score >= 3 ? 'Regular' : 'Low activity';
    const neverBooked = !row.lifetimeBookings;
    const neverPurchased = !row.lifetimeOrders;
    const suggestedAction = lifetimeTransactions === 0 ? 'Help with first booking or purchase'
      : inactivityDays > 90 ? 'Review for a relevant service follow-up'
        : neverBooked ? 'Discuss installation or maintenance needs'
          : neverPurchased ? 'Discuss replacement or parts needs'
            : 'Keep service and sales experience consistent';
    const customer = { id: row.id, name: row.name, bookings: row.bookings, completedBookings: row.completedBookings, cancelledBookings: row.cancelledBookings, noShows: row.noShows, orders: row.orders, completedOrders: row.completedOrders, lifetimeBookings: number(row.lifetimeBookings), lifetimeOrders: number(row.lifetimeOrders), serviceValue: round(row.serviceValue), productValue: round(row.productValue), spend, lastBooking: row.lastBooking || null, lastPurchase: row.lastPurchase || null, lifetimeLastActivity: lifetimeLast, inactivityDays, lifetimeTransactions, suggestedAction, segment, score, scoreBreakdown: { recency, frequency, monetary }, neverBooked, neverPurchased };
    return { ...customer, loyalty: evaluateHistory(policy, rewardHistories.get(customer.id)) };
  });
  const qualified = rows.filter(row => row.loyalty.tier);
  const approaching = rows.filter(row => !row.loyalty.tier && row.loyalty.progress?.percent >= 75);
  const mostActive = [...rows].sort((a, b) => (b.completedBookings + b.completedOrders) - (a.completedBookings + a.completedOrders)).find(row => row.completedBookings + row.completedOrders > 0) || null;
  const followUp = rows.filter(row => row.lifetimeTransactions > 0 && row.inactivityDays > 90).sort((a, b) => a.inactivityDays - b.inactivityDays || b.lifetimeTransactions - a.lifetimeTransactions).slice(0, 30);
  const crossService = rows.filter(row => row.lifetimeTransactions > 0 && (row.neverBooked || row.neverPurchased)).sort((a, b) => b.lifetimeTransactions - a.lifetimeTransactions).slice(0, 30);
  return { top: [...rows].sort((a, b) => b.score - a.score || b.spend - a.spend).slice(0, 30), followUp, crossService, followUpTotal: rows.filter(row => row.lifetimeTransactions > 0 && row.inactivityDays > 90).length, crossServiceTotal: rows.filter(row => row.lifetimeTransactions > 0 && (row.neverBooked || row.neverPurchased)).length, mostActive, segments: rows.reduce((summary, row) => { summary[row.segment] = (summary[row.segment] || 0) + 1; return summary; }, {}), totalCustomers: rows.length, customerCatalogCapped: users.length >= 10000, qualifiedCount: qualified.length, approachingCount: approaching.length, qualified: qualified.sort((a, b) => b.loyalty.progress.value - a.loyalty.progress.value).slice(0, 20), approaching: approaching.sort((a, b) => b.loyalty.progress.percent - a.loyalty.progress.percent).slice(0, 20), scoring: 'Scores add 0-3 points each for recent activity, completed bookings and orders, and spending. Recent activity checks the last 30, 90, and 180 days. Counts check 1, 3, and 5 completions for these records. Spending checks amounts above 0, PHP 20,000, and PHP 50,000. These scores describe the records in this report, not total spending in all time.' };
}

async function compute(period) {
  const policy = await loadPolicy();
  const [services, products, customers] = await Promise.all([serviceDemand(period), productDemand(period), customerDemand(period, policy)]);
  const productsWithCost = [...products.aircon, ...products.tools, ...products.parts].filter(row => row.contribution !== null && row.units > 0);
  const leaders = { service: services.find(row => row.bookings > 0) || null, aircon: [...products.aircon].sort((a, b) => b.units - a.units).find(row => row.units > 0) || null, tool: [...products.tools].sort((a, b) => b.units - a.units).find(row => row.units > 0) || null, part: [...products.parts].sort((a, b) => b.units - a.units).find(row => row.units > 0) || null, consumedPart: [...products.parts].sort((a, b) => b.consumed - a.consumed).find(row => row.consumed > 0) || null, contribution: productsWithCost.sort((a, b) => b.contribution - a.contribution)[0] || null, customer: customers.mostActive };
  const actions = [];
  const serviceSample = services.reduce((sum, row) => sum + row.bookings, 0);
  const periodDays = Math.max(1, Math.ceil((period.end - period.start) / 86400000));
  if (serviceSample >= 10) {
    const busiest = services.find(row => row.demand === 'High demand');
    if (busiest) actions.push({ kind: 'service', name: busiest.name, action: 'Check technician availability', evidence: `${busiest.bookings} bookings and ${busiest.completed} completed for these dates` });
    const rare = [...services].reverse().find(row => row.demand === 'Low demand');
    if (rare) actions.push({ kind: 'service', name: rare.name, action: 'Consider a special offer', evidence: `${rare.bookings} bookings across ${periodDays} days` });
  }
  if (serviceSample >= 20 && periodDays >= 30) {
    const unused = services.find(row => row.demand === 'No demand');
    if (unused) actions.push({ kind: 'service', name: unused.name, action: 'Check if customers can find it', evidence: `No bookings across ${periodDays} days; confirm service availability before changing the offering` });
  }
  const completedServiceRows = services.filter(row => row.completed > 0);
  if (completedServiceRows.length >= 4) {
    const prices = completedServiceRows.map(row => row.averageCompletedValue).sort((a, b) => a - b);
    const medianPrice = prices[Math.floor(prices.length / 2)];
    const highValueNiche = completedServiceRows.filter(row => row.bookings <= 2 && row.averageCompletedValue > medianPrice).sort((a, b) => b.averageCompletedValue - a.averageCompletedValue)[0];
    if (highValueNiche) actions.push({ kind: 'service', name: highValueNiche.name, action: 'Consider a special offer', evidence: `${highValueNiche.bookings} bookings; ${round(highValueNiche.averageCompletedValue).toLocaleString('en-PH')} PHP average value of completed records` });
    const busyLowValue = completedServiceRows.filter(row => row.demand === 'High demand' && row.averageCompletedValue < medianPrice).sort((a, b) => b.bookings - a.bookings)[0];
    if (busyLowValue) actions.push({ kind: 'service', name: busyLowValue.name, action: 'Check service prices', evidence: `${busyLowValue.bookings} bookings; average completed value is below the service median. Verify direct costs before repricing.` });
  }
  for (const [kind, list] of [['aircon', products.aircon], ['tool', products.tools], ['repair part', products.parts]]) {
    for (const row of list.filter(item => Object.hasOwn(productActionPriority, item.action)).sort((a, b) => productActionPriority[a.action] - productActionPriority[b.action] || b.units + b.consumed - a.units - a.consumed).slice(0, 3)) {
      actions.push({ kind, name: row.name, action: row.action, evidence: `${row.units} sold${row.consumed ? `, ${row.consumed} used in ${row.completedServices} completed services` : ''}; ${row.stock === null ? 'stock unavailable' : `${row.stock} in stock${row.stockCoverDays === null ? '' : `, about ${row.stockCoverDays} days of stock left`}`}; estimated profit ${row.margin === null ? 'unavailable' : `${row.margin}%`}` });
    }
  }
  return { period: { range: period.range, from: period.start, to: period.end }, services, products, customers, loyaltyPolicy: policy, leaders, actions, asOf: new Date(), methodology: 'Service bookings use the request date and exclude installations linked to product orders. Completed booking values use saved prices. Product sales use completed orders and walk-in sales. Parts used in finished jobs are counted separately from sales. Days of stock left uses the average sold or used per day during these dates. Profit estimates use saved costs; some refunds cannot be linked to a specific item. Walk-in sales without a named customer do not go to a customer account. Rewards use all-time finished bookings and orders that meet the Customer Privileges rules. Checkout checks which items can get a discount. See Sales and Payments for completed sales, payments, and refund totals.' };
}

function buildDecisionIntelligence(query, now = new Date()) {
  const period = parsePeriod(query, now);
  const bucket = Math.floor(now.getTime() / 60000);
  return remember('decision-intelligence', { range: period.range, from: period.start.toISOString(), to: period.end.toISOString().slice(0, 10), bucket }, () => compute(period), { ttlMs: 60000, maxEntries: 12 });
}

module.exports = { buildDecisionIntelligence, parsePeriod, demandLabel, serviceDemandLabel, decision, productDecision, mergeProductRows };
