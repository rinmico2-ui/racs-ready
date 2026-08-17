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
const {
  bookingApprovedValue, buildProjectPricingMap, isRepairBooking, normalizePaymentMethod, paymentDate,
} = require("./revenueRecognition");
const { buildServiceCostAnalytics } = require("./serviceCostAnalytics");

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
    startDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth() - 11, 1);
    endDate = to ? new Date(`${to}T23:59:59`) : now;
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
    $or: [
      { verifiedAt: dateFilter }, { completedAt: dateFilter },
      { collectedAt: dateFilter }, { submittedAt: dateFilter },
    ],
    status: { $in: ["payment_collected", "waiting_for_remittance", "remitted", "verified", "paid", "partial"] },
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

  const [bookings, rawPayments, orders, posSales] = await Promise.all([
    sourceFilter === "pos" || sourceFilter === "order" ? [] : BookingService.find(bookingsQuery).lean(),
    Payment.find(paymentsQuery).lean(),
    sourceFilter === "service" || sourceFilter === "pos" || serviceOnlyScope ? [] : Order.find(ordersQuery).lean(),
    sourceFilter === "service" || sourceFilter === "order" || serviceOnlyScope || !["all", "paid"].includes(psFilter) ? [] : WalkInSale.find(posQuery).lean(),
  ]);
  const projectPricingMap = await buildProjectPricingMap(bookings);
  const visibleBookingIds = new Set(bookings.map((booking) => String(booking._id)));
  const visibleOrderIds = new Set(orders.map((order) => String(order._id)));
  const visibleProjectIds = new Set(Array.from(projectPricingMap.values()).map((entry) => entry.projectId));
  let payments = rawPayments.filter((payment) => {
    const eventDate = new Date(paymentDate(payment));
    if (Number.isNaN(eventDate.getTime()) || eventDate < startDate || eventDate > endDate) return false;
    if (sourceFilter === "service") return (payment.bookingId && visibleBookingIds.has(String(payment.bookingId)))
      || (payment.projectId && visibleProjectIds.has(String(payment.projectId)));
    if (sourceFilter === "order") return payment.orderId && visibleOrderIds.has(String(payment.orderId));
    if (sourceFilter === "pos") return false;
    return (payment.bookingId && visibleBookingIds.has(String(payment.bookingId)))
      || (payment.projectId && visibleProjectIds.has(String(payment.projectId)))
      || (payment.orderId && visibleOrderIds.has(String(payment.orderId)));
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
  let filteredBookings = bookings;
  if (stFilter === "core") filteredBookings = filteredBookings.filter((booking) => !isRepairBooking(booking));
  if (stFilter === "repair") filteredBookings = filteredBookings.filter(isRepairBooking);
  if (psFilter !== "all") {
    filteredBookings = filteredBookings.filter((b) => b.paymentStatus === psFilter);
  }
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
  payments = payments.filter((payment) => {
    if (payment.bookingId) return filteredBookingIds.has(String(payment.bookingId));
    if (payment.projectId) return filteredProjectIds.has(String(payment.projectId));
    if (payment.orderId) return visibleOrderIds.has(String(payment.orderId));
    return false;
  });

  // ── Core metrics ──
  const serviceRevenue = filteredBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0);
  const orderRevenue = orders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0);
  const posRevenue = posSales.reduce((sum, s) => sum + Number(s.totalAmount || 0), 0);
  const posCost = posSales.reduce((sum, s) => sum + Number(s.totalCost || 0), 0);
  const posProfit = posRevenue - posCost;
  const paymentRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0) + posRevenue;
  const totalRevenue = serviceRevenue + orderRevenue + posRevenue;

  // ── Revenue by source ──
  const productRevenue = orders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
  const deliveryRevenue = orders.reduce((sum, o) => sum + (o.deliveryFee || 0), 0);
  const installationRevenue = orders.reduce((sum, o) => sum + (o.installationFee || 0), 0);

  // ── Payment method breakdown ──
  const gcashRevenue = payments.filter((p) => normalizePaymentMethod(p.method) === "gcash").reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const codRevenue = payments.filter((p) => normalizePaymentMethod(p.method) === "cash").reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const bankRevenue = payments.filter((p) => normalizePaymentMethod(p.method) === "bank").reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const otherRecordedRevenue = payments
    .filter((p) => normalizePaymentMethod(p.method) === "other")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

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

    const monthKey = monthStart.toLocaleString("en-PH", { month: "short", year: "numeric" });
    monthlyRevenue[monthKey] = {
      service: mBookings.reduce((s, b) => s + getBookingRevenue(b), 0),
      orders: mOrders.reduce((s, o) => s + (o.total || o.totalAmount || 0), 0),
      pos: mPos.reduce((s, p) => s + Number(p.totalAmount || 0), 0),
      total: 0,
    };
    monthlyRevenue[monthKey].total = monthlyRevenue[monthKey].service + monthlyRevenue[monthKey].orders + monthlyRevenue[monthKey].pos;
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
  filteredBookings.forEach((b) => {
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
  const serviceCostAnalytics = await buildServiceCostAnalytics(filteredBookings, {
    revenueResolver: getBookingRevenue,
  });
  const totalPartsCost = serviceCostAnalytics.totals.partsCost
    + serviceCostAnalytics.totals.consumablesCost
    + serviceCostAnalytics.totals.localPurchaseCost
    + serviceCostAnalytics.totals.laborCost
    + posCost;
  const grossProfit = totalRevenue - totalPartsCost;
  const grossProfitMargin = totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : "0.0";
  const directCostByBooking = new Map(serviceCostAnalytics.services.map((service) => [
    String(service.bookingId),
    Number(service.partsCost || 0) + Number(service.consumablesCost || 0)
      + Number(service.localPurchaseCost || 0) + Number(service.laborCost || 0),
  ]));
  topTechnicians.forEach((technicianRow) => {
    const technicianBookingIds = filteredBookings
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
  const collectionRate = totalRevenue > 0 ? Math.min(100, (paymentRevenue / totalRevenue) * 100) : 0;
  const outstandingValue = Math.max(0, totalRevenue - paymentRevenue);
  const serviceShare = totalRevenue > 0 ? (serviceRevenue / totalRevenue) * 100 : 0;
  const orderShare = totalRevenue > 0 ? (orderRevenue / totalRevenue) * 100 : 0;
  const posShare = totalRevenue > 0 ? (posRevenue / totalRevenue) * 100 : 0;
  const directCostCoverage = totalRevenue > 0 ? (totalPartsCost / totalRevenue) * 100 : 0;

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
  const leadingChannel = [
    { name: "Services", share: serviceShare },
    { name: "Online orders", share: orderShare },
    { name: "POS", share: posShare },
  ].sort((a, b) => b.share - a.share)[0];
  executiveInsights.push({ tone: leadingChannel.share >= 70 ? "warning" : "info", title: "Revenue concentration", text: `${leadingChannel.name} contribute ${leadingChannel.share.toFixed(1)}% of combined revenue across the three commercial channels in this period.` });
  if (grossProfit < 0) {
    executiveInsights.push({ tone: "danger", title: "Negative contribution", text: `Known direct costs (${totalPartsCost.toLocaleString("en-PH", { style: "currency", currency: "PHP" })}) exceed total revenue for this period — review parts, consumables, and labor costs.` });
  }
  if (!executiveInsights.length) executiveInsights.push({ tone: "info", title: "Stable performance", text: "No material revenue or collection exception was detected in this period." });

  // ── Technicians for filter dropdown ──
  const technicians = await Technician.find({}, "name").sort({ name: 1 }).lean();

  return {
    filters: { startDate, endDate, source: sourceFilter, paymentMethod: pmFilter, paymentStatus: psFilter, serviceType: stFilter, technician: techFilter },
    technicians: technicians.map((t) => ({ id: t._id, name: t.name })),
    analytics: {
      totalRevenue, serviceRevenue, orderRevenue, posRevenue, posCost, posProfit,
      posMargin: posRevenue ? (posProfit / posRevenue) * 100 : 0,
      productRevenue, deliveryRevenue, installationRevenue,
      paymentRevenue,
      gcashRevenue: gcashRevenue + posGcashRevenue,
      codRevenue: codRevenue + posCashRevenue,
      bankRevenue: bankRevenue + posBankRevenue,
      otherRevenue: otherRecordedRevenue + posOtherRevenue,
      coreRevenue, repairRevenue, mixRevenue,
      corePartsCost: serviceCostAnalytics.services
        .filter(s => { const b = filteredBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "core" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      repairPartsCost: serviceCostAnalytics.services
        .filter(s => { const b = filteredBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "repair" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      mixPartsCost: serviceCostAnalytics.services
        .filter(s => { const b = filteredBookings.find(fb => String(fb._id) === s.bookingId); return b ? serviceCategory(b) === "mix" : false; })
        .reduce((sum, s) => sum + (s.partsCost || 0), 0),
      monthlyRevenue, monthlyPartsCost, totalPartsCost, grossProfit, grossProfitMargin,
      serviceCosts: serviceCostAnalytics.totals,
      completedServiceCosts: serviceCostAnalytics.services.map(s => {
        const booking = filteredBookings.find(b => String(b._id) === s.bookingId);
        return { ...s, serviceCategory: booking ? serviceCategory(booking) : "core" };
      }),
      directCostCoverage,
      paidBookings, pendingPayments, partialPayments,
      totalTransactions,
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

module.exports = { buildRevenueAnalytics };
