'use strict';
const { manilaDateTime } = require('./bookingDateTime');
const { available } = require('./kitMaterialBalance');
const units = require('./repairUnitWorkflow');
const { purchaseReceived } = require('./standardRepairVisit');
const ref = value => String(value?._id || value || '');
const fail = message => Object.assign(new Error(message), { status: 409 });
const partKey = part => part.toolId ? `id:${ref(part.toolId)}` : `name:${String(part.name || '').trim().toLowerCase()}`;
const remainingReservation = row => Math.max(0, Number(row.quantity) - ['quantityFulfilled', 'quantityReturned', 'quantityDamaged', 'quantityMissing'].reduce((sum, key) => sum + Number(row[key] || 0), 0));
const belongs = (item, bookingId) => [...(item.bookingIds || []), ...(item.issuedBookingIds || [])].some(value => ref(value) === ref(bookingId));

function approvedParts(booking) {
  const source = booking.repairUnitTracking
    ? units.rows(booking).filter(row => ['approved', 'completed'].includes(row.unit.repairReview?.state)).flatMap(row => row.unit.quotation?.parts || [])
    : booking.quotation?.parts || [];
  const grouped = new Map();
  for (const part of source) {
    const name = String(part.name || part.partName || '').trim(), quantity = Number(part.quantity ?? 1);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) throw fail('The approved replacement parts need a staff review.');
    const key = partKey({ ...part, name }), previous = grouped.get(key);
    if (previous) previous.quantity += quantity;
    else grouped.set(key, { key, name, quantity, unit: part.unit || 'pcs', toolId: part.toolId || null });
  }
  return [...grouped.values()];
}

