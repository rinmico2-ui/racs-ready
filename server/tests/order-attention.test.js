const test = require("node:test");
const assert = require("node:assert/strict");
const { orderAttentionState, requestedOrderCutoff } = require("../utils/orderAttention");

test('assignment accepts the saved customer schedule in equivalent formats but requires rescheduling to change it', () => {
  const { assertOrderAssignmentSchedule } = require('../utils/orderAttention');
  for (const fulfillmentType of ['delivery_only', 'delivery_installation']) {
    const order = { fulfillmentType, delivery:{preferredDate:'2026-10-21T16:00:00.000Z'}, timeSlot:'10:30 PM - 11:30 PM' };
    assert.doesNotThrow(() => assertOrderAssignmentSchedule(order));
    assert.doesNotThrow(() => assertOrderAssignmentSchedule(order, {scheduledDate:'2026-10-22', timeSlot:'22:30'}));
    for (const input of [{scheduledDate:'2026-10-23'}, {timeSlot:'23:00'}, {scheduledDate:'invalid'}, {timeSlot:'invalid'}]) {
      assert.throws(() => assertOrderAssignmentSchedule(order, input), error => error.status === 409 && error.code === 'ORDER_SCHEDULE_CHANGE_REQUIRES_RESCHEDULE');
    }
  }
});

test("uses a Manila delivery window plus the 30-minute operational grace", () => {
  const order = {
    status: "pending_payment",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-25T00:00:00.000Z") },
    timeSlot: "10:00 AM",
  };
  assert.equal(orderAttentionState(order, new Date("2026-08-25T02:30:00.000Z")).isPastDate, false);
  const state = orderAttentionState(order, new Date("2026-08-25T02:30:00.001Z"));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionType, "payment_review_overdue");
  assert.equal(state.requestedScheduleAt, "2026-08-25T02:30:00.000Z");
  assert.equal(state.timeZone, "Asia/Manila");
  assert.equal(order.status, "pending_payment");
});

test("keeps a future pending order in its normal queue", () => {
  const order = {
    status: "pending_payment",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date("2026-08-26T00:00:00.000Z") },
    timeSlot: "09:00",
  };
  assert.equal(orderAttentionState(order, new Date("2026-08-25T04:00:00.000Z")).isPastDate, false);
});

test("keeps pickup orders valid through the selected Manila business day", () => {
  const cutoff = requestedOrderCutoff({
    status: "ready_for_pickup",
    fulfillmentType: "customer_pickup",
    pickupDate: new Date("2026-08-24T00:00:00.000Z"),
  });
  assert.equal(cutoff.toISOString(), "2026-08-24T15:59:59.999Z");
});

test("does not flag active delivery work as an admin review delay", () => {
  const state = orderAttentionState({
    status: "out_for_delivery",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-20T00:00:00.000Z") },
    timeSlot: "9:00 AM",
  }, new Date("2026-08-25T00:00:00.000Z"));
  assert.equal(state.isPastDate, false);
});

test("date-only legacy deliveries remain valid until end of day, then require recovery", () => {
  const order = {
    status: "preparing_unit",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-24T00:00:00.000Z") },
  };
  assert.equal(orderAttentionState(order, new Date("2026-08-24T15:59:59.999Z")).isPastDate, false);
  const state = orderAttentionState({
    status: "preparing_unit",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-24T00:00:00.000Z") },
  }, new Date("2026-08-24T16:00:00.000Z"));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionType, "assignment_overdue");
});

test("an assigned order requires schedule recovery after its delivery window passes", () => {
  const state = orderAttentionState({
    status: "technician_assigned",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date("2026-08-24T00:00:00.000Z") },
    timeSlot: "9:00 AM - 11:00 AM",
  }, new Date("2026-08-24T02:31:00.000Z"));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionTitle, "Schedule Passed Before Acceptance");
});

test("accepted but undispatched work is distinguished from an assignment delay", () => {
  const state = orderAttentionState({
    status: "technician_accepted",
    fulfillmentType: "delivery_installation",
    delivery: { preferredDate: new Date("2026-08-24T00:00:00.000Z") },
    timeSlot: "09:00-11:00",
  }, new Date("2026-08-24T02:31:00.000Z"));
  assert.equal(state.isPastDate, true);
  assert.equal(state.attentionType, "dispatch_overdue");
  assert.equal(state.attentionTitle, "Dispatch Window Expired");
});

test("technician response SLA is separate from the customer schedule cutoff", () => {
  const order = {
    status: "technician_assigned",
    fulfillmentType: "delivery_only",
    delivery: { preferredDate: new Date("2026-08-26T00:00:00.000Z") },
    timeSlot: "2:00 PM",
    statusHistory: [{ status: "technician_assigned", timestamp: "2026-08-25T00:00:00.000Z" }],
  };
  assert.equal(orderAttentionState(order, new Date("2026-08-25T02:00:00.000Z")).isAcceptanceOverdue, false);
  const state = orderAttentionState(order, new Date("2026-08-25T02:00:00.001Z"));
  assert.equal(state.isAcceptanceOverdue, true);
  assert.equal(state.isPastDate, false);
  assert.equal(state.acceptanceDeadlineAt, "2026-08-25T02:00:00.000Z");
});

test("team response timing uses the actual member deadline instead of the legacy two-hour SLA", () => {
  const order = {
    status: "technician_assigned", technicianId: "lead", fulfillmentType: "delivery_installation",
    delivery: { preferredDate: "2026-08-26" }, timeSlot: "09:00",
    statusHistory: [{ status: "technician_assigned", timestamp: "2026-08-25T00:00:00Z" }],
    technicianAcceptance: { status: "pending", deadlineAt: "2026-08-25T00:30:00Z" },
    technicianTeam: [
      { technicianId: "lead", status: "pending", deadlineAt: "2026-08-25T00:30:00Z" },
      { technicianId: "support", status: "pending", deadlineAt: "2026-08-25T00:45:00Z" },
    ],
  };
  const atDeadline = orderAttentionState(order, new Date("2026-08-25T00:30:00Z"));
  assert.equal(atDeadline.acceptanceDeadlineAt, "2026-08-25T00:30:00.000Z");
  assert.equal(atDeadline.isAcceptanceOverdue, true);
  assert.equal(atDeadline.isPastDate, false);
  order.technicianTeam[0].status = "accepted";
  const supporting = orderAttentionState(order, new Date("2026-08-25T00:40:00Z"));
  assert.equal(supporting.acceptanceDeadlineAt, "2026-08-25T00:45:00.000Z");
  assert.equal(supporting.isAcceptanceOverdue, false);
});

test("a stored team response deadline works even when assignment history is missing", () => {
  const state = orderAttentionState({
    status: "technician_assigned", technicianId: "lead", fulfillmentType: "delivery_installation",
    delivery: { preferredDate: "2026-08-26" }, timeSlot: "09:00",
    technicianTeam: [{ technicianId: "lead", status: "pending", deadlineAt: "2026-08-25T00:30:00Z" }],
  }, new Date("2026-08-25T01:00:00Z"));
  assert.equal(state.acceptanceDeadlineAt, "2026-08-25T00:30:00.000Z");
  assert.equal(state.isAcceptanceOverdue, true);
});
