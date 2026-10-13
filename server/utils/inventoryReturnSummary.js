'use strict';
const { manilaDateTime } = require('./bookingDateTime');
async function inventoryReturnSummary(now = new Date()) {
  const EquipmentAssignment = require('../models/EquipmentAssignment');
  const base = { consumable: { $ne: true }, status: { $in: ['checked_out', 'in_use'] } };
  const overdue = [{ expectedReturnAt: { $lt: now } }, { $and: [{ expectedReturnAt: null }, { workDate: { $lt: manilaDateTime(now, 0) } }] }];
  const [overdueCount, equipmentAttention, materialReports] = await Promise.all([
    EquipmentAssignment.countDocuments({ ...base, $or: overdue }),
    EquipmentAssignment.countDocuments({ ...base, $or: [{ returnPending: true }, ...overdue] }),
    require('../models/KitReturn').countDocuments({ status: 'pending', category: { $in: ['consumable', 'repair_part'] } }),
  ]);
  // Equipment both overdue and awaiting receipt is counted once.
  return { overdue: overdueCount, actionable: equipmentAttention + materialReports };
}
module.exports = { inventoryReturnSummary };
