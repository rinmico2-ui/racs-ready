"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { walkInPayment } = require("../utils/walkInPayment");
const { walkInProjectWindow, projectDateKey, hasPreferredCapacity } = require("../utils/walkInProjectWindow");
const { persistWalkInService } = require("../utils/walkInServiceWrite");
const { extendAcceptanceDeadline } = require("../utils/acceptanceDeadline");
const { orderAttentionState } = require("../utils/orderAttention");
const Payment = require("../models/Payment"), Booking = require("../models/BookingService");

const now = new Date("2035-01-01T02:00:00Z");
test("counter payments preserve the actual method and remain valid payment and booking values", async () => {
  for (const [method, expected] of [["cash", "cash"], ["cod", "cash"], ["gcash", "gcash"], ["maya", "maya"], ["card", "card"], ["bank_transfer", "bank"]]) {
    const result = walkInPayment({ paymentMethod: method, cashPaymentMode: "downpayment", downpaymentAmount: 100, paymentReference: "AUTH-1234" }, 1000, now);
    assert.equal(result.method, expected); assert.equal(result.status, "partial");
    await new Payment({ method: result.method, gateway: result.gateway, amount: result.amount, status: "verified" }).validate();
    assert.ok(Booking.schema.path("paymentMethod").enumValues.includes(result.booking));
    assert.ok(Booking.schema.path("paymentChannel").enumValues.includes(result.channel));
  }
});
test("electronic payments require an actual reference and reject unsupported selections", () => {
  const input = { cashPaymentMode: "full", downpaymentAmount: 100 };
  for (const method of ["gcash", "maya", "card", "bank_transfer"]) assert.throws(() => walkInPayment({ ...input, paymentMethod: method }, 100), /reference/);
  for (const paymentMethod of ["crypto", "__proto__", "constructor", {}, true]) assert.throws(() => walkInPayment({ ...input, paymentMethod }, 100), /Choose/);
  assert.throws(() => walkInPayment({ ...input, paymentReference: "x".repeat(161) }, 100));
  assert.throws(() => walkInPayment({ ...input, cashPaymentMode: "anything" }, 100));
});
test("collected amounts are checked against server prices without inflating partial payments to full", () => {
  const input = { paymentMethod: "cash", cashPaymentMode: "full", downpaymentAmount: 100 };
  for (const downpaymentAmount of [0, -1, 101, 99, true, {}, "", NaN, Infinity, 99.999]) assert.throws(() => walkInPayment({ ...input, downpaymentAmount }, 100));
  assert.equal(walkInPayment(input, 100).status, "paid");
  assert.notEqual(walkInPayment(input, 100).reference, walkInPayment(input, 100).reference);
});
test("service project dates preserve the Manila date serialized by the browser", () => {
  assert.equal(projectDateKey("2035-01-01T16:00:00.000Z"), "2035-01-02");
  const prefs = walkInProjectWindow({ startDate: "2035-01-01T16:00:00Z", endDate: "2035-01-08T16:00:00Z", preferences: { workingDays: ["monday", "tuesday"], preferredWorkingHours: "afternoon" } }, "2035-01-02", 10, now);
  assert.equal(prefs.preferredStartDate.toISOString(), "2035-01-01T16:00:00.000Z");
  assert.deepEqual(prefs.preferredWorkingHours, { start: "13:00", end: "17:00" });
});
test("service project windows reject past, impossible, reversed, mismatched, and unbounded dates", () => {
  const input = { startDate: "2035-01-02", endDate: "2035-01-09" };
  for (const change of [{ startDate: "2030-01-02" }, { startDate: "2035-02-30" }, { endDate: "2035-01-01" }, { endDate: "2037-01-01" }, { startDate: "2035-01-03" }, { preferences: { workingDays: ["holiday"] } }, { preferences: { preferredWorkingHours: "anytime" } }]) assert.throws(() => walkInProjectWindow({ ...input, ...change }, "2035-01-02", 10, now));
});
test("project availability honors selected working days and half-day working periods", () => {
  const prefs = walkInProjectWindow({ startDate: "2035-01-02", endDate: "2035-01-09", preferences: { workingDays: ["tuesday"] } }, "2035-01-02", 10, now);
  const verdict = { sufficient: true, days: [{ date: "2035-01-02", isWorkingDay: true, capacityHours: 8, availableTechnicians: 1 }, { date: "2035-01-03", isWorkingDay: true, capacityHours: 24, availableTechnicians: 3 }] };
  assert.equal(hasPreferredCapacity(verdict, prefs), false);
  verdict.days.push({ date: "2035-01-09", isWorkingDay: true, capacityHours: 24, availableTechnicians: 3 });
  assert.equal(hasPreferredCapacity(verdict, prefs), true);
});

