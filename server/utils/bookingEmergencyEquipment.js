'use strict';
const { ref } = require('./standardJobTeam');
const { outstanding } = require('./kitMaterialBalance');

// Live, read-only custody. A cancelled assignment never constitutes a return.
async function read(booking, overrides = {}, source = 'booking') {
  const deps = { Equipment: require('../models/EquipmentAssignment'), Kit: require('../models/DailyKit'), ...overrides };
  const incident = booking.staffingEmergencies?.at(-1);
  if (!incident) return { items: [], hasReport: false };
  const crew = incident.team || [];
  const technicianIds = crew.map(row => row.technicianId);
  const linkField = source === 'order' ? 'orderIds' : 'bookingIds', issuedField = source === 'order' ? 'issuedOrderIds' : 'issuedBookingIds';
  const linked = item => [...item[linkField] || [], ...item[issuedField] || []].some(id => ref(id) === ref(booking._id));
  const kits = await deps.Kit.find({ technicianId: { $in: technicianIds }, $or: [
    { [`items.${linkField}`]: booking._id }, { [`items.${issuedField}`]: booking._id },
    { [`deltaItems.${linkField}`]: booking._id }, { [`deltaItems.${issuedField}`]: booking._id },
  ] }).select('_id technicianId workDate items deltaItems').lean();
  // Daily kits consolidate several bookings. Use each matching item's ledger
  // references; selecting every ledger from that kit would include unrelated work.
  const ledgerIds = kits.flatMap(kit => [...kit.items || [], ...kit.deltaItems || []].filter(linked)
    .flatMap(item => [item.equipmentAssignmentId, ...item.custodyAssignmentIds || [], ...item.reservedAssignmentIds || []]).filter(Boolean));
  const ledgers = await deps.Equipment.find({ technicianId: { $in: technicianIds },
    status: { $in: ['reserved', 'checked_out', 'in_use'] }, $or: [{ [source === 'order' ? 'orderIds' : 'bookingId']: booking._id }, { _id: { $in: ledgerIds } }] })
    .select('_id technicianId equipmentName equipmentCode quantity status consumable consumableUsed consumableReturned consumableDamaged consumableMissing returnPending dailyKitId workDate').lean();
  const holder = id => crew.find(row => ref(row.technicianId) === ref(id))?.name || 'Previous technician';
  const items = ledgers.filter(row => !row.consumable).map(row => ({ id: ref(row._id), name: row.equipmentName,
    holder: holder(row.technicianId), category: 'equipment', quantity: Number(row.quantity) || 0,
    state: row.status === 'reserved' ? 'reserved' : row.returnPending ? 'return_pending' : 'with_technician',
    shared: Boolean(row.dailyKitId) }));
  for (const row of ledgers.filter(row => row.consumable && !row.dailyKitId)) {
    const quantity = Math.max(0, Number(row.quantity || 0) - Number(row.consumableUsed || 0) - Number(row.consumableReturned || 0)
      - Number(row.consumableDamaged || 0) - Number(row.consumableMissing || 0));
    if (quantity > 0) items.push({ id: ref(row._id), name: row.equipmentName, holder: holder(row.technicianId), category: 'consumable', quantity,
      state: row.status === 'reserved' ? 'reserved' : row.returnPending ? 'return_pending' : 'with_technician', shared: false });
  }
  for (const kit of kits) for (const item of [...kit.items || [], ...kit.deltaItems || []]) {
    if (!linked(item) || !['consumable', 'repair_part'].includes(item.category) || outstanding(item) <= 0) continue;
    items.push({ id: ref(item._id), name: item.name, holder: holder(kit.technicianId), category: item.category,
      quantity: outstanding(item), unit: item.unit || 'pcs', returnPendingQuantity: Number(item.returnPendingQuantity || 0),
      state: Number(item.returnPendingQuantity || 0) > 0 ? 'return_pending' : 'with_technician', shared: true });
  }
  return { hasReport: true, items };
}

async function releaseDemand(result, actorId, overrides = {}, source = 'booking') {
  if (result.duplicate) return;
  const deps = { release: require('./equipmentAssignmentLifecycle').releaseReservedEquipment,
    syncKit: require('./dailyKitService').syncDailyKit, ...overrides };
  const { booking, incident } = result;
  const technicianIds = [...new Set(incident.team.map(row => ref(row.technicianId)))];
  // Only unissued reservations from the previous crew are released. A shared
  // kit's physical custody survives, including work for other customers.
  await deps.release({ filter: { ...(source === 'order' ? { orderIds: { $size: 1, $all: [booking._id] } } : { bookingId: booking._id }), technicianId: { $in: technicianIds }, createdAt: { $lte: incident.reportedAt } },
    actorId, reason: 'Emergency report: previous team released before work started', moduleName: 'emergency reassignment' });
  const results = await Promise.allSettled(technicianIds.map(id => deps.syncKit(id, source === 'order' ? booking.delivery?.preferredDate : booking.bookingDate, { automatic: true })));
  const failure = results.find(row => row.status === 'rejected');
  if (failure) throw failure.reason;
}

module.exports = { read, releaseDemand };
