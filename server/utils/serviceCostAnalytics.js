const ServiceToolUsage = require("../models/ServiceToolUsage");
const ServiceReport = require("../models/ServiceReport");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const { bookingCompletionDate, RECOGNIZED_BOOKING_STATUSES } = require("./enterpriseRevenue");
const { allocateServiceRevenue } = require("./serviceAnalytics");

function bookingRevenue(booking) {
  const items = booking.services || [];
  if (items.length) {
    const coreRevenue = items
      .filter(item => item.type !== "repair")
      .reduce((sum, item) => sum + (booking.loyaltyDiscount ? require('./transactionDiscounts').serviceLineValue(item)
        : Number(item.totalPrice ?? (Number(item.unitPrice) || 0) * (Number(item.quantity) || 1))), 0);
    const repairItems = items.filter(item => item.type === "repair");
    const repairInspectionRevenue = Number(booking.inspectionFeeTotalCollected || 0) || repairItems.reduce(
      (sum, item) => sum + Number(item.initialCost ?? item.unitPrice ?? 0) * Math.max(1, Number(item.quantity) || 1), 0,
    );
    const itemQuotationRevenue = repairItems.reduce((sum, item) => sum + Number(item.quotation?.totalCost || 0), 0);
    const quotationRevenue = itemQuotationRevenue || Number(booking.quotation?.totalCost || 0);
    return Math.max(0, coreRevenue - Number(booking.discount || 0)) + repairInspectionRevenue + quotationRevenue + Number(booking.travelFare || 0);
  }
  const isRepair = booking.serviceType === "repair" || booking.serviceModel === "RepairService" ||
    items.some(service => service.type === "repair");
  if (isRepair) return Number(booking.inspectionFeeTotalCollected || booking.initialCost || 0) + Number(booking.quotation?.totalCost || 0);
  return Number(booking.totalPrice || booking.estimatedFee || 0);
}

function serviceName(booking, report) {
  return report?.serviceName || booking.service?.name || (booking.services || []).map(s => s.name).filter(Boolean).join(", ") ||
    (booking.serviceType === "repair" || booking.serviceModel === "RepairService" ? "Repair Service" : "Service");
}

function usageCost(item) {
  return Number(item.toolCost || (Number(item.quantityUsed || 0) * Number(item.unitPrice || 0)) || 0);
}

function directLaborCost(report) {
  return Number(report?.actualLaborCost || 0);
}

