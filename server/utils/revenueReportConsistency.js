'use strict';
// Independent arithmetic checks for every displayed source. This flags a broken
// breakdown; it never changes saved transactions or forces totals to agree.
function checkRevenueReportConsistency(A) {
  const sum = (rows, field) => (rows || []).reduce((total, row) => total + Number(row[field] || 0), 0);
  const serviceRows = A.profitabilityServiceRows || A.completedServiceCosts || [];
  const serviceCosts = rows => rows.reduce((total, row) => total + ['partsCost', 'consumablesCost', 'laborCost', 'localPurchaseCost'].reduce((cost, field) => cost + Number(row[field] || 0), 0), 0);
  const comparisons = {
    completedActivity: [sum(A.activity?.completed, 'amount'), A.recognizedGrossRevenue],
    cashActivity: [sum(A.activity?.payments, 'amount'), A.netCollections],
    requestedActivity: [sum(A.activity?.requested, 'amount'), A.totalRevenue],
    requestedBalance: [Number(A.reconciliation.appliedPayments) + Number(A.reconciliation.unpaidBalance), A.reconciliation.requestedValue],
    monthlySales: [Object.values(A.monthlyRevenue || {}).reduce((total, month) => total + Number(month.completedService || 0) + Number(month.completedOrders || 0) + Number(month.completedPos || 0) - Number(month.refunds || 0), 0), A.recognizedRevenue],
    monthlyCosts: [Object.values(A.monthlyPartsCost || {}).reduce((total, cost) => total + Number(cost || 0), 0), A.totalPartsCost],
    serviceSales: [sum(A.serviceProfitability?.rows, 'revenue'), sum(serviceRows, 'revenue')],
    serviceCosts: [sum(A.serviceProfitability?.rows, 'directCost'), serviceCosts(serviceRows)],
    serviceProfit: [sum(A.serviceProfitability?.rows, 'grossProfit'), sum(serviceRows, 'grossProfit')],
    itemizedCosts: [A.costDetails.total, Number(A.totalPartsCost) + Number(A.operatingExpenses)],
    profitEquation: [Number(A.recognizedRevenue) - Number(A.totalPartsCost) - Number(A.operatingExpenses), A.operatingProfit],
  };
  const differences = Object.fromEntries(Object.entries(comparisons).map(([key, [actual, expected]]) => [key,
    Number.isFinite(Number(actual)) && Number.isFinite(Number(expected)) ? Math.round((actual - expected) * 100) / 100 : null]));
  return { matches: Object.values(differences).every(value => value === 0), differences };
}
module.exports = { checkRevenueReportConsistency };
