const {
  inRange,
  localDateKey,
  money,
  netPaymentsThrough,
  orderCompletionDate,
  summarizeOrderCosts,
  summarizePaymentLedger,
} = require("./enterpriseRevenue");

const FINAL_PAYMENT_STATUSES = new Set(["paid", "verified", "remitted", "refunded"]);

function growth(current, previous) {
  if (previous > 0) return ((current - previous) / previous) * 100;
  return current > 0 ? 100 : 0;
}

function validOrders(orders = []) {
  return orders.filter(order => order?.status !== "cancelled");
}

function recognizedOrders(orders = [], startDate, endDate) {
  return orders.filter(order => order?.status === "completed" && inRange(orderCompletionDate(order), startDate, endDate));
}

function units(order) {
  return (order?.items || []).reduce((total, item) => total + Math.max(0, Number(item.quantity) || 0), 0);
}

function normalizePaymentMethod(value) {
  const method = String(value || "other").toLowerCase();
  if (method.includes("gcash")) return "gcash";
  if (["cod", "cash", "cash_onsite"].includes(method)) return "cash";
  if (["bank", "paymongo"].includes(method)) return "bank";
  return "other";
}

function buildBuckets(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  const dayCount = Math.floor((end - start) / 86400000) + 1;
  const mode = dayCount <= 31 ? "day" : dayCount <= 120 ? "week" : "month";
  const rows = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const bucketStart = new Date(cursor);
    let bucketEnd;
    if (mode === "day") {
      bucketEnd = new Date(cursor);
      bucketEnd.setHours(23, 59, 59, 999);
      cursor.setDate(cursor.getDate() + 1);
    } else if (mode === "week") {
      bucketEnd = new Date(cursor);
      bucketEnd.setDate(bucketEnd.getDate() + 6);
      bucketEnd.setHours(23, 59, 59, 999);
      cursor.setDate(cursor.getDate() + 7);
    } else {
      bucketEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    if (bucketEnd > end) bucketEnd = new Date(end);
    const label = mode === "month"
      ? bucketStart.toLocaleDateString("en-PH", { month: "short", year: "2-digit" })
      : mode === "week"
        ? `${bucketStart.toLocaleDateString("en-PH", { month: "short", day: "numeric" })}-${bucketEnd.toLocaleDateString("en-PH", { month: "short", day: "numeric" })}`
        : bucketStart.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
    rows.push({
      key: localDateKey(bucketStart),
      label,
      start: bucketStart,
      end: bucketEnd,
      orders: 0,
      bookedValue: 0,
      recognizedRevenue: 0,
      netCollections: 0,
      refunds: 0,
    });
  }
  return rows;
}

function buildTrend(cohortOrders, completionOrders, payments, startDate, endDate) {
  const buckets = buildBuckets(startDate, endDate);
  buckets.forEach(bucket => {
    const placed = cohortOrders.filter(order => inRange(order.createdAt, bucket.start, bucket.end));
    const completed = completionOrders.filter(order => inRange(orderCompletionDate(order), bucket.start, bucket.end));
    const ledger = summarizePaymentLedger(payments, {
      startDate: bucket.start,
      endDate: bucket.end,
      normalizeMethod: normalizePaymentMethod,
    });
    bucket.orders = placed.length;
    bucket.bookedValue = validOrders(placed).reduce((sum, order) => sum + money(order.total), 0);
    bucket.recognizedRevenue = completed.reduce((sum, order) => sum + money(order.total), 0);
    bucket.netCollections = ledger.netCollections;
    bucket.refunds = ledger.refunds;
  });
  return buckets.map(bucket => ({ ...bucket, start: bucket.start.toISOString(), end: bucket.end.toISOString() }));
}

function productRankings(orders = []) {
  const products = new Map();
  const brands = new Map();
  orders.forEach(order => {
    (order.items || []).forEach(item => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const revenue = money(item.totalPrice) || money(item.unitPrice) * quantity;
      const name = [item.brand, item.modelLine, item.capacity && `${item.capacity}${item.capacityUnit || " HP"}`]
        .filter(Boolean).join(" ") || "Unnamed product";
      const product = products.get(name) || { name, units: 0, revenue: 0, orders: 0 };
      product.units += quantity;
      product.revenue += revenue;
      product.orders += 1;
      products.set(name, product);

      const brandName = String(item.brand || "Unspecified");
      const brand = brands.get(brandName) || { name: brandName, units: 0, revenue: 0 };
      brand.units += quantity;
      brand.revenue += revenue;
      brands.set(brandName, brand);
    });
  });
  return {
    topProducts: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    topBrands: [...brands.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
  };
}

