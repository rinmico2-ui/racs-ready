'use strict';
const crypto = require('crypto');
const { usageDay } = require('./technicianToolsService');
const { assignmentWorkDecision } = require('./technicianWorkSync');
const { manilaDateKey, manilaDateTime } = require('./bookingDateTime');
const ref = value => String(value?._id || value || '');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const snapshot = row => Object.fromEntries(['_id', 'recordKind', 'equipmentName', 'equipmentCode', 'source', 'companyMode', 'owner', 'quantity', 'date', 'workType', 'workReference', 'bookingId', 'orderId', 'notes', 'createdAt'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));

function stockFilter(Tool, quantity = 1) {
  return { active: { $ne: false }, archivedAt: null, assignable: { $ne: false }, status: { $ne: 'discontinued' },
    type: { $in: ['equipment', 'tool'] }, assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
    $and: [Tool.operationalAssetFilter()], quantity: { $gte: quantity },
    $expr: { $gte: [{ $subtract: ['$quantity', { $ifNull: ['$reservedQuantity', 0] }] }, quantity] } };
}

function normalize(input) {
  const validId = value => require('mongoose').isValidObjectId(value);
  const text = (value, name, min, max) => {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw fail(`${name} must be ${min} to ${max} characters.`, 400);
    return value.trim();
  };
  usageDay(input.date);
  if (!['booking', 'order'].includes(input.workType) || !validId(input.workId)) throw fail('Choose the booking or order where this equipment was used.', 400);
  if (!['company', 'personal', 'borrowed'].includes(input.source)) throw fail('Choose who owns the equipment.', 400);
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw fail('Enter a whole-number quantity from 1 to 10,000.', 400);
  const value = { date: input.date, workType: input.workType, workId: ref(input.workId), source: input.source, quantity,
    notes: text(input.notes, 'The reason for using extra equipment', 3, 500),
    clientSubmissionId: text(input.clientSubmissionId, 'The submission reference', 16, 80) };
  if (!/^[a-z\d-]+$/i.test(value.clientSubmissionId)) throw fail('Refresh the form to create a valid submission reference.', 400);
  if (input.source === 'company') {
    value.companyMode = input.companyMode || 'held';
    if (!['held', 'stock'].includes(value.companyMode)) throw fail('Choose equipment already with you or available company stock.', 400);
    if (value.companyMode === 'stock') {
      if (!validId(input.inventoryItemId)) throw fail('Choose equipment from company stock.', 400);
      if (input.receiptConfirmed !== true) throw fail('Confirm that you physically received the equipment before checking it out.', 400);
      value.inventoryItemId = ref(input.inventoryItemId);
      value.receiptConfirmed = true;
    } else {
      if (!validId(input.equipmentAssignmentId)) throw fail('Choose company equipment issued to you.', 400);
      value.equipmentAssignmentId = ref(input.equipmentAssignmentId);
    }
  } else {
    value.equipmentName = text(input.equipmentName, 'The equipment name', 2, 160);
    value.owner = input.source === 'borrowed' ? text(input.owner, 'The equipment owner', 2, 160) : 'Technician personal equipment';
  }
  return value;
}

