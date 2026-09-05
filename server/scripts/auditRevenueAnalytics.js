"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { buildMongoConnectionUri } = require("../utils/mongoConnection");
const { buildRevenueAnalytics } = require("../utils/revenueAnalytics");

const terminalBookingStatuses = new Set(["completed", "repair_completed", "closed"]);
const acceptedPaymentStatuses = new Set(["verified", "paid", "partial", "remitted"]);
const number = (value) => Number(value || 0);
const percent = (part, whole) => whole ? Math.round((part / whole) * 1000) / 10 : null;
const dateValue = (value) => value ? new Date(value).getTime() : NaN;
const validDate = (value) => Number.isFinite(dateValue(value));
const sum = (rows, selector) => rows.reduce((total, row) => total + number(selector(row)), 0);
const distribution = (rows, selector) => rows.reduce((result, row) => {
  const key = String(selector(row) || "missing");
  result[key] = (result[key] || 0) + 1;
  return result;
}, {});

function bookingCompletion(booking) {
  if (validDate(booking.completedAt)) return booking.completedAt;
  if (validDate(booking.repairCompletion?.completedAt)) return booking.repairCompletion.completedAt;
  if (validDate(booking.slaTracking?.resolutionAt)) return booking.slaTracking.resolutionAt;
  const history = [...(booking.statusHistory || [])].reverse().find((event) =>
    terminalBookingStatuses.has(event?.toStatus || event?.status));
  return history?.timestamp || history?.changedAt || booking.updatedAt;
}

function orderCompletion(order) {
  if (validDate(order.completedAt)) return order.completedAt;
  const history = [...(order.statusHistory || [])].reverse().find((event) => event?.status === "completed");
  return history?.timestamp || order.updatedAt;
}

