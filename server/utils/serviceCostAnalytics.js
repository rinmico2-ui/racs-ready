const ServiceToolUsage = require("../models/ServiceToolUsage");
const ServiceReport = require("../models/ServiceReport");
const EquipmentAssignment = require("../models/EquipmentAssignment");

function bookingRevenue(booking) {
  const items = booking.services || [];
  if (items.length) {
    const coreRevenue = items
      .filter(item => item.type !== "repair")
      .reduce((sum, item) => sum + Number(item.totalPrice ?? (Number(item.unitPrice) || 0) * (Number(item.quantity) || 1)), 0);
    const repairItems = items.filter(item => item.type === "repair");
    const repairInspectionRevenue = Number(booking.inspectionFeeTotalCollected || 0) || repairItems.reduce(
      (sum, item) => sum + Number(item.initialCost ?? item.unitPrice ?? 0) * Math.max(1, Number(item.quantity) || 1), 0,
    );
    const itemQuotationRevenue = repairItems.reduce((sum, item) => sum + Number(item.quotation?.totalCost || 0), 0);
    const quotationRevenue = itemQuotationRevenue || Number(booking.quotation?.totalCost || 0);
    return coreRevenue + repairInspectionRevenue + quotationRevenue + Number(booking.travelFare || 0);
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

async function buildServiceCostAnalytics(bookings, options = {}) {
  const completed = (bookings || []).filter(booking => booking.status === "completed");
  const ids = completed.map(booking => booking._id);
  if (!ids.length) return { services: [], equipment: [], totals: { revenue: 0, partsCost: 0, consumablesCost: 0, laborCost: 0, grossProfit: 0, grossProfitMargin: 0 } };

  const [usages, reports, assignments] = await Promise.all([
    ServiceToolUsage.find({ bookingId: { $in: ids } }).sort({ usedAt: 1 }).lean(),
    ServiceReport.find({ bookingId: { $in: ids } }).lean(),
    EquipmentAssignment.find({ bookingId: { $in: ids }, consumable: { $ne: true } })
      .populate("technicianId", "name firstName lastName userEmail").sort({ workDate: -1 }).lean(),
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
    return { bookingId: id, reference: booking.bookingReference || booking.workOrderNumber || id.slice(-8).toUpperCase(), serviceName: serviceName(booking, report), customer: booking.customer?.name || "Customer", technician: booking.technician?.name || equipment[0]?.technician || "Unassigned", completedAt: booking.updatedAt, revenue, partsCost, consumablesCost, laborCost, laborCostRecorded: laborCost > 0, localPurchaseCost, localPurchases, grossProfit, grossProfitMargin: revenue ? (grossProfit / revenue) * 100 : 0, laborHours: bookingReports.reduce((sum, row) => sum + Number(row.laborHours || 0), 0), consumables, repairParts, equipment };
  });
  const totals = services.reduce((sum, row) => ({ revenue: sum.revenue + row.revenue, partsCost: sum.partsCost + row.partsCost, consumablesCost: sum.consumablesCost + row.consumablesCost, laborCost: sum.laborCost + row.laborCost, localPurchaseCost: sum.localPurchaseCost + row.localPurchaseCost, grossProfit: sum.grossProfit + row.grossProfit }), { revenue: 0, partsCost: 0, consumablesCost: 0, laborCost: 0, localPurchaseCost: 0, grossProfit: 0 });
  totals.grossProfitMargin = totals.revenue ? (totals.grossProfit / totals.revenue) * 100 : 0;

  const equipmentGroups = new Map();
  services.flatMap(row => row.equipment).forEach(item => {
    const key = `${item.name}|${item.technician}`;
    if (!equipmentGroups.has(key)) equipmentGroups.set(key, { name: item.name, technician: item.technician, timesUsed: 0, checkoutStatus: item.checkoutStatus, returnStatus: item.returnStatus });
    const row = equipmentGroups.get(key); row.timesUsed += item.quantity; row.checkoutStatus = item.checkoutStatus; row.returnStatus = item.returnStatus;
  });
  return { services, equipment: [...equipmentGroups.values()].sort((a, b) => b.timesUsed - a.timesUsed), totals };
}

module.exports = { buildServiceCostAnalytics, bookingRevenue, directLaborCost };