function createService(overrides = {}) {
  const m = { ...Object.fromEntries(['DailyKit', 'Tool', 'StockReservation', 'ServiceToolUsage'].map(name => [name, require('../models/' + name)])), ...overrides };
  const scoped = (query, session) => session ? query.session(session) : query;
  async function plan({ booking, assignment, technicianId, session }) {
    const parts = approvedParts(booking);
    const kit = await scoped(m.DailyKit.findOne({ technicianId, workDate: manilaDateTime(assignment.bookingDate || booking.bookingDate, 0) }), session);
    const reservations = await scoped(m.StockReservation.find({ bookingId: booking._id, status: { $in: ['reserved', 'checked_out'] } }), session);
    const tools = parts.some(part => part.toolId) ? await scoped(m.Tool.find({ _id: { $in: parts.map(part => part.toolId).filter(Boolean) } }), session).lean() : [];
    const items = (kit?.items || []).filter(item => belongs(item, booking._id));
    const budgets = new Map(items.map(item => [ref(item._id), available(item)]));
    const reservationBudgets = new Map(reservations.map(row => [ref(row._id), remainingReservation(row)]));
    const allocations = [];
    const partRows = parts.map(part => {
      const tool = part.toolId && tools.find(row => ref(row._id) === ref(part.toolId));
      if (part.toolId && (!tool || (tool.type || tool.itemType) !== 'part' || tool.inventoryClass === 'operational_asset')) throw fail(`${part.name} is not a replacement part. Ask staff to review the approved quotation.`);
      let remaining = part.quantity, issued = 0, reserved = 0, purchased = 0;
      const kitAllocations = [], reservationAllocations = [];
      for (const item of items.filter(row => row.category === 'repair_part' && ref(row.toolId) === ref(part.toolId) && part.toolId
        && ['issued', 'checked_out', 'in_custody'].includes(row.checkoutStatus))) {
        const quantity = Math.min(remaining, budgets.get(ref(item._id)) || 0);
        if (quantity > 0) { kitAllocations.push({ item, quantity }); budgets.set(ref(item._id), budgets.get(ref(item._id)) - quantity); issued += quantity; remaining -= quantity; }
      }
      const deductedReservations = reservations.filter(row => ref(row.toolId) === ref(part.toolId) && row.status === 'reserved' && row.stockTreatment !== 'soft_hold');
      if (deductedReservations.reduce((sum, row) => sum + remainingReservation(row), 0) > remaining) throw fail(`Ask staff to reconcile the extra reserved ${part.name} before completion.`);
      for (const row of deductedReservations) {
        const quantity = Math.min(remaining, reservationBudgets.get(ref(row._id)) || 0);
        if (quantity > 0) { reservationAllocations.push({ row, quantity }); reserved += quantity; remaining -= quantity; }
      }
      const purchases = (booking.localPurchase || []).filter(row => row.quotationKey === part.key && purchaseReceived(row));
      purchased = Math.min(remaining, purchases.reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0));
      remaining -= purchased;
      allocations.push({ part, tool, issued, reserved, purchased, kitAllocations, reservationAllocations });
      return { name: part.name, quantity: part.quantity, unit: tool?.unit || part.unit, missing: Math.max(0, remaining), source: issued + reserved && purchased ? 'Issued stock and nearby purchase' : purchased ? 'Nearby purchase / customer supplied' : 'Issued or reserved repair part' };
    });
    const consumables = items.filter(item => item.category === 'consumable' && available(item) > 0).map(item => ({ itemName: item.name, unit: item.unit || 'pcs', available: available(item) }));
    return { kit, reservations, allocations, parts: partRows, consumables,
      equipmentCount: items.filter(item => item.category === 'equipment').length };
  }
  async function record(input) {
    if (!input.session) throw Error('Repair completion inventory requires a transaction.');
    const data = await plan(input), missing = data.parts.filter(part => part.missing > 0);
    if (missing.length) throw fail(`Confirm the issued parts or nearby purchase before completion: ${missing.map(part => part.name).join(', ')}.`);
    const usages = [];
    for (const allocation of data.allocations) {
      for (const { item, quantity } of allocation.kitAllocations) item.quantityUsed = Number(item.quantityUsed || 0) + quantity;
      // A checked-out reservation mirrors kit stock. It never adds another
      // stock deduction or another usage row on completion.
      let toFulfill = allocation.issued + allocation.reserved;
      for (const row of data.reservations.filter(row => ref(row.toolId) === ref(allocation.part.toolId))) {
        if (!toFulfill) break;
        if (row.status === 'reserved' && row.stockTreatment === 'soft_hold') continue;
        const quantity = Math.min(toFulfill, remainingReservation(row));
        if (!quantity) continue;
        row.quantityFulfilled = Number(row.quantityFulfilled || 0) + quantity;
        if (!remainingReservation(row)) { row.status = 'fulfilled'; row.fulfilledAt = new Date(); }
        await row.save({ session: input.session }); toFulfill -= quantity;
      }
      for (const [quantity, inventory] of [[allocation.issued + allocation.reserved, true], [allocation.purchased, false]]) if (quantity > 0) usages.push({
        assignmentId: input.assignment._id, bookingId: input.booking._id, technicianId: input.technicianId,
        toolItemId: inventory ? allocation.part.toolId : undefined, inventoryItemId: inventory ? allocation.part.toolId : undefined,
        itemName: allocation.part.name, itemType: 'part', unit: allocation.tool?.unit || allocation.part.unit, quantityUsed: quantity,
        unitPrice: inventory ? Number(allocation.tool?.costPrice || 0) : 0, deductedFromInventory: inventory, recordedBy: input.userId,
        notes: inventory ? 'Approved repair part installed; stock was deducted at issue or reservation.' : 'Approved purchased part installed; purchase cost is recorded in the linked expense.',
      });
    }
    if (data.allocations.some(row => row.kitAllocations.length)) await data.kit.save({ session: input.session });
    if (usages.length) await m.ServiceToolUsage.insertMany(usages, { session: input.session });
    return data.parts.map(({ name, quantity, unit }) => ({ name, quantity, unit }));
  }
  return { plan, record };
}
module.exports = { createService, approvedParts, belongs };
