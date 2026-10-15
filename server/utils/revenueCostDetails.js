"use strict";

const { orderItemCost, orderCompletionDate, bookingCompletionDate, summarizeOrderConsumables } = require("./enterpriseRevenue");
const MAX_ROWS_PER_CATEGORY = 1000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value, limit = 500) => String(value || "").slice(0, limit);
const shortReference = (kind, value) => `${kind} …${String(value || "").slice(-8).toUpperCase()}`;
const sum = rows => rows.reduce((total, row) => total + number(row.amount), 0);
const close = (a, b) => Math.abs(a - b) < 0.005;
const savedPrice = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
function productPricing(item, quantity, cost, hasCost) {
  const sellingPrice = savedPrice(item.unitPrice);
  const salesAmount = savedPrice(item.totalPrice) ?? (sellingPrice === null ? null : sellingPrice * quantity);
  return { sellingPrice, salesAmount, grossProfit: salesAmount === null || !hasCost ? null : salesAmount - cost };
}

function buildRevenueCostDetails({ serviceRows = [], orders = [], orderCostCatalog = [], orderConsumableUsages = [], linkedServiceRows = [],
  posSales = [], projectMaterials = [], projectBookings = new Map(), operatingExpenses = [], payrollRows = [], totals = {} } = {}) {
  const categories = [
    ["service", "Service job costs"], ["orders", "Order and installation costs"], ["pos", "Walk-in / POS product costs"],
    ["project_materials", "Project materials"], ["expenses", "Approved operating expenses"], ["payroll", "Approved and paid payroll"],
  ].map(([key, label]) => ({ key, label, total: number(totals[key]), records: [] }));
  const groups = new Map(categories.map(group => [group.key, group]));
  function add(category, row, includeZero = false) {
    if (!includeZero && !number(row.amount)) return;
    groups.get(category).records.push({ ...row, title: text(row.title, 160), description: text(row.description),
      reference: text(row.reference, 100), status: text(row.status, 40), amount: number(row.amount) });
  }
  function serviceCosts(service, category, reference = service.reference, sourceId = service.bookingId, kind = "booking", completedAt = service.completedAt) {
    const base = { sourceId: String(sourceId || ""), kind, date: completedAt, reference, status: "completed" };
    for (const [field, label, fallback] of [["repairParts", "Repair part", "partsCost"], ["consumables", "Job supply", "consumablesCost"]]) {
      const items = service[field] || [];
      if (!items.length) add(category, { ...base, title: label, description: service.serviceName, amount: service[fallback], basis: "Saved service cost" });
      for (const item of items) {
        const quantity = number(item.quantity), cost = number(item.cost);
        add(category, { ...base, title: item.name || label, description: `${label} for ${service.serviceName || "service"}`, amount: cost,
          quantity, unit: text(item.unit || "pcs", 30), unitCost: quantity ? cost / quantity : null, basis: "Saved service cost" });
      }
    }
    add(category, { ...base, title: "Recorded job labor", description: service.serviceName, amount: service.laborCost, basis: "Saved internal labor cost" });
    if (service.localPurchases?.length) {
      for (const purchase of service.localPurchases) add(category, { ...base, title: purchase.partName || "Local purchase", description: purchase.source || "External supplier",
        amount: purchase.actualPurchaseCost, basis: "Saved local purchase cost" });
    } else add(category, { ...base, title: "Local purchases", description: service.serviceName, amount: service.localPurchaseCost, basis: "Saved local purchase cost" });
  }
  serviceRows.forEach(service => serviceCosts(service, "service"));

  const catalog = new Map(orderCostCatalog.map(item => [String(item._id), number(item.costPrice)]));
  const orderById = new Map(orders.map(order => [String(order._id), order]));
  const orderByBooking = new Map(orders.filter(order => order.bookingId).map(order => [String(order.bookingId), order]));
  for (const order of orders) {
    for (const item of order.items || []) {
      const quantity = Math.max(0, number(item.quantity)), unitCost = orderItemCost(item, catalog);
      add("orders", { sourceId: String(order._id), kind: "order", reference: order.orderReference || shortReference("Order", order._id), date: orderCompletionDate(order), status: order.status,
        title: [item.brand, item.modelLine, item.capacity].filter(Boolean).join(" ") || "Aircon product", quantity, unitCost, unit: "units", amount: quantity * unitCost,
        ...productPricing(item, quantity, quantity * unitCost, unitCost > 0),
        basis: Object.hasOwn(item, "costPrice") ? "Bought price saved on the order" : "Legacy order using current catalog cost",
        warning: quantity > 0 && !unitCost ? "No usable bought price is saved for this item. Its recorded cost is zero." : "" }, true);
    }
  }
  for (const usage of orderConsumableUsages) {
    const order = orderById.get(String(usage.orderId));
    if (!order || usage.itemType !== "consumable" || usage.lifecycleStatus === "voided") continue;
    const cost = summarizeOrderConsumables([order], [usage]).totalCost, quantity = Math.max(0, number(usage.quantityUsed));
    add("orders", { sourceId: String(order._id), kind: "order", reference: order.orderReference || shortReference("Order", order._id), date: orderCompletionDate(order), status: order.status,
      title: usage.itemName || "Installation supplies", quantity, unit: text(usage.unit || "pcs", 30), unitCost: quantity ? cost / quantity : null, amount: cost, basis: "Saved order supply usage cost" });
  }
  for (const service of linkedServiceRows) {
    const order = orderByBooking.get(String(service.bookingId));
    if (order) serviceCosts(service, "orders", order.orderReference || shortReference("Order", order._id), order._id, "order", orderCompletionDate(order));
  }
  for (const sale of posSales) {
    const components = (sale.items || []).map(item => {
      const quantity = number(item.quantity), unitCost = number(item.costPrice), amount = quantity * unitCost;
      return { label: text(item.itemName || "Counter product", 160), quantity, unit: text(item.unit || "pcs", 30), unitCost, amount,
        ...productPricing(item, quantity, amount, unitCost > 0) };
    });
    const amount = number(sale.totalCost), itemCost = sum(components);
    const salesAmount = savedPrice(sale.totalAmount), hasCost = savedPrice(sale.totalCost) !== null && components.length > 0 && components.every(item => item.unitCost > 0);
    add("pos", { sourceId: String(sale._id), kind: "pos", reference: sale.invoiceNumber || shortReference("Counter sale", sale._id), date: sale.completedAt || sale.createdAt,
      title: "Counter sale product cost", status: sale.status, amount, components, basis: "Total cost saved on the completed counter sale",
      salePricing: { salesAmount, discount: savedPrice(sale.discount), grossProfit: salesAmount === null || !hasCost ? null : salesAmount - amount },
      warning: !close(amount, itemCost) ? "The saved sale cost differs from the item costs below. The report uses the saved sale total; review the original sale."
        : components.some(item => item.quantity > 0 && item.unitCost <= 0) ? "Some items have no saved bought price. Their recorded cost is zero." : "" }, true);
  }
  for (const material of projectMaterials) {
    const booking = projectBookings.get(String(material.projectId));
    const quantity = number(material.quantity), cost = number(material.totalPrice || quantity * number(material.unitPrice));
    add("project_materials", { sourceId: String(material.projectId), kind: "project", reference: booking?.bookingReference || shortReference("Project", material.projectId),
      date: booking ? bookingCompletionDate(booking) : null, status: "fulfilled", title: material.itemName || "Project material",
      description: text(material.type), quantity, unitCost: quantity ? cost / quantity : null, unit: text(material.unit || "pcs", 30), amount: cost, basis: "Saved fulfilled material value" });
  }
  for (const expense of operatingExpenses.filter(row => row.status === "approved")) add("expenses", { sourceId: String(expense._id), kind: "expense", reference: shortReference("Expense", expense._id), date: expense.expenseDate,
    status: expense.status, title: text(expense.type).replaceAll("_", " ") || "Operating expense", description: expense.description,
    amount: expense.amount, basis: "Approved expense amount" });
  for (const payroll of payrollRows.filter(row => ["approved", "paid"].includes(row.status))) {
    const employee = payroll.employee && typeof payroll.employee === "object" ? payroll.employee : {};
    const employeeName = [employee.firstName, employee.lastName].filter(Boolean).join(" ");
    const components = [{ label: "Basic pay", amount: number(payroll.basicPay) }, { label: "Overtime pay", amount: number(payroll.overtimePay) },
      ...(payroll.allowances || []).map(item => ({ label: text(item.name || "Allowance", 80), amount: number(item.amount) }))];
    add("payroll", { sourceId: String(payroll._id), kind: "payroll", reference: payroll.payslipNumber || shortReference("Payroll", payroll._id), date: payroll.payDate,
      status: payroll.status, title: employeeName || "Staff payroll", description: "Gross payroll; employee deductions do not reduce this business cost.",
      periodStart: payroll.periodStart, periodEnd: payroll.periodEnd, amount: payroll.grossPay, components, basis: "Gross pay for approved or paid payroll",
      warning: !close(number(payroll.grossPay), sum(components)) ? "The saved gross pay differs from the available pay components. The report uses saved gross pay." : "" });
  }
  for (const category of categories) {
    category.records.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
    category.recordCount = category.records.length;
    category.recordedTotal = sum(category.records);
    category.reconciled = close(category.recordedTotal, category.total);
    category.records = category.records.slice(0, MAX_ROWS_PER_CATEGORY);
    category.truncated = category.records.length < category.recordCount;
  }
  return { categories, total: categories.reduce((total, category) => total + category.total, 0), reconciled: categories.every(category => category.reconciled), maxRecordsPerCategory: MAX_ROWS_PER_CATEGORY };
}

// Never mutate the shared analytics cache. Salary identities, references and
// individual amounts must not escape through secretary JSON/CSV/PDF responses.
function revenueAnalyticsForRole(analytics, role) {
  if (!analytics?.costDetails || role === "admin") return analytics;
  return { ...analytics, costDetails: { ...analytics.costDetails, categories: analytics.costDetails.categories.map(category => category.key === "payroll"
    ? { ...category, records: [], restricted: true } : category) } };
}

module.exports = { MAX_ROWS_PER_CATEGORY, buildRevenueCostDetails, revenueAnalyticsForRole };
