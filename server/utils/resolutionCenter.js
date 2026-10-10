const { orderAttentionState } = require("./orderAttention");
const { bookingReviewState } = require("./bookingReview");
const { assignmentTimingState, parseAppointmentTime, manilaDateTime } = require("./bookingDateTime");

const RECOVERY_BOOKING_STATUSES = Object.freeze([
  "pending", "pending_project_scheduling", "payment_verified", "awaiting_assignment", "assigned",
  "pending_reassignment", "confirmed", "scheduled", "re-scheduled", "repair_requested",
  "pending_inspection", "inspection_scheduled", "ready_for_repair", "repair_scheduled",
]);

function bookingScheduleNeedsResolution(booking, now = new Date()) {
  if (!booking || !RECOVERY_BOOKING_STATUSES.includes(booking.status)) return false;
  if (bookingReviewState(booking, now).isReviewOverdue) return true;
  if (["awaiting_assignment", "pending_reassignment"].includes(booking.status)) {
    const timing = assignmentTimingState(booking, now);
    if (timing.assignmentCutoffAt) return timing.isExpired;
  }
  const date = booking.projectScheduling?.preferredStartDate || booking.preferredDate || booking.bookingDate;
  if (!date) return booking.autoReschedulePending === true;
  let end = parseAppointmentTime(booking.endTime);
  if (!Number.isFinite(end)) {
    const start = parseAppointmentTime(booking.startTime || booking.preferredTime);
    end = Number.isFinite(start) ? start + (Number(booking.serviceDurationMinutes || booking.duration) || 60) : 24 * 60;
  }
  const cutoff = manilaDateTime(date, end);
  return cutoff ? cutoff.getTime() < now.getTime() : booking.autoReschedulePending === true;
}

