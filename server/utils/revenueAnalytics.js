// ═══════════════════════════════════════════════════════════════════════════════
// SHARED REVENUE ANALYTICS ENGINE
// Single source of truth for the Revenue Intelligence report. Used by both the
// SSR page render (routes/pages.js → /admin/reports/revenue) and the filtered
// AJAX endpoint (routes/adminApi.js → /api/admin/reports/revenue) so the two
// entry points can never drift out of sync with each other.
// ═══════════════════════════════════════════════════════════════════════════════
const BookingService = require("../models/BookingService");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const WalkInSale = require("../models/WalkInSale");
const Technician = require("../models/Technician");
const Inventory = require("../models/Inventory");
const HVACProduct = require("../models/HVACProduct");
const Expense = require("../models/Expense");
const Payroll = require("../models/Payroll");
const ProjectMaterial = require("../models/ProjectMaterial");
const {
  bookingApprovedValue, buildProjectPricingMap, isRepairBooking, normalizePaymentMethod,
} = require("./revenueRecognition");
const { buildServiceCostAnalytics } = require("./serviceCostAnalytics");
const {
  ACCEPTED_PAYMENT_STATUSES,
  bookingCompletionDate,
  inRange: inDateRange,
  isRecognizedBooking,
  isRecognizedOrder,
  localDateKey,
  netPaymentsThrough,
  orderCompletionDate,
  parseReportDate,
  summarizeOrderCosts,
  summarizePaymentLedger,
} = require("./enterpriseRevenue");

/**
 * Resolve the reporting date range from either a preset `period` or explicit
 * `from`/`to` values. Falls back to a rolling 12-month window.
 */
function resolveDateRange({ from, to, period }) {
  const now = new Date();
  let startDate;
  let endDate;

  if (period === "this_month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = now;
  } else if (period === "last_month") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (period === "last_3_months") {
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 3);
    endDate = now;
  } else if (period === "last_6_months") {
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 6);
    endDate = now;
  } else if (period === "ytd") {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = now;
  } else if (from || to) {
    startDate = from ? parseReportDate(from) : new Date(now.getFullYear(), now.getMonth() - 11, 1);
    endDate = to ? parseReportDate(to, true) : now;
  } else {
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 12);
    endDate = now;
  }
  return { startDate, endDate };
}

/**
 * Build the full Revenue Intelligence analytics payload for the given filter
 * set. This is the ONLY place this computation should live — both routes
 * that render the revenue report must call this function.
 *
 * @param {object} query — { from, to, source, paymentMethod, paymentStatus, serviceType, technician, period }
 */
