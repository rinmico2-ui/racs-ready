const {
  ASSIGNMENT_GRACE_MINUTES,
  manilaDateTime,
  parseAppointmentTime,
} = require("./bookingDateTime");

const TECHNICIAN_RESPONSE_MINUTES = 120;

// These stages have not started physical fulfillment. If their customer
// schedule expires, operations must agree on a replacement schedule before
// payment review, assignment, acceptance, or departure can continue.
const REVIEWABLE_ORDER_STATUSES = new Set([
  "pending_payment",
  "preparing_unit",
  "technician_declined",
  "technician_assigned",
  "technician_accepted",
  "ready_for_pickup",
]);

function scheduledDate(order) {
  return order?.fulfillmentType === "customer_pickup"
    ? order?.pickupDate
    : order?.delivery?.preferredDate;
}

function scheduledStartMinutes(order) {
  const firstWindowValue = String(order?.timeSlot || "").trim().split(/\s*(?:-|–|—)\s*/)[0];
  return parseAppointmentTime(firstWindowValue);
}

/**
 * Resolve the order cutoff in Asia/Manila regardless of the Node host zone.
 * Pickup orders are date-only and remain valid through that business day.
 * Delivery work gets the same 30-minute operational grace as service work.
 */
function requestedOrderCutoff(order) {
  const dateValue = scheduledDate(order);
  if (!dateValue) return null;
  if (order?.fulfillmentType === "customer_pickup") {
    return manilaDateTime(dateValue, 24 * 60, -1);
  }

  const startMinutes = scheduledStartMinutes(order);
  // Legacy delivery orders can be date-only. Keep those actionable through
  // the selected Manila business day instead of silently skipping recovery.
  if (!Number.isFinite(startMinutes)) return manilaDateTime(dateValue, 24 * 60, -1);
  return manilaDateTime(dateValue, startMinutes + ASSIGNMENT_GRACE_MINUTES);
}

function lastAssignmentAt(order) {
  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  const entry = history.slice().reverse().find((item) => item?.status === "technician_assigned");
  const timestamp = entry?.timestamp ? new Date(entry.timestamp) : null;
  return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null;
}

function technicianAcceptanceState(order, now = new Date()) {
  const assignedAt = order?.status === "technician_assigned" ? lastAssignmentAt(order) : null;
  const deadline = assignedAt
    ? new Date(assignedAt.getTime() + TECHNICIAN_RESPONSE_MINUTES * 60 * 1000)
    : null;
  const reference = now instanceof Date ? now : new Date(now);
  return {
    responseMinutes: TECHNICIAN_RESPONSE_MINUTES,
    assignedAt: assignedAt ? assignedAt.toISOString() : null,
    acceptanceDeadlineAt: deadline ? deadline.toISOString() : null,
    isAcceptanceOverdue: Boolean(
      deadline && !Number.isNaN(reference.getTime()) && reference.getTime() > deadline.getTime()
    ),
  };
}

function attentionCopy(order) {
  if (order?.status === "pending_payment") {
    return {
      attentionType: "payment_review_overdue",
      attentionTitle: "Payment Review Window Expired",
      attentionReason: "The requested schedule passed before payment review was completed",
    };
  }
  if (order?.fulfillmentType === "customer_pickup") {
    return {
      attentionType: "pickup_overdue",
      attentionTitle: order.status === "ready_for_pickup" ? "Pickup Date Passed" : "Pickup Preparation Overdue",
      attentionReason: order.status === "ready_for_pickup"
        ? "The pickup date passed before the customer collected the order"
        : "The pickup date passed before preparation was completed",
    };
  }
  if (order?.status === "technician_assigned") {
    return {
      attentionType: "assignment_overdue",
      attentionTitle: "Schedule Passed Before Acceptance",
      attentionReason: "The delivery schedule passed before the assigned technician confirmed the work",
    };
  }
  if (order?.status === "technician_accepted") {
    return {
      attentionType: "dispatch_overdue",
      attentionTitle: "Dispatch Window Expired",
      attentionReason: "The technician accepted, but the order did not depart within the scheduled dispatch window",
    };
  }
  return {
    attentionType: "assignment_overdue",
    attentionTitle: "Assignment Window Expired",
    attentionReason: order?.status === "technician_declined"
      ? "The requested schedule passed before a replacement technician was confirmed"
      : "The requested schedule passed before a technician was confirmed",
  };
}

function orderAttentionState(order, now = new Date()) {
  const cutoff = requestedOrderCutoff(order);
  const reference = now instanceof Date ? now : new Date(now);
  const isPastDate = Boolean(
    REVIEWABLE_ORDER_STATUSES.has(order?.status)
      && cutoff
      && !Number.isNaN(reference.getTime())
      && reference.getTime() > cutoff.getTime()
  );
  const copy = isPastDate ? attentionCopy(order) : {
    attentionType: null,
    attentionTitle: null,
    attentionReason: null,
  };
  const startMinutes = scheduledStartMinutes(order);
  const start = order?.fulfillmentType === "customer_pickup"
    ? manilaDateTime(scheduledDate(order), 0)
    : manilaDateTime(scheduledDate(order), startMinutes);

  return {
    timeZone: "Asia/Manila",
    graceMinutes: order?.fulfillmentType === "customer_pickup" ? 0 : ASSIGNMENT_GRACE_MINUTES,
    isPastDate,
    ...copy,
    scheduledStartAt: start ? start.toISOString() : null,
    requestedScheduleAt: cutoff ? cutoff.toISOString() : null,
    blocksProgress: isPastDate,
    ...technicianAcceptanceState(order, reference),
  };
}

function withOrderAttentionState(order, now = new Date()) {
  return { ...order, ...orderAttentionState(order, now) };
}

module.exports = {
  REVIEWABLE_ORDER_STATUSES,
  TECHNICIAN_RESPONSE_MINUTES,
  orderAttentionState,
  requestedOrderCutoff,
  technicianAcceptanceState,
  withOrderAttentionState,
};