function buildOrderAnalytics({
  cohortOrders = [],
  previousCohortOrders = [],
  completionCandidates = [],
  payments = [],
  inventoryItems = [],
  startDate,
  endDate,
  previousStart,
  previousEnd,
}) {
  const cohortValid = validOrders(cohortOrders);
  const previousValid = validOrders(previousCohortOrders);
  const recognized = recognizedOrders(completionCandidates, startDate, endDate);
  const previousRecognized = recognizedOrders(completionCandidates, previousStart, previousEnd);
  const grossOrderValue = cohortValid.reduce((sum, order) => sum + money(order.total), 0);
  const previousGrossOrderValue = previousValid.reduce((sum, order) => sum + money(order.total), 0);
  const recognizedRevenue = recognized.reduce((sum, order) => sum + money(order.total), 0);
  const previousRecognizedRevenue = previousRecognized.reduce((sum, order) => sum + money(order.total), 0);
  const currentLedger = summarizePaymentLedger(payments, { startDate, endDate, normalizeMethod: normalizePaymentMethod });
  const previousLedger = summarizePaymentLedger(payments, { startDate: previousStart, endDate: previousEnd, normalizeMethod: normalizePaymentMethod });
  const paymentByOrder = new Map();
  payments.forEach(payment => {
    if (!payment.orderId) return;
    const key = String(payment.orderId);
    if (!paymentByOrder.has(key)) paymentByOrder.set(key, []);
    paymentByOrder.get(key).push(payment);
  });
  let outstandingBalance = 0;
  let ledgerMismatchCount = 0;
  cohortValid.forEach(order => {
    const orderPayments = paymentByOrder.get(String(order._id)) || [];
    const collected = netPaymentsThrough(orderPayments, endDate);
    outstandingBalance += Math.max(0, money(order.total) - collected);
    if (FINAL_PAYMENT_STATUSES.has(order.paymentStatus) && collected + 0.01 < money(order.total)) ledgerMismatchCount += 1;
  });

  const completedCohort = cohortOrders.filter(order => order.status === "completed");
  const cancelled = cohortOrders.filter(order => order.status === "cancelled");
  const statusBreakdown = {};
  const fulfillmentBreakdown = {};
  const paymentBreakdown = {};
  cohortOrders.forEach(order => {
    const status = order.status || "unknown";
    const fulfillment = order.fulfillmentType || "unknown";
    const payment = order.paymentStatus || "pending";
    statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    fulfillmentBreakdown[fulfillment] = (fulfillmentBreakdown[fulfillment] || 0) + 1;
    paymentBreakdown[payment] = (paymentBreakdown[payment] || 0) + 1;
  });

  const cycleHours = recognized.map(order => (new Date(orderCompletionDate(order)) - new Date(order.createdAt)) / 3600000)
    .filter(hours => Number.isFinite(hours) && hours >= 0);
  const technicianMap = new Map();
  cohortOrders.forEach(order => {
    if (!order.technicianId && !order.technician?.name) return;
    const key = String(order.technicianId || order.technician.name);
    const row = technicianMap.get(key) || { name: order.technician?.name || "Assigned technician", orders: 0, completed: 0, value: 0 };
    row.orders += 1;
    if (order.status === "completed") row.completed += 1;
    if (order.status !== "cancelled") row.value += money(order.total);
    technicianMap.set(key, row);
  });

  const cost = summarizeOrderCosts(recognized, inventoryItems);
  const estimatedGrossMargin = recognizedRevenue - cost.totalCost;
  const marginReliable = cost.coveragePercent >= 100;
  const rankings = productRankings(recognized);
  const totalOrders = cohortOrders.length;
  const completionRate = totalOrders ? (completedCohort.length / totalOrders) * 100 : 0;
  const cancellationRate = totalOrders ? (cancelled.length / totalOrders) * 100 : 0;
  const insights = [];
  const recognizedGrowth = growth(recognizedRevenue, previousRecognizedRevenue);
  if (recognizedGrowth < -10) insights.push({ tone: "danger", icon: "bi-graph-down-arrow", title: "Recognized sales contraction", text: `Completed-order revenue is ${Math.abs(recognizedGrowth).toFixed(1)}% below the preceding period.` });
  else if (recognizedGrowth > 10) insights.push({ tone: "success", icon: "bi-graph-up-arrow", title: "Recognized sales momentum", text: `Completed-order revenue grew ${recognizedGrowth.toFixed(1)}% period over period.` });
  if (cancellationRate > 10) insights.push({ tone: "danger", icon: "bi-exclamation-triangle", title: "Cancellation leakage", text: `${cancellationRate.toFixed(1)}% of orders placed in the period were cancelled.` });
  if (outstandingBalance > 0) insights.push({ tone: "warning", icon: "bi-wallet2", title: "Collection exposure", text: `${outstandingBalance.toLocaleString("en-PH", { style: "currency", currency: "PHP" })} remains outstanding on valid orders placed in this period.` });
  if (ledgerMismatchCount) insights.push({ tone: "danger", icon: "bi-database-exclamation", title: "Ledger reconciliation required", text: `${ledgerMismatchCount} order${ledgerMismatchCount === 1 ? " is" : "s are"} marked settled without a complete payment ledger.` });
  if (cost.coveragePercent < 100) insights.push({ tone: "warning", icon: "bi-boxes", title: "Incomplete margin coverage", text: `${cost.coveragePercent.toFixed(1)}% of recognized units have a current inventory cost. Margin is an estimate until cost coverage is complete.` });
  if (!insights.length) insights.push({ tone: "info", icon: "bi-check2-circle", title: "Stable order operation", text: "No material sales, cancellation, collection, or cost exception is visible in this reporting window." });

  return {
    totalOrders,
    validOrders: cohortValid.length,
    grossRevenue: grossOrderValue,
    grossOrderValue,
    recognizedRevenue,
    grossCollections: currentLedger.grossCollections,
    refunds: currentLedger.refunds,
    netCollections: currentLedger.netCollections,
    outstandingBalance,
    pendingPaymentValue: outstandingBalance,
    ledgerMismatchCount,
    estimatedCost: cost.totalCost,
    costCoveragePercent: cost.coveragePercent,
    marginReliable,
    estimatedGrossMargin,
    estimatedMarginPercent: recognizedRevenue > 0 ? (estimatedGrossMargin / recognizedRevenue) * 100 : 0,
    avgOrderValue: cohortValid.length ? grossOrderValue / cohortValid.length : 0,
    unitsSold: recognized.reduce((sum, order) => sum + units(order), 0),
    unitsPerOrder: recognized.length ? recognized.reduce((sum, order) => sum + units(order), 0) / recognized.length : 0,
    completedOrders: completedCohort.length,
    recognizedOrders: recognized.length,
    cancelledOrders: cancelled.length,
    completionRate,
    cancellationRate,
    avgCycleHours: cycleHours.length ? cycleHours.reduce((sum, value) => sum + value, 0) / cycleHours.length : 0,
    orderGrowth: growth(totalOrders, previousCohortOrders.length),
    revenueGrowth: growth(grossOrderValue, previousGrossOrderValue),
    recognizedRevenueGrowth: recognizedGrowth,
    collectionGrowth: growth(currentLedger.netCollections, previousLedger.netCollections),
    statusBreakdown,
    fulfillmentBreakdown,
    paymentBreakdown,
    collectionsByMethod: currentLedger.byMethod,
    dailyTrend: buildTrend(cohortOrders, recognized, payments, startDate, endDate),
    ...rankings,
    technicians: [...technicianMap.values()].map(row => ({ ...row, completionRate: row.orders ? (row.completed / row.orders) * 100 : 0 })).sort((a, b) => b.value - a.value).slice(0, 8),
    recentOrders: [...cohortOrders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12).map(order => ({
      id: String(order._id),
      reference: order.orderReference || String(order._id),
      customer: order.customer?.name || "Customer",
      items: units(order),
      fulfillment: order.fulfillmentType,
      payment: order.paymentStatus,
      status: order.status,
      total: money(order.total),
      date: order.createdAt,
    })),
    insights: insights.slice(0, 6),
  };
}

module.exports = {
  buildBuckets,
  buildOrderAnalytics,
  buildTrend,
  growth,
  normalizePaymentMethod,
  productRankings,
  recognizedOrders,
  units,
  validOrders,
};
