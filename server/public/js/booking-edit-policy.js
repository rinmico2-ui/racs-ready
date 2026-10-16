(function (root, factory) {
  'use strict';
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.BookingEditPolicy = policy;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const editableStatuses = new Set(['pending', 'payment_verified', 'confirmed', 'awaiting_assignment']);
  const verifiedStatuses = new Set(['verified', 'paid', 'partial', 'refunded']);
  const paymentLockReason = 'Payment has been verified. Contact staff if your booking details need to change.';
  function paymentVerified(booking = {}) {
    return Boolean(booking.paymentVerifiedAt || booking.paymentVerifiedBy
      || booking.status === 'payment_verified' || verifiedStatuses.has(booking.paymentStatus)
      || (booking.payments || []).some(payment => payment?.verifiedAt || payment?.verifiedBy
        || verifiedStatuses.has(payment?.status)));
  }
  function state(booking = {}) {
    const verified = paymentVerified(booking);
    return { canEdit: editableStatuses.has(booking.status || 'pending') && !verified,
      paymentVerified: verified, reason: verified ? paymentLockReason : '' };
  }
  return { state, paymentVerified, paymentLockReason, verifiedStatuses: [...verifiedStatuses] };
});
