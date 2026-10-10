const BookingService = require("../models/BookingService");
const Inventory = require("../models/Inventory");
const Order = require("../models/Order");
const { buildRevenueDashboardSnapshot } = require("./revenueAnalytics");
const { remember } = require("./reportCache");
const {
  TERMINAL_BOOKING_STATUSES,
  TERMINAL_ORDER_STATUSES,
} = require("./adminOperationsDashboard");

function countPipeline(rows, terminalStatuses) {
  return (rows || []).reduce((summary, row) => {
    const status = String(row._id || "unknown");
    const count = Number(row.count || 0);
    summary.total += count;
    if (terminalStatuses.has(status)) summary.terminal += count;
    else summary.active += count;
    summary.byStatus[status] = count;
    return summary;
  }, { total: 0, active: 0, terminal: 0, byStatus: {} });
}

function buildReportCenterInsights(snapshot) {
  const financial = snapshot.financial;
  const operations = snapshot.operations;
  const inventory = snapshot.inventory;
  const insights = [];

  if (financial) {
    if (financial.operatingProfit < 0) {
      insights.push({ tone: "danger", title: "Saved costs are higher than completed sales", text: "Completed sales is below the direct costs, approved expenses, and payroll currently recorded for this month.", href: "/admin/reports/revenue#section-cost" });
    } else if (financial.monthlyRevenue > 0) {
      insights.push({ tone: "success", title: "Saved records show a profit", text: `The profit after saved costs is ${Math.round(financial.profitMargin || 0)}% of completed sales.`, href: "/admin/reports/revenue#section-cost" });
    }
    if (financial.pendingPayments > 0) {
      const outstanding = Number(financial.pendingPayments || 0).toLocaleString("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
      insights.push({ tone: "warning", title: "Unpaid amounts", text: `${outstanding} of approved work value has not been paid yet.`, href: "/admin/payments" });
    }
    if (Number(financial.costDataCoverage || 0) < 80) {
      insights.push({ tone: "warning", title: "Some cost details are missing", text: "Profit is an estimate until more job and product costs are saved.", href: "/admin/reports/revenue#section-cost" });
    }
  }

  if (inventory && inventory.alerts > 0) {
    insights.push({ tone: inventory.outOfStock > 0 ? "danger" : "warning", title: "Stock needs attention", text: `${inventory.outOfStock} item types have no stock and ${inventory.lowStock} have low stock. Check these items before buying more.`, href: "/admin/reports/inventory" });
  }
  if (financial && Number(financial.paymentActionCount || 0) > 0) {
    insights.push({ tone: Number(financial.paymentExceptionCount || 0) > 0 ? "danger" : "warning", title: "Payments need checking", text: `${financial.paymentActionCount} payment record${financial.paymentActionCount === 1 ? "" : "s"} need a payment check or a problem fixed.`, href: "/admin/payments" });
  }
  if (operations && operations.activeBookings + operations.activeOrders > 0) {
    insights.push({ tone: "info", title: "Unfinished bookings and orders", text: `${operations.activeBookings} service bookings and ${operations.activeOrders} product orders remain active.`, href: "/admin/operations/calendar" });
  }
  if (!insights.length) {
    insights.push({ tone: "info", title: "Nothing urgent to check", text: "Open a report to see changes over time and the records behind each total.", href: "/admin/reports/revenue" });
  }
  const priority = { danger: 0, warning: 1, info: 2, success: 3 };
  return insights
    .map((insight, index) => ({ ...insight, _index: index }))
    .sort((left, right) => (priority[left.tone] ?? 2) - (priority[right.tone] ?? 2) || left._index - right._index)
    .slice(0, 4)
    .map(({ _index, ...insight }) => insight);
}

async function computeReportCenterSnapshot(now = new Date()) {
  const [financialResult, bookingResult, orderResult, inventoryResult] = await Promise.allSettled([
    buildRevenueDashboardSnapshot(now),
    BookingService.aggregate([
      { $match: { sourceOrderId: null } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Inventory.aggregate([
      { $match: { active: true, status: { $ne: "discontinued" } } },
      {
        $group: {
          _id: null,
          skuCount: { $sum: 1 },
          units: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$quantity", 0] }, 0] }, { $ifNull: ["$quantity", 0] }, 0] } },
          outOfStock: { $sum: { $cond: [{ $lte: [{ $ifNull: ["$quantity", 0] }, 0] }, 1, 0] } },
          lowStock: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $ifNull: ["$quantity", 0] }, 0] },
                    { $lte: [{ $ifNull: ["$quantity", 0] }, { $ifNull: ["$minStockLevel", 3] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const bookingCounts = bookingResult.status === "fulfilled"
    ? countPipeline(bookingResult.value, new Set(TERMINAL_BOOKING_STATUSES))
    : null;
  const orderCounts = orderResult.status === "fulfilled"
    ? countPipeline(orderResult.value, new Set(TERMINAL_ORDER_STATUSES))
    : null;
  const stock = inventoryResult.status === "fulfilled" ? (inventoryResult.value[0] || {}) : null;

  const snapshot = {
    asOf: now.toISOString(),
    financial: financialResult.status === "fulfilled" ? {
      ...financialResult.value,
      paymentActionCount: Number(financialResult.value.pendingLedgerCount || 0)
        + Number(financialResult.value.paymentExceptionCount || 0),
    } : null,
    operations: bookingCounts && orderCounts ? {
      activeBookings: bookingCounts.active,
      activeOrders: orderCounts.active,
      totalBookings: bookingCounts.total,
      totalOrders: orderCounts.total,
    } : null,
    inventory: stock ? {
      skuCount: Number(stock.skuCount || 0),
      units: Number(stock.units || 0),
      outOfStock: Number(stock.outOfStock || 0),
      lowStock: Number(stock.lowStock || 0),
      alerts: Number(stock.outOfStock || 0) + Number(stock.lowStock || 0),
    } : null,
    sourceHealth: {
      financial: financialResult.status === "fulfilled",
      bookings: bookingResult.status === "fulfilled",
      orders: orderResult.status === "fulfilled",
      inventory: inventoryResult.status === "fulfilled",
    },
  };
  snapshot.partial = Object.values(snapshot.sourceHealth).some(value => !value);
  snapshot.insights = buildReportCenterInsights(snapshot);
  return snapshot;
}

function buildReportCenterSnapshot(now = new Date()) {
  const minuteBucket = Math.floor(now.getTime() / 60000);
  return remember("report-center", { minuteBucket }, () => computeReportCenterSnapshot(now), {
    ttlMs: 30000,
    maxEntries: 5,
  });
}

module.exports = {
  buildReportCenterInsights,
  buildReportCenterSnapshot,
  countPipeline,
};
