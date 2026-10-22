'use strict';
const team = require('./standardJobTeam');
const flow = require('./repairUnitWorkflow');
const pricing = require('../public/js/repair-visit-payment');
const { isCoreOrigin } = require('../public/js/core-repair-policy');
const ref = team.ref;
const fail = (message, status = 409, code = 'REPAIR_FINDING_BLOCKED') => Object.assign(new Error(message), { status, code });
const discoveries = booking => (booking?.services || []).filter(row => row.type === 'repair' && row.discoveredDuringService);
const needsReview = booking => discoveries(booking).some(row => row.discoveredDuringService.coreDisposition === 'on_hold'
  || Number(row.discoveredDuringService.refundReviewAmount) > 0.01);
const received = (booking, ledger) => require('./paymentSummary').summarizeBookingPayments(booking, ledger.map(row => ({ ...row,
  refundAmount: row.refundStatus === 'completed' || row.status === 'refunded' ? row.refundAmount : 0,
}))).amountPaid;
const unperformed = booking => (booking.services || []).some(row => row.type === 'core')
  && (booking.services || []).every(row => row.type === 'core' ? row.status === 'cancelled' : (row.units || []).length > 0 && row.units.every(unit => unit.repairReview?.state === 'declined'));
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw fail(`${label} must contain ${min} to ${max} characters.`, 400);
  return value.trim();
}
function identity(row) { return row.applianceGroupId ? `group:${row.applianceGroupId}` : `item:${ref(row._id)}`; }
function sources(booking) {
  const groups = new Map();
  let ordinal = 0;
  for (const row of booking.services || []) {
    if (row.type !== 'core' || row.relocation?.scope || !row._id) continue;
    const key = identity(row), entry = groups.get(key) || { row, rows: [] };
    entry.rows.push(row); groups.set(key, entry);
  }
  return [...groups.values()].flatMap(({ row, rows }) => Array.from({ length: Number(row.quantity || 1) }, (_, index) => {
    const found = discoveries(booking).find(repair => {
      const source = booking.services.find(core => ref(core._id) === ref(repair.discoveredDuringService.sourceServiceItemId));
      return source && identity(source) === identity(row) && Number(repair.discoveredDuringService.unitIndex) === index + 1;
    });
    return { serviceItemId: ref(row._id), unitIndex: index + 1,
      label: [`${require('../public/js/appliance-services').labels[row.applianceKind] || 'Appliance'} ${++ordinal}`, row.brand,
        row.applianceTypeName || row.airconTypeName, row.hp ? `${row.hp} HP` : '', row.model,
        Number(row.quantity) > 1 ? `Unit ${index + 1}` : ''].filter(Boolean).join(' · '),
      services: rows.map(core => core.name), eligible: rows.some(core => !['completed', 'cancelled'].includes(core.status)),
      findingId: found ? ref(found._id) : null };
  }));
}
function assertActive(booking, technicianId, assignment, now) {
  if (!team.isPrimary(booking, technicianId)) throw fail('Only the assigned primary technician can report a repair finding.', 403);
  if (booking.archivedAt || booking.isProject || booking.sourceOrderId || team.closed.has(booking.status)) throw fail('Use the appropriate active service workspace for this booking.');
  require('./customerCancellationPolicy').assertNoHold(booking);
  require('./workContinuation').assertVisitActive(booking); team.assertReady(booking);
  if (!assignment || assignment.status !== 'in_progress') throw fail('Arrive and Start Work before reporting a repair found during the service.');
  if (require('./bookingDateTime').manilaDateKey(assignment.bookingDate || booking.bookingDate) !== require('./bookingDateTime').manilaDateKey(now)) throw fail('Report findings on the scheduled Philippine work date. Ask Operations to review an unfinished earlier visit.');
}
function canAdd(booking) {
  return isCoreOrigin(booking) && !booking.repairExecution?.startedAt && !['pending', 'awaiting_customer', 'approved'].includes(booking.quotationReview?.status)
    && flow.rows(booking).every(({ unit }) => ['pending', 'staff_review'].includes(unit.repairReview?.state));
}
function present(booking, role = 'technician') {
  return { bookingId: ref(booking._id), reference: booking.bookingReference || '', version: booking.__v || 0, role,
    closed: Boolean(booking.archivedAt || team.closed.has(booking.status)),
    canCloseUnperformed: unperformed(booking) && !needsReview(booking),
    sources: role === 'technician' ? sources(booking) : [], canAdd: role === 'technician' && canAdd(booking),
    addBlockedReason: !isCoreOrigin(booking) ? 'Repair found is available only for bookings that started with core services. Use the existing inspection and quotation for booked repairs.'
      : canAdd(booking) ? '' : 'A repair quotation is already submitted or work has started. Ask Operations to review any further findings.',
    payment: pricing.balance(booking), quotationSettled: pricing.breakdown(booking).quotationSettled, findings: discoveries(booking).map(row => {
      const finding = row.discoveredDuringService, unit = row.units?.[0];
      return { id: ref(row._id), key: `G${booking.services.indexOf(row) + 1}-U001`, name: row.name,
        findings: finding.findings, recommendedAction: finding.recommendedAction, severity: finding.severity,
        coreDisposition: finding.coreDisposition, reportedAt: finding.reportedAt, decisionNotes: finding.decisionNotes,
        refundReviewAmount: finding.refundReviewAmount || 0, repairState: unit?.repairReview?.state || 'pending',
        refundQueued: Boolean(finding.refundQueuedAt),
        inspectionFee: 0, photos: unit?.inspection?.photos || [], originalBookingTotal: finding.originalBookingTotal };
    }) };
}
function append(booking, assignment, technician, input, now) {
  if (!isCoreOrigin(booking)) throw fail('Repair found is available only for bookings that started with core services. Use the existing repair inspection and quotation.', 409, 'CORE_ONLY_REPAIR_FINDING');
  const requestedSource = booking.services.find(row => row.type === 'core' && ref(row._id) === String(input.serviceItemId));
  const selection = sources(booking).find(row => row.unitIndex === Number(input.unitIndex) && requestedSource
    && identity(booking.services.find(core => ref(core._id) === row.serviceItemId)) === identity(requestedSource));
  if (!selection || !selection.eligible) throw fail('Choose an unfinished core-service appliance from this booking.', 400);
  if (selection.findingId) return { findingId: selection.findingId, alreadyRecorded: true };
  if (!canAdd(booking)) throw fail('A repair quote is already under review or decided. Ask Operations to review further changes.');
  const findings = text(input.findings, 'Findings', 10, 2000), action = text(input.recommendedAction, 'Recommended repair', 5, 1000);
  if (!['standard', 'urgent', 'unsafe'].includes(input.severity) || typeof input.coreCanContinue !== 'boolean') throw fail('Choose the urgency and whether the booked core work can continue.', 400);
  if (input.severity === 'unsafe' && input.coreCanContinue) throw fail('Pause the affected work when the appliance is unsafe to continue servicing.', 400);
  const source = booking.services.find(row => ref(row._id) === selection.serviceItemId);
  const affected = booking.services.filter(row => row.type === 'core' && identity(row) === identity(source) && !['completed', 'cancelled'].includes(row.status));
  if (affected.some(row => row.technicianId && ref(row.technicianId) !== ref(technician._id))) throw fail('This appliance work belongs to another technician. Ask Operations to review the finding.', 403);
  const before = pricing.balance(booking).total;
  booking.services.push({ type: 'repair', name: `${selection.label} — additional repair`, serviceId: null, quantity: 1,
    brand: source.brand, model: source.model, hp: source.hp, hpDescription: source.hpDescription,
    airconType: source.airconType, airconTypeName: source.airconTypeName,
    applianceType: source.applianceType || source.airconType || source.applianceKind,
    applianceTypeName: source.applianceTypeName || source.airconTypeName,
    unitType: source.applianceType || source.airconType || source.applianceKind, unitCategory: source.applianceKind || (source.isAirconService ? 'aircon' : undefined),
    isAirconService: source.isAirconService, unitPrice: 0, initialCost: 0, totalPrice: 0, duration: 0,
    problemDescription: findings, repairIssue: findings, phase: 'repair_phase_1', status: 'inspection_in_progress',
    technicianId: technician._id, technicianName: technician.name, assignmentId: assignment._id,
    schedule: { date: booking.bookingDate, startTime: booking.startTime, endTime: booking.endTime, durationMinutes: 0, kind: 'inspection' },
    discoveredDuringService: { sourceServiceItemId: source._id, unitIndex: selection.unitIndex, requestId: input.requestId,
      findings, recommendedAction: action, severity: input.severity, reportedBy: technician._id, reportedAt: now,
      coreDisposition: input.coreCanContinue ? 'continuing' : 'on_hold', originalBookingTotal: before,
      affectedCoreItems: affected.map(row => ({ serviceItemId: row._id, previousStatus: row.status })) },
    units: [{ unitIndex: 1, label: selection.label, problemDescription: findings, status: 'pending',
      repairReview: { state: 'pending', revision: 0 }, inspection: { findings, recommendedAction: action, technicianConfirmed: false } }],
    statusHistory: [{ status: 'inspection_in_progress', changedAt: now, changedBy: technician._id,
      changedByName: technician.name, reason: 'Repair found during an existing core service; no new inspection or travel charge.' }],
  });
  const repair = booking.services[booking.services.length - 1];
  if (!input.coreCanContinue) for (const core of affected) {
    core.status = 'on_hold'; core.coreRepairHold = { findingId: repair._id, state: 'on_hold' };
    core.statusHistory.push({ status: 'on_hold', changedAt: now, changedBy: technician._id, changedByName: technician.name, reason: findings });
  }
  booking.serviceType = 'mixed'; booking.isMultiService = true; booking.repairUnitTracking = true; booking.status = 'in-progress';
  booking.totalInitialCost = before;
  booking.statusHistory.push({ toStatus: booking.status, changedBy: technician._id, changedByModel: 'Technician', changedByName: technician.name,
    reason: input.coreCanContinue ? 'Additional repair finding recorded; original service continues.' : 'Affected core work paused for Operations review.', timestamp: now });
  return { findingId: ref(repair._id), alreadyRecorded: false };
}
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Assignment: require('../models/Assignment'),
    Payment: require('../models/Payment'), lock: require('./operationLock').withOperationLock, now: () => new Date(), ...overrides };
  async function assignmentFor(booking, tech, session) {
    return deps.Assignment.findOne({ bookingId: booking._id, technicianId: tech._id,
      ...(booking.assignmentId ? { _id: booking.assignmentId } : {}), status: { $nin: ['expired', 'declined', 'cancelled'] } }).session(session || null);
  }
  async function read(id, actor) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid booking.', 400);
    const booking = await deps.Booking.findById(id);
    if (!booking) throw fail('Booking not found.', 404);
    if (actor.role === 'technician') assertActive(booking, actor.technician._id, await assignmentFor(booking, actor.technician), deps.now());
    else if (!['admin', 'secretary'].includes(actor.role)) throw fail('Access denied.', 403);
    const result = present(booking, actor.role);
    const ledger = await deps.Payment.find({ bookingId: booking._id }).session(null).lean();
    if (ledger.length) {
      result.payment.amountPaid = received(booking, ledger);
      result.payment.amountDue = Math.max(0, result.payment.total - result.payment.amountPaid);
      result.payment.paidInFull = result.payment.amountDue <= 0.01;
    }
    return result;
  }
  async function act(id, actor, action, input = {}) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid booking.', 400);
    return deps.lock(`booking-payment:${id}`, async () => {
      const session = await deps.mongoose.startSession(); let result;
      try { await session.withTransaction(async () => {
        const booking = await deps.Booking.findById(id).session(session);
        if (!booking) throw fail('Booking not found.', 404);
        const now = deps.now();
        if (action === 'report') {
          if (actor.role !== 'technician') throw fail('Only the primary technician reports findings.', 403);
          const assignment = await assignmentFor(booking, actor.technician, session);
          assertActive(booking, actor.technician._id, assignment, now);
          if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) throw fail('Refresh the form before submitting this finding.', 400);
          const prior = discoveries(booking).find(row => row.discoveredDuringService.requestId === input.requestId);
          if (prior) { result = { ...present(booking, actor.role), findingId: ref(prior._id), alreadyRecorded: true }; return; }
          if (!Number.isInteger(input.version) || input.version !== (booking.__v || 0)) throw fail('This booking changed. Refresh it before reporting a finding.');
          const ledger = await deps.Payment.find({ bookingId: booking._id }).session(session).lean();
          if (ledger.length) {
            booking.amountPaid = received(booking, ledger);
            booking.balanceAmount = Math.max(0, pricing.balance(booking).total - booking.amountPaid);
            booking.balanceCollected = booking.balanceAmount <= 0.01;
          }
          const added = append(booking, assignment, actor.technician, input, now);
          if (!added.alreadyRecorded) {
            assignment.serviceType = 'mixed';
            await assignment.save({ session }); booking.increment(); await booking.save({ session });
          }
          result = { ...present(booking, actor.role), ...added };
        } else {
          if (!['admin', 'secretary'].includes(actor.role)) throw fail('Operations must review the affected core work.', 403);
          if (!['resume-core', 'cancel-core', 'review-refund', 'queue-refund', 'close-visit'].includes(action)) throw fail('Unknown finding action.', 400);
          if (booking.archivedAt || team.closed.has(booking.status)) throw fail('This booking is closed.');
          if (!Number.isInteger(input.version) || input.version !== (booking.__v || 0)) throw fail('This booking changed. Refresh it before deciding.');
          const repair = discoveries(booking).find(row => ref(row._id) === String(input.findingId));
          if (!repair) throw fail('Repair finding not found.', 404);
          const finding = repair.discoveredDuringService;
          const notes = text(input.reason, 'Decision reason', 5, 1000);
          if (['resume-core', 'cancel-core'].includes(action)) {
            if (finding.coreDisposition !== 'on_hold') throw fail('This affected work has already been reviewed.');
            for (const row of booking.services.filter(row => ref(row.coreRepairHold?.findingId) === ref(repair._id) && row.coreRepairHold.state === 'on_hold')) {
              row.status = action === 'resume-core' ? 'in_progress' : 'cancelled';
              row.coreRepairHold.state = action === 'resume-core' ? 'resumed' : 'not_performed';
              row.statusHistory.push({ status: row.status, changedAt: now, changedBy: actor.userId, changedByName: actor.name || 'Operations', reason: notes });
            }
            finding.coreDisposition = action === 'resume-core' ? 'resumed' : 'not_performed';
          }
          finding.decidedBy = actor.userId; finding.decidedAt = now; finding.decisionNotes = notes;
          const totals = booking.calculateTotalCosts();
          booking.totalInitialCost = totals.totalInitialCost; booking.totalPrice = totals.totalPrice;
          const ledger = await deps.Payment.find({ bookingId: booking._id }).session(session).lean();
          const paid = ledger.length ? received(booking, ledger) : Number(booking.amountPaid || 0);
          const total = pricing.balance(booking).total;
          const overpaid = Math.round(Math.max(0, paid - total) * 100) / 100;
          if (action === 'review-refund' && !pricing.breakdown(booking).quotationSettled) throw fail('Record the customer repair decisions before settling the final refund.');
          if (action === 'review-refund' && overpaid > 0.01) throw fail(`Record and verify the outstanding refund of PHP ${overpaid.toLocaleString('en-PH')} in the booking payment records first.`);
          if (action === 'queue-refund') {
            if (!pricing.breakdown(booking).quotationSettled) throw fail('Record the customer repair decisions before requesting a refund.');
            if (overpaid <= 0.01) throw fail('There is no remaining overpayment to refund.');
            if (ledger.some(row => ['pending', 'processing', 'partial'].includes(row.refundStatus))) throw fail('This booking already has a refund in progress. Review it in Payments.');
            const eligible = ledger.filter(row => row.status !== 'refunded' && require('./paymentSummary').RECEIVED_PAYMENT_STATUSES.has(row.status) && !Number(row.refundAmount));
            if (eligible.reduce((sum, row) => sum + Number(row.amount || 0), 0) + 0.01 < overpaid) throw fail('Payments with earlier partial refunds need an individual finance review before another refund is queued.');
            let remaining = overpaid; const paymentIds = [];
            for (const row of eligible) {
              const amount = Math.round(Math.min(remaining, Number(row.amount)) * 100) / 100;
              if (amount <= 0) continue;
              const updated = await deps.Payment.updateOne({ _id: row._id, refundStatus: { $nin: ['pending','processing','partial'] }, refundAmount: { $in: [0,null] } },
                { $set: { refundAmount: amount, refundStatus: 'pending', refundMethod: 'original', refundReason: notes },
                  $push: { events: { status: 'refund_pending', actor: actor.userId, actorRole: actor.role, actorName: actor.name,
                    note: `Refund requested for unperformed core work: ${notes}`, at: now, metadata: { repairFindingId: repair._id, amount } } } }, { session, runValidators: true });
              if (updated.modifiedCount !== 1) throw fail('A payment refund changed. Refresh the finding before requesting it again.');
              remaining = Math.round((remaining - amount) * 100) / 100; paymentIds.push(row._id);
            }
            finding.refundQueuedAt = now; finding.refundPaymentIds = paymentIds;
          }
          if (action === 'close-visit') {
            if (!unperformed(booking) || needsReview(booking) || paid + 0.01 < total || overpaid > 0.01) throw fail('Resolve every service decision, payment and refund before closing an unperformed visit.');
            booking.status = 'cancelled'; booking.cancellationReason = notes;
            await deps.Assignment.updateMany({ bookingId: booking._id, status: { $nin: ['completed','cancelled','expired','declined'] } },
              { $set: { status:'cancelled', cancelledAt: now } }, { session });
          }
          finding.refundReviewAmount = overpaid; booking.amountPaid = paid; booking.balanceAmount = Math.max(0, total - paid);
          booking.balanceCollected = booking.balanceAmount <= 0.01;
          booking.statusHistory.push({ toStatus: booking.status, changedBy: actor.userId, changedByModel: 'User', changedByName: actor.name || 'Operations', reason: `Repair finding review: ${notes}`, timestamp: now });
          booking.increment(); await booking.save({ session }); result = present(booking, actor.role);
        }
      }, { timeoutMS: 15000 }); } finally { await session.endSession(); }
      return result;
    });
  }
  return { read, act };
}
module.exports = { createService, present, discoveries, needsReview, sources, append, canAdd };
