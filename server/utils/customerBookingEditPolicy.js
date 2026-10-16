"use strict";
const policy = require('../public/js/booking-edit-policy');

async function hasVerifiedPayment(booking) {
  return Boolean(policy.paymentVerified(booking) || await require('../models/Payment').exists({
    bookingId: booking._id,
    $or: [{ status: { $in: policy.verifiedStatuses } }, { verifiedAt: { $ne: null } }, { verifiedBy: { $ne: null } }],
  }));
}
async function assertPaymentNotVerified(booking) {
  if (await hasVerifiedPayment(booking)) throw Object.assign(Error(policy.paymentLockReason), { status: 409, code: 'BOOKING_PAYMENT_VERIFIED' });
}

// Mongoose includes these conditions in the update performed by save(). A
// payment verified after validation must prevent this customer write too.
function guardCustomerSave(booking) {
  booking.$where = { ...(booking.$where || {}), paymentVerifiedAt: null, paymentVerifiedBy: null,
    paymentStatus: { $nin: policy.verifiedStatuses }, status: { $ne: 'payment_verified' } };
}

module.exports = { hasVerifiedPayment, assertPaymentNotVerified, guardCustomerSave };
