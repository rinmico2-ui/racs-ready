'use strict';
const team = require('./standardJobTeam');
const units = require('./repairUnitWorkflow');
const visitPayment = require('../public/js/repair-visit-payment');
const { manilaDateKey, manilaDateTime, parseAppointmentTime } = require('./bookingDateTime');
const fail = (message, status = 409, code = 'REPAIR_VISIT_BLOCKED') => Object.assign(new Error(message), { status, code });
const keyFor = part => part.toolId ? `id:${team.ref(part.toolId)}` : `name:${String(part.name || '').trim().toLowerCase()}`;
const purchaseReceived = purchase => purchase.purchaseByType === 'customer' ? purchase.purchaseStatus === 'verified'
  : purchase.purchaseStatus === 'receipt_uploaded' && Boolean(purchase.receiptUrl) && Number(purchase.actualPurchaseCost) > 0;
const formatTime = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function duration(value, fallback = 90) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 15 || number > 480) throw fail('Enter 15 to 480 minutes for the repair or purchase trip.', 400);
  return number;
}
function approvedParts(booking) {
  const parts = booking.repairUnitTracking ? units.rows(booking).filter(row => row.unit.repairReview?.state === 'approved').flatMap(row => row.unit.quotation?.parts || []) : booking.quotation?.parts || [];
  const grouped = new Map();
  for (const part of parts) {
    const key = keyFor(part), quantity = Number(part.quantity || 1);
    if (!part.name || !Number.isInteger(quantity) || quantity < 1) throw fail('The approved parts list needs a staff review.');
    const row = grouped.get(key) || { key, name: part.name, toolId: part.toolId, quantity: 0, quotedTotal: 0 };
    row.quantity += quantity; row.quotedTotal += Number(part.cost || 0) * quantity; grouped.set(key, row);
  }
  return [...grouped.values()];
}
function approvalReady(booking) {
  if (!booking.inspection?.completedAt || booking.approval?.status !== 'approved') return false;
  if (!booking.repairUnitTracking) return Boolean(booking.quotation);
  const rows = units.rows(booking);
  return booking.quotationReview?.status === 'approved' && rows.length > 0
    && rows.every(row => ['approved', 'declined', 'completed'].includes(row.unit.repairReview?.state))
    && rows.some(row => row.unit.repairReview?.state === 'approved');
}
function partCoverage(booking, kit) {
  const carried = new Map();
  if (kit && ['confirmed', 'in_progress'].includes(kit.status) && !kit.hasDelta) for (const item of kit.items || []) {
    if (!(item.bookingIds || []).concat(item.issuedBookingIds || []).some(id => team.ref(id) === team.ref(booking._id))) continue;
    if (!['repair_part', 'consumable'].includes(item.category) || !['issued', 'checked_out', 'in_custody'].includes(item.checkoutStatus)) continue;
    const quantity = require('./kitMaterialBalance').available(item);
    const key = keyFor({ name: item.name, toolId: item.toolId }); carried.set(key, (carried.get(key) || 0) + quantity);
  }
  return approvedParts(booking).map(part => {
    const purchases = (booking.localPurchase || []).filter(row => row.quotationKey === part.key);
    const bought = purchases.filter(purchaseReceived).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const available = (carried.get(part.key) || 0) + bought;
    return { ...part, available, missing: Math.max(0, part.quantity - available), purchasePending: purchases.some(row => !purchaseReceived(row)) };
  });
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Assignment: require('../models/Assignment'),
    Kit: require('../models/DailyKit'), Expense: require('../models/Expense'),
    slots: (...args) => require('../routes/scheduleRoutes').getTimeSlotsForQuery(...args),
    lock: require('./operationLock').withOperationLock, receipt: require('./financialReceiptStorage').findFinancialReceipt,
    now: () => new Date(), ...overrides };
  async function load(id, technicianId, session) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid repair booking.', 400);
    const booking = await deps.Booking.findById(id).session(session || null).lean();
    if (!booking) throw fail('Repair booking not found.', 404);
    if (!team.isPrimary(booking, technicianId)) throw fail('The primary technician manages repair work. Supporting technicians can view the shared kit and add work notes.', 403);
    if (booking.isProject || booking.sourceOrderId || !units.hasRepair(booking)) throw fail('Use the appropriate service or project workspace for this job.');
    if (booking.archivedAt || team.closed.has(booking.status)) throw fail('This repair booking is closed.');
    const assignment = await deps.Assignment.findOne({ bookingId: booking._id, technicianId,
      ...(booking.assignmentId ? { _id: booking.assignmentId } : {}), status: { $nin: ['cancelled', 'declined', 'expired'] } }).session(session || null).sort({ assignedAt: -1 }).lean();
    if (!assignment) throw fail('Current repair assignment not found. Refresh your jobs.', 404);
    return { booking, assignment };
  }
  async function inspect(state, technicianId, input = {}, { checkTime = true } = {}) {
    const { booking, assignment } = state, now = deps.now(), date = manilaDateKey(now);
    const requiresOnSiteConsent = !approvalReady(booking) && units.canDecideOnSite(booking);
    const confirmedQuotationTotal = units.summary(booking, ['staff_review', 'customer_review', 'approved', 'completed']).totalAmount;
    let pricedBooking = booking;
    if (requiresOnSiteConsent) {
      // Preview the submitted price and parts without writing a customer decision.
      pricedBooking = { ...booking, services: (booking.services || []).map(item => ({ ...item, units: (item.units || []).map(unit => ({ ...unit, repairReview: { ...unit.repairReview } })) })) };
      units.recordOnSiteDecision(pricedBooking, { customerAgreed: true, confirmedQuotationTotal }, { technicianId, now });
    }
    const repairMinutes = duration(input.repairMinutes, Math.ceil(Math.max(15, Math.min(480, Number(booking.repairExecution?.repairMinutes || booking.technicianAssistant?.estimatedDurationMinutes) || 90)) / 15) * 15);
    const purchaseMinutes = input.purchaseMinutes == null ? 45 : duration(input.purchaseMinutes);
    const visitReasons = [];
    if (!team.readiness(booking, now).ready) visitReasons.push('Every assigned technician must accept this visit.');
    if (assignment.status !== 'in_progress') visitReasons.push('Go En Route, record arrival, then Start Work before planning repairs.');
    if (!approvalReady(booking) && !requiresOnSiteConsent) visitReasons.push('Submit the inspection and quotation first. Record the customer decision on site, or wait for the online quotation decision.');
    if (booking.repairExecution?.status === 'deferred') visitReasons.push('This visit has ended. Operations must confirm the next repair schedule.');
    if (booking.repairExecution?.status === 'cancelled') visitReasons.push('The customer cancelled this repair. Inspection payment and equipment returns remain separate.');
    const reasons = [...visitReasons], visitDate = manilaDateKey(assignment.bookingDate);
    if (visitDate !== date) reasons.push('Repair work can continue only on this visit\'s scheduled Philippine date. You can request a return visit.');
    const kit = await deps.Kit.findOne({ technicianId, workDate: { $gte: manilaDateTime(date, 0), $lt: manilaDateTime(date, 1440) } }).session(state.session || null).lean();
    const parts = approvalReady(pricedBooking) ? partCoverage(pricedBooking, kit) : [];
    const readiness = require('./dailyKitService').dailyKitReadiness(kit);
    const tools = (kit?.items || []).filter(item => item.category === 'equipment' && (item.source === 'standard' || (item.bookingIds || []).concat(item.issuedBookingIds || []).some(id => team.ref(id) === team.ref(booking._id))))
      .map(item => ({ name: item.name, ready: ['issued', 'checked_out', 'in_custody', 'standard_kit'].includes(item.checkoutStatus) }));
    const toolsReady = readiness.ready && tools.every(tool => tool.ready);
    const minute = Math.ceil((now.getTime() - manilaDateTime(date, 0).getTime()) / 60000);
    const ids = team.ids(booking).length ? team.ids(booking) : [team.ref(technicianId)];
    async function windowFor(extraMinutes) {
      if (!checkTime) return { available: false, reason: 'Check the team schedule when choosing Repair now.' };
      if (reasons.length) return { available: false, reason: reasons[0] };
      let end = minute + repairMinutes + extraMinutes;
      for (const id of ids) {
        const result = await deps.slots({ date, technicianId: id, duration: String(repairMinutes + extraMinutes), quantity: '1', travelTime: '30' },
          { excludeBookingId: booking._id, existingAppointment: true, ongoingStartMinutes: minute });
        if (result.statusCode >= 400) throw fail('The team schedule could not be checked. Try again before proceeding.', 503);
        const slot = result.payload?.timeSlots?.find(row => row.available === true && parseAppointmentTime(row.startTime) === minute);
        if (!slot) return { available: false, reason: result.payload?.message || 'The repair and travel buffer do not fit everyone\'s remaining shift or conflict with another booking, order or project.' };
        end = Math.max(end, minute + Number(result.payload.capacityPerSlot || repairMinutes + extraMinutes + 30));
      }
      return { available: true, endTime: formatTime(end) };
    }
    const direct = await windowFor(0), local = parts.some(part => part.missing > 0) ? await windowFor(purchaseMinutes) : direct;
    return { ...state, version: booking.__v || 0, reference: booking.bookingReference || booking.workOrderNumber || team.ref(booking._id).slice(-6),
      date, visitDate, reasons, visitReasons, firstVisitPayment: visitPayment.summary(booking), payment: visitPayment.balance(booking), repairMinutes, purchaseMinutes, parts, direct, local,
      canStart: checkTime && !reasons.length && direct.available && toolsReady && parts.every(part => part.missing === 0) && booking.repairExecution?.status !== 'in_progress',
      requiresOnSiteConsent, confirmedQuotationTotal, tools, toolsReady, toolReason: toolsReady ? '' : readiness.error || 'Some required tools are not issued or are no longer at the site.',
      approvalReady: approvalReady(booking), execution: booking.repairExecution || null,
      purchases: (booking.localPurchase || []).map(row => ({ key: row.quotationKey, partName: row.partName, quantity: row.quantity, purchaseStatus: row.purchaseStatus, purchaseByType: row.purchaseByType, supplierName: row.supplierName, expectedPurchaseCost: row.expectedPurchaseCost })),
    };
  }
  async function read(id, technicianId, input = {}) { return inspect(await load(id, technicianId), technicianId, input, { checkTime: !['choice', 'later', 'cancel'].includes(input.mode) }); }
  async function act(id, technician, actorId, action, input) {
    if (!['start', 'defer', 'cancel-repair', 'plan-purchase', 'receipt', 'verify-customer-part'].includes(action)) throw fail('Unknown repair action.', 400);
    const date = manilaDateKey(deps.now());
    return deps.lock(`repair-visit:${id}`, () => deps.lock(require('./operationLock').bookingCapacityLockKey(date), async () => {
      const session = await deps.mongoose.startSession();
      let result;
      try { await session.withTransaction(async () => {
        const state = await load(id, technician._id, session); state.session = session;
        const { booking, assignment } = state;
        const originalStatus = booking.status;
        if (!Number.isInteger(input.version) || input.version !== (booking.__v || 0)) throw fail('This repair record changed. Refresh the work plan before saving.');
        const needsTime = ['start', 'plan-purchase'].includes(action);
        const plan = await inspect(state, technician._id, input, { checkTime: needsTime });
        const blockers = needsTime ? plan.reasons : plan.visitReasons;
        if (blockers.length) throw fail(blockers.join(' '));
        const set = {}, now = deps.now();
        let notification = 'Repair work plan updated';
        if (action === 'cancel-repair' || plan.requiresOnSiteConsent && ['start', 'defer', 'plan-purchase'].includes(action)) {
          if (action === 'cancel-repair' && (typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 1000)) throw fail('Record the customer\'s reason for cancelling the repair (5 to 1,000 characters).', 400);
          units.recordOnSiteDecision(booking, input, { technicianId: technician._id, actorId, now, cancel: action === 'cancel-repair' });
          for (const key of ['services', 'quotation', 'quotationReview', 'approval', 'balanceAmount', 'status']) set[key] = booking[key];
        }
        if (action === 'plan-purchase') {
          if (!plan.local.available) throw fail(plan.local.reason);
          if (input.customerAgreed !== true || input.supplierCanProvide !== true || typeof input.supplierName !== 'string' || input.supplierName.trim().length < 2 || input.supplierName.length > 160) throw fail('Record customer consent, the nearby supplier name, and confirmed part availability.', 400);
          if (!['technician', 'customer'].includes(input.purchaseBy)) throw fail('Choose who will buy the part.', 400);
          if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 50) throw fail('Choose the missing parts to buy.', 400);
          const seen = new Set(), purchases = [...(booking.localPurchase || [])];
          for (const entry of input.parts) {
            if (!entry || typeof entry !== 'object') throw fail('Choose a valid missing repair part.', 400);
            const part = plan.parts.find(row => row.key === entry.key && row.missing > 0);
            if (!part || seen.has(entry.key) || part.purchasePending) throw fail('Choose distinct missing parts. Existing purchases must be completed or reviewed by staff.');
            const cost = Number(entry.expectedPurchaseCost);
            if (!Number.isFinite(cost) || cost < 0.01 || cost > 1000000) throw fail('Enter a valid expected total buying cost for each missing part.', 400);
            seen.add(entry.key);
            purchases.push({ quotationKey: part.key, partName: part.name, toolId: part.toolId || null, quantity: part.missing,
              quotedCustomerPrice: part.quotedTotal, expectedPurchaseCost: cost, actualPurchaseCost: 0,
              supplierName: input.supplierName.trim(), supplierAvailabilityConfirmed: true, purchaseByType: input.purchaseBy,
              purchasedBy: input.purchaseBy === 'technician' ? technician._id : null, purchasedByName: input.purchaseBy === 'technician' ? technician.name : booking.customer?.name || 'Customer',
              purchaseStatus: input.purchaseBy === 'technician' ? 'pending' : 'awaiting_customer', adminVerificationStatus: input.purchaseBy === 'technician' ? 'pending' : 'not_required' });
          }
          set.localPurchase = purchases;
          const external = new Map();
          for (const purchase of purchases) external.set(purchase.quotationKey, (external.get(purchase.quotationKey) || 0) + Number(purchase.quantity || 0));
          const remainingExternal = new Map(external);
          set.quotation = { ...booking.quotation, parts: (booking.quotation?.parts || []).map(part => {
            const key = keyFor(part), quantity = Math.min(Number(part.quantity || 1), remainingExternal.get(key) || 0);
            remainingExternal.set(key, Math.max(0, (remainingExternal.get(key) || 0) - quantity));
            return { ...part, externalQuantity: quantity, source: quantity >= Number(part.quantity || 1) ? 'external_purchase' : 'inventory' };
          }) };
          set.repairExecution = { status: 'purchase_pending', workDate: date, repairMinutes: plan.repairMinutes, purchaseMinutes: plan.purchaseMinutes, reason: 'Customer agreed to a nearby purchase within the approved quotation.' };
          notification = 'Nearby repair-parts purchase planned; repair has not started';
        } else if (action === 'receipt' || action === 'verify-customer-part') {
          const purchases = (booking.localPurchase || []).map(row => ({ ...row })), purchase = purchases.find(row => row.quotationKey === input.key);
          if (!purchase || !plan.parts.some(row => row.key === input.key)) throw fail('This purchase is not part of the currently approved repair.');
          if (action === 'receipt') {
            const match = String(input.receiptUrl || '').match(/^\/api\/receipts\/([a-f\d]{24})$/i), cost = Number(input.actualPurchaseCost);
            if (purchase.purchaseByType !== 'technician' || !match || !Number.isFinite(cost) || cost < 0.01 || cost > 1000000) throw fail('Upload the receipt and enter the actual total buying cost.', 400);
            if (purchase.purchaseStatus === 'receipt_uploaded') throw fail('This purchase receipt is already recorded. Refresh the plan.');
            const file = await deps.receipt(match[1]);
            if (!file || String(file.metadata?.uploadedBy) !== String(actorId)) throw fail('Use a receipt uploaded by your own account.', 403);
            Object.assign(purchase, { receiptUrl: input.receiptUrl, actualPurchaseCost: cost, purchaseStatus: 'receipt_uploaded', purchasedAt: now });
            await deps.Expense.create([{ technicianId: technician._id, technicianName: technician.name || 'Technician', bookingId: booking._id,
              type: 'external_parts', amount: cost, description: `Local purchase: ${purchase.partName} from ${purchase.supplierName}`.slice(0, 500),
              receiptImage: input.receiptUrl, expenseDate: now, status: 'pending' }], { session });
          } else {
            if (purchase.purchaseByType !== 'customer' || input.correctPartVerified !== true) throw fail('Confirm the customer-provided part is correct before using it.', 400);
            Object.assign(purchase, { purchaseStatus: 'verified', verifiedAt: now, actualPurchaseCost: 0, adminVerificationStatus: 'not_required' });
          }
          set.localPurchase = purchases;
          notification = 'Repair part received; check the work plan before starting';
        } else if (action === 'cancel-repair') {
          const coreRemaining = (booking.services || []).some(item => item.type === 'core' && !['completed', 'cancelled'].includes(item.status));
          if (!coreRemaining && !plan.firstVisitPayment.settled) throw fail(`Record the remaining first-visit payment of ₱${plan.firstVisitPayment.amountDue.toLocaleString('en-PH')} before closing this visit. The repair quotation is separate.`, 409, 'PHASE_ONE_PAYMENT_REQUIRED');
          set.repairExecution = { status: 'cancelled', workDate: date, reason: input.reason.trim() };
          notification = 'Customer cancelled the repair on site; inspection fees and completed core services remain payable';
        } else if (action === 'start') {
          if (booking.repairExecution?.status === 'in_progress') throw fail('Repair work has already started. Record the repair and tests in Appliance repairs.');
          if (!plan.canStart) throw fail(!plan.direct.available ? plan.direct.reason : !plan.toolsReady ? plan.toolReason : 'Some approved parts have not been brought or received. Buy the missing parts nearby or request another visit.');
          set.status = 'repair_in_progress'; set.endTime = plan.direct.endTime;
          set.technicianTeamSchedule = team.scheduleKey('booking', { ...booking, endTime: set.endTime });
          set.repairExecution = { status: 'in_progress', workDate: date, startedAt: now, startedBy: technician._id, repairMinutes: plan.repairMinutes, plannedEndTime: set.endTime };
          set.repairSchedule = { preference: 'today', decidedAt: now };
          set.services = (booking.services || []).map(item => item.type === 'repair' && (item.units || []).some(unit => unit.repairReview?.state === 'approved')
            ? { ...item, status: 'repair_in_progress', phase: 'repair_phase_2', schedule: { ...(item.schedule || {}), endTime: set.endTime, kind: 'repair' } } : item);
          notification = 'Approved repair started on site';
        } else {
          const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
          if (reason.length < 5 || reason.length > 1000) throw fail('Explain why another visit is needed (5 to 1,000 characters).', 400);
          if ((booking.services || []).some(item => item.type === 'core' && !['completed', 'cancelled'].includes(item.status))) throw fail('Finish the booked core services before closing this mixed visit.');
          if (!plan.firstVisitPayment.settled) throw fail(`Record the remaining first-visit payment of ₱${plan.firstVisitPayment.amountDue.toLocaleString('en-PH')} before requesting the next visit. This covers inspection, travel and completed core services; the repair quotation is separate.`, 409, 'PHASE_ONE_PAYMENT_REQUIRED');
          const dates = input.preferredDates;
          if (!Array.isArray(dates) || dates.length < 1 || dates.length > 3 || new Set(dates).size !== dates.length || dates.some(day => !require('./bookingDateTime').strictManilaDateKey(day) || day <= date)) throw fail('Choose one to three distinct future Philippine dates.', 400);
          if (!['morning', 'afternoon', 'any'].includes(input.preferredTime)) throw fail('Choose a valid preferred time window.', 400);
          set.status = 'repair_approved'; set.repairSchedule = { preference: 'later', decidedAt: now };
          set.preferredSchedule = { dates: dates.map(day => manilaDateTime(day, 0)), timeWindow: input.preferredTime, submittedAt: now, submittedBy: actorId };
          set.repairExecution = { status: 'deferred', workDate: date, repairMinutes: plan.repairMinutes, reason };
          set.services = (booking.services || []).map(item => item.type === 'repair' && !['completed', 'repair_declined', 'cancelled'].includes(item.status) ? { ...item, status: 'repair_approved', phase: 'repair_phase_2' } : item);
          notification = 'Repair follow-up requested; Operations will confirm the next visit';
        }
        set.statusHistory = [...(booking.statusHistory || []), { fromStatus: originalStatus, toStatus: set.status || originalStatus, timestamp: now,
          changedBy: technician._id, changedByModel: 'Technician', changedByName: technician.name || 'Technician', reason: notification }];
        set.updatedAt = now;
        const written = await deps.Booking.updateOne({ _id: booking._id, status: originalStatus, technicianId: booking.technicianId,
          ...(booking.updatedAt ? { updatedAt: booking.updatedAt } : {}), ...(booking.__v == null ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: booking.__v }) }, { $set: set, $inc: { __v: 1 } }, { session, runValidators: true });
        if (written.modifiedCount !== 1) throw fail('This repair changed. Refresh before trying again.');
        if (action === 'start' || action === 'defer' || action === 'cancel-repair' && !(booking.services || []).some(item => item.type === 'core' && !['completed', 'cancelled'].includes(item.status))) await deps.Assignment.updateMany({ bookingId: booking._id, technicianId: { $in: team.ids(booking) }, status: { $in: ['accepted', 'en_route', 'on_site', 'in_progress'] } },
          { $set: action === 'start' ? { endTime: set.endTime, status: 'in_progress' } : { status: 'completed', completedAt: now } }, { session, runValidators: true });
        result = { success: true, action, message: notification, bookingId: booking._id, customerId: booking.customerId };
      }); } finally { await session.endSession(); }
      return result;
    }));
  }
  return { read, act };
}
function present(plan) {
  const { version, reference, date, visitDate, reasons, visitReasons, firstVisitPayment, payment, repairMinutes, purchaseMinutes, parts, direct, local, canStart, approvalReady, execution, purchases, requiresOnSiteConsent, confirmedQuotationTotal, tools, toolsReady, toolReason } = plan;
  return { version, reference, date, visitDate, reasons, visitReasons, firstVisitPayment, payment, repairMinutes, purchaseMinutes, parts, direct, local, canStart, approvalReady, execution, purchases, requiresOnSiteConsent, confirmedQuotationTotal, tools, toolsReady, toolReason };
}
module.exports = { createService, present, partCoverage, approvedParts, approvalReady, duration, purchaseReceived };
