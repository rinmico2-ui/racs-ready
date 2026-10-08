const {
  inRange,
  localDateKey,
  money,
  netPaymentsThrough,
  orderCompletionDate,
  summarizeOrderCosts,
  summarizeOrderConsumables,
  summarizeLinkedInstallationCosts,
  summarizePaymentLedger,
} = require("./enterpriseRevenue");
const { orderAttentionState, requestedOrderCutoff } = require("./orderAttention");

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

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
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

function completedItemRefunds(refunds, startDate, endDate) {
  return (refunds || []).filter(refund => refund.status === "completed" && inRange(refund.processedAt, startDate, endDate));
}

function buildTrend(cohortOrders, completionOrders, payments, productRefunds, startDate, endDate) {
  const buckets = buildBuckets(startDate, endDate);
  buckets.forEach(bucket => {
    const placed = cohortOrders.filter(order => inRange(order.createdAt, bucket.start, bucket.end));
    const completed = completionOrders.filter(order => inRange(orderCompletionDate(order), bucket.start, bucket.end));
    const ledger = summarizePaymentLedger(payments, {
      startDate: bucket.start,
      endDate: bucket.end,
      normalizeMethod: normalizePaymentMethod,
    });
    const itemRefundTotal = completedItemRefunds(productRefunds, bucket.start, bucket.end)
      .reduce((sum, refund) => sum + money(refund.amount), 0);
    bucket.orders = placed.length;
    bucket.bookedValue = validOrders(placed).reduce((sum, order) => sum + money(order.total), 0);
    bucket.recognizedRevenue = completed.reduce((sum, order) => sum + money(order.total), 0);
    bucket.netCollections = ledger.netCollections - itemRefundTotal;
    bucket.refunds = ledger.refunds + itemRefundTotal;
  });
  return buckets.map(bucket => ({ ...bucket, start: bucket.start.toISOString(), end: bucket.end.toISOString() }));
}

