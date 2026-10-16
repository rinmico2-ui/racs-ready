'use strict';

const text = value => typeof value === 'string' ? value.trim() : '';
function issueDescription(booking) {
  const issues = [booking?.issueDescription, booking?.unitInfo?.problemDescription,
    ...(Array.isArray(booking?.repairIssues) ? booking.repairIssues : [booking?.repairIssues]),
    ...(booking?.services || []).flatMap(item => [item.problemDescription, item.repairIssue, item.issueDescription])];
  return [...new Set(issues.map(text).filter(Boolean))].join('\n');
}

function context(payment, { booking, order, project, collector } = {}) {
  // Installation bookings mirror an order; the payment belongs to the order.
  const source = order || booking || project;
  const reference = order?.orderReference || booking?.bookingReference || project?.projectReference || '-';
  const customer = order?.customer || booking?.customer || project?.customer || {};
  return {
    sourceType: order ? 'order' : project ? 'project' : 'service',
    bookingReference: reference, bookingStatus: source?.status || '-',
    customerName: customer.name || '-', customerEmail: customer.email || '-', customerPhone: customer.phone || '-',
    serviceName: order ? (order.items || []).map(item => `${item.quantity || 1} × ${item.modelLine || 'Aircon'}`).join(', ')
      : [...new Set([booking?.service?.name, ...(booking?.services || []).map(item => item.name)].filter(Boolean))].join(', ') || project?.title || 'Service',
    issueDescription: issueDescription(booking),
    specialInstructions: order?.delivery?.notes || booking?.paymentNotes || '',
    bookingDate: booking?.bookingDate || order?.delivery?.preferredDate || order?.pickupDate || null,
    bookingCreatedAt: source?.createdAt || null,
    bookingPaymentMethod: source?.paymentMethod || null,
    bookingPaymentStatus: source?.paymentStatus || null,
    paymentChannel: payment.method || source?.paymentChannel || null,
    collectedByName: payment.collectedByName || collector?.name || '',
    collectionNotes: (payment.events || []).filter(event => ['payment_collected', 'waiting_for_remittance', 'collected'].includes(event.status))
      .map(event => text(event.note)).filter(Boolean).join('\n') || text(payment.notes),
  };
}

module.exports = { issueDescription, context };
