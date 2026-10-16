'use strict';
const pricing = require('../public/js/repair-visit-payment');
const team = require('./standardJobTeam');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function createService(overrides = {}) {
  const deps = { mongoose: require('mongoose'), Booking: require('../models/BookingService'), Payment: require('../models/Payment'),
    Assignment: require('../models/Assignment'), lock: require('./operationLock').withOperationLock, now: () => new Date(), ...overrides };
  return async function collect(id, technician, actorId, input) {
    if (!deps.mongoose.isValidObjectId(id)) throw fail('Invalid repair reference.', 400);
    return deps.lock(`repair-visit:${id}`, async () => {
      const session = await deps.mongoose.startSession(); let result;
      try { await session.withTransaction(async () => {
        const booking = await deps.Booking.findById(id).session(session);
        if (!booking) throw fail('Booking not found.', 404);
        if (!team.isPrimary(booking, technician._id)) throw fail('Only the primary technician can record the first-visit payment.', 403);
        if (booking.isProject || booking.sourceOrderId || !require('./repairUnitWorkflow').hasRepair(booking) || booking.archivedAt || team.closed.has(booking.status)) throw fail('This repair visit is not open for payment collection.');
        const assignment = await deps.Assignment.findOne({ bookingId: booking._id, technicianId: technician._id,
          ...(booking.assignmentId ? { _id: booking.assignmentId } : {}), status: 'in_progress' }).session(session);
        if (!assignment || !team.readiness(booking).ready) throw fail('Start the accepted visit before recording an inspection payment.');
        const bill = pricing.summary(booking);
        if (bill.settled) { result = { success: true, alreadyCollected: true, message: 'The first-visit payment is already recorded.', phaseOnePayment: { ...bill, amountCollected: 0 } }; return; }
        if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || Math.abs(input.amount - bill.amountDue) > 0.009) throw fail(`Record exactly the remaining first-visit balance of ₱${bill.amountDue.toLocaleString('en-PH')}. Refresh the payment details before collecting.`, 400);
        const methods = { cash:'cod', cod:'cod', gcash:'gcash', maya:'other', bank_transfer:'bank' };
        if (!Object.hasOwn(methods, input.method)) throw fail('Choose Cash, GCash, Maya or Bank transfer.', 400);
        if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 1000)) throw fail('Payment notes must be text of up to 1,000 characters.', 400);
        const now = deps.now(), collected = bill.amountDue, paidAfter = Math.round((bill.amountPaid + collected) * 100) / 100;
        const inspectionCash = Math.min(collected, Math.max(0, bill.inspectionTarget - bill.amountPaid));
        const coreCash = bill.allCoreCompleted ? collected - inspectionCash : 0;
        booking.amountPaid = paidAfter; booking.inspectionFeeCollected = true;
        booking.inspectionFeeAmount = bill.repairInspectionFee; booking.inspectionFeeDistanceFare = bill.distanceFare;
        booking.inspectionFeeTotalCollected = Number(booking.inspectionFeeTotalCollected || 0) + inspectionCash;
        booking.downpaymentAppliedToInspection = Math.min(bill.amountPaid, Math.max(0, Number(booking.downpaymentAmount) || 0), bill.inspectionTarget);
        booking.inspectionFeeMethod = input.method; booking.inspectionFeeCollectedAt ||= now;
        if (bill.allCoreCompleted) {
          booking.coreServicePaymentCollected = true; booking.coreServicePaymentAmount = bill.coreServiceAmount;
          booking.coreServicePaymentCashCollected = Number(booking.coreServicePaymentCashCollected || 0) + coreCash;
          booking.coreServicePaymentMethod = input.method; booking.coreServicePaymentCollectedAt = now;
        }
        booking.balanceAmount = Math.max(0, Math.round((bill.initialBookingTotal + Number(booking.quotation?.totalCost || 0) - paidAfter) * 100) / 100);
        booking.paymentStatus = 'waiting_for_remittance';
        await deps.Payment.create([{ bookingId: booking._id, amount: collected, method: methods[input.method], type:'inspection', gateway:methods[input.method], status:'waiting_for_remittance',
          reference: input.notes?.trim() || `First-visit payment collected by ${technician.name || 'Technician'}`, collectedBy:technician._id, collectedByName:technician.name || 'Technician', collectedAt:now,
          events:[{status:'payment_collected',actor:actorId,actorName:technician.name,actorRole:'technician',at:now},{status:'waiting_for_remittance',actor:actorId,actorName:technician.name,actorRole:'technician',at:now}],
          notes:`First visit: inspection ₱${bill.repairInspectionFee}, travel ₱${bill.distanceFare}, completed core services ₱${bill.coreServiceAmount}; newly collected ₱${collected}. Repair quotation is separate.`,
        }], { session });
        booking.increment(); await booking.save({ session });
        result = { success:true, message:'First-visit payment recorded. You can continue the return-visit request.',
          phaseOnePayment:{...bill,amountDue:0,amountCollected:collected,remainingInitialBalance:Math.max(0,bill.initialBookingTotal-paidAfter)},
          booking:{amountPaid:paidAfter,inspectionFeeCollected:true,balanceAmount:booking.balanceAmount} };
      }); } finally { await session.endSession(); }
      return result;
    });
  };
}
module.exports = { createService };
