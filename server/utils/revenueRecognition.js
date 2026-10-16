const Project = require("../models/Project");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const { calculateProjectCustomerPricing } = require("./projectPricing");

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isRepairBooking(booking) { return require('./bookingReportValue').hasRepair(booking); }

async function buildProjectPricingMap(bookings) {
  const bookingIds = (bookings || []).map((booking) => booking._id).filter(Boolean);
  if (!bookingIds.length) return new Map();
  const projects = await Project.find({ ...require('./reportingScope').reportableMatch(), bookingId: { $in: bookingIds } })
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
  const workOrdersByProject = new Map();
  const dailyRowsByProject = new Map();
  workOrders.forEach((order) => {
    const key = String(order.projectId);
    if (!workOrdersByProject.has(key)) workOrdersByProject.set(key, []);
    workOrdersByProject.get(key).push(order);
  });
  dailyRows.forEach((row) => {
    const key = String(row.projectId);
    if (!dailyRowsByProject.has(key)) dailyRowsByProject.set(key, []);
    dailyRowsByProject.get(key).push(row);
  });
  const result = new Map();
  projects.forEach((project) => {
    const projectKey = String(project._id);
    const projectOrders = workOrdersByProject.get(projectKey) || [];
    const projectDays = dailyRowsByProject.get(projectKey) || [];
    const booking = bookingMap.get(String(project.bookingId));
    result.set(String(project.bookingId), {
      projectId: String(project._id),
      pricing: calculateProjectCustomerPricing({ project, booking, workOrders: projectOrders, dailyRows: projectDays }),
    });
  });
  return result;
}

function bookingApprovedValue(booking, projectPricingMap = new Map()) {
  if (booking?.sourceOrderId) return 0; // Included installation is recognized with its product purchase.
  const projectEntry = projectPricingMap.get(String(booking?._id));
  if (projectEntry) return money(projectEntry.pricing.total);
  return require('./bookingReportValue').bookingReportValue(booking);
}

function acceptedPayment(payment) {
  return !payment?.testDataExcludedAt && require('./enterpriseRevenue').ACCEPTED_PAYMENT_STATUSES.has(payment?.status);
}

function paymentDate(payment) {
  return require('./enterpriseRevenue').collectionDate(payment);
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