async function readCollection(database, name, projection) {
  const exists = (await database.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  return exists ? database.collection(name).find({}, { projection }).toArray() : [];
}

async function main() {
  const configuredUri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/appointment_scheduler";
  const connection = buildMongoConnectionUri(configuredUri, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET,
    authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(connection.uri, { serverSelectionTimeoutMS: 15000 });
  const database = mongoose.connection.db;
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const [bookings, orders, posSales, payments, expenses, payrolls, inventories, hvacProducts, serviceReports, serviceUsage, projectMaterials, projects] = await Promise.all([
    readCollection(database, "bookingservices", { status:1, createdAt:1, updatedAt:1, completedAt:1, repairCompletion:1, slaTracking:1, statusHistory:1, totalPrice:1, estimatedFee:1, amountPaid:1, paymentStatus:1, sourceOrderId:1, orderId:1 }),
    readCollection(database, "orders", { status:1, createdAt:1, updatedAt:1, completedAt:1, statusHistory:1, total:1, subtotal:1, paymentStatus:1, items:1, bookingId:1 }),
    readCollection(database, "walkinsales", { status:1, createdAt:1, completedAt:1, totalAmount:1, totalCost:1, items:1 }),
    readCollection(database, "payments", { status:1, amount:1, refundAmount:1, refundStatus:1, bookingId:1, orderId:1, projectId:1, verifiedAt:1, completedAt:1, collectedAt:1, submittedAt:1, refundedAt:1 }),
    readCollection(database, "expenses", { status:1, amount:1, expenseDate:1, bookingId:1, projectId:1 }),
    readCollection(database, "payrolls", { status:1, netPay:1, payDate:1 }),
    readCollection(database, "inventories", { costPrice:1, sellingPrice:1 }),
    readCollection(database, "hvac_products", { costPrice:1, sellingPrice:1, variants:1 }),
    readCollection(database, "servicereports", { bookingId:1, status:1, partsCost:1, laborCost:1, totalCost:1 }),
    readCollection(database, "servicetoolusages", { bookingId:1, toolCost:1, quantityUsed:1, unitPrice:1 }),
    readCollection(database, "projectmaterials", { projectId:1, status:1, type:1, quantity:1, unitPrice:1, totalPrice:1 }),
    readCollection(database, "projects", { status:1, createdAt:1, totalAmount:1, contractValue:1 }),
  ]);

  const recentBookings = bookings.filter((row) => validDate(row.createdAt) && new Date(row.createdAt) >= twelveMonthsAgo && row.status !== "cancelled");
  const completedBookings = bookings.filter((row) => terminalBookingStatuses.has(row.status));
  const recentOrders = orders.filter((row) => validDate(row.createdAt) && new Date(row.createdAt) >= twelveMonthsAgo && row.status !== "cancelled");
  const completedOrders = orders.filter((row) => row.status === "completed");
  const completedPos = posSales.filter((row) => row.status === "completed");
  const orderLines = orders.flatMap((order) => (order.items || []).map((item) => ({ ...item, orderStatus:order.status })));
  const completedOrderLines = orderLines.filter((line) => line.orderStatus === "completed");
  const completedBookingIds = new Set(completedBookings.map((row) => String(row._id)));
  const costedServiceIds = new Set([
    ...serviceReports.filter((row) => number(row.totalCost) > 0 || number(row.partsCost) > 0 || number(row.laborCost) > 0).map((row) => String(row.bookingId)),
    ...serviceUsage.filter((row) => number(row.toolCost) > 0 || number(row.unitPrice) > 0).map((row) => String(row.bookingId)),
  ]);
  const acceptedPayments = payments.filter((row) => acceptedPaymentStatuses.has(row.status));
  const linkedPayments = payments.filter((row) => row.bookingId || row.orderId || row.projectId);
  const inventoryCostIds = new Set([
    ...inventories.filter((row) => number(row.costPrice) > 0).map((row) => String(row._id)),
    ...hvacProducts.flatMap((product) => (product.variants || [])
      .filter((variant) => number(variant.costPrice) > 0)
      .map((variant) => String(variant._id))),
  ]);
  const orderUnits = sum(completedOrderLines, (line) => line.quantity);
  const catalogCostedUnits = sum(completedOrderLines.filter((line) => line.inventoryId && inventoryCostIds.has(String(line.inventoryId))), (line) => line.quantity);
  const posLines = completedPos.flatMap((sale) => sale.items || []);
  const posUnits = sum(posLines, (line) => line.quantity);
  const posCostedUnits = sum(posLines.filter((line) => number(line.costPrice) > 0), (line) => line.quantity);
  const { filters: engineFilters, analytics: engine } = await buildRevenueAnalytics();

  const audit = {
    generatedAt: new Date().toISOString(),
    database: { collectionsReviewed: 12, remoteConnection: connection.uri.startsWith("mongodb") && !connection.uri.includes("localhost") },
    population: {
      bookings: bookings.length, orders: orders.length, posSales: posSales.length, payments: payments.length,
      expenses: expenses.length, payrolls: payrolls.length, inventoryItems: inventories.length, hvacProducts: hvacProducts.length,
      projectMaterials: projectMaterials.length, projects: projects.length,
    },
    last12Months: { validBookings:recentBookings.length, validOrders:recentOrders.length },
    lifecycle: {
      bookingStatuses:distribution(bookings, (row) => row.status), orderStatuses:distribution(orders, (row) => row.status),
      completedBookings:completedBookings.length,
      completedBookingsWithAuthoritativeDate:completedBookings.filter((row) => validDate(bookingCompletion(row))).length,
      completedBookingsWithExplicitCompletedAt:completedBookings.filter((row) => validDate(row.completedAt)).length,
      completedOrders:completedOrders.length,
      completedOrdersWithAuthoritativeDate:completedOrders.filter((row) => validDate(orderCompletion(row))).length,
      completedOrdersWithExplicitCompletedAt:completedOrders.filter((row) => validDate(row.completedAt)).length,
    },
    ledger: {
      statuses:distribution(payments, (row) => row.status), acceptedPayments:acceptedPayments.length,
      linkedPayments:linkedPayments.length, unlinkedPayments:payments.length-linkedPayments.length,
      linkedCoveragePercent:percent(linkedPayments.length, payments.length),
      grossAcceptedAmount:sum(acceptedPayments, (row) => row.amount), completedRefundAmount:sum(payments.filter((row) => row.refundStatus === "completed"), (row) => row.refundAmount),
    },
    costCoverage: {
      completedServicesWithRecordedCost:[...completedBookingIds].filter((id) => costedServiceIds.has(id)).length,
      completedServices:completedBookingIds.size,
      serviceCoveragePercent:percent([...completedBookingIds].filter((id) => costedServiceIds.has(id)).length, completedBookingIds.size),
      completedOrderUnits:orderUnits, catalogCostedOrderUnits:catalogCostedUnits, orderCoveragePercent:percent(catalogCostedUnits, orderUnits),
      completedPosUnits:posUnits, costedPosUnits:posCostedUnits, posCoveragePercent:percent(posCostedUnits, posUnits),
      inventoryWithCost:inventories.filter((row) => number(row.costPrice) > 0).length,
      inventoryCoveragePercent:percent(inventories.filter((row) => number(row.costPrice) > 0).length, inventories.length),
      fulfilledProjectMaterials:projectMaterials.filter((row) => row.status === "fulfilled").length,
      fulfilledProjectMaterialValue:sum(projectMaterials.filter((row) => row.status === "fulfilled"), (row) => row.totalPrice || (number(row.quantity) * number(row.unitPrice))),
    },
    governance: {
      approvedExpenses:expenses.filter((row) => row.status === "approved").length,
      pendingExpenses:expenses.filter((row) => row.status === "pending").length,
      approvedOrPaidPayrolls:payrolls.filter((row) => ["approved","paid"].includes(row.status)).length,
      draftPayrolls:payrolls.filter((row) => row.status === "draft").length,
      linkedOrderBookings:orders.filter((row) => row.bookingId).length,
      projectStatuses:distribution(projects, (row) => row.status),
    },
    reportEngine: {
      period: { start:engineFilters.startDate, end:engineFilters.endDate },
      commercialActivity: {
        serviceBookings:engine.serviceTransactions, onlineOrders:engine.orderTransactions,
        posSales:engine.posTransactions, recognizedTransactions:engine.recognizedTransactions,
      },
      financialReconciliation: {
        bookedValue:engine.totalRevenue, recognizedRevenue:engine.recognizedRevenue,
        recognizedServiceRevenue:engine.recognizedServiceRevenue,
        recognizedOrderRevenue:engine.recognizedOrderRevenue, recognizedPosRevenue:engine.posRevenue,
        grossCollections:engine.grossCollections, refunds:engine.refunds,
        netCollections:engine.netCollections, outstandingValue:engine.outstandingValue,
      },
      managementControls: {
        atRiskServiceBookings:engine.atRiskServiceBookings, openServiceBookings:engine.openServiceBookings,
        openOrders:engine.openOrders, paymentExceptionCount:engine.paymentExceptionCount,
        paymentExceptionValue:engine.paymentExceptionValue, pendingLedgerCount:engine.pendingLedgerCount,
        directCostCoveragePercent:engine.costDataCoverage, completedOrderCostCoveragePercent:engine.orderCostCoverage,
        completedOrderCost:engine.orderCost, completedOrderCostBasis:engine.orderCostBasis,
        pendingExpenseCount:engine.pendingExpenseCount, draftPayrollCount:engine.draftPayrollCount,
        completionEvidenceCoveragePercent:engine.completionEvidenceCoverage,
      },
      executiveInsights:engine.executiveInsights,
    },
  };

  console.log(JSON.stringify(audit, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(`Revenue audit failed: ${error.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
