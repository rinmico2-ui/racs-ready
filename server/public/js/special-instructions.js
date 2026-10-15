(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpecialInstructions = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const text = value => typeof value === 'string' ? value.trim() : '';
  const escape = value => value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function render(value) {
    const instructions = text(value);
    return '<section class="special-instructions" aria-label="Special instructions">' +
      '<h6 class="special-instructions-title"><i class="bi bi-chat-left-text" aria-hidden="true"></i>Special instructions</h6>' +
      '<p class="special-instructions-text' + (instructions ? '' : ' special-instructions-empty') + '">' +
      escape(instructions || 'No special instructions provided.') + '</p></section>';
  }

  // General booking/assignment notes contain staff activity and payment logs.
  // Only the fields entered by the customer belong in this section.
  const renderBooking = booking => render(booking?.paymentNotes);
  const renderOrder = order => render(order?.delivery?.notes);
  return { render, renderBooking, renderOrder };
});
