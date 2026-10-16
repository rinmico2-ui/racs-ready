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

function isRepairBooking(booking) { return require('./bookingReportValue').hasRepair(booking); }

function resolveBookedValue(booking) {
  return require('./bookingReportValue').bookingReportValue(booking);
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
  if (ratingByBooking.has(String(booking?._id))) {
    const canonical = Number(ratingByBooking.get(String(booking?._id)));
    return canonical >= 1 && canonical <= 5 ? canonical : 0;
  }
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
    const repair = line.type === 'repair';
    const approved = line.approval?.status === 'approved' || (!line.approval?.status && booking.approval?.status === 'approved');
    const explicitRevenue = repair
      ? finitePositive(line.initialCost ?? line.unitPrice) * quantity + (approved ? finitePositive(line.quotation?.totalCost) : 0)
      : require('./transactionDiscounts').serviceLineValue(line);
    return { line, quantity, explicitRevenue };
  });
  // An overall repair quotation belongs to the repair lines. It must not be
  // spread onto an unrelated core service in the same booking.
  const repairs = normalized.filter(row => row.line.type === 'repair');
  if (repairs.length) {
    const itemQuotes = repairs.reduce((sum, row) => sum + (row.line.approval?.status === 'approved' || (!row.line.approval?.status && booking.approval?.status === 'approved') ? finitePositive(row.line.quotation?.totalCost) : 0), 0);
    const finalRepair = finitePositive(booking.totalFinalCost) || finitePositive(booking.finalCost)
      || itemQuotes || (booking.approval?.status === 'approved' ? finitePositive(booking.quotation?.totalCost) : 0);
    const inspection = finitePositive(booking.inspectionFeeAmount) + finitePositive(booking.inspectionFeeDistanceFare)
      || finitePositive(booking.inspectionFeeTotalCollected)
      || repairs.reduce((sum, row) => sum + finitePositive(row.line.initialCost ?? row.line.unitPrice) * row.quantity, 0)
      || finitePositive(booking.initialCost);
    const repairBase = repairs.reduce((sum, row) => sum + row.explicitRevenue, 0);
    const repairUnits = repairs.reduce((sum, row) => sum + row.quantity, 0);
    repairs.forEach(row => { row.explicitRevenue = inspection + finalRepair > 0
      ? (inspection + finalRepair) * (repairBase ? row.explicitRevenue / repairBase : row.quantity / repairUnits) : 0; });
  }
  const core = normalized.filter(row => row.line.type !== 'repair');
  const coreTotal = core.reduce((sum, row) => sum + row.explicitRevenue, 0);
  if (coreTotal > 0 && finitePositive(booking.discount)) {
    const discounted = Math.max(0, coreTotal - finitePositive(booking.discount));
    core.forEach(row => { row.explicitRevenue *= discounted / coreTotal; });
  }
  const explicitTotal = normalized.reduce((sum, row) => sum + row.explicitRevenue, 0);
  const targetRevenue = finitePositive(bookingRevenue);
  const residual = Math.max(0, targetRevenue - explicitTotal);
  const totalQuantity = normalized.reduce((sum, row) => sum + row.quantity, 0) || 1;

  return normalized.map((row) => ({
    ...row.line,
    quantity: row.quantity,
    allocatedRevenue: explicitTotal > targetRevenue ? row.explicitRevenue * targetRevenue / explicitTotal : row.explicitRevenue + residual * (row.quantity / totalQuantity),
  }));
}

const reportDates = require('./reportingDates');
const localDateKey = reportDates.dateKey;

function getWeekBounds(anchorDate = new Date(), weeksAgo = 0) {
  const endExclusive = reportDates.addDays(reportDates.startOfDay(anchorDate), 1 - Math.max(0, weeksAgo) * 7);
  const start = reportDates.addDays(endExclusive, -7);
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
  const anchor = reportDates.startOfDay(anchorDate);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = reportDates.addDays(anchor, -offset);
    const key = localDateKey(date);
    const values = countByDay.get(key) || { bookings: 0, completed: 0 };
    rows.push({
      day: date.toLocaleDateString("en-PH", { weekday: "short", timeZone: reportDates.TIME_ZONE }),
      date: key,
      bookings: values.bookings,
      completed: values.completed,
    });
  }
  return rows;
}

function buildWeekdayForecast(bookings = [], startDate, endDate) {
  const start = reportDates.startOfDay(startDate);
  const end = reportDates.startOfDay(endDate);
  const counts = new Map();
  bookings.forEach((booking) => {
    const key = localDateKey(booking && booking.createdAt);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });

  const weekdayTotals = Array(7).fill(0);
  const weekdaySamples = Array(7).fill(0);
  for (let cursor = new Date(start); cursor <= end; cursor = reportDates.addDays(cursor, 1)) {
    const day = new Date(cursor.getTime() + 8 * 3600000).getUTCDay();
    weekdayTotals[day] += counts.get(localDateKey(cursor)) || 0;
    weekdaySamples[day] += 1;
  }

  return Array.from({ length: 7 }, (_, index) => {
    const date = reportDates.addDays(end, index + 1);
    const day = new Date(date.getTime() + 8 * 3600000).getUTCDay();
    return {
      day: date.toLocaleDateString("en-PH", { weekday: "short", timeZone: reportDates.TIME_ZONE }),
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