function parseResolutionFocus(value) {
  const match = String(value || "").match(/^(booking|order):([a-f\d]{24})$/i);
  return match ? { source: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
}

function focusedResolutionCases(cases, focus) {
  if (!focus) return cases;
  return cases.filter(item => ((item.sourceType || "booking") === focus.source && String(item.id) === focus.id)
    || (focus.source === "booking" && item.sourceType === "order" && String(item.linkedBookingId) === focus.id));
}

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const ISSUE_PRIORITY = Object.freeze({ no_show: 0, past_date: 1, schedule_conflict: 2, technician_issue: 3, customer_reschedule: 4, incomplete: 5, no_technician: 6 });

function groupResolutionCases(cases) {
  const records = new Map();
  for (const [index, item] of cases.entries()) {
    const identity = item.id || item.bookingId || item.orderId || item.caseId || item.reference || `row-${index}`;
    const key = `${item.sourceType || "booking"}:${identity}`;
    const record = records.get(key) || { base: item, issues: new Map() };
    for (const issue of item.issues || [item]) {
      const existing = record.issues.get(issue.issueType);
      if (!existing || (SEVERITY_RANK[issue.severity] ?? 2) < (SEVERITY_RANK[existing.severity] ?? 2)) {
        const details = {};
        for (const field of ["caseId", "issueType", "severity", "reason", "requiresReschedule", "canReassign", "allowedActions", "noShowReport", "awaitingCustomerSchedule"]) {
          if (issue[field] !== undefined) details[field] = issue[field];
        }
        record.issues.set(issue.issueType, details);
      }
    }
    records.set(key, record);
  }
  return [...records.entries()].map(([key, record]) => {
    const issues = [...record.issues.values()].sort((a, b) =>
      (ISSUE_PRIORITY[a.issueType] ?? 7) - (ISSUE_PRIORITY[b.issueType] ?? 7)
      || (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2));
    const severity = issues.reduce((highest, issue) =>
      (SEVERITY_RANK[issue.severity] ?? 2) < (SEVERITY_RANK[highest] ?? 2) ? issue.severity : highest,
    record.base.severity || "medium");
    return { ...record.base, ...issues[0], caseId: key, severity, issues };
  });
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function resolutionPaymentNeedsReview(record, source = 'booking') {
  if (!record || ['cancelled', 'completed', 'closed'].includes(record.status)) return false;
  if (source === 'order' && record.paymentMethod === 'cash_onsite') return false;
  const status = normalizeText(record.paymentStatus) ||
    (['pending', 'pending_project_scheduling', 'pending_payment'].includes(record.status) ? 'pending' : '');
  return status === 'pending';
}

function pendingResolutionProposal(booking) {
  if (['cancelled', 'completed', 'closed', 'repair_completed'].includes(booking?.status)) return null;
  const proposal = booking?.proposedReschedule;
  if (proposal?.status !== 'pending' || !proposal.date || Number.isNaN(new Date(proposal.date).getTime())) return null;
  return proposal;
}

function pendingResolutionRequest(booking) {
  if (['cancelled', 'completed', 'closed', 'repair_completed'].includes(booking?.status)) return null;
  const request = booking?.rescheduleRequest;
  if (request?.status !== 'pending' || !require('./bookingDateTime').strictManilaDateKey(request.requestedDate)) return null;
  return request;
}

function orderIssueLabel(issueType) {
  return ({
    payment_review_overdue: "Payment review overdue",
    assignment_overdue: "Assignment overdue",
    dispatch_overdue: "Dispatch overdue",
    pickup_overdue: "Pickup overdue",
  })[issueType] || "Order review";
}

function orderResolutionCase(order, now = new Date(), thresholdHours = 8) {
  const attention = orderAttentionState(order, now);
  if (!attention.isPastDate || !attention.attentionType) return null;

  const scheduledAt = attention.requestedScheduleAt ? new Date(attention.requestedScheduleAt) : null;
  const elapsedMs = scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? now.getTime() - scheduledAt.getTime() : 0;
  const daysPast = Math.max(0, Math.floor(elapsedMs / 86400000));
  const itemCount = (order.items || []).reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0);
  const itemName = (order.items || []).map((item) => item.modelLine || item.brand).filter(Boolean).join(", ") || "Air-conditioning order";
  const technicianName = order.technicianId?.name || order.technician?.name || "Unassigned";

  return {
    ...require('./orderResolutionScheduling').orderWorkload(order, thresholdHours),
    projectScheduling: order.bookingId?.projectScheduling || order.projectScheduling || null,
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
    routeDurationMin: Number(order.routeDurationMin) || 30,
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
    awaitingCustomerSchedule: require('./orderRescheduleInvitation').activeOrderRescheduleInvitation(order, now),
    allowedActions: [
      "view",
      ...(resolutionPaymentNeedsReview(order, 'order') ? ["verify_payment"] : []),
      "reschedule",
      "send_link",
      "cancel",
      ...(order.customer?.phone || order.delivery?.contactNumber ? ["call"] : []),
    ],
  };
}

function summarizeResolutionCases(cases) {
  return groupResolutionCases(cases).reduce((summary, item) => {
    summary.total += 1;
    for (const issue of item.issues) {
      summary.byIssue[issue.issueType] = (summary.byIssue[issue.issueType] || 0) + 1;
    }
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
    if (issue && issue !== "all" && ![item, ...(item.issues || [])].some(entry => normalizeText(entry.issueType) === issue)) return false;
    if (severity && severity !== "all" && normalizeText(item.severity) !== severity) return false;
    if (search) {
      const haystack = [item.id, item.linkedBookingId, item.reference, item.customer, item.email, item.phone, item.serviceName, item.subject, item.reason, item.technicianName, ...(item.issues || []).map(entry => entry.reason)]
        .map(normalizeText).join(" ");
      if (!haystack.includes(search)) return false;
    }
    return true;
  }).map(item => {
    const selectedIssue = issue && issue !== "all" && item.issues?.find(entry => normalizeText(entry.issueType) === issue);
    return selectedIssue ? { ...item, ...selectedIssue } : item;
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
  pendingResolutionRequest,
  pendingResolutionProposal,
  resolutionPaymentNeedsReview,
  groupResolutionCases,
  RECOVERY_BOOKING_STATUSES,
  bookingScheduleNeedsResolution,
  parseResolutionFocus,
  focusedResolutionCases,
  filterResolutionCases,
  orderResolutionCase,
  paginateResolutionCases,
  sortResolutionCases,
  summarizeResolutionCases,
};
