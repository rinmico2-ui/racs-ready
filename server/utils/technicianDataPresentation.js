"use strict";

// Technician responses are an operational view, not a copy of the persistence
// model. Keep payment-verification evidence and customer account data inside
// the admin/customer boundary even when a technician is assigned to the job.
const TECHNICIAN_BOOKING_EXCLUDE_SELECT = [
  "-paymentProof",
  "-paymentReference",
  "-gcashNumber",
  "-customer.email",
  "-customerAccountAccess",
  "-adminNotes",
  "-internalNotes",
].join(" ");

const TECHNICIAN_ORDER_EXCLUDE_SELECT = [
  "-paymentId",
  "-paymentReference",
  "-gcashNumber",
  "-gcashProofUrl",
  "-customer.email",
  "-customerAccountAccess",
  "-createdBy",
  "-checkoutRequestId",
  "-refundReason",
].join(" ");

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === "function" ? value.toObject() : value;
}

function technicianCustomer(customer) {
  if (!customer || typeof customer !== "object") return customer;
  return {
    ...(customer.name ? { name: customer.name } : {}),
    ...(customer.phone ? { phone: customer.phone } : {}),
    ...(customer.address ? { address: customer.address } : {}),
  };
}

function presentTechnicianBooking(value) {
  const source = plain(value);
  if (!source || typeof source !== "object") return source;
  const booking = { ...source };

  delete booking.paymentProof;
  delete booking.paymentReference;
  delete booking.gcashNumber;
  delete booking.customerAccountAccess;
  delete booking.adminNotes;
  delete booking.internalNotes;
  delete booking.payments;

  if (booking.customer) booking.customer = technicianCustomer(booking.customer);
  return booking;
}

function presentTechnicianOrder(value) {
  const source = plain(value);
  if (!source || typeof source !== "object") return source;
  const order = { ...source };

  delete order.paymentId;
  delete order.paymentReference;
  delete order.gcashNumber;
  delete order.gcashProofUrl;
  delete order.customerAccountAccess;
  delete order.createdBy;
  delete order.checkoutRequestId;
  delete order.refundReason;

  if (order.customer) order.customer = technicianCustomer(order.customer);
  return order;
}

function presentTechnicianPayment(value) {
  const payment = plain(value) || {};
  const allowed = [
    "_id",
    "amount",
    "method",
    "type",
    "status",
    "collectedByName",
    "collectedAt",
    "submittedAt",
    "verifiedAt",
    "completedAt",
    "refundAmount",
    "refundStatus",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => payment[key] !== undefined)
      .map((key) => [key, payment[key]]),
  );
}

const TECHNICIAN_RESPONSE_PRIVATE_KEYS = new Set([
  "customerEmail",
  "customerAccountAccess",
  "paymentProof",
  "repairPaymentProof",
  "paymentReference",
  "gcashNumber",
  "gcashProofUrl",
  "adminNotes",
  "internalNotes",
  "checkoutRequestId",
]);

/**
 * Last-line response policy for the technician API. Route-level projections
 * remain the primary control; this recursive presenter prevents a future
 * populate or newly-added assignment field from bypassing that boundary.
 */
function presentTechnicianApiPayload(value, parentKey = "") {
  const source = plain(value);
  if (Array.isArray(source)) {
    if (parentKey === "payments") return source.map(presentTechnicianPayment);
    return source.map((item) => presentTechnicianApiPayload(item, parentKey));
  }
  if (
    !source
    || typeof source !== "object"
    || source instanceof Date
    || Buffer.isBuffer(source)
    || source._bsontype
  ) return source;

  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (TECHNICIAN_RESPONSE_PRIVATE_KEYS.has(key)) continue;
    if (key === "email" && ["customer", "customerId"].includes(parentKey)) continue;
    result[key] = presentTechnicianApiPayload(item, key);
  }
  return result;
}

module.exports = {
  TECHNICIAN_BOOKING_EXCLUDE_SELECT,
  TECHNICIAN_ORDER_EXCLUDE_SELECT,
  presentTechnicianBooking,
  presentTechnicianOrder,
  presentTechnicianPayment,
  presentTechnicianApiPayload,
};