function persistenceFixture(failure, transactions = false) {
  const rows = new Map(), events = [];
  const documents = ["booking", "assignment", "project", "payment"].map(kind => {
    class Model {
      constructor(data) { Object.assign(this, data); }
      toObject() { return { _id: kind }; }
      async save(options) { events.push([kind, options?.session ? "transaction" : "standalone"]); rows.set(this._id, this); if (failure === kind) throw Error("Write failed"); }
      static async deleteOne({ _id }) { rows.delete(_id); }
    }
    return new Model({ _id: kind });
  });
  const session = { withTransaction: async work => { try { await work(); } catch (error) { rows.clear(); throw error; } }, endSession: async () => events.push("ended") };
  const mongoose = { connection: { getClient: () => ({ topology: { description: { servers: new Map([["db", { type: transactions ? "RSPrimary" : "Standalone" }]]) } } }) }, startSession: async () => session };
  return { documents, mongoose, rows, events };
}
test("standalone MongoDB reverses a failed payment and its new booking/assignment/project", async () => {
  for (const failure of ["booking", "assignment", "project", "payment"]) {
    const fixture = persistenceFixture(failure);
    await assert.rejects(persistWalkInService(fixture), /Write failed/);
    assert.equal(fixture.rows.size, 0);
  }
});
test("transactional MongoDB aborts incomplete walk-ins and commits all four records together", async () => {
  const failed = persistenceFixture("payment", true);
  await assert.rejects(persistWalkInService(failed)); assert.equal(failed.rows.size, 0);
  const fixture = persistenceFixture(null, true);
  assert.equal((await persistWalkInService(fixture)).length, 4);
  assert.equal(fixture.rows.size, 4); assert.equal(fixture.events.at(-1), "ended");
});
test("deadline extensions start from now when overdue and reject malformed lengths", () => {
  assert.equal(extendAcceptanceDeadline("2035-01-01T01:00:00Z", 60, now).toISOString(), "2035-01-01T03:00:00.000Z");
  assert.equal(extendAcceptanceDeadline("2035-01-01T03:00:00Z", 60, now).toISOString(), "2035-01-01T04:00:00.000Z");
  for (const minutes of [0, -1, 721, 5.5, "6abc", {}, true, ""]) assert.throws(() => extendAcceptanceDeadline(null, minutes, now));
});
test("order deadline extensions preserve the assignment time and original schedule checks", () => {
  const order = { status: "technician_assigned", fulfillmentType: "delivery_installation", delivery: { preferredDate: "2035-01-02" }, timeSlot: "09:00", technicianAcceptance: { status: "pending", deadlineAt: "2035-01-01T05:00:00Z" }, statusHistory: [{ status: "technician_assigned", timestamp: "2035-01-01T00:00:00Z" }] };
  const result = orderAttentionState(order, now);
  assert.equal(result.assignedAt, "2035-01-01T00:00:00.000Z"); assert.equal(result.acceptanceDeadlineAt, "2035-01-01T05:00:00.000Z");
  assert.equal(result.isAcceptanceOverdue, false);
  assert.equal(orderAttentionState(order, new Date("2035-01-03T00:00:00Z")).isPastDate, true);
});