async function buildRevenueAnalytics(query = {}) {
  const { from, to, source, paymentMethod, paymentStatus, serviceType, technician, period } = query;
  const { startDate, endDate } = resolveDateRange({ from, to, period });
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    throw Object.assign(new Error("Invalid reporting date range"), { statusCode: 400 });
  }

  const dateFilter = { $gte: startDate, $lte: endDate };
  const sourceFilter = source || "all";
  const pmFilter = paymentMethod || "all";
  const psFilter = paymentStatus || "all";
  const stFilter = serviceType || "all";
  const techFilter = technician || "all";
  const serviceOnlyScope = stFilter !== "all" || techFilter !== "all";

  // ── Fetch data ──
  const bookingsQuery = { createdAt: dateFilter, status: { $ne: "cancelled" } };
  if (techFilter !== "all") bookingsQuery.technicianId = techFilter;
  const paymentsQuery = {
    $and: [
      { $or: [
        { verifiedAt: dateFilter }, { completedAt: dateFilter },
        { collectedAt: dateFilter }, { submittedAt: dateFilter }, { refundedAt: dateFilter },
      ] },
      { $or: [
        { status: { $in: Array.from(ACCEPTED_PAYMENT_STATUSES) } },
        { refundAmount: { $gt: 0 } },
      ] },
    ],
  };

  const ordersQuery = { createdAt: dateFilter, status: { $ne: "cancelled" } };
  if (pmFilter !== "all") {
    const methodAliases = {
      gcash: ["gcash", "gcash_full", "gcash_downpayment"],
      cod: ["cod", "cash", "cash_onsite", "downpayment"],
      bank: ["bank", "bank_transfer"],
    };
    if (methodAliases[pmFilter]) ordersQuery.paymentMethod = { $in: methodAliases[pmFilter] };
    else ordersQuery.paymentMethod = { $nin: [...methodAliases.gcash, ...methodAliases.cod, ...methodAliases.bank] };
  }
  if (psFilter !== "all") ordersQuery.paymentStatus = psFilter;

  const posQuery = { createdAt: dateFilter, status: "completed" };
  if (pmFilter !== "all") {
    const posAliases = { gcash: ["gcash"], cod: ["cash", "cod"], bank: ["bank", "bank_transfer"] };
    posQuery.paymentMethod = posAliases[pmFilter] ? { $in: posAliases[pmFilter] } : { $nin: ["gcash", "cash", "cod", "bank", "bank_transfer"] };
  }

  const recognizedBookingQuery = {
    status: { $in: ["completed", "repair_completed", "closed"] },
    $or: [
      { completedAt: dateFilter },
      { "repairCompletion.completedAt": dateFilter },
      { "slaTracking.resolutionAt": dateFilter },
      { "statusHistory": { $elemMatch: { toStatus: { $in: ["completed", "repair_completed", "closed"] }, timestamp: dateFilter } } },
      { updatedAt: dateFilter },
    ],
  };
  if (techFilter !== "all") recognizedBookingQuery.technicianId = techFilter;
  const recognizedOrderQuery = {
    status: "completed",
    $or: [
      { "statusHistory": { $elemMatch: { status: "completed", timestamp: dateFilter } } },
      { updatedAt: dateFilter },
    ],
  };
  if (ordersQuery.paymentMethod) recognizedOrderQuery.paymentMethod = ordersQuery.paymentMethod;
  if (ordersQuery.paymentStatus) recognizedOrderQuery.paymentStatus = ordersQuery.paymentStatus;

  const [bookings, rawPayments, orders, posSales, recognizedBookingRows, recognizedOrderRows] = await Promise.all([
    sourceFilter === "pos" || sourceFilter === "order" ? [] : BookingService.find(bookingsQuery).lean(),
    Payment.find(paymentsQuery).lean(),
    sourceFilter === "service" || sourceFilter === "pos" || serviceOnlyScope ? [] : Order.find(ordersQuery).lean(),
    sourceFilter === "service" || sourceFilter === "order" || serviceOnlyScope || !["all", "paid"].includes(psFilter) ? [] : WalkInSale.find(posQuery).lean(),
    sourceFilter === "pos" || sourceFilter === "order" ? [] : BookingService.find(recognizedBookingQuery).lean(),
    sourceFilter === "service" || sourceFilter === "pos" || serviceOnlyScope ? [] : Order.find(recognizedOrderQuery).lean(),
  ]);
  const uniqueBookings = Array.from(new Map(
    [...bookings, ...recognizedBookingRows].map((booking) => [String(booking._id), booking]),
  ).values());
  const projectPricingMap = await buildProjectPricingMap(uniqueBookings);
  let payments = rawPayments.filter((payment) => {
    if (sourceFilter === "service") return Boolean(payment.bookingId || payment.projectId);
    if (sourceFilter === "order") return Boolean(payment.orderId);
    if (sourceFilter === "pos") return false;
    return Boolean(payment.bookingId || payment.projectId || payment.orderId);
  });
  if (pmFilter !== "all") {
    const wantedMethod = normalizePaymentMethod(pmFilter);
    payments = payments.filter((payment) => normalizePaymentMethod(payment.method) === wantedMethod);
  }

  // ── Helper ──
  function getBookingRevenue(b) {
    return bookingApprovedValue(b, projectPricingMap);
  }

  // ── Apply payment status / service type filters to bookings ──
  function applyBookingFilters(rows) {
    let result = rows;
    if (stFilter === "core") result = result.filter((booking) => !isRepairBooking(booking));
    if (stFilter === "repair") result = result.filter(isRepairBooking);
    if (psFilter !== "all") result = result.filter((booking) => booking.paymentStatus === psFilter);
    return result;
  }

  let filteredBookings = applyBookingFilters(bookings);
  if (pmFilter !== "all") {
    const paymentBookingIds = new Set(payments.filter((payment) => payment.bookingId).map((payment) => String(payment.bookingId)));
    const paymentProjectIds = new Set(payments.filter((payment) => payment.projectId).map((payment) => String(payment.projectId)));
    Array.from(projectPricingMap.entries()).forEach(([bookingId, entry]) => {
      if (paymentProjectIds.has(entry.projectId)) paymentBookingIds.add(bookingId);
    });
    filteredBookings = filteredBookings.filter((booking) => paymentBookingIds.has(String(booking._id)));
  }
  const filteredBookingIds = new Set(filteredBookings.map((booking) => String(booking._id)));
  const filteredProjectIds = new Set(
    Array.from(projectPricingMap.entries())
      .filter(([bookingId]) => filteredBookingIds.has(bookingId))
      .map(([, entry]) => entry.projectId),
  );
  if (serviceOnlyScope) {
    payments = payments.filter((payment) => {
      if (payment.bookingId) return filteredBookingIds.has(String(payment.bookingId));
      if (payment.projectId) return filteredProjectIds.has(String(payment.projectId));
      return false;
    });
  }

  let recognizedBookings = applyBookingFilters(recognizedBookingRows)
    .filter((booking) => isRecognizedBooking(booking, startDate, endDate));
  if (pmFilter !== "all") {
    const paidBookingIds = new Set(payments.filter((payment) => payment.bookingId).map((payment) => String(payment.bookingId)));
    const paidProjectIds = new Set(payments.filter((payment) => payment.projectId).map((payment) => String(payment.projectId)));
    recognizedBookings = recognizedBookings.filter((booking) => {
      const project = projectPricingMap.get(String(booking._id));
      return paidBookingIds.has(String(booking._id)) || (project && paidProjectIds.has(project.projectId));
    });
  }
  const recognizedOrders = recognizedOrderRows.filter((order) => isRecognizedOrder(order, startDate, endDate));
  const orderLinkedBookingIds = new Set(
    [...orders, ...recognizedOrders].map((order) => order.bookingId).filter(Boolean).map(String),
  );
  filteredBookings = filteredBookings.filter((booking) => !orderLinkedBookingIds.has(String(booking._id)));
  recognizedBookings = recognizedBookings.filter((booking) => !orderLinkedBookingIds.has(String(booking._id)));

  // ── Core metrics ──
  const serviceRevenue = filteredBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0);
  const orderRevenue = orders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0);
  const posRevenue = posSales.reduce((sum, s) => sum + Number(s.totalAmount || 0), 0);
  const posCost = posSales.reduce((sum, s) => sum + Number(s.totalCost || 0), 0);
  const posProfit = posRevenue - posCost;
  const totalRevenue = serviceRevenue + orderRevenue + posRevenue;
  const recognizedServiceRevenue = recognizedBookings.reduce((sum, booking) => sum + getBookingRevenue(booking), 0);
  const recognizedOrderRevenue = recognizedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const recognizedGrossRevenue = recognizedServiceRevenue + recognizedOrderRevenue + posRevenue;

  const paymentLedger = summarizePaymentLedger(payments, {
    startDate,
    endDate,
    normalizeMethod: normalizePaymentMethod,
  });
  const grossCollections = paymentLedger.grossCollections + posRevenue;
  const refunds = paymentLedger.refunds;
  const paymentRevenue = paymentLedger.netCollections + posRevenue;
  const recognizedRevenue = recognizedGrossRevenue - refunds;

  const cohortEntityFilters = [];
  if (filteredBookings.length) cohortEntityFilters.push({ bookingId: { $in: filteredBookings.map((booking) => booking._id) } });
  if (orders.length) cohortEntityFilters.push({ orderId: { $in: orders.map((order) => order._id) } });
  const cohortProjectIds = Array.from(projectPricingMap.entries())
    .filter(([bookingId]) => filteredBookings.some((booking) => String(booking._id) === bookingId))
    .map(([, entry]) => entry.projectId);
  if (cohortProjectIds.length) cohortEntityFilters.push({ projectId: { $in: cohortProjectIds } });
  const cohortPayments = cohortEntityFilters.length
    ? await Payment.find({
      $and: [
        { $or: cohortEntityFilters },
        { $or: [
          { status: { $in: Array.from(ACCEPTED_PAYMENT_STATUSES) } },
          { refundAmount: { $gt: 0 } },
        ] },
      ],
    }).lean()
    : [];
  const cohortNetCollections = netPaymentsThrough(cohortPayments, endDate) + posRevenue;
  const outstandingValue = Math.max(0, totalRevenue - cohortNetCollections);

  // ── Revenue by source ──
  const productRevenue = orders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
  const deliveryRevenue = orders.reduce((sum, o) => sum + (o.deliveryFee || 0), 0);
  const installationRevenue = orders.reduce((sum, o) => sum + (o.installationFee || 0), 0);

  // ── Payment method breakdown ──
  const gcashRevenue = paymentLedger.byMethod.gcash;
  const codRevenue = paymentLedger.byMethod.cash;
  const bankRevenue = paymentLedger.byMethod.bank;
  const otherRecordedRevenue = paymentLedger.byMethod.other;

  // ── Monthly bucketing ──
  const actualMonths = Math.min(Math.max(2, Math.ceil((endDate - startDate) / (30 * 24 * 60 * 60 * 1000))), 24);
  const monthlyRevenue = {};
  for (let i = actualMonths - 1; i >= 0; i--) {
    const monthStart = new Date(startDate);
    monthStart.setMonth(monthStart.getMonth() + i);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    if (monthEnd < startDate || monthStart > endDate) continue;

    const mBookings = filteredBookings.filter((b) => { const d = new Date(b.createdAt); return d >= monthStart && d < monthEnd; });
    const mOrders = orders.filter((o) => { const d = new Date(o.createdAt); return d >= monthStart && d < monthEnd; });
    const mPos = posSales.filter((s) => { const d = new Date(s.createdAt); return d >= monthStart && d < monthEnd; });
    const mRecognizedBookings = recognizedBookings.filter((booking) => {
      const date = new Date(bookingCompletionDate(booking));
      return date >= monthStart && date < monthEnd;
    });
    const mRecognizedOrders = recognizedOrders.filter((order) => {
      const date = new Date(orderCompletionDate(order));
      return date >= monthStart && date < monthEnd;
    });
    const boundedMonthEnd = monthEnd < endDate ? new Date(monthEnd.getTime() - 1) : endDate;
    const monthLedger = summarizePaymentLedger(payments, {
      startDate: monthStart > startDate ? monthStart : startDate,
      endDate: boundedMonthEnd,
      normalizeMethod: normalizePaymentMethod,
    });

    const monthKey = monthStart.toLocaleString("en-PH", { month: "short", year: "numeric" });
    monthlyRevenue[monthKey] = {
      service: mBookings.reduce((s, b) => s + getBookingRevenue(b), 0),
      orders: mOrders.reduce((s, o) => s + (o.total || o.totalAmount || 0), 0),
      pos: mPos.reduce((s, p) => s + Number(p.totalAmount || 0), 0),
      total: 0,
      recognized: mRecognizedBookings.reduce((s, b) => s + getBookingRevenue(b), 0)
        + mRecognizedOrders.reduce((s, o) => s + Number(o.total || 0), 0)
        + mPos.reduce((s, p) => s + Number(p.totalAmount || 0), 0)
        - monthLedger.refunds,
      collections: monthLedger.netCollections + mPos.reduce((s, p) => s + Number(p.totalAmount || 0), 0),
      refunds: monthLedger.refunds,
    };
    monthlyRevenue[monthKey].total = monthlyRevenue[monthKey].service + monthlyRevenue[monthKey].orders + monthlyRevenue[monthKey].pos;
  }

  const dailyRevenue = [];
  const dailyStart = new Date(Math.max(startDate.getTime(), endDate.getTime() - (92 * 86400000)));
  dailyStart.setHours(0, 0, 0, 0);
  for (let cursor = new Date(dailyStart); cursor <= endDate; cursor.setDate(cursor.getDate() + 1)) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(23, 59, 59, 999);
    const dayBookings = filteredBookings.filter((booking) => inDateRange(booking.createdAt, dayStart, dayEnd));
    const dayOrders = orders.filter((order) => inDateRange(order.createdAt, dayStart, dayEnd));
    const dayPos = posSales.filter((sale) => inDateRange(sale.completedAt || sale.createdAt, dayStart, dayEnd));
    const dayRecognizedBookings = recognizedBookings.filter((booking) => inDateRange(bookingCompletionDate(booking), dayStart, dayEnd));
    const dayRecognizedOrders = recognizedOrders.filter((order) => inDateRange(orderCompletionDate(order), dayStart, dayEnd));
    const dayLedger = summarizePaymentLedger(payments, { startDate: dayStart, endDate: dayEnd, normalizeMethod: normalizePaymentMethod });
    const posValue = dayPos.reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
    dailyRevenue.push({
      date: localDateKey(dayStart),
      booked: dayBookings.reduce((sum, booking) => sum + getBookingRevenue(booking), 0)
        + dayOrders.reduce((sum, order) => sum + Number(order.total || 0), 0) + posValue,
      recognized: dayRecognizedBookings.reduce((sum, booking) => sum + getBookingRevenue(booking), 0)
        + dayRecognizedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0) + posValue - dayLedger.refunds,
      collections: dayLedger.netCollections + posValue,
      refunds: dayLedger.refunds,
    });
  }

  // ── Service type split (core / repair / mix) ──
  function serviceCategory(booking) {
    if (booking?.serviceType === "mixed" || ((booking?.services || []).some(s => s.type === "repair") && (booking?.services || []).some(s => s.type !== "repair")))
      return "mix";
    if (isRepairBooking(booking)) return "repair";
    return "core";
  }
  const coreRevenue = filteredBookings
    .filter((b) => serviceCategory(b) === "core")
    .reduce((sum, b) => sum + getBookingRevenue(b), 0);
  const repairRevenue = filteredBookings
    .filter((b) => serviceCategory(b) === "repair")
    .reduce((sum, b) => sum + getBookingRevenue(b), 0);
  const mixRevenue = filteredBookings
    .filter((b) => serviceCategory(b) === "mix")
    .reduce((sum, b) => sum + getBookingRevenue(b), 0);

  // ── Top technicians ──
  const techRevenue = {};
  recognizedBookings.forEach((b) => {
    if (b.technicianId) {
      const revenue = getBookingRevenue(b);
      if (revenue <= 0) return;
      const tid = b.technicianId.toString();
      if (!techRevenue[tid]) techRevenue[tid] = { id: tid, name: b.technician?.name || "Unknown", revenue: 0, bookings: 0 };
      techRevenue[tid].revenue += revenue;
      techRevenue[tid].bookings++;
    }
  });
  const topTechnicians = Object.values(techRevenue).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // ── Direct/known cost engine (completed services only — matches cost breakdown card) ──
  const recognizedInventoryIds = [...new Set(
    recognizedOrders.flatMap((order) => (order.items || []).map((item) => String(item.inventoryId || ""))).filter(Boolean),
  )];
  const recognizedProjectIds = Array.from(projectPricingMap.entries())
    .filter(([bookingId]) => recognizedBookings.some((booking) => String(booking._id) === bookingId))
    .map(([, entry]) => entry.projectId);
  const [serviceCostAnalytics, inventoryCosts, hvacCostProducts, approvedExpenses, payrollRows, projectMaterials] = await Promise.all([
    buildServiceCostAnalytics(recognizedBookings, { revenueResolver: getBookingRevenue }),
    recognizedInventoryIds.length
      ? Inventory.find({ _id: { $in: recognizedInventoryIds } }).select("costPrice").lean()
      : [],
    recognizedInventoryIds.length
      ? HVACProduct.find({ "variants._id": { $in: recognizedInventoryIds } }).select("variants._id variants.costPrice").lean()
      : [],
    Expense.find({ status: "approved", expenseDate: dateFilter }).select("amount type bookingId projectId").lean(),
    Payroll.find({ status: { $in: ["approved", "paid"] }, payDate: dateFilter }).select("grossPay netPay status").lean(),
    recognizedProjectIds.length
      ? ProjectMaterial.find({
        projectId: { $in: recognizedProjectIds },
        status: "fulfilled",
        type: { $in: ["part", "consumable"] },
      }).select("projectId totalPrice quantity unitPrice type").lean()
      : [],
  ]);
  const orderCostCatalog = inventoryCosts.concat(
    hvacCostProducts.flatMap((product) => (product.variants || []).map((variant) => ({
      _id: variant._id,
      costPrice: variant.costPrice,
    }))),
  );
  const orderCostSummary = summarizeOrderCosts(recognizedOrders, orderCostCatalog);
  const projectMaterialCost = projectMaterials.reduce(
    (sum, material) => sum + Number(material.totalPrice || (Number(material.quantity || 0) * Number(material.unitPrice || 0))),
    0,
  );
  const bookingsWithRecordedDirectCost = new Set(serviceCostAnalytics.services
    .filter((service) => Number(service.partsCost || 0) + Number(service.consumablesCost || 0)
      + Number(service.localPurchaseCost || 0) > 0)
    .map((service) => String(service.bookingId)));
  const projectsWithRecordedMaterials = new Set(projectMaterials.map((material) => String(material.projectId)));
  const duplicatedDirectExpenseTypes = new Set(["external_parts", "material"]);
  const operatingExpenseRows = approvedExpenses.filter((expense) => !(
    duplicatedDirectExpenseTypes.has(expense.type)
    && ((expense.bookingId && bookingsWithRecordedDirectCost.has(String(expense.bookingId)))
      || (expense.projectId && projectsWithRecordedMaterials.has(String(expense.projectId))))
  ));
  const approvedExpenseTotal = operatingExpenseRows.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const payrollCost = payrollRows.reduce((sum, payroll) => sum + Number(payroll.grossPay || 0), 0);
  const serviceDirectCost = serviceCostAnalytics.totals.partsCost
    + serviceCostAnalytics.totals.consumablesCost
    + serviceCostAnalytics.totals.localPurchaseCost
    + serviceCostAnalytics.totals.laborCost;
  const totalPartsCost = serviceDirectCost + posCost + orderCostSummary.totalCost + projectMaterialCost;
  const grossProfit = recognizedRevenue - totalPartsCost;
  const grossProfitMargin = recognizedRevenue > 0 ? ((grossProfit / recognizedRevenue) * 100).toFixed(1) : "0.0";
  const operatingExpenses = approvedExpenseTotal + payrollCost;
  const operatingProfit = grossProfit - operatingExpenses;
  const operatingMargin = recognizedRevenue > 0 ? (operatingProfit / recognizedRevenue) * 100 : 0;
  const costDataCoverage = recognizedGrossRevenue > 0
    ? ((recognizedServiceRevenue + posRevenue + (recognizedOrderRevenue * orderCostSummary.coveragePercent / 100)) / recognizedGrossRevenue) * 100
    : 100;
  const directCostByBooking = new Map(serviceCostAnalytics.services.map((service) => [
    String(service.bookingId),
    Number(service.partsCost || 0) + Number(service.consumablesCost || 0)
      + Number(service.localPurchaseCost || 0) + Number(service.laborCost || 0),
  ]));
  topTechnicians.forEach((technicianRow) => {
    const technicianBookingIds = recognizedBookings
      .filter((booking) => booking.technicianId && String(booking.technicianId) === technicianRow.id)
      .map((booking) => String(booking._id));
    technicianRow.partsCost = technicianBookingIds.reduce((sum, id) => sum + Number(directCostByBooking.get(id) || 0), 0);
    technicianRow.profit = technicianRow.revenue - technicianRow.partsCost;
  });
  const monthlyPartsCost = {};
  Object.keys(monthlyRevenue).forEach((key) => { monthlyPartsCost[key] = 0; });
  serviceCostAnalytics.services.forEach((service) => {
    const completedAt = new Date(service.completedAt);
    if (Number.isNaN(completedAt.getTime())) return;
    const key = completedAt.toLocaleString("en-PH", { month: "short", year: "numeric" });
    if (Object.prototype.hasOwnProperty.call(monthlyPartsCost, key)) {
      monthlyPartsCost[key] += Number(directCostByBooking.get(String(service.bookingId)) || 0);
    }
  });
  recognizedOrders.forEach((order) => {
    const key = new Date(orderCompletionDate(order)).toLocaleString("en-PH", { month: "short", year: "numeric" });
    if (Object.prototype.hasOwnProperty.call(monthlyPartsCost, key)) {
      monthlyPartsCost[key] += summarizeOrderCosts([order], orderCostCatalog).totalCost;
    }
  });
  posSales.forEach((sale) => {
    const key = new Date(sale.completedAt || sale.createdAt).toLocaleString("en-PH", { month: "short", year: "numeric" });
    if (Object.prototype.hasOwnProperty.call(monthlyPartsCost, key)) monthlyPartsCost[key] += Number(sale.totalCost || 0);
  });
  projectMaterials.forEach((material) => {
    const projectEntry = Array.from(projectPricingMap.entries()).find(([, entry]) => String(entry.projectId) === String(material.projectId));
    const booking = projectEntry ? recognizedBookings.find((row) => String(row._id) === projectEntry[0]) : null;
    if (!booking) return;
    const key = new Date(bookingCompletionDate(booking)).toLocaleString("en-PH", { month: "short", year: "numeric" });
    if (Object.prototype.hasOwnProperty.call(monthlyPartsCost, key)) {
      monthlyPartsCost[key] += Number(material.totalPrice || (Number(material.quantity || 0) * Number(material.unitPrice || 0)));
    }
  });

  // ── Recent transactions (include payment method from Payment records) ──
  const bookingPaymentMethod = {};
  payments.forEach(p => {
    if (p.bookingId) {
      const key = String(p.bookingId);
      bookingPaymentMethod[key] = normalizePaymentMethod(p.method);
    }
  });
  const orderPaymentMethod = {};
  payments.forEach(p => {
    if (p.orderId) {
      const key = String(p.orderId);
      orderPaymentMethod[key] = normalizePaymentMethod(p.method);
    }
  });
  const recentTransactions = [
    ...filteredBookings.map((b) => ({
      type: "service", reference: b.bookingReference, customer: b.customer?.name || "Unknown",
      amount: getBookingRevenue(b), status: b.paymentStatus, method: bookingPaymentMethod[String(b._id)] || normalizePaymentMethod(b.paymentMethod) || "other", date: b.createdAt,
    })),
    ...orders.map((o) => ({
      type: "order", reference: o.orderReference, customer: o.customer?.name || "Unknown",
      amount: o.total || o.totalAmount || 0, status: o.paymentStatus, method: orderPaymentMethod[String(o._id)] || normalizePaymentMethod(o.paymentMethod) || "other", date: o.createdAt,
    })),
    ...posSales.map((s) => ({
      type: "pos", reference: s.invoiceNumber, customer: s.customerName || "Walk-In", amount: s.totalAmount || 0,
      status: s.status, method: normalizePaymentMethod(s.paymentMethod) || "other", date: s.createdAt,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  // ── POS payment methods ──
  const posPaymentMethods = posSales.reduce((map, s) => {
    const method = s.paymentMethod || "other";
    map[method] = (map[method] || 0) + Number(s.totalAmount || 0);
    return map;
  }, {});
  const posGcashRevenue = Object.entries(posPaymentMethods).filter(([method]) => normalizePaymentMethod(method) === "gcash").reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
  const posCashRevenue = Object.entries(posPaymentMethods).filter(([method]) => normalizePaymentMethod(method) === "cash").reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
  const posBankRevenue = Object.entries(posPaymentMethods).filter(([method]) => normalizePaymentMethod(method) === "bank").reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
  const posOtherRevenue = Math.max(0, posRevenue - posGcashRevenue - posCashRevenue - posBankRevenue);
  const grossCollectionMethods = {
    gcash: paymentLedger.grossByMethod.gcash + posGcashRevenue,
    cash: paymentLedger.grossByMethod.cash + posCashRevenue,
    bank: paymentLedger.grossByMethod.bank + posBankRevenue,
    other: paymentLedger.grossByMethod.other + posOtherRevenue,
  };

  // ── POS products ──
  const posProductMap = {};
  posSales.forEach((sale) => {
    const factor = Number(sale.subtotal || 0) > 0 ? Number(sale.totalAmount || 0) / Number(sale.subtotal) : 1;
    (sale.items || []).forEach((item) => {
      const key = item.itemName || "Unnamed";
      if (!posProductMap[key]) posProductMap[key] = { name: key, category: item.category || "Other", channel: "pos", quantity: 0, revenue: 0, cost: 0, profit: 0 };
      const row = posProductMap[key];
      row.quantity += Number(item.quantity || 0);
      row.revenue += Number(item.totalPrice || 0) * factor;
      row.cost += Number(item.costPrice || 0) * Number(item.quantity || 0);
      row.profit = row.revenue - row.cost;
    });
  });

  // ── Order products (online / pickup HVAC units) ──
  const orderProductMap = {};
  const orderBrandMap = {};
  const orderCapacityMap = {};
  const orderFulfillmentMap = { delivery_only: { count: 0, revenue: 0 }, delivery_installation: { count: 0, revenue: 0 }, customer_pickup: { count: 0, revenue: 0 } };
  orders.forEach((o) => {
    const fulfillment = o.fulfillmentType || "delivery_only";
    if (orderFulfillmentMap[fulfillment]) {
      orderFulfillmentMap[fulfillment].count++;
      orderFulfillmentMap[fulfillment].revenue += Number(o.total || 0);
    }
    (o.items || []).forEach((item) => {
      const name = item.modelLine || item.brand || "Unknown Unit";
      const brand = item.brand || "Unknown Brand";
      const capacity = item.capacity ? `${item.capacity}${item.capacityUnit || "HP"}` : "N/A";
      if (!orderProductMap[name]) orderProductMap[name] = { name, brand, capacity, channel: "order", quantity: 0, revenue: 0, avgUnitPrice: 0, orders: 0 };
      const row = orderProductMap[name];
      row.quantity += Number(item.quantity || 0);
      row.revenue += Number(item.totalPrice || 0);
      row.orders++;
      row.avgUnitPrice = row.quantity > 0 ? row.revenue / row.quantity : 0;
      if (!orderBrandMap[brand]) orderBrandMap[brand] = { brand, quantity: 0, revenue: 0, models: new Set() };
      orderBrandMap[brand].quantity += Number(item.quantity || 0);
      orderBrandMap[brand].revenue += Number(item.totalPrice || 0);
      orderBrandMap[brand].models.add(name);
      if (!orderCapacityMap[capacity]) orderCapacityMap[capacity] = { capacity, quantity: 0, revenue: 0, orders: 0 };
      orderCapacityMap[capacity].quantity += Number(item.quantity || 0);
      orderCapacityMap[capacity].revenue += Number(item.totalPrice || 0);
      orderCapacityMap[capacity].orders++;
    });
  });
  const topOrderProducts = Object.values(orderProductMap).sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  const orderBrandAnalysis = Object.values(orderBrandMap).map((b) => ({ ...b, models: b.models.size })).sort((a, b) => b.revenue - a.revenue);
  const orderCapacityAnalysis = Object.values(orderCapacityMap).sort((a, b) => b.revenue - a.revenue);

  // ── Combined product intelligence ──
  const allProductsMap = {};
  Object.values(posProductMap).forEach((p) => {
    const key = `pos:${p.name}`;
    allProductsMap[key] = { name: p.name, category: p.category || "POS", channel: "POS", quantity: p.quantity, revenue: p.revenue, cost: p.cost, profit: p.profit, orders: 1 };
  });
  Object.values(orderProductMap).forEach((p) => {
    const key = `order:${p.name}`;
    if (allProductsMap[key]) {
      allProductsMap[key].quantity += p.quantity;
      allProductsMap[key].revenue += p.revenue;
      allProductsMap[key].orders += p.orders;
    } else {
      allProductsMap[key] = { name: p.name, category: p.brand || "Aircon", channel: "Online Order", quantity: p.quantity, revenue: p.revenue, cost: 0, profit: 0, orders: p.orders };
    }
  });
  const combinedTopProducts = Object.values(allProductsMap).sort((a, b) => b.revenue - a.revenue).slice(0, 20);
  const totalProductUnits = combinedTopProducts.reduce((s, p) => s + p.quantity, 0);
  const totalProductRevenue = combinedTopProducts.reduce((s, p) => s + p.revenue, 0);

  // ── Payment status counts ──
  const paidBookings = filteredBookings.filter((b) => b.paymentStatus === "paid").length;
  const pendingPayments = filteredBookings.filter((b) => b.paymentStatus === "pending").length;
  const partialPayments = filteredBookings.filter((b) => b.paymentStatus === "partial").length;

  // ── Growth rate (first half vs second half of the reporting window) ──
  const halfStart = new Date(startDate.getTime() + (endDate - startDate) / 2);
  const firstHalfRevenue = filteredBookings.filter((b) => new Date(b.createdAt) < halfStart).reduce((s, b) => s + getBookingRevenue(b), 0)
    + orders.filter((o) => new Date(o.createdAt) < halfStart).reduce((s, o) => s + (o.total || 0), 0)
    + posSales.filter((s) => new Date(s.createdAt) < halfStart).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const secondHalfRevenue = filteredBookings.filter((b) => new Date(b.createdAt) >= halfStart).reduce((s, b) => s + getBookingRevenue(b), 0)
    + orders.filter((o) => new Date(o.createdAt) >= halfStart).reduce((s, o) => s + (o.total || 0), 0)
    + posSales.filter((s) => new Date(s.createdAt) >= halfStart).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const growthRate = firstHalfRevenue > 0 ? ((secondHalfRevenue - firstHalfRevenue) / firstHalfRevenue * 100) : 0;

  // ── Derived executive metrics ──
  const totalTransactions = filteredBookings.length + orders.length + posSales.length;
  const collectionRate = totalRevenue > 0 ? Math.min(100, (cohortNetCollections / totalRevenue) * 100) : 0;
  const refundRate = grossCollections > 0 ? (refunds / grossCollections) * 100 : 0;
  const serviceShare = totalRevenue > 0 ? (serviceRevenue / totalRevenue) * 100 : 0;
  const orderShare = totalRevenue > 0 ? (orderRevenue / totalRevenue) * 100 : 0;
  const posShare = totalRevenue > 0 ? (posRevenue / totalRevenue) * 100 : 0;
  const directCostCoverage = costDataCoverage;

  // ── Executive insights (strategic call-outs shown at the top of the report) ──
  const executiveInsights = [];
  if (growthRate >= 10) {
    executiveInsights.push({ tone: "success", title: "Revenue momentum", text: `Combined service, online-order, and POS revenue increased ${growthRate.toFixed(1)}% between the first and second half of this period.` });
  } else if (growthRate <= -10) {
    executiveInsights.push({ tone: "danger", title: "Revenue contraction", text: `Combined revenue declined ${Math.abs(growthRate).toFixed(1)}% between the first and second half of this period.` });
  }
  if (collectionRate < 70 && outstandingValue > 0) {
    executiveInsights.push({ tone: "warning", title: "Collection exposure", text: `${outstandingValue.toLocaleString("en-PH", { style: "currency", currency: "PHP" })} of approved booked value is not represented by an accepted payment record.` });
  }
  if (refunds > 0) {
    executiveInsights.push({ tone: refundRate >= 5 ? "warning" : "info", title: "Refund activity", text: `${refunds.toLocaleString("en-PH", { style: "currency", currency: "PHP" })} was refunded in this period (${refundRate.toFixed(1)}% of gross collections).` });
  }
  if (costDataCoverage < 95) {
    executiveInsights.push({ tone: "warning", title: "Incomplete cost basis", text: `Known cost coverage is ${costDataCoverage.toFixed(1)}%. Online orders without catalog cost are excluded from margin until their cost data is completed.` });
  }
  const leadingChannel = [
    { name: "Services", share: serviceShare },
    { name: "Online orders", share: orderShare },
    { name: "POS", share: posShare },
  ].sort((a, b) => b.share - a.share)[0];
  executiveInsights.push({ tone: leadingChannel.share >= 70 ? "warning" : "info", title: "Revenue concentration", text: `${leadingChannel.name} contribute ${leadingChannel.share.toFixed(1)}% of combined revenue across the three commercial channels in this period.` });
  if (grossProfit < 0) {
    executiveInsights.push({ tone: "danger", title: "Negative contribution", text: `Known direct costs (${totalPartsCost.toLocaleString("en-PH", { style: "currency", currency: "PHP" })}) exceed total revenue for this period — review parts, consumables, and labor costs.` });
  }
  if (grossProfit >= 0 && operatingProfit < 0) {
    executiveInsights.push({ tone: "danger", title: "Operating loss", text: `Contribution is positive, but approved expenses and payroll produce an operating loss of ${Math.abs(operatingProfit).toLocaleString("en-PH", { style: "currency", currency: "PHP" })}.` });
  }
  if (!executiveInsights.length) executiveInsights.push({ tone: "info", title: "Stable performance", text: "No material revenue or collection exception was detected in this period." });

  // ── Technicians for filter dropdown ──
  const technicians = await Technician.find({}, "name").sort({ name: 1 }).lean();

  return {
    filters: { startDate, endDate, source: sourceFilter, paymentMethod: pmFilter, paymentStatus: psFilter, serviceType: stFilter, technician: techFilter },
    technicians: technicians.map((t) => ({ id: t._id, name: t.name })),
    analytics: {
      totalRevenue, serviceRevenue, orderRevenue, posRevenue, posCost, posProfit,
      recognizedRevenue, recognizedGrossRevenue, recognizedServiceRevenue, recognizedOrderRevenue,
      grossCollections, refunds, refundRate, netCollections: paymentRevenue, cohortNetCollections,
      posMargin: posRevenue ? (posProfit / posRevenue) * 100 : 0,
      productRevenue, deliveryRevenue, installationRevenue,
      paymentRevenue,
      gcashRevenue: gcashRevenue + posGcashRevenue,
      codRevenue: codRevenue + posCashRevenue,
      bankRevenue: bankRevenue + posBankRevenue,
      otherRevenue: otherRecordedRevenue + posOtherRevenue,
      grossCollectionMethods,
      refundMethods: paymentLedger.refundsByMethod,
      coreRevenue, repairRevenue, mixRevenue,
      corePartsCost: serviceCostAnalytics.services
        .filter(s => { const b = recognizedBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "core" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      repairPartsCost: serviceCostAnalytics.services
        .filter(s => { const b = recognizedBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "repair" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      mixPartsCost: serviceCostAnalytics.services
        .filter(s => { const b = recognizedBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "mix" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      monthlyRevenue, dailyRevenue, monthlyPartsCost, totalPartsCost, grossProfit, grossProfitMargin,
      serviceDirectCost, orderCost: orderCostSummary.totalCost, orderCostCoverage: orderCostSummary.coveragePercent,
      orderCostBasis: orderCostSummary.basis, projectMaterialCost, approvedExpenseTotal, payrollCost,
      operatingExpenses, operatingProfit, operatingMargin, operatingProfitMargin: operatingMargin, costDataCoverage,
      serviceCosts: serviceCostAnalytics.totals,
      completedServiceCosts: serviceCostAnalytics.services.map(s => {
        const booking = recognizedBookings.find(b => String(b._id) === s.bookingId);
        return { ...s, serviceCategory: booking ? serviceCategory(booking) : "core" };
      }),
      directCostCoverage,
      paidBookings, pendingPayments, partialPayments,
      totalTransactions,
      recognizedTransactions: recognizedBookings.length + recognizedOrders.length + posSales.length,
      serviceTransactions: filteredBookings.length, orderTransactions: orders.length, posTransactions: posSales.length,
      avgTransactionValue: totalRevenue / (totalTransactions || 1),
      avgServiceTicket: filteredBookings.length ? serviceRevenue / filteredBookings.length : 0,
      avgOrderValue: orders.length ? orderRevenue / orders.length : 0,
      avgPosSale: posSales.length ? posRevenue / posSales.length : 0,
      collectionRate, outstandingValue, serviceShare, orderShare, posShare,
      topTechnicians, recentTransactions, growthRate: growthRate.toFixed(1), posPaymentMethods,
      topPosProducts: Object.values(posProductMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      topOrderProducts, orderBrandAnalysis, orderCapacityAnalysis, orderFulfillmentMap,
      combinedTopProducts, totalProductUnits, totalProductRevenue,
      executiveInsights,
    },
  };
}

async function buildRevenueDashboardSnapshot(now = new Date()) {
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthEnd = new Date(currentMonthStart.getTime() - 1);
  const [currentResult, previousResult] = await Promise.all([
    buildRevenueAnalytics({ from: currentMonthStart.toISOString(), to: now.toISOString().slice(0, 10) }),
    buildRevenueAnalytics({ from: previousMonthStart.toISOString(), to: previousMonthEnd.toISOString().slice(0, 10) }),
  ]);
  const current = currentResult.analytics;
  const previous = previousResult.analytics;
  const todayKey = localDateKey(now);
  const today = (current.dailyRevenue || []).find((row) => row.date === todayKey) || {};
  const lastSeven = (current.dailyRevenue || []).slice(-7);

  return {
    revenueToday: Number(today.recognized || 0),
    monthlyRevenue: Number(current.recognizedRevenue || 0),
    lastMonthRevenue: Number(previous.recognizedRevenue || 0),
    pendingPayments: Number(current.outstandingValue || 0),
    monthlyExpenses: Number(current.operatingExpenses || 0),
    profitMargin: Math.round(Number(current.operatingMargin || 0)),
    operatingProfit: Number(current.operatingProfit || 0),
    grossProfit: Number(current.grossProfit || 0),
    directCosts: Number(current.totalPartsCost || 0),
    refunds: Number(current.refunds || 0),
    grossCollections: Number(current.grossCollections || 0),
    netCollections: Number(current.netCollections || 0),
    bookedValue: Number(current.totalRevenue || 0),
    costDataCoverage: Number(current.costDataCoverage || 0),
    revenueBreakdown: {
      services: Number(current.recognizedServiceRevenue || 0),
      orders: Number(current.recognizedOrderRevenue || 0),
      pos: Number(current.posRevenue || 0),
      refunds: Number(current.refunds || 0),
    },
    revenueTrend7: lastSeven.map((row) => ({
      date: new Date(`${row.date}T00:00:00`).toLocaleDateString("en", { weekday: "short" }),
      amount: Number(row.recognized || 0),
      collections: Number(row.collections || 0),
      refunds: Number(row.refunds || 0),
    })),
  };
}

module.exports = { buildRevenueAnalytics, buildRevenueDashboardSnapshot, resolveDateRange };