function buildServiceLineAllocations(booking, summary = {}) {
  const revenue = Number(summary.revenue || 0);
  const partsCost = Number(summary.partsCost || 0);
  const consumablesCost = Number(summary.consumablesCost || 0);
  const laborCost = Number(summary.laborCost || 0);
  const localPurchaseCost = Number(summary.localPurchaseCost || 0);
  const allocatedRevenue = allocateServiceRevenue(booking, revenue);
  const rawAllocatedTotal = allocatedRevenue.reduce((sum, line) => sum + Number(line.allocatedRevenue || 0), 0);
  const totalUnits = allocatedRevenue.reduce((sum, line) => sum + Math.max(1, Number(line.quantity) || 1), 0) || 1;
  const itemCosts = summary.itemCosts instanceof Map ? summary.itemCosts : new Map();
  const allocatedLineIds = new Set(allocatedRevenue.map((line) => String(line._id || "")).filter(Boolean));
  const exactTotals = [...itemCosts.entries()].filter(([lineId]) => allocatedLineIds.has(String(lineId))).map(([, costs]) => costs).reduce((totals, costs) => ({
    partsCost: totals.partsCost + Number(costs.partsCost || 0),
    consumablesCost: totals.consumablesCost + Number(costs.consumablesCost || 0),
    laborCost: totals.laborCost + Number(costs.laborCost || 0),
  }), { partsCost: 0, consumablesCost: 0, laborCost: 0 });
  const sharedCosts = {
    partsCost: Math.max(0, partsCost - exactTotals.partsCost),
    consumablesCost: Math.max(0, consumablesCost - exactTotals.consumablesCost),
    laborCost: Math.max(0, laborCost - exactTotals.laborCost),
  };
  return allocatedRevenue.map((line) => {
    const quantity = Math.max(1, Number(line.quantity) || 1);
    const lineRevenue = rawAllocatedTotal > 0
      ? Number(line.allocatedRevenue || 0) * (revenue / rawAllocatedTotal)
      : revenue * (quantity / totalUnits);
    const share = revenue > 0 ? lineRevenue / revenue : quantity / totalUnits;
    const lineId = String(line._id || "");
    const exact = itemCosts.get(lineId) || {};
    const linePartsCost = Number(exact.partsCost || 0) + sharedCosts.partsCost * share;
    const lineConsumablesCost = Number(exact.consumablesCost || 0) + sharedCosts.consumablesCost * share;
    const lineLaborCost = Number(exact.laborCost || 0) + sharedCosts.laborCost * share;
    const lineLocalPurchaseCost = localPurchaseCost * share;
    const lineDirectCost = linePartsCost + lineConsumablesCost + lineLaborCost + lineLocalPurchaseCost;
    const lineGrossProfit = lineRevenue - lineDirectCost;
    const type = String(line.type || booking.serviceType || "core").toLowerCase();
    return {
      serviceItemId: line._id || line.serviceId || null,
      serviceName: line.name || summary.fallbackName || "Service",
      serviceCategory: type === "repair" ? "repair" : type === "mixed" ? "mix" : "core",
      quantity,
      completedAt: summary.completedAt,
      revenue: lineRevenue,
      partsCost: linePartsCost,
      consumablesCost: lineConsumablesCost,
      laborCost: lineLaborCost,
      localPurchaseCost: lineLocalPurchaseCost,
      grossProfit: lineGrossProfit,
      grossProfitMargin: lineRevenue ? (lineGrossProfit / lineRevenue) * 100 : 0,
      allocationMethod: allocatedRevenue.length > 1
        ? (itemCosts.has(lineId) ? "service_item_then_revenue_share" : "revenue_share")
        : "direct_booking",
    };
  });
}

