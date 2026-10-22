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
    const cancellationPending = ['pending', 'under_review'].includes(booking.customerCancellation?.status || booking.cancellation?.request?.status);
    return { canEdit: editableStatuses.has(booking.status || 'pending') && !verified && !cancellationPending,
      paymentVerified: verified, reason: cancellationPending ? 'Your cancellation request is under review. Wait for the decision before changing this booking.' : verified ? paymentLockReason : '' };
  }
  return { state, paymentVerified, paymentLockReason, verifiedStatuses: [...verifiedStatuses] };
});
