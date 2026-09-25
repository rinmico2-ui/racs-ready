(function () {
  'use strict';

  const errors = {
    ORDER_FULFILLMENT_INVALID: ['fulfillment', 'Choose delivery or pickup'],
    ORDER_ITEMS_INVALID: ['product', 'Check your products'],
    ORDER_ITEM_QUANTITY_INVALID: ['product', 'Check the quantity'],
    ORDER_ITEM_DUPLICATE: ['product', 'Check your products'],
    ORDER_UNIT_LIMIT_EXCEEDED: ['product', 'Check the quantity'],
    ORDER_DELIVERY_ADDRESS_REQUIRED: ['address', 'Check the delivery address'],
    ORDER_CONTACT_INVALID: ['contact', 'Check the phone number'],
    ORDER_LOCATION_REQUIRED: ['map', 'Check the map pin'],
    ORDER_DELIVERY_DATE_INVALID: ['schedule', 'Choose another date'],
    ORDER_PICKUP_DATE_INVALID: ['pickup', 'Choose another pickup date'],
    ORDER_PICKUP_STORE_CLOSED: ['pickup', 'Choose another pickup date'],
    ORDER_TIME_REQUIRED: ['schedule', 'Choose a start time'],
    ORDER_SLOT_UNAVAILABLE: ['schedule', 'Choose another start time'],
    ORDER_PAYMENT_METHOD_INVALID: ['paymentPlan', 'Choose how much to pay'],
    ORDER_PAYMENT_CHANNEL_INVALID: ['paymentChannel', 'Choose how to pay'],
    ORDER_PAYMENT_CHANNEL_UNAVAILABLE: ['paymentChannel', 'Choose another payment method'],
    ORDER_GCASH_NOT_CONFIGURED: ['paymentChannel', 'Choose another payment method'],
    ORDER_GCASH_SENDER_INVALID: ['paymentReference', 'Check the sender number'],
    ORDER_PAYMENT_REFERENCE_REQUIRED: ['paymentReference', 'Enter the payment reference'],
    ORDER_PAYMENT_PROOF_REQUIRED: ['receipt', 'Upload your receipt'],
    ORDER_PAYMENT_PROOF_INVALID: ['receipt', 'Choose another receipt photo'],
  };

  const selectors = {
    cart: {
      product: '#wizardStep1', fulfillment: '#wizardStep1 .fulfill-card',
      address: '#wizardAddress', contact: '#wizardContact', map: '#checkoutMapCard',
      schedule: '#checkoutCalendarContainer', pickup: '#wizardPickupDate',
      paymentPlan: '#paymentOptionsContainer .payment-method-card',
      paymentChannel: '#orderPaymentChannelSection .payment-channel-card:not(:disabled)',
      paymentReference: '#wizardGcashSenderNumber', receipt: '#gcashProofWizard',
    },
    direct: {
      product: '#wizardHpOptions', fulfillment: '#productOrderModal .fulfill-card',
      address: '#wizardAddress', contact: '#wizardContact', map: '#wizardMap',
      schedule: '#checkoutCalendarContainer', pickup: '#wizardPickupDate',
      paymentPlan: '#paymentOptionsContainer .payment-method-card',
      paymentChannel: '#directPaymentChannelSection .payment-channel-card:not(:disabled)',
      paymentReference: '#wizardGcashSenderNumber', receipt: '#wizardGcashProof',
    },
  };

  function issueFor(data, mode) {
    const entry = errors[data?.code];
    if (!entry || !selectors[mode]) return null;
    const [field, title] = entry;
    const step = mode === 'cart'
      ? (field === 'product' || field === 'fulfillment' ? 1 : ['address', 'contact', 'map', 'schedule', 'pickup'].includes(field) ? 2 : 3)
      : (field === 'product' ? 1 : field === 'fulfillment' ? 2 : ['address', 'contact', 'map', 'schedule', 'pickup'].includes(field) ? 3 : 4);
    return {
      step,
      title,
      message: String(data.error || 'Check this field and try again.'),
      confirmButtonText: 'Fix this',
      focusSelector: selectors[mode][field],
    };
  }

  function isFutureDate(dateKey, now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return false;
    const parsed = new Date(`${dateKey}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateKey) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return dateKey > `${values.year}-${values.month}-${values.day}`;
  }

  window.OrderCheckoutErrors = { issueFor, isFutureDate };
})();