async function buildServiceCostAnalytics(bookings, options = {}) {
  const completed = (bookings || []).filter(booking => RECOGNIZED_BOOKING_STATUSES.has(booking.status));
  const ids = completed.map(booking => booking._id);
  if (!ids.length) {
    const empty = { services: [], equipment: [], totals: { revenue: 0, partsCost: 0, consumablesCost: 0, laborCost: 0, unpricedConsumablesCount: 0, grossProfit: 0, grossProfitMargin: 0 } };
    if (options.includeSourceRows) empty.sourceRows = { reports: [], assignments: [] };
    return empty;
  }

  // These collections can contain image/signature payloads and long workflow
  // histories. Profitability only needs the fields below, so keep the report
  // query deliberately narrow. This is especially important for hosted MongoDB
  // connections where transferring base64 evidence can dominate the request.
  const [usages, reports, assignments] = await Promise.all([
    ServiceToolUsage.find({ bookingId: { $in: ids }, lifecycleStatus: { $ne: "voided" }, ...(options.excludeOrderLinkedUsage ? { orderId: null } : {}) })
      .select("bookingId serviceItemId itemName itemType unit quantityUsed unitPrice toolCost usedAt")
      .sort({ usedAt: 1 })
      .lean(),
    ServiceReport.find({ bookingId: { $in: ids } })
      .select("bookingId serviceItemId technicianId serviceName partsReplaced laborHours actualLaborCost status submittedAt followUpRequired createdAt updatedAt")
      .lean(),
    EquipmentAssignment.find({ bookingId: { $in: ids }, consumable: { $ne: true } })
      .select("bookingId technicianId equipmentName quantity status checkedOutAt returnedAt workDate")
      .populate("technicianId", "name firstName lastName userEmail")
      .sort({ workDate: -1 })
      .lean(),
  ]);
  const usageMap = new Map();
  usages.forEach(item => {
    const key = String(item.bookingId);
    if (!usageMap.has(key)) usageMap.set(key, []);
    usageMap.get(key).push(item);
  });
  const reportMap = new Map();
  reports.forEach(report => {
    const key = String(report.bookingId);
    if (!reportMap.has(key)) reportMap.set(key, []);
    reportMap.get(key).push(report);
  });
  const assignmentMap = new Map();
  assignments.forEach(item => {
    const key = String(item.bookingId);
    if (!assignmentMap.has(key)) assignmentMap.set(key, []);
    assignmentMap.get(key).push(item);
  });

  const services = completed.map(booking => {
    const id = String(booking._id);
    const bookingReports = reportMap.get(id) || [];
    const report = bookingReports.find(row => !row.serviceItemId) || bookingReports[0];
    const serviceUsages = usageMap.get(id) || [];
    const consumables = serviceUsages.filter(item => item.itemType === "consumable").map(item => ({ name: item.itemName, quantity: Number(item.quantityUsed || 0), unit: item.unit || "pcs", cost: usageCost(item) }));
    const unpricedConsumablesCount = consumables.filter(item => item.quantity > 0 && item.cost <= 0).length;
    let repairParts = serviceUsages.filter(item => item.itemType === "part").map(item => ({ name: item.itemName, quantity: Number(item.quantityUsed || 0), unit: item.unit || "pcs", cost: usageCost(item) }));
    if (!repairParts.length && bookingReports.some(row => row.partsReplaced?.length)) repairParts = bookingReports.flatMap(row => row.partsReplaced || []).map(item => ({ name: item.name, quantity: Number(item.quantity || 0), unit: item.unit || "pcs", cost: Number(item.cost || 0) * Number(item.quantity || 1) }));
    const equipment = (assignmentMap.get(id) || []).map(item => ({ name: item.equipmentName, technician: item.technicianId?.name || [item.technicianId?.firstName, item.technicianId?.lastName].filter(Boolean).join(" ") || booking.technician?.name || "Unassigned", quantity: Number(item.quantity || 1), status: item.status, checkoutStatus: item.checkedOutAt ? "Checked out" : item.status === "reserved" ? "Reserved" : "Not checked out", returnStatus: item.returnedAt || item.status === "returned" ? "Returned" : ["damaged", "lost"].includes(item.status) ? item.status : "Outstanding" }));

    // Local purchases (bought from external shop by technician)
    const localPurchases = (booking.localPurchase || []).map(lp => ({
      partName: lp.partName,
      quotedCustomerPrice: Number(lp.quotedCustomerPrice || 0),
      actualPurchaseCost: Number(lp.actualPurchaseCost || 0),
      source: lp.source || "External Supplier",
      purchasedBy: lp.purchasedByName || "Technician",
      purchaseStatus: lp.purchaseStatus || "purchased",
      receiptUrl: lp.receiptUrl || "",
      purchasedAt: lp.purchasedAt,
    }));
    const localPurchaseCost = localPurchases.reduce((sum, lp) => sum + lp.actualPurchaseCost, 0);

    const revenue = typeof options.revenueResolver === "function"
      ? Number(options.revenueResolver(booking) || 0)
      : bookingRevenue(booking);
    const partsCost = repairParts.reduce((sum, item) => sum + item.cost, 0);
    const consumablesCost = consumables.reduce((sum, item) => sum + item.cost, 0);
    // Quotation/legacy laborCost is a customer fee already included in
    // revenue. Deduct only a separately recorded internal labor expense.
    const laborCost = bookingReports.reduce((sum, row) => sum + directLaborCost(row), 0);
    const grossProfit = revenue - partsCost - consumablesCost - laborCost - localPurchaseCost;
    const itemCosts = new Map();
    const addItemCost = (serviceItemId, field, amount) => {
      if (!serviceItemId || Number(amount || 0) <= 0) return;
      const key = String(serviceItemId);
      if (!itemCosts.has(key)) itemCosts.set(key, { partsCost: 0, consumablesCost: 0, laborCost: 0 });
      itemCosts.get(key)[field] += Number(amount || 0);
    };
    serviceUsages.forEach((item) => {
      if (item.itemType === "part") addItemCost(item.serviceItemId, "partsCost", usageCost(item));
      if (item.itemType === "consumable") addItemCost(item.serviceItemId, "consumablesCost", usageCost(item));
    });
    bookingReports.forEach((row) => addItemCost(row.serviceItemId, "laborCost", directLaborCost(row)));
    if (!serviceUsages.some((item) => item.itemType === "part")) {
      bookingReports.forEach((row) => (row.partsReplaced || []).forEach((item) => {
        addItemCost(row.serviceItemId, "partsCost", Number(item.cost || 0) * Number(item.quantity || 1));
      }));
    }
    const serviceLines = buildServiceLineAllocations(booking, {
      revenue, partsCost, consumablesCost, laborCost, localPurchaseCost,
      fallbackName: serviceName(booking, report),
      completedAt: bookingCompletionDate(booking),
      itemCosts,
    });
    return { bookingId: id, reference: booking.bookingReference || booking.workOrderNumber || id.slice(-8).toUpperCase(), serviceName: serviceName(booking, report), customer: booking.customer?.name || "Customer", technician: booking.technician?.name || equipment[0]?.technician || "Unassigned", completedAt: bookingCompletionDate(booking), revenue, partsCost, consumablesCost, unpricedConsumablesCount, laborCost, laborCostRecorded: laborCost > 0, localPurchaseCost, localPurchases, grossProfit, grossProfitMargin: revenue ? (grossProfit / revenue) * 100 : 0, laborHours: bookingReports.reduce((sum, row) => sum + Number(row.laborHours || 0), 0), consumables, repairParts, equipment, serviceLines };
  });
  const totals = services.reduce((sum, row) => ({ revenue: sum.revenue + row.revenue, partsCost: sum.partsCost + row.partsCost, consumablesCost: sum.consumablesCost + row.consumablesCost, unpricedConsumablesCount: sum.unpricedConsumablesCount + row.unpricedConsumablesCount, laborCost: sum.laborCost + row.laborCost, localPurchaseCost: sum.localPurchaseCost + row.localPurchaseCost, grossProfit: sum.grossProfit + row.grossProfit }), { revenue: 0, partsCost: 0, consumablesCost: 0, unpricedConsumablesCount: 0, laborCost: 0, localPurchaseCost: 0, grossProfit: 0 });
  totals.grossProfitMargin = totals.revenue ? (totals.grossProfit / totals.revenue) * 100 : 0;

  const equipmentGroups = new Map();
  services.flatMap(row => row.equipment).forEach(item => {
    const key = `${item.name}|${item.technician}`;
    if (!equipmentGroups.has(key)) equipmentGroups.set(key, { name: item.name, technician: item.technician, timesUsed: 0, checkoutStatus: item.checkoutStatus, returnStatus: item.returnStatus });
    const row = equipmentGroups.get(key); row.timesUsed += item.quantity; row.checkoutStatus = item.checkoutStatus; row.returnStatus = item.returnStatus;
  });
  const result = { services, equipment: [...equipmentGroups.values()].sort((a, b) => b.timesUsed - a.timesUsed), totals };
  // Report pages can reuse these already-fetched rows for workflow controls,
  // avoiding duplicate ServiceReport and EquipmentAssignment queries.
  if (options.includeSourceRows) result.sourceRows = { reports, assignments };
  return result;
}

module.exports = { buildServiceCostAnalytics, bookingRevenue, buildServiceLineAllocations, directLaborCost };
