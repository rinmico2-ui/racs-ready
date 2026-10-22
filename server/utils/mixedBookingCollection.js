'use strict';
const pricing = require('../public/js/repair-visit-payment');
const team = require('./standardJobTeam');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Assignment: require('../models/Assignment'),
    Payment: require('../models/Payment'), lock: require('./operationLock').withOperationLock, ...overrides };
  return async function collect(bookingId, technician, userId, input = {}, assignmentId) {
    if (!deps.mongoose.isValidObjectId(bookingId)) throw fail('Invalid booking.', 400);
    return deps.lock(`booking-payment:${bookingId}`, async () => {
      const session = await deps.mongoose.startSession(); let result;
      try {
        await session.withTransaction(async () => {
          const booking = await deps.Booking.findById(bookingId).session(session);
          if (!booking) throw fail('Booking not found.', 404);
          if (!team.isPrimary(booking, technician._id)) throw fail('Only the assigned primary technician can collect this booking payment.', 403);
          if (booking.archivedAt || booking.isProject || booking.sourceOrderId || ['cancelled', 'rejected', 'closed'].includes(booking.status)) throw fail('This booking cannot receive payment.');
          require('./customerCancellationPolicy').assertNoHold(booking);
          require('./workContinuation').assertVisitActive(booking); team.assertReady(booking);
          const assignment = await deps.Assignment.findOne({ bookingId: booking._id, technicianId: technician._id,
            ...(booking.assignmentId ? { _id: booking.assignmentId } : {}), status: { $in: ['in_progress', 'completed'] } }).session(session);
          if (!assignment || assignmentId && team.ref(assignment._id) !== team.ref(assignmentId)) throw fail('The assignment changed. Refresh before collecting payment.');
          const bill = pricing.breakdown(booking);
          if (!bill.isMixedBooking) throw fail('Use the collection flow for this service.');
          const payments = await deps.Payment.find({ bookingId: booking._id }).session(session).lean();
          const reconciled = require('./paymentSummary').reconcileBookingPayments({ totalPrice: bill.total }, payments);
          const paid = payments.length ? reconciled.ledgerCollected : bill.amountPaid;
          const due = Math.round(Math.max(0, bill.total - paid) * 100) / 100;
          const snapshot = () => ({ amountPaid: booking.amountPaid, balanceAmount: booking.balanceAmount,
            balanceCollected: booking.balanceCollected, paymentStatus: booking.paymentStatus,
            repairPaymentCollected: booking.repairPaymentCollected, repairPaymentAmount: booking.repairPaymentAmount,
            repairPaymentMethod: booking.repairPaymentMethod });
          if (due <= 0.01) {
            result = { success: true, alreadyCollected: true, message: 'The combined booking payment is already recorded.',
              ...snapshot(), amountPaid: paid, balanceAmount: 0, balanceCollected: true,
              booking: { ...snapshot(), amountPaid: paid, balanceAmount: 0, balanceCollected: true } }; return;
          }
          const eligibility = pricing.collection(booking);
          if (!eligibility.allowed) throw Object.assign(fail(eligibility.reason), { code: eligibility.code });
          const method = String(input.method || 'cash').toLowerCase();
          if (!['cash', 'gcash', 'bank'].includes(method)) throw fail('Choose Cash, GCash or Bank transfer.', 400);
          if (method === 'cash' && input.cashReceivedConfirmed !== true) throw fail('Confirm that you received the cash before recording this collection.', 400);
          if (method !== 'cash' && (typeof input.reference !== 'string' || !input.reference.trim())) throw fail('Enter the GCash or bank transfer reference number.', 400);
          const amount = Number(input.amount);
          if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount - due) > 0.009) throw fail(`Collect the combined remaining balance of PHP ${due.toLocaleString('en-PH')}.`, 400);
          if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 1000)) throw fail('Keep payment notes within 1000 characters.', 400);
          const now = new Date(), paymentLedger = { lines: bill.lines, total: bill.total, previouslyPaid: paid, collected: amount, balance: 0 };
          const [payment] = await deps.Payment.create([{ bookingId: booking._id, amount, method, gateway: method === 'cash' ? 'cod' : method,
            type: 'final', status: 'waiting_for_remittance', reference: method === 'cash' ? undefined : input.reference.trim(),
            collectedBy: technician._id, collectedByName: technician.name, collectedAt: now, collectionLocation: input.location || undefined,
            notes: [bill.lines.map(line => `${line.label}: PHP ${line.amount}`).join('; '), input.notes || ''].filter(Boolean).join('. '),
            events: [{ status: 'payment_collected', actor: userId, actorName: technician.name, actorRole: 'technician', at: now,
              metadata: { paymentLedger, cashReceivedConfirmed: method === 'cash' } },
            { status: 'waiting_for_remittance', actor: userId, actorName: technician.name, actorRole: 'technician', at: now }],
          }], { session });
          booking.amountPaid = Math.round((paid + amount) * 100) / 100; booking.balanceAmount = 0; booking.balanceCollected = true;
          booking.balanceCollectedAt = now; booking.balanceCollectedBy = technician._id; booking.paymentStatus = 'waiting_for_remittance';
          booking.coreServicePaymentCollected = true; booking.coreServicePaymentAmount = bill.lines[0].amount;
          booking.coreServicePaymentMethod = method; booking.coreServicePaymentCollectedAt = now;
          booking.inspectionFeeCollected = true; booking.inspectionFeeAmount = bill.lines[1].amount;
          booking.inspectionFeeDistanceFare = bill.lines[3].amount; booking.inspectionFeeMethod = method; booking.inspectionFeeCollectedAt ||= now;
          // These snapshots describe allocations within this one payment, not additional collections.
          const priorInspectionCredit = Math.min(paid, bill.lines[1].amount + bill.lines[3].amount);
          booking.inspectionFeeTotalCollected = Math.max(0, bill.lines[1].amount + bill.lines[3].amount - Math.min(Number(booking.downpaymentAmount) || 0, priorInspectionCredit));
          booking.downpaymentAppliedToInspection = Math.min(Number(booking.downpaymentAmount) || 0, priorInspectionCredit);
          if (bill.repairTotal > 0) {
            booking.repairPaymentCollected = true; booking.repairPaymentAmount = bill.repairTotal; booking.repairPaymentMethod = method;
            booking.repairPaymentCollectedAt = now; booking.repairPaymentCollectedBy = technician._id;
          }
          booking.statusHistory ||= []; booking.statusHistory.push({ toStatus: booking.status, changedBy: technician._id,
            changedByModel: 'Technician', changedByName: technician.name, reason: 'Combined booking payment collected', timestamp: now,
            metadata: { paymentId: payment._id, paymentLedger } });
          booking.increment(); await booking.save({ session });
          result = { success: true, message: 'Combined booking payment recorded. Waiting for remittance verification.', paymentId: payment._id,
            paymentLedger, ...snapshot(), booking: snapshot() };
        }, { timeoutMS: 15000 });
      } finally { await session.endSession(); }
      return result;
    });
  };
}
module.exports = { createService };
