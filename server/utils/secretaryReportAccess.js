const secretaryReportRequests = new Set([
  "GET /reports/overview",
  "GET /reports/decisions",
  "GET /reports/revenue",
  "GET /reports/orders/export",
  "POST /reports/orders/drilldown",
  "POST /reports/service/drilldown",
  "GET /ratings/service",
  "GET /ratings/service/export",
  "GET /ratings/aircons",
  "GET /ratings/top-products",
  "GET /ratings/technicians",
  "GET /ratings/analytics",
]);

function isSecretaryReportRequest(req) {
  return secretaryReportRequests.has(`${req.method} ${req.path}`);
}

module.exports = { isSecretaryReportRequest };
