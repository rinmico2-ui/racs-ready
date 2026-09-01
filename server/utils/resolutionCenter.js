const { orderAttentionState } = require("./orderAttention");

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function orderIssueLabel(issueType) {
  return ({
    payment_review_overdue: "Payment review overdue",
    assignment_overdue: "Assignment overdue",
    pickup_overdue: "Pickup overdue",
  })[issueType] || "Order review";
}

function orderResolutionCase(order, now = new Date()) {
  const attention = orderAttentionState(order, now);
  if (!attention.isPastDate || !attention.attentionType) return null;

  const scheduledAt = attention.requestedScheduleAt ? new Date(attention.requestedScheduleAt) : null;
  const elapsedMs = scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? now.getTime() - scheduledAt.getTime() : 0;
  const daysPast = Math.max(0, Math.floor(elapsedMs / 86400000));
  const itemCount = (order.items || []).reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0);
  const itemName = (order.items || []).map((item) => item.modelLine || item.brand).filter(Boolean).join(", ") || "Air-conditioning order";
  const technicianName = order.technicianId?.name || order.technician?.name || "Unassigned";
  const isPaymentReview = attention.attentionType === "payment_review_overdue";

  return {
    caseId: `order:${order._id}:${attention.attentionType}`,
    id: String(order._id),
    orderId: String(order._id),
    linkedBookingId: order.bookingId ? String(order.bookingId._id || order.bookingId) : null,
    sourceType: "order",
    sourceLabel: "Order",
    reference: order.orderReference || `#${String(order._id).slice(-8).toUpperCase()}`,
    customer: order.customer?.name || "Customer",
    email: order.customer?.email || "",
    phone: order.customer?.phone || order.delivery?.contactNumber || "",
    subject: itemName,
    serviceName: itemName,
    itemCount,
    status: order.status,
    issueType: attention.attentionType,
    issueLabel: orderIssueLabel(attention.attentionType),
    severity: daysPast >= 2 ? "critical" : "high",
    reason: attention.attentionReason || "The requested order schedule passed and requires admin action.",
    scheduledAt: attention.requestedScheduleAt,
    bookingDate: attention.requestedScheduleAt,
    startTime: order.timeSlot || "",
    technicianName,
    isPastDate: true,
    daysPast,
    fulfillmentType: order.fulfillmentType,
    paymentStatus: order.paymentStatus || "pending",
    paymentMethod: order.paymentMethod || "",
    amount: Number(order.total) || 0,
    preparation: order.preparation || null,
    allowedActions: [
      "view",
      ...(isPaymentReview && !["verified", "paid", "partial", "remitted"].includes(normalizeText(order.paymentStatus)) ? ["verify_payment"] : []),
      "reschedule",
      ...(order.customer?.phone || order.delivery?.contactNumber ? ["call"] : []),
    ],
  };
}

function summarizeResolutionCases(cases) {
  return cases.reduce((summary, item) => {
    summary.total += 1;
    summary.byIssue[item.issueType] = (summary.byIssue[item.issueType] || 0) + 1;
    summary.bySource[item.sourceType || "booking"] = (summary.bySource[item.sourceType || "booking"] || 0) + 1;
    summary.bySeverity[item.severity || "medium"] = (summary.bySeverity[item.severity || "medium"] || 0) + 1;
    if (item.isPastDate) summary.pastDue += 1;
    return summary;
  }, { total: 0, pastDue: 0, byIssue: {}, bySource: { booking: 0, order: 0 }, bySeverity: {} });
}

function filterResolutionCases(cases, filters = {}) {
  const source = normalizeText(filters.source);
  const issue = normalizeText(filters.issue);
  const severity = normalizeText(filters.severity);
  const search = normalizeText(filters.q);
  return cases.filter((item) => {
    if (source && source !== "all" && normalizeText(item.sourceType || "booking") !== source) return false;
    if (issue && issue !== "all" && normalizeText(item.issueType) !== issue) return false;
    if (severity && severity !== "all" && normalizeText(item.severity) !== severity) return false;
    if (search) {
      const haystack = [item.reference, item.customer, item.email, item.phone, item.serviceName, item.subject, item.reason, item.technicianName]
        .map(normalizeText).join(" ");
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function sortResolutionCases(cases) {
  return cases.sort((a, b) => {
    const severity = (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
    if (severity) return severity;
    const overdue = (Number(b.daysPast) || 0) - (Number(a.daysPast) || 0);
    if (overdue) return overdue;
    return String(a.reference || "").localeCompare(String(b.reference || ""));
  });
}

function paginateResolutionCases(cases, pageValue, perPageValue) {
  const page = Math.max(1, Number.parseInt(pageValue, 10) || 1);
  const perPage = Math.min(100, Math.max(10, Number.parseInt(perPageValue, 10) || 25));
  const total = cases.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  return {
    cases: cases.slice((safePage - 1) * perPage, safePage * perPage),
    pagination: { page: safePage, perPage, total, pages },
  };
}

module.exports = {
  filterResolutionCases,
  orderResolutionCase,
  paginateResolutionCases,
  sortResolutionCases,
  summarizeResolutionCases,
};
