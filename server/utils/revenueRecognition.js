const Project = require("../models/Project");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const { calculateProjectCustomerPricing } = require("./projectPricing");

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isRepairBooking(booking) {
  return booking?.serviceType === "repair"
    || booking?.serviceType === "mixed"
    || booking?.serviceModel === "RepairService"
    || (booking?.services || []).some((service) => service.type === "repair");
}

async function buildProjectPricingMap(bookings) {
  const bookingIds = (bookings || []).map((booking) => booking._id).filter(Boolean);
  if (!bookingIds.length) return new Map();
  const projects = await Project.find({ bookingId: { $in: bookingIds } })
    .select("bookingId totalUnits completedUnits payment quotationReview repair")
    .lean();
  if (!projects.length) return new Map();
  const projectIds = projects.map((project) => project._id);
  const [workOrders, dailyRows] = await Promise.all([
    WorkOrder.find({ projectId: { $in: projectIds }, status: { $ne: "cancelled" } })
      .select("projectId unitCount completedUnitCount status").lean(),
    DailyAssignment.find({ projectId: { $in: projectIds }, status: { $ne: "skipped" } })
      .select("projectId date completedUnits").lean(),
  ]);
  const bookingMap = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const result = new Map();
  projects.forEach((project) => {
    const projectOrders = workOrders.filter((order) => String(order.projectId) === String(project._id));
    const projectDays = dailyRows.filter((day) => String(day.projectId) === String(project._id));
    const booking = bookingMap.get(String(project.bookingId));
    result.set(String(project.bookingId), {
      projectId: String(project._id),
      pricing: calculateProjectCustomerPricing({ project, booking, workOrders: projectOrders, dailyRows: projectDays }),
    });
  });
  return result;
}

function bookingApprovedValue(booking, projectPricingMap = new Map()) {
  const projectEntry = projectPricingMap.get(String(booking?._id));
  if (projectEntry) return money(projectEntry.pricing.total);
  if (isRepairBooking(booking)) {
    const inspection = money(booking.inspectionFeeTotalCollected || booking.initialCost);
    const approvedRepair = booking?.approval?.status === "approved" ? money(booking?.quotation?.totalCost) : 0;
    return inspection + approvedRepair;
  }
  return money(booking?.totalPrice || booking?.estimatedFee);
}

function acceptedPayment(payment) {
  return ["payment_collected", "waiting_for_remittance", "remitted", "verified", "paid", "partial"].includes(payment?.status);
}

function paymentDate(payment) {
  return payment?.verifiedAt || payment?.completedAt || payment?.collectedAt || payment?.submittedAt;
}

function normalizePaymentMethod(method) {
  const value = String(method || "other").toLowerCase();
  if (["cash", "cod", "cash_onsite", "downpayment"].includes(value)) return "cash";
  if (["bank", "bank_transfer"].includes(value)) return "bank";
  if (["gcash", "gcash_full", "gcash_downpayment"].includes(value)) return "gcash";
  return "other";
}

module.exports = {
  acceptedPayment,
  bookingApprovedValue,
  buildProjectPricingMap,
  isRepairBooking,
  money,
  normalizePaymentMethod,
  paymentDate,
};
