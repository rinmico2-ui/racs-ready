'use strict';
const { outstanding, available } = require('./kitMaterialBalance');
const id = value => String(value?._id || value || '');
const unique = values => [...new Set(values.filter(Boolean).map(id))];
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function quantities(input) {
  const result = Object.fromEntries(['unused', 'used', 'damaged', 'missing'].map(key => [key, Number(input[key] ?? 0)]));
  if (Object.values(result).some(value => !Number.isFinite(value) || value < 0)) throw fail('Enter valid quantities of zero or more.', 400);
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  if (result.total <= 0) throw fail('Enter the quantity you are returning or reporting.', 400);
  return result;
}
function text(value) {
  if (value != null && typeof value !== 'string') throw fail('Enter valid notes.', 400);
  if ((value || '').trim().length > 500) throw fail('Keep notes within 500 characters.', 400);
  return (value || '').trim();
}
function createService(overrides = {}) {
  const m = { mongoose: require('mongoose'), ...Object.fromEntries(['KitReturn', 'DailyKit', 'EquipmentAssignment', 'Tool', 'StockAdjustment'].map(name => [name, require('../models/' + name)])), ...overrides };
  const equipment = () => m.equipmentService || require('./technicianToolsService').createService();
  const validId = value => { if (!m.mongoose.isValidObjectId(value)) throw fail('Invalid return record.', 400); };
  async function transaction(work, providedSession) {
    if (providedSession) return work(providedSession);
    const session = await m.mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } catch (error) {
      if (error.code === 11000) throw fail('A return report is already awaiting admin review.');
      if (/Transaction numbers are only allowed/i.test(error.message)) throw fail('Returns are temporarily unavailable. Ask admin to check the database setup.', 503);
      throw error;
    } finally { await session.endSession(); }
  }
  async function reportEquipment({ assignmentIds, technicianIds, userId, condition = 'good', damageDescription = '', equipmentUse = 'not_recorded' }) {
    if (!['good', 'fair', 'damaged', 'lost'].includes(condition)) throw fail('Choose an equipment condition.', 400);
    if (!['used', 'unused', 'not_recorded'].includes(equipmentUse)) throw fail('Choose whether the equipment was used.', 400);
    const notes = text(damageDescription);
    if (['damaged', 'lost'].includes(condition) && !notes) throw fail('Add a note about damaged or missing equipment.', 400);
    if (!Array.isArray(assignmentIds) || !assignmentIds.length || assignmentIds.length > 100) throw fail('Choose up to 100 equipment records.', 400);
    assignmentIds.forEach(validId);
    return transaction(async session => {
      const reports = [];
      for (const assignmentId of unique(assignmentIds)) {
        const row = await m.EquipmentAssignment.findById(assignmentId).session(session).lean();
        if (!row) throw fail('Equipment record not found.', 404);
        if (!technicianIds.map(id).includes(id(row.technicianId))) throw fail('This equipment was not issued to you.', 403);
        if (row.consumable || !['checked_out', 'in_use'].includes(row.status) || row.returnPending || ['processing', 'resolved'].includes(row.resolutionState)) throw fail('This equipment is already returned or awaiting review.');
        const kits = await m.DailyKit.find({ technicianId: { $in: technicianIds }, $or: [{ _id: row.dailyKitId || null }, { 'items.equipmentAssignmentId': row._id }, { 'items.custodyAssignmentIds': row._id }, { 'deltaItems.equipmentAssignmentId': row._id }] }).session(session).lean();
        const items = kits.flatMap(kit => [...(kit.items || []), ...(kit.deltaItems || [])].filter(item => id(item.toolId) === id(row.equipmentId)));
        if (['good', 'fair'].includes(condition)) await equipment().assertWorkFinished(row, items, session);
        const quantity = Number(row.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) throw fail('The issued quantity needs an admin check.');
        const claimed = await m.EquipmentAssignment.updateOne({ _id: row._id, returnPending: { $ne: true }, status: { $in: ['checked_out', 'in_use'] } }, { $set: { returnPending: true } }, { session });
        if (!claimed.modifiedCount) throw fail('This equipment is already awaiting review.');
        for (const kit of kits) {
          const sets = {};
          for (const key of ['items', 'deltaItems']) (kit[key] || []).forEach((item, index) => {
            if (id(item.equipmentAssignmentId) === id(row._id) || (item.custodyAssignmentIds || []).some(value => id(value) === id(row._id)) || id(kit._id) === id(row.dailyKitId) && id(item.toolId) === id(row.equipmentId)) {
              sets[`${key}.${index}.returnPendingQuantity`] = Number(item.returnPendingQuantity || 0) + quantity;
            }
          });
          if (Object.keys(sets).length) await m.DailyKit.updateOne({ _id: kit._id }, { $set: sets }, { session });
        }
        const [report] = await m.KitReturn.create([{
          technicianId: row.technicianId, dailyKitId: row.dailyKitId, equipmentAssignmentId: row._id,
          toolId: row.equipmentId, name: row.equipmentName, category: 'equipment', condition, notes, equipmentUse,
          unused: ['good', 'fair'].includes(condition) ? quantity : 0, damaged: condition === 'damaged' ? quantity : 0, missing: condition === 'lost' ? quantity : 0,
          bookingIds: unique([row.bookingId, ...items.flatMap(item => [...(item.bookingIds || []), ...(item.issuedBookingIds || [])])]),
          orderIds: unique([...(row.orderIds || []), ...items.flatMap(item => [...(item.orderIds || []), ...(item.issuedOrderIds || [])])]), reportedBy: userId,
        }], { session });
        reports.push(report);
      }
      return reports;
    });
  }
  async function reportMaterials({ kitId, itemId, technicianIds, userId, session: providedSession, ...input }) {
    validId(kitId); validId(itemId);
    const qty = quantities(input), notes = text(input.notes);
    if ((qty.damaged || qty.missing || qty.used) && !notes) throw fail('Explain any used, damaged, or missing items.', 400);
    return transaction(async session => {
      const kit = await m.DailyKit.findOne({ _id: kitId, technicianId: { $in: technicianIds } }).session(session);
      if (!kit) throw fail('Daily Kit not found.', 404);
      const item = [...(kit.items || []), ...(kit.deltaItems || [])].find(row => id(row._id) === id(itemId) && ['consumable', 'repair_part'].includes(row.category));
      if (!item || !item.toolId) throw fail('Issued material not found.', 404);
      if (Number(item.returnPendingQuantity || 0) > 0) throw fail('This item already has a report awaiting admin review.');
      if (qty.total > available(item) + 1e-9) throw fail(`Only ${available(item)} ${item.unit || 'pcs'} remain unaccounted for.`);
      // Usage already recorded on a job is displayed separately. Additional
      // usage can be reconciled here only after that work ends or is cancelled.
      if (qty.used) await equipment().assertWorkFinished({}, [item], session);
      item.returnPendingQuantity = qty.total;
      await kit.save({ session });
      const [report] = await m.KitReturn.create([{
        technicianId: kit.technicianId, dailyKitId: kit._id, itemId: item._id, toolId: item.toolId,
        name: item.name, unit: item.unit, category: item.category, ...Object.fromEntries(['unused', 'used', 'damaged', 'missing'].map(key => [key, qty[key]])), notes,
        bookingIds: unique([...(item.bookingIds || []), ...(item.issuedBookingIds || [])]), orderIds: unique([...(item.orderIds || []), ...(item.issuedOrderIds || [])]), reportedBy: userId,
      }], { session });
      return report;
    }, providedSession);
  }
  async function reportMaterialsBatch({ items, technicianIds, userId, notes }) {
    if (!Array.isArray(items) || !items.length || items.length > 100) throw fail('Choose between 1 and 100 materials to return.', 400);
    const sharedNotes = text(notes), seen = new Set();
    const inputs = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('Choose valid material records.', 400);
      validId(item.kitId); validId(item.itemId);
      const key = `${id(item.kitId)}:${id(item.itemId)}`;
      if (seen.has(key)) throw fail('Each material can only appear once in a return.', 400);
      seen.add(key);
      const qty = quantities(item);
      return { kitId: item.kitId, itemId: item.itemId, ...Object.fromEntries(['unused', 'used', 'damaged', 'missing'].map(key => [key, qty[key]])), notes: text(item.notes ?? sharedNotes) };
    });
    // All reports reserve their quantities together. A changed balance or
    // an invalid item rolls back the entire submission, including earlier rows.
    return transaction(async session => {
      const reports = [];
      for (const input of inputs) reports.push(await reportMaterials({ ...input, technicianIds, userId, session }));
      return reports;
    });
  }
  async function reconcile({ reportId, userId, decision, notes, quantities: corrected, condition, session: providedSession }) {
    validId(reportId);
    if (!['receive', 'reject'].includes(decision)) throw fail('Choose receive or reject.', 400);
    const receiptNotes = text(notes);
    if (decision === 'reject' && !receiptNotes) throw fail('Explain why this report needs correction.', 400);
    return transaction(async session => {
      const report = await m.KitReturn.findById(reportId).session(session);
      if (!report) throw fail('Return report not found.', 404);
      if (report.status !== 'pending') throw fail('This return report was already reviewed.');
      report.reportedQuantities = Object.fromEntries(['unused', 'used', 'damaged', 'missing'].map(key => [key, Number(report[key] || 0)]));
      report.reportedCondition = report.condition;
      if (report.category === 'equipment') {
        if (condition) {
          if (!['good', 'fair', 'damaged', 'lost'].includes(condition)) throw fail('Choose a valid return condition.', 400);
          const total = Number(report.unused) + Number(report.damaged) + Number(report.missing);
          report.condition = condition;
          report.unused = ['good', 'fair'].includes(condition) ? total : 0;
          report.damaged = condition === 'damaged' ? total : 0; report.missing = condition === 'lost' ? total : 0;
        }
        if (decision === 'receive') await equipment().receiveEquipment({ assignmentIds: [report.equipmentAssignmentId], technicianIds: [report.technicianId], userId, condition: report.condition, damageDescription: receiptNotes || report.notes, session });
        else {
          await m.EquipmentAssignment.updateOne({ _id: report.equipmentAssignmentId, returnPending: true }, { $set: { returnPending: false } }, { session });
          const kits = await m.DailyKit.find({ $or: [{ _id: report.dailyKitId || null }, { 'items.equipmentAssignmentId': report.equipmentAssignmentId }, { 'items.custodyAssignmentIds': report.equipmentAssignmentId }, { 'deltaItems.equipmentAssignmentId': report.equipmentAssignmentId }] }).session(session);
          const total = Number(report.unused) + Number(report.damaged) + Number(report.missing);
          for (const kit of kits) {
            for (const item of [...(kit.items || []), ...(kit.deltaItems || [])]) {
              if (id(item.equipmentAssignmentId) === id(report.equipmentAssignmentId) || (item.custodyAssignmentIds || []).some(value => id(value) === id(report.equipmentAssignmentId)) || id(kit._id) === id(report.dailyKitId) && id(item.toolId) === id(report.toolId)) item.returnPendingQuantity = Math.max(0, Number(item.returnPendingQuantity || 0) - total);
            }
            await kit.save({ session });
          }
        }
      } else {
        const kit = await m.DailyKit.findById(report.dailyKitId).session(session);
        const item = kit && [...(kit.items || []), ...(kit.deltaItems || [])].find(row => id(row._id) === id(report.itemId));
        if (!item) throw fail('The original issued kit item is missing. Ask admin to check the record.');
        const reserved = Number(item.returnPendingQuantity || 0);
        if (decision === 'receive') {
          const qty = quantities(corrected || report);
          if (qty.used) await equipment().assertWorkFinished({}, [item], session);
          if (Math.abs(qty.total - reserved) > 1e-9 || qty.total > outstanding(item) + 1e-9) throw fail('Received quantities must account for the full reported total. Reject the report if it needs a different total.');
          if ((qty.damaged || qty.missing || qty.used) && !receiptNotes && !report.notes) throw fail('Add notes explaining the quantities received.', 400);
          if (qty.unused > 0) {
            const tool = await m.Tool.findOneAndUpdate({ _id: report.toolId }, { $inc: { quantity: qty.unused } }, { session, returnDocument: 'after' }).lean();
            if (!tool) throw fail('The linked inventory item is missing.');
            await m.Tool.updateOne({ _id: tool._id, status: { $ne: 'discontinued' } }, { $set: { status: Number(tool.quantity) <= Number(tool.minStockLevel ?? 3) ? 'low_stock' : 'in_stock' } }, { session });
            await m.StockAdjustment.create([{ toolId: report.toolId, type: 'return', reason: 'return', quantityBefore: Number(tool.quantity) - qty.unused, quantityAfter: tool.quantity, delta: qty.unused, adjustedBy: userId, notes: `Received unused Daily Kit materials: ${id(report._id)}` }], { session });
          }
          item.quantityReturned = Number(item.quantityReturned || 0) + qty.unused;
          item.quantityUsed = Number(item.quantityUsed || 0) + qty.used;
          item.quantityDamaged = Number(item.quantityDamaged || 0) + qty.damaged;
          item.quantityMissing = Number(item.quantityMissing || 0) + qty.missing;
          for (const key of ['unused', 'used', 'damaged', 'missing']) report[key] = qty[key];
          // Project material ledgers are mirrored; they are not another stock
          // deduction or another credit on return.
          const ledgers = await m.EquipmentAssignment.find({ dailyKitId: kit._id, equipmentId: item.toolId, consumable: true, status: { $in: ['in_use', 'checked_out'] } }).session(session).sort({ createdAt: 1 });
          const left = { ...qty };
          for (const ledger of ledgers) {
            let capacity = Math.max(0, Number(ledger.quantity || 0) - Number(ledger.consumableUsed || 0) - Number(ledger.consumableReturned || 0) - Number(ledger.consumableDamaged || 0) - Number(ledger.consumableMissing || 0));
            for (const [key, field] of [['unused', 'consumableReturned'], ['used', 'consumableUsed'], ['damaged', 'consumableDamaged'], ['missing', 'consumableMissing']]) {
              const apply = Math.min(capacity, left[key]); ledger[field] = Number(ledger[field] || 0) + apply; left[key] -= apply; capacity -= apply;
            }
            if (!capacity) ledger.status = 'returned';
            await ledger.save({ session });
          }
          if (outstanding(item) <= 1e-9) item.checkoutStatus = 'returned';
        }
        item.returnPendingQuantity = 0;
        await kit.save({ session });
      }
      report.status = decision === 'receive' ? 'received' : 'rejected';
      report.receivedBy = userId; report.receivedAt = new Date(); report.receiptNotes = receiptNotes;
      await report.save({ session });
      return report;
    }, providedSession);
  }
  async function receiveEquipmentRecord({ assignmentId, userId, condition, notes }) {
    validId(assignmentId);
    return transaction(async session => {
      const pending = await m.KitReturn.findOne({ equipmentAssignmentId: assignmentId, status: 'pending' }).session(session);
      if (pending) return reconcile({ reportId: pending._id, userId, condition, notes, decision: 'receive', session });
      const row = await m.EquipmentAssignment.findById(assignmentId).session(session).lean();
      if (!row) throw fail('Equipment record not found.', 404);
      const [received] = await equipment().receiveEquipment({ assignmentIds: [assignmentId], technicianIds: [row.technicianId], userId, condition, damageDescription: notes, session });
      return received;
    });
  }
  async function reconcileBatch({ items, userId, decision, notes, confirmedReceived }) {
    if (!Array.isArray(items) || !items.length || items.length > 100) throw fail('Choose between 1 and 100 return reports.', 400);
    if (!['receive', 'reject'].includes(decision)) throw fail('Choose receive or reject.', 400);
    if (decision === 'receive' && confirmedReceived !== true) throw fail('Confirm that you checked all selected returned items first.', 400);
    const sharedNotes = text(notes), seen = new Set();
    const inputs = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('Choose valid return reports.', 400);
      validId(item.reportId);
      if (seen.has(id(item.reportId))) throw fail('Each report can only be reviewed once in a batch.', 400);
      seen.add(id(item.reportId));
      return { reportId: item.reportId, quantities: item.quantities, condition: item.condition, notes: text(item.notes ?? sharedNotes) };
    });
    return transaction(async session => {
      const reports = [];
      for (const input of inputs) reports.push(await reconcile({ ...input, userId, decision, session }));
      return reports;
    });
  }
  return { reportEquipment, reportMaterials, reportMaterialsBatch, reconcile, reconcileBatch, receiveEquipmentRecord };
}
module.exports = { createService, quantities };