function productRankings(orders = [], inventoryItems = [], startDate, endDate, portfolioComplete = true) {
  const products = new Map();
  const brands = new Map();
  const inventoryById = new Map(inventoryItems.map(item => [String(item._id), item]));
  orders.forEach((order, orderIndex) => {
    (order.items || []).forEach(item => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const revenue = require('./transactionDiscounts').netLineValue(order, item);
      const name = [item.brand, item.modelLine, item.capacity && `${item.capacity}${item.capacityUnit || " HP"}`]
        .filter(Boolean).join(" ") || "Unnamed product";
      const inventoryId = item.inventoryId ? String(item.inventoryId) : '';
      const key = inventoryId || `name:${name.toLowerCase()}`;
      const product = products.get(key) || { name, inventoryId, units: 0, revenue: 0, orders: 0, orderIds: new Set() };
      product.units += quantity;
      product.revenue += revenue;
      const orderId = String(order._id || order.orderReference || `row-${orderIndex}`);
      if (!product.orderIds.has(orderId)) { product.orderIds.add(orderId); product.orders += 1; }
      products.set(key, product);

      const brandName = String(item.brand || "Unspecified");
      const brand = brands.get(brandName) || { name: brandName, units: 0, revenue: 0 };
      brand.units += quantity;
      brand.revenue += revenue;
      brands.set(brandName, brand);
    });
  });
  const periodDays = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000));
  const currentWindow = Number.isFinite(new Date(endDate).getTime()) && new Date(endDate).getTime() >= Date.now() - 14 * 86400000;
  const allProducts = [...products.values()];
  const portfolioUnits = allProducts.reduce((sum, row) => sum + row.units, 0);
  const portfolioValue = allProducts.reduce((sum, row) => sum + row.revenue, 0);
  const productRows = allProducts.map(({ orderIds, ...row }) => {
    const inventory = inventoryById.get(row.inventoryId);
    const stock = inventory ? Math.max(0, Number(inventory.quantity) || 0) : null;
    const minStock = inventory ? Math.max(0, Number(inventory.minStockLevel) || 0) : null;
    const share = portfolioUnits ? (row.units / portfolioUnits) * 100 : 0;
    let decision = 'Monitor demand';
    let reason = `${row.units} completed units across ${row.orders} orders; more history is needed before changing purchasing.`;
    if (!portfolioComplete || !currentWindow) {
      decision = 'Review in full portfolio';
      reason = 'This filtered or historical period cannot establish current purchasing priority; compare full demand and POS sales.';
    } else if (periodDays >= 14 && portfolioUnits >= 10 && row.units >= 3 && stock !== null && stock <= minStock) {
      decision = 'Review replenishment';
      reason = `${row.units} completed units (${share.toFixed(0)}% of order units); ${stock} on hand against a ${minStock}-unit stock floor.`;
    } else if (periodDays >= 30 && portfolioUnits >= 10 && row.units <= 2 && stock !== null && stock > minStock) {
      decision = 'Pause extra buying';
      reason = `Only ${row.units} completed unit${row.units === 1 ? '' : 's'} in this period with ${stock} on hand; check POS demand before the next purchase.`;
    } else if (periodDays >= 14 && portfolioUnits >= 10 && share >= 20 && row.units >= 5) {
      decision = 'Protect availability';
      reason = `${row.units} completed units account for ${share.toFixed(0)}% of order unit demand; verify stock and supplier lead time.`;
    }
    return { ...row, stock, minStock, unitShare: share, valueShare: portfolioValue ? row.revenue / portfolioValue * 100 : 0, decision, reason };
  });
  return {
    topProducts: [...productRows].sort((a, b) => b.revenue - a.revenue || b.units - a.units).slice(0, 8),
    mostOrderedProducts: [...productRows].sort((a, b) => b.units - a.units || b.orders - a.orders || b.revenue - a.revenue).slice(0, 8),
    leastOrderedProducts: [...productRows].filter(row => row.units > 0).sort((a, b) => a.units - b.units || a.revenue - b.revenue).slice(0, 8),
    productDecisions: productRows.filter(row => !['Monitor demand', 'Review in full portfolio'].includes(row.decision)).sort((a, b) => (a.decision === 'Review replenishment' ? -1 : 0) - (b.decision === 'Review replenishment' ? -1 : 0) || b.units - a.units).slice(0, 6),
    productPortfolioUnits: portfolioUnits,
    topBrands: [...brands.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
  };
}

