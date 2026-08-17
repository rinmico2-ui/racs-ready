function positiveMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function distinctProductiveDays(dailyRows) {
  const keys = new Set(
    (dailyRows || [])
      .filter(row => Number(row.completedUnits || 0) > 0 && row.date)
      .map(row => new Date(row.date).toDateString())
  );
  return Math.max(1, keys.size);
}

function bookedCoreServiceCharge(project, booking, totalUnits) {
  const services = Array.isArray(booking?.services) ? booking.services : [];
  if (services.length) {
    return services.reduce((sum, item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = positiveMoney(item.unitPrice);
      return sum + (unitPrice ? unitPrice * quantity : positiveMoney(item.totalPrice));
    }, 0);
  }
  const unitPrice = positiveMoney(booking?.servicePrice || booking?.service?.basePrice);
  return unitPrice * Math.max(1, Number(totalUnits || booking?.quantity || 1));
}

/**
 * Customer-facing large-project pricing.
 * - Service scope is priced from an approved quote or booked per-unit price.
 * - Travel is one site-visit fare per distinct productive onsite day, not per tech.
 * - Crew size and labor days never create an additional customer labor charge.
 */
function calculateProjectCustomerPricing({ project, booking, workOrders = [], dailyRows = [] }) {
  const trackedTotal = workOrders.reduce((sum, order) => sum + Number(order.unitCount || 0), 0);
  const trackedDone = workOrders.reduce((sum, order) => sum + Number(order.completedUnitCount || 0), 0);
  const totalUnits = trackedTotal || Number(project?.totalUnits || booking?.quantity || 0);
  const completedUnits = workOrders.length ? trackedDone : Number(project?.completedUnits || 0);
  const daysWorked = distinctProductiveDays(dailyRows);
  const travelFarePerDay = positiveMoney(booking?.travelFare);
  const travelFare = travelFarePerDay * daysWorked;
  const serviceType = booking?.serviceType || project?.repair?.serviceType || "core";
  let serviceCharge = 0;
  let pricingSource = "";

  const approvedProjectQuote = project?.quotationReview?.status === "approved"
    ? positiveMoney(project.quotationReview.totalAmount)
    : 0;
  if (approvedProjectQuote) {
    serviceCharge = approvedProjectQuote;
    pricingSource = "Approved project quotation";
  } else if (serviceType === "repair" || serviceType === "mixed") {
    const projectRepairQuote = project?.repair?.quotation?.approvedAt
      ? positiveMoney(project.repair.quotation.totalCost)
      : 0;
    const bookingRepairQuote = booking?.approval?.status === "approved"
      ? positiveMoney(booking.quotation?.totalCost)
      : 0;
    serviceCharge = projectRepairQuote || bookingRepairQuote;
    if (serviceCharge) pricingSource = "Approved repair quotation";
  } else {
    serviceCharge = bookedCoreServiceCharge(project, booking, totalUnits);
    if (serviceCharge) pricingSource = "Booked per-unit service pricing";
  }

  // A deliberately stored project total is a fallback for legacy/admin-priced
  // records only when no reproducible quote or booked unit price exists.
  const storedTotal = positiveMoney(project?.payment?.totalAmount);
  if (!serviceCharge && storedTotal) {
    serviceCharge = Math.max(0, storedTotal - travelFare);
    pricingSource = "Approved project total";
  }

  const total = serviceCharge + travelFare;
  const alreadyPaid = Math.max(
    positiveMoney(project?.payment?.amountPaid),
    positiveMoney(booking?.amountPaid),
    positiveMoney(booking?.downpaymentAmount)
  );
  return {
    totalUnits,
    completedUnits,
    remainingUnits: Math.max(0, totalUnits - completedUnits),
    daysWorked,
    travelFarePerDay,
    travelFare,
    serviceCharge,
    total,
    alreadyPaid,
    balance: Math.max(0, total - alreadyPaid),
    pricingSource,
    pricingReady: serviceCharge > 0,
    serviceType,
  };
}

module.exports = { calculateProjectCustomerPricing, distinctProductiveDays };
