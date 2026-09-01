const COMPLETED_STATUSES = new Set(["completed", "repair_completed", "closed"]);
const CANCELLED_STATUSES = new Set(["cancelled", "rejected", "repair_declined", "no-show"]);
const IN_PROGRESS_STATUSES = new Set([
  "on-the-way",
  "arrived",
  "waiting-for-customer",
  "no-show-reported",
  "in-progress",
  "inspection_in_progress",
  "repair_in_progress",
]);

function normalizeStatus(value) {
  return String(value || "pending").trim().toLowerCase();
}

function isRepairBooking(booking) {
  const normalizedType = value => String(value || "").trim().toLowerCase();
  return normalizedType(booking && booking.serviceType) === "repair"
    || normalizedType(booking && booking.serviceModel) === "repairservice"
    || (Array.isArray(booking && booking.services) && booking.services.some(service => normalizedType(service.type) === "repair"))
    || Boolean(booking && (
      booking.workOrderNumber
      || booking.repairIssues
      || booking.issueDescription
      || booking.unitInfo?.problemDescription
      || booking.inspection?.completedAt
      || booking.diagnosis?.completedAt
      || booking.quotation?.createdAt
      || booking.repairPaymentCollected
      || Number(booking.repairPaymentAmount) > 0
      || Number(booking.inspectionFeeTotalCollected) > 0
    ));
}

function resolveBookedValue(booking) {
  if (!booking) return 0;
  if (isRepairBooking(booking)) {
    const inspection = Number(booking.inspectionFeeAmount || 0) + Number(booking.inspectionFeeDistanceFare || 0)
      || Number(booking.inspectionFeeTotalCollected || 0);
    const repair = Number(booking.totalFinalCost) || Number(booking.finalCost)
      || (normalizeStatus(booking.approval?.status) === "approved" ? Number(booking.quotation?.totalCost) : 0);
    const tracked = inspection + repair;
    if (tracked > 0) return tracked;
    return Number(booking.amountPaid) || Number(booking.totalPrice) || Number(booking.estimatedFee) || Number(booking.initialCost) || 0;
  }
  return Number(booking.totalPrice) || Number(booking.estimatedFee) || Number(booking.amountPaid) || Number(booking.servicePrice) || 0;
}

function statusGroup(value) {
  const status = normalizeStatus(value);
  if (COMPLETED_STATUSES.has(status)) return "completed";
  if (CANCELLED_STATUSES.has(status)) return "cancelled";
  if (IN_PROGRESS_STATUSES.has(status)) return "in_progress";
  return "pending";
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function ratingForBooking(booking, ratingByBooking = new Map()) {
  const embedded = finitePositive(booking && booking.customerRating);
  if (embedded >= 1 && embedded <= 5) return embedded;
  const external = finitePositive(ratingByBooking.get(String(booking && booking._id)));
  return external >= 1 && external <= 5 ? external : 0;
}

function summarizeLifecycle(bookings = []) {
  const summary = { completed: 0, cancelled: 0, inProgress: 0, pending: 0 };
  bookings.forEach((booking) => {
    const group = statusGroup(booking && booking.status);
    if (group === "in_progress") summary.inProgress += 1;
    else summary[group] += 1;
  });
  return summary;
}

function allocateServiceRevenue(booking, bookingRevenue) {
  const lines = Array.isArray(booking && booking.services) && booking.services.length
    ? booking.services
    : [{
      name: booking && booking.service && booking.service.name,
      type: booking && booking.serviceType,
      quantity: booking && booking.quantity,
    }];
  const normalized = lines.map((line) => {
    const quantity = Math.max(1, Number(line.quantity) || 1);
    const explicitRevenue = finitePositive(line.totalPrice)
      || finitePositive(line.finalCost) * quantity
      || finitePositive(line.unitPrice) * quantity;
    return { line, quantity, explicitRevenue };
  });
  const explicitTotal = normalized.reduce((sum, row) => sum + row.explicitRevenue, 0);
  const targetRevenue = finitePositive(bookingRevenue);
  const residual = Math.max(0, targetRevenue - explicitTotal);
  const totalQuantity = normalized.reduce((sum, row) => sum + row.quantity, 0) || 1;

  return normalized.map((row) => ({
    ...row.line,
    quantity: row.quantity,
    allocatedRevenue: row.explicitRevenue + residual * (row.quantity / totalQuantity),
  }));
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getWeekBounds(anchorDate = new Date(), weeksAgo = 0) {
  const endExclusive = new Date(anchorDate);
  endExclusive.setHours(0, 0, 0, 0);
  endExclusive.setDate(endExclusive.getDate() + 1 - (Math.max(0, weeksAgo) * 7));
  const start = new Date(endExclusive);
  start.setDate(start.getDate() - 7);
  return { start, endExclusive };
}

function buildDailyTrend(bookings = [], anchorDate = new Date(), days = 7) {
  const countByDay = new Map();
  bookings.forEach((booking) => {
    const key = localDateKey(booking && booking.createdAt);
    if (!key) return;
    const current = countByDay.get(key) || { bookings: 0, completed: 0 };
    current.bookings += 1;
    if (statusGroup(booking.status) === "completed") current.completed += 1;
    countByDay.set(key, current);
  });

  const rows = [];
  const anchor = new Date(anchorDate);
  anchor.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchor);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const values = countByDay.get(key) || { bookings: 0, completed: 0 };
    rows.push({
      day: date.toLocaleDateString("en-PH", { weekday: "short" }),
      date: key,
      bookings: values.bookings,
      completed: values.completed,
    });
  }
  return rows;
}

function buildWeekdayForecast(bookings = [], startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const counts = new Map();
  bookings.forEach((booking) => {
    const key = localDateKey(booking && booking.createdAt);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });

  const weekdayTotals = Array(7).fill(0);
  const weekdaySamples = Array(7).fill(0);
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const day = cursor.getDay();
    weekdayTotals[day] += counts.get(localDateKey(cursor)) || 0;
    weekdaySamples[day] += 1;
  }

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setDate(date.getDate() + index + 1);
    const day = date.getDay();
    return {
      day: date.toLocaleDateString("en-PH", { weekday: "short" }),
      date: localDateKey(date),
      bookings: weekdaySamples[day]
        ? Math.round((weekdayTotals[day] / weekdaySamples[day]) * 10) / 10
        : 0,
      sampleSize: weekdaySamples[day],
    };
  });
}

module.exports = {
  CANCELLED_STATUSES,
  COMPLETED_STATUSES,
  IN_PROGRESS_STATUSES,
  allocateServiceRevenue,
  buildDailyTrend,
  buildWeekdayForecast,
  getWeekBounds,
  isRepairBooking,
  normalizeStatus,
  ratingForBooking,
  resolveBookedValue,
  statusGroup,
  summarizeLifecycle,
};