function buildOrderAnalytics({
  cohortOrders = [],
  previousCohortOrders = [],
  completionCandidates = [],
  payments = [],
  productRefunds = [],
  inventoryItems = [],
  orderConsumableUsages = [],
  linkedInstallationServices = [],
  startDate,
  endDate,
  previousStart,
  previousEnd,
  productPortfolioComplete = true,
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
  const currentItemRefunds = completedItemRefunds(productRefunds, startDate, endDate);
  const previousItemRefunds = completedItemRefunds(productRefunds, previousStart, previousEnd);
  const currentItemRefundTotal = currentItemRefunds.reduce((sum, refund) => sum + money(refund.amount), 0);
  const previousItemRefundTotal = previousItemRefunds.reduce((sum, refund) => sum + money(refund.amount), 0);
  const collectionsByMethod = { ...currentLedger.byMethod };
  currentItemRefunds.forEach(refund => {
    const method = normalizePaymentMethod(refund.method);
    collectionsByMethod[method] = money((collectionsByMethod[method] || 0) - money(refund.amount));
  });
  const paymentByOrder = new Map();
  payments.forEach(payment => {
    if (!payment.orderId) return;
    const key = String(payment.orderId);
    if (!paymentByOrder.has(key)) paymentByOrder.set(key, []);
    paymentByOrder.get(key).push(payment);
  });
  let outstandingBalance = 0;
  let ledgerMismatchCount = 0;
  const actionOrderIds = new Set();
  cohortValid.forEach(order => {
    const orderPayments = paymentByOrder.get(String(order._id)) || [];
    const collected = netPaymentsThrough(orderPayments, endDate);
    outstandingBalance += Math.max(0, money(order.total) - collected);
    if (FINAL_PAYMENT_STATUSES.has(order.paymentStatus) && collected + 0.01 < money(order.total)) {
      ledgerMismatchCount += 1;
      actionOrderIds.add(String(order._id));
    }
  });

  const completedCohort = cohortOrders.filter(order => order.status === "completed");
  const cancelled = cohortOrders.filter(order => order.status === "cancelled");
  const openOrders = cohortValid.filter(order => order.status !== "completed");
  const reportAsOf = new Date(Math.min(new Date(endDate).getTime(), Date.now()));
  const overdueOrders = openOrders.filter(order => orderAttentionState(order, reportAsOf).isPastDate);
  const unassignedOrders = openOrders.filter(order => order.fulfillmentType !== "customer_pickup"
    && order.status !== "pending_payment" && !order.technicianId && !order.technician?._id);
  const pendingPaymentOrders = openOrders.filter(order => order.status === "pending_payment" || order.paymentStatus === "pending");
  overdueOrders.forEach(order => actionOrderIds.add(String(order._id)));
  unassignedOrders.forEach(order => actionOrderIds.add(String(order._id)));
  openOrders.filter(order => order.status === "technician_declined"
    || (order.rescheduleRequest?.requested && order.rescheduleRequest?.status === "pending"))
    .forEach(order => actionOrderIds.add(String(order._id)));
  const backlogAging = { today: 0, twoToThree: 0, fourToSeven: 0, overSeven: 0 };
  openOrders.forEach(order => {
    const ageDays = Math.max(0, Math.floor((reportAsOf - new Date(order.createdAt)) / 86400000));
    if (ageDays <= 1) backlogAging.today += 1;
    else if (ageDays <= 3) backlogAging.twoToThree += 1;
    else if (ageDays <= 7) backlogAging.fourToSeven += 1;
    else backlogAging.overSeven += 1;
  });
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
  const scheduledCompletions = recognized.map(order => ({
    completedAt: orderCompletionDate(order),
    cutoff: requestedOrderCutoff(order),
  })).filter(row => row.completedAt && row.cutoff);
  const onTimeCompleted = scheduledCompletions.filter(row => new Date(row.completedAt) <= row.cutoff).length;
  const cancellationReasons = Object.entries(cancelled.reduce((summary, order) => {
    const reason = String(order.cancellationReason || "Unspecified").trim() || "Unspecified";
    summary[reason] = (summary[reason] || 0) + 1;
    return summary;
  }, {})).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6);
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
  const consumables = summarizeOrderConsumables(recognized, orderConsumableUsages);
  const linkedInstallation = summarizeLinkedInstallationCosts(recognized, linkedInstallationServices);
  const installationOrders = recognized.filter(order => order.fulfillmentType === "delivery_installation");
  const installationsWithoutUsage = installationOrders.filter(order => {
    const linkedCost = linkedInstallation.byBooking.get(String(order.bookingId || ""));
    return !consumables.byOrder.has(String(order._id))
      && !Number(linkedCost?.consumablesCost || 0)
      && !Number(linkedCost?.unpricedConsumablesCount || 0);
  }).length;
  const knownDirectCost = cost.totalCost + consumables.totalCost + linkedInstallation.totalCost;
  const estimatedGrossMargin = recognizedRevenue - knownDirectCost;
  const marginReliable = cost.coveragePercent >= 100 && consumables.missingCostRecords === 0 && installationOrders.length === 0;
  const orderCostRows = recognized.map(order => {
    const productCost = summarizeOrderCosts([order], inventoryItems);
    const consumablesCost = consumables.byOrder.get(String(order._id)) || 0;
    const linkedCost = linkedInstallation.byBooking.get(String(order.bookingId || "")) || {};
    return {
      reference: order.orderReference || String(order._id),
      fulfillment: order.fulfillmentType || "unknown",
      completedAt: orderCompletionDate(order),
      revenue: money(order.total),
      productCost: productCost.totalCost,
      consumablesCost: consumablesCost + Number(linkedCost.consumablesCost || 0),
      linkedServiceCost: Number(linkedCost.totalCost || 0) - Number(linkedCost.consumablesCost || 0),
      knownContribution: money(order.total) - productCost.totalCost - consumablesCost - Number(linkedCost.totalCost || 0),
      productCostComplete: productCost.coveragePercent >= 100,
      usageRecorded: consumables.byOrder.has(String(order._id))
        || Number(linkedCost.consumablesCost || 0) > 0
        || Number(linkedCost.unpricedConsumablesCount || 0) > 0,
    };
  }).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 20);
  const rankings = productRankings(recognized, inventoryItems, startDate, endDate, productPortfolioComplete);
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
  if (consumables.missingCostRecords) insights.push({ tone: "warning", icon: "bi-tools", title: "Unpriced installation materials", text: `${consumables.missingCostRecords} recorded consumable usage row${consumables.missingCostRecords === 1 ? " has" : "s have"} no cost snapshot. Known contribution may be overstated.` });
  if (installationsWithoutUsage) insights.push({ tone: "info", icon: "bi-clipboard-check", title: "Installation usage to verify", text: `${installationsWithoutUsage} completed installation order${installationsWithoutUsage === 1 ? " has" : "s have"} no recorded consumable usage; confirm whether any material was used.` });
  if (!insights.length) insights.push({ tone: "info", icon: "bi-check2-circle", title: "Stable order operation", text: "No material sales, cancellation, collection, or cost exception is visible in this reporting window." });

  return {
    totalOrders,
    validOrders: cohortValid.length,
    grossRevenue: grossOrderValue,
    grossOrderValue,
    recognizedRevenue,
    grossCollections: currentLedger.grossCollections,
    refunds: currentLedger.refunds + currentItemRefundTotal,
    netCollections: currentLedger.netCollections - currentItemRefundTotal,
    outstandingBalance,
    pendingPaymentValue: outstandingBalance,
    ledgerMismatchCount,
    estimatedCost: knownDirectCost,
    productCost: cost.totalCost,
    consumablesCost: consumables.totalCost + linkedInstallation.consumablesCost,
    linkedServiceCost: linkedInstallation.totalCost - linkedInstallation.consumablesCost,
    installationLaborCost: linkedInstallation.laborCost,
    installationPartsCost: linkedInstallation.partsCost,
    installationLocalPurchaseCost: linkedInstallation.localPurchaseCost,
    consumablesMissingCostRecords: consumables.missingCostRecords + linkedInstallation.unpricedConsumablesCount,
    installationOrders: installationOrders.length,
    installationsWithoutUsage,
    orderCostRows,
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
    medianCycleHours: percentile(cycleHours, 0.5),
    p90CycleHours: percentile(cycleHours, 0.9),
    onTimeRate: scheduledCompletions.length ? (onTimeCompleted / scheduledCompletions.length) * 100 : 0,
    onTimeSampleSize: scheduledCompletions.length,
    openOrders: openOrders.length,
    overdueOrders: overdueOrders.length,
    unassignedOrders: unassignedOrders.length,
    pendingPaymentOrders: pendingPaymentOrders.length,
    actionRequiredOrders: actionOrderIds.size,
    backlogAging,
    cancellationReasons,
    orderGrowth: growth(cohortValid.length, previousValid.length),
    revenueGrowth: growth(grossOrderValue, previousGrossOrderValue),
    recognizedRevenueGrowth: recognizedGrowth,
    collectionGrowth: growth(currentLedger.netCollections - currentItemRefundTotal, previousLedger.netCollections - previousItemRefundTotal),
    statusBreakdown,
    fulfillmentBreakdown,
    paymentBreakdown,
    collectionsByMethod,
    dailyTrend: buildTrend(cohortOrders, recognized, payments, productRefunds, startDate, endDate),
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
