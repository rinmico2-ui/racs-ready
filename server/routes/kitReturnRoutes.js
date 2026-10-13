'use strict';
const express = require('express');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/requirePermission');
const { outstanding, available } = require('../utils/kitMaterialBalance');
const KitReturn = require('../models/KitReturn');
const service = require('../utils/kitReturnService').createService();
module.exports = function createRouter({ technician = false, getContext } = {}) {
  const router = express.Router();
  router.use(authenticate, requireRole(technician ? ['technician'] : ['admin', 'secretary']));
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!technician) return req.user.role === 'secretary' ? requirePermission('appointments.view')(req, res, next) : next();
    try {
      req.returnContext = await getContext(req.user._id);
      if (!req.returnContext.tech) return res.status(404).json({ error: 'Technician record not found.' });
      next();
    } catch (error) { next(error); }
  });
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); } };
  if (technician) {
    router.get('/materials', handle(async (req, res) => {
      const DailyKit = require('../models/DailyKit');
      const selectAll = req.query.selection === 'all';
      const page = selectAll ? 1 : Math.max(1, parseInt(req.query.page, 10) || 1), limit = selectAll ? 100 : 20;
      const outstandingExpr = { $max: [0, { $subtract: [{ $ifNull: ['$item.quantityIssued', 0] }, { $add: ['quantityUsed', 'quantityReturned', 'quantityDamaged', 'quantityMissing'].map(field => ({ $ifNull: ['$item.' + field, 0] })) }] }] };
      const availableExpr = { $max: [0, { $subtract: [outstandingExpr, { $ifNull: ['$item.returnPendingQuantity', 0] }] }] };
      const [snapshot] = await DailyKit.aggregate([
        { $match: { technicianId: { $in: req.returnContext.technicianIds.map(value => new (require('mongoose').Types.ObjectId)(value)) } } },
        { $project: { workDate: 1, item: { $concatArrays: [{ $ifNull: ['$items', []] }, { $ifNull: ['$deltaItems', []] }] } } },
        { $unwind: '$item' },
        { $match: { 'item.category': { $in: ['consumable', 'repair_part'] }, $expr: { $gt: [outstandingExpr, 0] } } },
        ...(selectAll ? [{ $match: { $expr: { $and: [{ $gt: [availableExpr, 0] }, { $lte: [{ $ifNull: ['$item.returnPendingQuantity', 0] }, 0] }] } } }] : []),
        { $sort: { workDate: -1, _id: 1, 'item._id': 1 } },
        { $facet: { total: [{ $count: 'count' }], items: [{ $skip: (page - 1) * limit }, { $limit: limit },
          { $replaceRoot: { newRoot: { $mergeObjects: ['$item', { kitId: '$_id', workDate: '$workDate', outstanding: outstandingExpr, available: { $max: [0, { $subtract: [outstandingExpr, { $ifNull: ['$item.returnPendingQuantity', 0] }] }] } }] } } }] } },
      ]).allowDiskUse(true);
      if (selectAll && (snapshot?.total[0]?.count || 0) > 100) return res.status(400).json({ error: 'You have more than 100 materials. Select and return up to 100 at a time.' });
      const items = snapshot?.items || [];
      const sourceIds = key => [...new Set(items.flatMap(item => [...(item[key] || []), ...(item[key === 'bookingIds' ? 'issuedBookingIds' : 'issuedOrderIds'] || [])]).map(String))];
      const [bookings, orders] = await Promise.all([
        require('../models/BookingService').find({ _id: { $in: sourceIds('bookingIds') } }).select('_id status').lean(),
        require('../models/Order').find({ _id: { $in: sourceIds('orderIds') } }).select('_id status').lean(),
      ]);
      const cancelled = new Set([...bookings, ...orders].filter(job => job.status === 'cancelled').map(job => String(job._id)));
      items.forEach(item => { item.cancelledWork = [...(item.bookingIds || []), ...(item.issuedBookingIds || []), ...(item.orderIds || []), ...(item.issuedOrderIds || [])].some(value => cancelled.has(String(value))); });
      const total = snapshot?.total[0]?.count || 0;
      return res.json({ items, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
    }));
    router.post('/materials', handle(async (req, res) => {
      const report = await service.reportMaterials({ kitId: req.body.kitId, itemId: req.body.itemId, unused: req.body.unused ?? req.body.quantity, used: req.body.used, damaged: req.body.damaged, missing: req.body.missing, notes: req.body.notes, technicianIds: req.returnContext.technicianIds, userId: req.user._id });
      await require('../utils/kitReturnNotifications').reported(report, req);
      return res.json({ success: true, report, message: 'Report sent. Stock will be updated after admin confirms receipt.' });
    }));
    router.post('/materials/batch', handle(async (req, res) => {
      const reports = await service.reportMaterialsBatch({ items: req.body.items, notes: req.body.notes, technicianIds: req.returnContext.technicianIds, userId: req.user._id });
      await require('../utils/kitReturnNotifications').reported(reports, req);
      return res.json({ success: true, reports, message: `${reports.length} return report(s) sent. Stock will be updated after admin confirms receipt.` });
    }));
  }
  router.get('/', handle(async (req, res) => {
    const selectAll = !technician && req.query.selection === 'all';
    const page = selectAll ? 1 : Math.max(1, parseInt(req.query.page, 10) || 1), limit = selectAll ? 100 : 10;
    const filter = { status: !selectAll && ['received', 'rejected'].includes(req.query.status) ? req.query.status : 'pending' };
    if (technician) filter.technicianId = { $in: req.returnContext.technicianIds };
    const [items, total] = await Promise.all([
      KitReturn.find(filter).populate('technicianId', 'name').populate('dailyKitId', 'workDate')
        .populate('bookingIds', 'bookingReference status').populate('orderIds', 'orderReference status')
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      KitReturn.countDocuments(filter),
    ]);
    if (selectAll && total > 100) return res.status(400).json({ error: 'There are more than 100 pending reports. Select and review up to 100 at a time.' });
    return res.json({ items, pagination: { page, pages: Math.max(1, Math.ceil(total / limit)), total, limit } });
  }));
  if (!technician) router.post('/review-batch', requireRole(['admin']), handle(async (req, res) => {
    const reports = await service.reconcileBatch({ items: req.body.items, userId: req.user._id, decision: req.body.decision, notes: req.body.notes, confirmedReceived: req.body.confirmedReceived });
    for (const report of reports) {
      await require('../utils/audit').logEvent({ actor: req.user._id, target: report._id, action: `inventory.kit_return.${report.status}`, module: 'inventory', req, details: { batch: true, name: report.name, unused: report.unused, used: report.used, damaged: report.damaged, missing: report.missing, receiptNotes: report.receiptNotes } }).catch(error => console.warn('[kit-return] Audit unavailable:', error.message));
      await require('../utils/kitReturnNotifications').reviewed(report, req);
    }
    return res.json({ success: true, reports, message: req.body.decision === 'receive' ? `${reports.length} returns reviewed. Only usable returned stock was restored.` : `${reports.length} reports marked for correction. Stock was not changed.` });
  }));
  if (!technician) router.post('/:id/review', requireRole(['admin']), handle(async (req, res) => {
    const report = await service.reconcile({ reportId: req.params.id, userId: req.user._id, decision: req.body.decision, quantities: req.body.quantities, condition: req.body.condition, notes: req.body.notes });
    await require('../utils/audit').logEvent({ actor: req.user._id, target: report._id, action: `inventory.kit_return.${report.status}`, module: 'inventory', req, details: { name: report.name, unused: report.unused, used: report.used, damaged: report.damaged, missing: report.missing, receiptNotes: report.receiptNotes } }).catch(error => console.warn('[kit-return] Audit unavailable:', error.message));
    await require('../utils/kitReturnNotifications').reviewed(report, req);
    return res.json({ success: true, report, message: report.status === 'received' ? 'Return received. Only usable returned stock was restored.' : 'Report rejected. Stock was not changed.' });
  }));
  return router;
};