function createService(overrides = {}) {
  const m = { mongoose: require('mongoose'), ...Object.fromEntries(['EquipmentUsageLog', 'EquipmentAssignment', 'Assignment', 'BookingService', 'Order', 'Tool'].map(name => [name, require('../models/' + name)])),
    lock: (...args) => require('./operationLock').withOperationLock(...args), audit: (...args) => require('./audit').logEvent(...args), clock: () => new Date(), ...overrides };
  const scoped = (query, session) => session ? query.session(session) : query;
  async function options({ technicianIds, date }, session) {
    const { start, end } = usageDay(date);
    const reads = [
      () => scoped(m.Assignment.find({ technicianId: { $in: technicianIds }, bookingDate: { $gte: start, $lt: end }, status: { $in: ['on_site', 'in_progress', 'completed', 'cancelled'] } })
        .select('_id bookingId technicianId serviceItemId serviceType status bookingDate startTime arrivedAt startedAt serviceName'), session).lean(),
      () => scoped(m.Order.find({ technicianId: { $ne: null }, $or: [{ technicianId: { $in: technicianIds } }, { 'technicianTeam.technicianId': { $in: technicianIds }, 'technicianTeam.status': 'accepted' }],
        'delivery.preferredDate': { $gte: start, $lt: end }, isProject: { $ne: true }, archivedAt: null, status: { $in: ['arrived', 'installing', 'completed'] } })
        .select('_id orderReference technicianId technicianTeam status fulfillmentType continuation'), session).lean(),
      () => scoped(m.EquipmentAssignment.find({ technicianId: { $in: technicianIds }, consumable: { $ne: true }, status: { $in: ['checked_out', 'in_use', 'returned', 'damaged', 'lost'] },
        $and: [{ $or: [{ checkedOutAt: { $lt: end } }, { checkedOutAt: null, issuedAt: { $lt: end } }, { checkedOutAt: null, issuedAt: null, workDate: { $lt: end } }] },
          { $or: [{ returnedAt: null }, { returnedAt: { $gte: start } }] }] })
        .select('_id equipmentId equipmentName equipmentCode quantity status returnPending resolutionState technicianId'), session).lean(),
      () => scoped(m.Tool.find(stockFilter(m.Tool)).select('_id itemName assetCode barcode quantity reservedQuantity unit').sort({ itemName: 1 }).limit(500), session).lean(),
    ];
    // A MongoDB transaction uses one session and cannot run parallel reads.
    const [assignments, orders, equipment, stock] = session
      ? [await reads[0](), await reads[1](), await reads[2](), await reads[3]()] : await Promise.all(reads.map(read => read()));
    const bookings = assignments.length ? await scoped(m.BookingService.find({ _id: { $in: assignments.map(row => row.bookingId) } })
      .select(require('./technicianWorkSync').BOOKING_WORK_SELECT + ' bookingReference workOrderNumber serviceName continuation customerCancellation'), session).lean() : [];
    const allowedDate = date === manilaDateKey(m.clock());
    const jobs = assignments.flatMap(row => {
      const booking = bookings.find(booking => ref(booking._id) === ref(row.bookingId));
      if (!booking || row.status === 'cancelled' && !row.arrivedAt && !row.startedAt || !assignmentWorkDecision(row, booking).current) return [];
      return [{ id: ref(row._id), type: 'booking', bookingId: booking._id,
        reference: booking.bookingReference || booking.workOrderNumber || `Booking #${ref(booking._id).slice(-6).toUpperCase()}`,
        name: row.serviceName || booking.serviceName || 'Service booking',
        canCheckout: allowedDate && ['on_site', 'in_progress'].includes(row.status) && booking.continuation?.status !== 'pending' }];
    });
    for (const order of orders) {
      const member = (order.technicianTeam || []).find(row => technicianIds.includes(ref(row.technicianId)));
      if (!technicianIds.includes(ref(order.technicianId)) && member?.status !== 'accepted') continue;
      if (order.fulfillmentType === 'customer_pickup') continue;
      jobs.push({ id: ref(order._id), type: 'order', orderId: order._id,
        reference: order.orderReference || `Order #${ref(order._id).slice(-6).toUpperCase()}`, name: 'Delivery / installation',
        canCheckout: allowedDate && ['arrived', 'installing'].includes(order.status) && order.continuation?.status !== 'pending' });
    }
    return { jobs, equipment: equipment.map(row => ({ id: ref(row._id), equipmentId: ref(row.equipmentId), name: row.equipmentName,
      code: row.equipmentCode || '', quantity: row.quantity, status: row.status, returnPending: row.returnPending,
      resolutionState: row.resolutionState })), date,
      stockEquipment: stock.map(tool => ({ id: ref(tool._id), name: tool.itemName, code: tool.assetCode || tool.barcode || '',
        quantity: Math.max(0, Math.floor(Number(tool.quantity) - Number(tool.reservedQuantity || 0))), unit: tool.unit || 'pcs' })),
      stockCheckout: { allowedDate, message: allowedDate ? 'Company stock can be checked out for work that is still in progress.'
        : 'New stock checkouts are for today’s active work. For a past date, use equipment already issued on that date or ask operations to reconcile a missed issuance.' } };
  }

  async function checkoutStock({ value, job, technicianId, technicianIds, userId, session }) {
    if (!job.canCheckout || value.date !== manilaDateKey(m.clock())) throw fail('New equipment can only be checked out for today’s active work. Completed or past visits must use existing issuance records.');
    const { start, end } = usageDay(value.date);
    // Touch the owning job in the same transaction so completion, cancellation,
    // rescheduling or reassignment cannot race a new stock checkout.
    if (job.type === 'booking') {
      const booking = await m.BookingService.findById(job.bookingId).session(session).lean();
      require('./customerCancellationPolicy').assertNoHold(booking);
      require('./workContinuation').assertVisitActive(booking);
      const assignment = await m.Assignment.updateOne({ _id: job.id, technicianId: { $in: technicianIds }, status: { $in: ['on_site', 'in_progress'] }, bookingDate: { $gte: start, $lt: end } }, { $inc: { __v: 1 } }, { session });
      const parent = await m.BookingService.updateOne({ _id: job.bookingId, archivedAt: null }, { $inc: { __v: 1 } }, { session });
      if (!assignment.matchedCount || !parent.matchedCount) throw fail('The booking changed. Refresh the work details before checkout.');
    } else {
      const parent = await m.Order.updateOne({ _id: job.orderId, archivedAt: null, isProject: { $ne: true },
        status: { $in: ['arrived', 'installing'] }, 'delivery.preferredDate': { $gte: start, $lt: end }, 'continuation.status': { $ne: 'pending' },
        $or: [{ technicianId: { $in: technicianIds } }, { technicianId: { $ne: null }, technicianTeam: { $elemMatch: { technicianId: { $in: technicianIds }, status: 'accepted' } } }] },
      { $inc: { __v: 1 } }, { session });
      if (!parent.matchedCount) throw fail('The order changed. Refresh the work details before checkout.');
    }
    const tool = await m.Tool.findById(value.inventoryItemId).session(session).lean();
    if (!tool || !['tool', 'equipment'].includes(tool.type) || m.Tool.effectiveInventoryClass(tool) !== 'operational_asset') throw fail('Choose reusable equipment from company stock.', 400);
    const checkedOut = await m.Tool.findOneAndUpdate({ _id: tool._id, ...stockFilter(m.Tool, value.quantity) }, {
      $inc: { quantity: -value.quantity, checkedOutQuantity: value.quantity },
      $set: { assetStatus: 'checked_out', updatedAt: m.clock(), status: require('../models/Tool').effectiveStockStatus({ ...tool, quantity: Number(tool.quantity) - value.quantity }) },
    }, { session, returnDocument: 'after' });
    if (!checkedOut) throw fail('The requested quantity is no longer available. Refresh company stock and choose an available item.');
    const [custody] = await m.EquipmentAssignment.create([{
      technicianId, bookingId: job.bookingId || undefined, bookingIds: job.bookingId ? [job.bookingId] : [], orderIds: job.orderId ? [job.orderId] : [],
      workDate: start, equipmentId: tool._id, equipmentName: tool.itemName, equipmentCode: tool.assetCode || tool.barcode || '',
      quantity: value.quantity, consumable: false, status: 'checked_out', checkedOutAt: m.clock(), checkedOutBy: userId,
      issuedAt: m.clock(), issuedBy: String(userId), expectedReturnAt: manilaDateTime(value.date, 1440, -1),
      notes: `Extra equipment checked out for ${job.reference}. ${value.notes}`,
    }], { session });
    return { id: ref(custody._id), equipmentId: ref(tool._id), name: tool.itemName, code: tool.assetCode || tool.barcode || '' };
  }

  async function record({ technicianId, technicianIds, userId, input }) {
    const value = normalize(input);
    const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return m.lock(`extra-equipment:${technicianId}:${value.clientSubmissionId}`, async () => {
      if (require('./bookingSubmissionWrite').isKnownStandalone(m.mongoose.connection)) throw fail('Equipment records require the configured database replica set.', 503);
      const session = await m.mongoose.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          const existing = await m.EquipmentUsageLog.findOne({ technicianId, recordKind: 'extra', clientSubmissionId: value.clientSubmissionId }).session(session).lean();
          if (existing) {
            if (existing.submissionDigest !== digest) throw fail('This submission was already saved with different details. Reopen the form to create another record.');
            result = { item: snapshot(existing), duplicate: true }; return;
          }
          const available = await options({ technicianIds, date: value.date }, session);
          const job = available.jobs.find(row => row.type === value.workType && row.id === value.workId);
          if (!job) throw fail('This work is no longer available to you on the selected date. Choose a started or completed booking or order.', 403);
          let custody, equipmentName = value.equipmentName, equipmentCode = '', owner = value.owner;
          if (value.source === 'company') {
            if (value.companyMode === 'stock') {
              custody = await checkoutStock({ value, job, technicianId, technicianIds, userId, session });
            } else {
              custody = available.equipment.find(row => row.id === value.equipmentAssignmentId);
              if (!custody) throw fail('Only company equipment issued to you on this date can be recorded. Ask operations to record the issuance or handover first.', 403);
              if (value.quantity > Number(custody.quantity)) throw fail('The quantity exceeds the equipment issued to you.', 400);
              const tool = await m.Tool.findById(custody.equipmentId).session(session).lean();
              if (!tool || !['tool', 'equipment'].includes(tool.type) || m.Tool.effectiveInventoryClass(tool) !== 'operational_asset') throw fail('Choose reusable company equipment. Parts and consumables use the materials workflow.', 400);
              if (['checked_out', 'in_use'].includes(custody.status)) {
                const linked = await m.EquipmentAssignment.updateOne({ _id: custody.id, technicianId: { $in: technicianIds },
                  status: { $in: ['checked_out', 'in_use'] }, returnPending: { $ne: true }, resolutionState: { $nin: ['processing', 'resolved'] } },
                { $addToSet: job.type === 'booking' ? { bookingIds: job.bookingId } : { orderIds: job.orderId }, $inc: { __v: 1 }, $set: { updatedAt: new Date() } }, { session });
                if (!linked.matchedCount) throw fail('The equipment return is already being reviewed. Ask operations to check the custody record.');
              }
            }
            equipmentName = custody.name; equipmentCode = custody.code; owner = 'Company equipment';
          }
          const [saved] = await m.EquipmentUsageLog.create([{
            technicianId, createdBy: userId, recordKind: 'extra', source: value.source, companyMode: value.companyMode, owner,
            equipmentId: custody?.equipmentId, equipmentAssignmentId: custody?.id, equipmentName, equipmentCode,
            quantity: value.quantity, date: usageDay(value.date).start, notes: value.notes,
            workType: job.type, workReference: job.reference, bookingId: job.bookingId, orderId: job.orderId,
            assignmentId: job.type === 'booking' ? job.id : undefined, clientSubmissionId: value.clientSubmissionId, submissionDigest: digest,
          }], { session });
          result = { item: snapshot(saved), duplicate: false };
        });
      } finally { await session.endSession(); }
      if (!result.duplicate) await m.audit({ actor: userId, action: 'equipment.extra_usage_recorded', entityType: 'EquipmentUsageLog', entityId: result.item._id,
        details: { source: value.source, workType: value.workType, workId: value.workId, quantity: value.quantity } });
      return result;
    }, { leaseMs: 120000 });
  }
  return { options, record };
}

module.exports = { createService, normalize, snapshot };
