const ACCEPTED_PAYMENT_STATUSES = new Set([
  "payment_collected",
  "waiting_for_remittance",
  "remitted",
  "verified",
  "paid",
  "partial",
  "refunded",
]);

const RECOGNIZED_BOOKING_STATUSES = new Set([
  "completed",
  "repair_completed",
  "closed",
]);

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function inRange(value, startDate, endDate) {
  const date = value ? new Date(value) : null;
  return Boolean(date && !Number.isNaN(date.getTime()) && date >= startDate && date <= endDate);
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

function parseReportDate(value, endOfDay = false) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return new Date(NaN);
    return parsed;
  }
  return new Date(value);
}

function collectionDate(payment) {
  return payment?.verifiedAt || payment?.completedAt || payment?.collectedAt || payment?.submittedAt || null;
}

function refundDate(payment) {
  return payment?.refundedAt || (money(payment?.refundAmount) > 0 ? collectionDate(payment) : null);
}

function paymentAmounts(payment) {
  const gross = ACCEPTED_PAYMENT_STATUSES.has(payment?.status) ? money(payment?.amount) : 0;
  const refunded = Math.min(gross, money(payment?.refundAmount));
  return { gross, refunded, net: Math.max(0, gross - refunded) };
}

function summarizePaymentLedger(payments = [], options = {}) {
  const startDate = options.startDate || new Date(0);
  const endDate = options.endDate || new Date(8640000000000000);
  const normalizeMethod = options.normalizeMethod || ((value) => String(value || "other").toLowerCase());
  const byMethod = { gcash: 0, cash: 0, bank: 0, other: 0 };
  const grossByMethod = { gcash: 0, cash: 0, bank: 0, other: 0 };
  const refundsByMethod = { gcash: 0, cash: 0, bank: 0, other: 0 };
  let grossCollections = 0;
  let refunds = 0;
  let collectionCount = 0;
  let refundCount = 0;

  payments.forEach((payment) => {
    const amounts = paymentAmounts(payment);
    const method = normalizeMethod(payment?.method);
    const methodKey = Object.prototype.hasOwnProperty.call(byMethod, method) ? method : "other";
    if (amounts.gross > 0 && inRange(collectionDate(payment), startDate, endDate)) {
      grossCollections += amounts.gross;
      byMethod[methodKey] += amounts.gross;
      grossByMethod[methodKey] += amounts.gross;
      collectionCount += 1;
    }
    if (amounts.refunded > 0 && inRange(refundDate(payment), startDate, endDate)) {
      refunds += amounts.refunded;
      byMethod[methodKey] -= amounts.refunded;
      refundsByMethod[methodKey] += amounts.refunded;
      refundCount += 1;
    }
  });

  return {
    grossCollections,
    refunds,
    netCollections: grossCollections - refunds,
    collectionCount,
    refundCount,
    byMethod,
    grossByMethod,
    refundsByMethod,
  };
}

function netPaymentsThrough(payments = [], endDate = new Date(8640000000000000)) {
  return payments.reduce((sum, payment) => {
    if (!inRange(collectionDate(payment), new Date(0), endDate)) return sum;
    const amounts = paymentAmounts(payment);
    const refundedByEnd = amounts.refunded > 0 && inRange(refundDate(payment), new Date(0), endDate)
      ? amounts.refunded
      : 0;
    return sum + Math.max(0, amounts.gross - refundedByEnd);
  }, 0);
}

function bookingCompletionDate(booking) {
  if (booking?.completedAt) return booking.completedAt;
  if (booking?.repairCompletion?.completedAt) return booking.repairCompletion.completedAt;
  if (booking?.slaTracking?.resolutionAt) return booking.slaTracking.resolutionAt;
  const completedHistory = [...(booking?.statusHistory || [])].reverse().find((entry) =>
    ["completed", "repair_completed", "closed"].includes(entry?.toStatus || entry?.status)
  );
  return completedHistory?.timestamp || completedHistory?.changedAt || booking?.updatedAt || null;
}

function orderCompletionDate(order) {
  if (order?.completedAt) return order.completedAt;
  const completedHistory = [...(order?.statusHistory || [])].reverse().find((entry) => entry?.status === "completed");
  return completedHistory?.timestamp || (order?.status === "completed" ? order?.updatedAt : null);
}

function isRecognizedBooking(booking, startDate, endDate) {
  return RECOGNIZED_BOOKING_STATUSES.has(booking?.status)
    && inRange(bookingCompletionDate(booking), startDate, endDate);
}

function isRecognizedOrder(order, startDate, endDate) {
  return order?.status === "completed" && inRange(orderCompletionDate(order), startDate, endDate);
}

function summarizeOrderCosts(orders = [], inventoryItems = []) {
  const costById = new Map(inventoryItems.map((item) => [String(item._id), money(item.costPrice)]));
  let totalCost = 0;
  let totalUnits = 0;
  let costedUnits = 0;

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const unitCost = costById.get(String(item.inventoryId || "")) || 0;
      totalUnits += quantity;
      if (unitCost > 0) {
        costedUnits += quantity;
        totalCost += unitCost * quantity;
      }
    });
  });

  return {
    totalCost,
    totalUnits,
    costedUnits,
    coveragePercent: totalUnits > 0 ? (costedUnits / totalUnits) * 100 : 100,
    basis: "Current inventory cost; historical order items do not snapshot cost",
  };
}

module.exports = {
  ACCEPTED_PAYMENT_STATUSES,
  RECOGNIZED_BOOKING_STATUSES,
  bookingCompletionDate,
  collectionDate,
  inRange,
  isRecognizedBooking,
  isRecognizedOrder,
  localDateKey,
  money,
  netPaymentsThrough,
  orderCompletionDate,
  paymentAmounts,
  parseReportDate,
  refundDate,
  summarizeOrderCosts,
  summarizePaymentLedger,
};
