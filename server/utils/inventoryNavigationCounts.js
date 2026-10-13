'use strict';

const { manilaDateTime } = require('./bookingDateTime');

// Read-only counts: catalog alerts use actual quantities, not stale status flags.
function inventoryNavigationSources(now) {
  const start = manilaDateTime(now, 0);
  const end = manilaDateTime(now, 1440);
  const today = { $gte: start, $lt: end };
  return [
    ['inventoryAircons', () => require('../models/HVACProduct').aggregate([
      { $match: { active: true, archivedAt: null } },
      { $unwind: '$variants' },
      { $match: { 'variants.active': { $ne: false }, 'variants.status': { $nin: ['discontinued', 'coming_soon'] },
        $expr: { $lte: [{ $ifNull: ['$variants.quantity', 0] }, { $ifNull: ['$variants.minStockLevel', 3] }] } } },
      { $count: 'count' },
    ]).then(rows => rows[0]?.count || 0)],
    ['inventoryParts', () => require('../models/Tool').countDocuments({
      active: true, archivedAt: null, status: { $ne: 'discontinued' },
      $expr: { $lte: [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$minStockLevel', 3] }] },
    })],
    ['inventoryKits', () => require('../models/DailyKit').countDocuments({
      workDate: today,
      $or: [
        { hasDelta: true },
        ...['items', 'deltaItems'].map(field => ({ [field]: { $elemMatch: {
          checkoutStatus: 'unavailable', 'exception.approved': { $ne: true },
          'resolution.status': { $in: [null, '', 'admin_notified'] },
        } } })),
      ],
    })],
    ['inventorySales', async () => {
      // Aircon POS checkout creates an Order; parts checkout creates a WalkInSale.
      const createdAt = { $gte: start, $lte: now };
      const counts = await Promise.all([
        require('../models/WalkInSale').countDocuments({ status: 'completed', createdAt }),
        require('../models/Order').countDocuments({ salesChannel: 'walk_in', archivedAt: null,
          status: { $nin: ['cancelled', 'rejected'] }, createdAt }),
      ]);
      return counts.reduce((total, count) => total + count, 0);
    }],
    ['inventoryHistory', () => require('../models/StockAdjustment').countDocuments({ createdAt: { $gte: start, $lte: now } })],
  ];
}

module.exports = { inventoryNavigationSources };
