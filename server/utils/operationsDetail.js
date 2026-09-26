// Photos may be inline multi-megabyte data URLs. Keep them out of the first
// modal response; the protected photo endpoint reads them only on request.
const BOOKING_PHOTO_FIELDS = [
  'paymentProof', 'imageUrl', 'repairPaymentProof', 'proofPhoto', 'arrivalProofUrl',
  'refundProofUrl', 'unitInfo.photos', 'inspection.photos', 'services.photos',
  'services.units.inspection.photos',
];
const ASSIGNMENT_PHOTO_FIELDS = ['startProofUrl', 'arrivalProofUrl', 'proofPhoto', 'damagePhoto'];
const PAYMENT_PHOTO_FIELDS = ['proofUrl', 'customerPhotoUrl', 'remittanceProofUrl', 'refundProofUrl', 'customerSignature'];
const ORDER_PHOTO_FIELDS = ['gcashProofUrl', 'arrivalProofUrl', 'startProofUrl', 'proofPhoto'];
const exclude = fields => fields.map(field => '-' + field).join(' ');

async function currentAssignment(Assignment, booking, selection = '', populateTechnician = true) {
  const read = filter => {
    const query = Assignment.findOne(filter).select(selection).sort({ createdAt: -1, _id: -1 });
    if (populateTechnician) query.populate('technicianId', 'name userEmail phone user');
    return query.maxTimeMS(8000).lean();
  };
  if (booking.assignmentId) {
    const assigned = await read({ _id: booking.assignmentId, bookingId: booking._id });
    if (assigned) return assigned;
  }
  return read({ bookingId: booking._id });
}

function bookingPhotos(booking, assignment, payments) {
  const photos = [];
  const seen = new Set();
  const add = (src, label) => {
    if (typeof src !== 'string' || !src || seen.has(src)) return;
    seen.add(src); photos.push({ src, label });
  };
  add(booking.paymentProof, 'Customer Payment Proof');
  add(booking.imageUrl, 'Booking Image');
  add(booking.repairPaymentProof, 'Repair Payment Proof');
  add(booking.proofPhoto, 'Proof of Completion');
  if (assignment) {
    add(assignment.startProofUrl, 'Start Work Proof');
    add(assignment.proofPhoto, 'Proof of Completion');
    add(assignment.damagePhoto, 'Damaged Item Photo');
  }
  for (const payment of payments || []) {
    add(payment.proofUrl, 'Payment Proof');
    add(payment.customerPhotoUrl, 'Customer Confirmation Photo');
    add(payment.remittanceProofUrl, 'Remittance Proof');
  }
  for (const src of booking.unitInfo?.photos || []) add(src, 'Unit Photo');
  for (const src of booking.inspection?.photos || []) add(src, 'Inspection Photo');
  for (const service of booking.services || []) {
    for (const src of service.photos || []) add(src, 'Service Photo');
    for (const unit of service.units || []) {
      for (const src of unit.inspection?.photos || []) add(src, 'Inspection Photo');
    }
  }
  return photos;
}

module.exports = {
  BOOKING_PHOTO_FIELDS, ASSIGNMENT_PHOTO_FIELDS, PAYMENT_PHOTO_FIELDS, ORDER_PHOTO_FIELDS,
  exclude, currentAssignment, bookingPhotos,
};
