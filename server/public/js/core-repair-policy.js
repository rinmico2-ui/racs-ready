(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoreRepairPolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function isCoreOrigin(booking) {
    const items = booking?.services || [];
    const core = items.filter(item => item.type === 'core');
    const repair = items.filter(item => item.type === 'repair');
    if (!core.length || booking.isProject || booking.sourceOrderId) return false;
    if (!repair.length) return booking.serviceType !== 'repair' && booking.serviceType !== 'mixed';
    // A core-only booking becomes mixed after its first discovered repair.
    // Booked repair items identify bookings that were mixed from the outset.
    return repair.every(item => item.discoveredDuringService
      && core.some(source => String(source._id) === String(item.discoveredDuringService.sourceServiceItemId)));
  }
  return { isCoreOrigin };
});
