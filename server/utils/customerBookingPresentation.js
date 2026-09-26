"use strict";

const { computeBookingEndDateTime } = require("./bookingPolicy");

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function positiveQuantity(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRepairBooking(booking = {}) {
  const serviceType = text(booking.serviceType).toLowerCase();
  const serviceModel = text(booking.serviceModel).toLowerCase();
  const status = text(booking.status).toLowerCase();
  const hasRepairItem = Array.isArray(booking.services)
    && booking.services.some(item => text(item?.type).toLowerCase() === "repair");
  const hasCoreItem = Array.isArray(booking.services)
    && booking.services.some(item => text(item?.type).toLowerCase() === "core");
  const hasRepairProblem = Boolean(text(booking.unitInfo?.problemDescription || booking.issueDescription || booking.repairIssues));
  if (serviceType === "core" && serviceModel !== "repairservice" && !hasRepairItem && !status.startsWith("repair_")) {
    if (serviceModel === "coreservice" || hasCoreItem || !hasRepairProblem) return false;
  }
  return serviceType === "repair"
    || serviceType === "mixed"
    || serviceModel === "repairservice"
    || status.startsWith("repair_")
    || hasRepairItem
    || (!serviceModel && hasRepairProblem);
}

function repairItem(item = {}, booking = {}, index = 0) {
  const unitInfo = index === 0 && booking.unitInfo ? booking.unitInfo : {};
  const unitType = text(
    item.unitType
      || item.applianceTypeName
      || item.airconTypeName
      || item.unitCategory
      || unitInfo.unitType
      || booking.applianceTypeName
      || booking.applianceType,
  );
  const brand = text(item.brand || unitInfo.brand || booking.brand);
  const model = text(item.model || unitInfo.model);
  const problemDescription = text(
    item.problemDescription
      || item.repairIssue
      || unitInfo.problemDescription
      || booking.issueDescription
      || booking.repairIssues,
  );
  const photos = [
    ...(Array.isArray(item.photos) ? item.photos : []),
    ...(index === 0 && Array.isArray(unitInfo.photos) ? unitInfo.photos : []),
  ].map(text).filter(Boolean).filter((url, photoIndex, all) => all.indexOf(url) === photoIndex);

  return {
    _id: item._id || null,
    name: text(item.name) || [unitType, "Repair"].filter(Boolean).join(" ") || "Repair Service",
    unitType: unitType || "Not recorded",
    brand: brand || "Not recorded",
    model,
    problemDescription: problemDescription || "Not recorded",
    quantity: positiveQuantity(item.quantity, positiveQuantity(booking.quantity)),
    status: text(item.status || booking.status) || "pending",
    phase: text(item.phase),
    schedule: item.schedule || null,
    photos,
    quotation: item.quotation || null,
  };
}

function customerRepairDetails(booking = {}) {
  if (!isRepairBooking(booking)) return null;

  const services = Array.isArray(booking.services) ? booking.services.filter(Boolean) : [];
  const repairServices = services.filter(item => text(item.type).toLowerCase() === "repair");
  const sourceItems = repairServices.length
    ? repairServices
    : (text(booking.serviceType).toLowerCase() === "repair" ? services : []);
  const items = sourceItems.length
    ? sourceItems.map((item, index) => repairItem(item, booking, index))
    : [repairItem({}, booking, 0)];

  return {
    items,
    applianceCount: items.length,
    unitCount: items.reduce((sum, item) => sum + item.quantity, 0),
    primary: items[0],
  };
}

function enrichCustomerBooking(booking = {}) {
  const presented = { ...booking };
  const repairDetails = customerRepairDetails(presented);
  if (repairDetails) presented.customerRepairDetails = repairDetails;
  return presented;
}

function isUnpaidAftercareMaintenance(booking = {}) {
  const createdFromAftercare = booking.maintenance?.isMaintenance
    && (booking.maintenance?.paymentOnSite === true
      || text(booking.paymentNotes).startsWith("Maintenance requested from Aftercare"));
  if (!createdFromAftercare) return false;
  const settled = ["paid", "verified", "partial", "payment_collected", "remitted"]
    .includes(text(booking.paymentStatus).toLowerCase());
  const paymentSubmitted = Array.isArray(booking.payments)
    && booking.payments.some(payment => Number(payment?.amount) > 0
      && !["rejected", "refunded", "failed"].includes(text(payment?.status).toLowerCase()));
  return Number(booking.amountPaid || 0) <= 0 && !settled && !paymentSubmitted;
}

// Fields used by operations, fraud review, or payment verification must never be
// included in the customer history payload. Keeping this boundary here avoids
// coupling the public page to the full BookingService persistence model.
const CUSTOMER_HIDDEN_FIELDS = [
  "paymentProof",
  "paymentReference",
  "gcashNumber",
  "technicianAssistant",
  "statusHistory",
  "cancellationHistory",
  "internalNotes",
  "adminNotes",
];

function presentCustomerBooking(booking = {}) {
  const presented = enrichCustomerBooking(booking);
  // Customer pages must compare against the same Manila service window used
  // by the server's scheduling and lifecycle rules.
  const scheduleWindowEnd = computeBookingEndDateTime(presented);
  presented.scheduleWindowEndAt = scheduleWindowEnd ? scheduleWindowEnd.toISOString() : null;
  CUSTOMER_HIDDEN_FIELDS.forEach((field) => delete presented[field]);
  if (isUnpaidAftercareMaintenance(presented)) {
    presented.paymentDetailsDeferred = true;
    ["paymentMethod", "paymentChannel", "paymentStatus", "downpaymentPercentage",
      "downpaymentAmount", "amountPaid", "balanceAmount", "paymentNotes", "payments"]
      .forEach((field) => delete presented[field]);
  }

  if (Array.isArray(presented.payments)) {
    const customerPaymentFields = [
      "_id", "amount", "method", "type", "status", "reference",
      "submittedAt", "verifiedAt", "completedAt", "refundedAt",
      "refundAmount", "refundStatus",
    ];
    presented.payments = presented.payments.map((payment) => Object.fromEntries(
      customerPaymentFields
        .filter((field) => payment && payment[field] !== undefined)
        .map((field) => [field, payment[field]]),
    ));
  }

  if (Array.isArray(presented.services)) {
    presented.services = presented.services.map((service) => {
      const safeService = { ...service };
      delete safeService.statusHistory;
      delete safeService.technicianNotes;
      return safeService;
    });
  }

  return presented;
}

module.exports = {
  customerRepairDetails,
  enrichCustomerBooking,
  isRepairBooking,
  isUnpaidAftercareMaintenance,
  presentCustomerBooking,
};
