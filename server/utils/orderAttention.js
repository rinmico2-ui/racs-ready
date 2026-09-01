const REVIEWABLE_ORDER_STATUSES = new Set([
  "pending_payment",
  "preparing_unit",
  "technician_declined",
  "ready_for_pickup",
]);

function parseClock(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3];
  if (minutes > 59 || hours > (meridiem ? 12 : 23)) return null;
  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

function requestedOrderCutoff(order) {
  const isPickup = order?.fulfillmentType === "customer_pickup";
  const dateValue = isPickup ? order?.pickupDate : order?.delivery?.preferredDate;
  if (!dateValue) return null;

  const cutoff = new Date(dateValue);
  if (Number.isNaN(cutoff.getTime())) return null;
  const clock = parseClock(order?.timeSlot);
  if (clock) cutoff.setHours(clock.hours, clock.minutes, 0, 0);
  else cutoff.setHours(23, 59, 59, 999);
  return cutoff;
}

function orderAttentionState(order, now = new Date()) {
  const cutoff = requestedOrderCutoff(order);
  const isPastDate = Boolean(
    REVIEWABLE_ORDER_STATUSES.has(order?.status) &&
    cutoff &&
    cutoff.getTime() < now.getTime()
  );

  let attentionType = null;
  let attentionReason = null;
  if (isPastDate) {
    if (order.fulfillmentType === "customer_pickup") {
      attentionType = "pickup_overdue";
      attentionReason = order.status === "ready_for_pickup"
        ? "Pickup date passed before the order was collected"
        : "Pickup date passed before preparation was completed";
    } else if (order.status === "pending_payment") {
      attentionType = "payment_review_overdue";
      attentionReason = "Requested delivery date passed before payment review";
    } else {
      attentionType = "assignment_overdue";
      attentionReason = "Requested delivery date passed before technician assignment";
    }
  }

  return {
    isPastDate,
    attentionType,
    attentionReason,
    requestedScheduleAt: cutoff ? cutoff.toISOString() : null,
  };
}

function withOrderAttentionState(order, now = new Date()) {
  return { ...order, ...orderAttentionState(order, now) };
}

module.exports = {
  REVIEWABLE_ORDER_STATUSES,
  orderAttentionState,
  requestedOrderCutoff,
  withOrderAttentionState,
};
