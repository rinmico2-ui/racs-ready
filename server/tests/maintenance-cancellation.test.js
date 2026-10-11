"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { maintenanceCancellationBlock, attachMaintenanceCancellation, cancelCustomerMaintenance } = require("../utils/maintenanceCancellation");
const { reopenScheduleAfterBookingCancellation } = require("../utils/maintenanceLifecycle");

const request = { bookingId: "visit", customerId: "owner", actorName: "Customer", reason: " Changed  my plans today " };
const baseBooking = () => ({ _id: "visit", customerId: "owner", status: "awaiting_assignment",
  maintenance: { isMaintenance: true, paymentOnSite: true, assetId: "aircon", scheduleId: "cycle" },
  amountPaid: 0, paymentStatus: "pending", services: [{ status: "awaiting_assignment", statusHistory: [] }] });

function fixture(overrides = {}, { assigned = false, paid = false, reopenFails = false, retryAssigned = false } = {}) {
  let stored = { ...baseBooking(), ...overrides }, staged, sessions = 0, saves = 0, reopens = 0;
  const events = [];
  const session = {
    async withTransaction(callback) {
      try {
        await callback();
        if (retryAssigned) {
          staged = null;
          stored.status = "assigned";
          stored.technicianId = "technician";
          await callback();
        }
        if (staged) stored = staged;
        events.push("commit");
      } catch (error) { staged = null; events.push("abort"); throw error; }
    },
    async endSession() { events.push("end"); },
  };
  const query = value => ({ session(valueSession) { assert.equal(valueSession, session); return Promise.resolve(value); } });
  const dependencies = {
    mongoose: { async startSession() { sessions++; return session; } },
    Booking: { findById(id) {
      assert.equal(id, request.bookingId);
      const doc = structuredClone(stored);
      doc.save = async options => { assert.equal(options.session, session); saves++; staged = structuredClone(Object.fromEntries(Object.entries(doc).filter(([, value]) => typeof value !== "function"))); events.push("save"); };
      doc.$session = value => assert.equal(value, null);
      return query(doc);
    } },
    Assignment: { exists(filter) { assert.ok(filter.status.$nin.includes("declined")); return query(assigned); } },
    Payment: { exists(filter) { assert.ok(filter.status.$nin.includes("rejected")); return query(paid); } },
    async reopen(booking, options) {
      assert.equal(booking.status, "cancelled"); assert.equal(options.session, session);
      reopens++; events.push("reopen");
      if (reopenFails) throw new Error("Schedule write failed");
    },
  };
  return { dependencies, events, get stored() { return stored; }, get saves() { return saves; }, get reopens() { return reopens; }, get sessions() { return sessions; } };
}

test("an unpaid unassigned aftercare visit can be cancelled with its reminder in one transaction", async () => {
  const f = fixture();
  const result = await cancelCustomerMaintenance(request, f.dependencies);
  assert.equal(result.cancellation.changed, true);
  assert.equal(f.stored.status, "cancelled");
  assert.equal(f.stored.services[0].status, "cancelled");
  assert.equal(f.stored.cancellationReason, "Changed my plans today");
  assert.equal(f.stored.cancelledBy, "owner");
  assert.deepEqual(f.events, ["save", "reopen", "commit", "end"]);
});

test("invalid cancellation reasons never start a transaction", async () => {
  for (const reason of ["short", "no    money", "x".repeat(501)]) {
    const f = fixture();
    await assert.rejects(cancelCustomerMaintenance({ ...request, reason }, f.dependencies), error => error.status === 400);
    assert.equal(f.sessions, 0); assert.equal(f.saves, 0);
  }
});

test("a customer cannot cancel another customer's maintenance", async () => {
  const f = fixture({ customerId: "another-owner" });
  await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), error => error.status === 403);
  assert.equal(f.saves, 0); assert.equal(f.reopens, 0);
  assert.deepEqual(f.events, ["abort", "end"]);
});

test("assigned, started, paid and submitted-payment visits require staff review", async () => {
  const cases = [
    { status: "assigned" }, { status: "confirmed" }, { status: "en_route" }, { status: "in_progress" },
    { status: "completed" }, { technicianId: "tech" }, { assignmentId: "assignment" }, { assignedAt: new Date() },
    { services: [{ status: "completed" }] }, { services: [{ status: "pending", technicianId: "tech" }] },
    { amountPaid: 1 }, { balanceCollected: true }, { paymentStatus: "waiting_for_remittance" },
    { paymentStatus: "verified" }, { paymentStatus: "refunded" }, { paymentProof: "/receipt.jpg" },
    { paymentReference: "submitted-reference" }, { paymentVerifiedAt: new Date() },
    { payments: [{ status: "pending", amount: 100 }] },
  ];
  for (const value of cases) {
    const f = fixture(value);
    await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), error => error.status === 409, JSON.stringify(value));
    assert.equal(f.saves, 0); assert.equal(f.reopens, 0);
  }
  for (const records of [{ assigned: true }, { paid: true }]) {
    const f = fixture({}, records);
    await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), error => error.status === 409);
    assert.equal(f.saves, 0); assert.equal(f.reopens, 0);
  }
});

test("ordinary bookings do not gain an awaiting-assignment cancellation permission", async () => {
  const f = fixture({ maintenance: {} });
  await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), error => error.status === 409);
  assert.equal(f.saves, 0);
});

test("a failed reminder update aborts the visit cancellation", async () => {
  const f = fixture({}, { reopenFails: true });
  await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), /Schedule write failed/);
  assert.equal(f.stored.status, "awaiting_assignment");
  assert.deepEqual(f.events, ["save", "reopen", "abort", "end"]);
});

test("a transaction retry rechecks a technician assigned after the first read", async () => {
  const f = fixture({}, { retryAssigned: true });
  await assert.rejects(cancelCustomerMaintenance(request, f.dependencies), error => error.status === 409);
  assert.equal(f.stored.status, "assigned");
  assert.equal(f.stored.technicianId, "technician");
  assert.equal(f.events.includes("commit"), false);
});

test("repeated cancellation keeps the original reason and does not save duplicate booking history", async () => {
  const f = fixture({ status: "cancelled", cancellationReason: "Original cancellation reason" });
  const result = await cancelCustomerMaintenance(request, f.dependencies);
  assert.equal(result.cancellation.changed, false);
  assert.equal(f.stored.cancellationReason, "Original cancellation reason");
  assert.equal(f.saves, 0); assert.equal(f.reopens, 1);
});

test("customer action flags use actual payment and assignment records in bounded batch reads", async () => {
  const calls = [];
  const model = ids => ({ async distinct(field, filter) { calls.push({ field, filter }); return ids; } });
  const visits = ["visit", "assigned", "paid", "free"].map(_id => ({ ...baseBooking(), _id }));
  visits.push({ ...baseBooking(), _id: "work", status: "in_progress" }, { _id: "ordinary", status: "pending" });
  const result = await attachMaintenanceCancellation(visits, { Assignment: model(["assigned"]), Payment: model(["paid"]) });
  assert.deepEqual(result.map(booking => booking.customerCanCancelMaintenance), [true, false, false, true, false, undefined]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].filter.bookingId.$in, ["visit", "assigned", "paid", "free"]);
  assert.equal(maintenanceCancellationBlock(baseBooking()), null);
});

test("reopening only changes the exact linked scheduled cycle and never touches the aircon or warranty", async () => {
  for (const [dueDate, status] of [["2026-10-01", "overdue"], ["2026-10-11", "due"], ["2027-01-08", "upcoming"]]) {
    const now = new Date("2026-10-11T12:00:00");
    const writes = [], booking = { ...baseBooking(), status: "cancelled", cancellationReason: "Changed my plans today" };
    const session = {};
    const Schedule = {
      findOne(filter) {
        assert.deepEqual(filter, { bookingId: "visit", status: "scheduled", customerId: "owner", _id: "cycle" });
        return { select() { return this; }, session(value) { assert.equal(value, session); return this; }, lean: async () => ({ _id: "cycle", dueDate }) };
      },
      async findOneAndUpdate(filter, update, options) { writes.push({ filter, update, options }); return { status }; },
    };
    const result = await reopenScheduleAfterBookingCancellation(booking, { Schedule, session, now, actorId: "owner", actorName: "Customer" });
    assert.equal(result.status, status);
    const write = writes[0];
    assert.equal(write.filter.bookingId, "visit"); assert.equal(write.filter.status, "scheduled");
    assert.equal(write.update.$set.bookingId, null); assert.equal(write.update.$set.status, status);
    assert.equal(write.update.$set["customerResponse.status"], "none");
    assert.equal(write.update.$set.dueDate, undefined);
    assert.equal(write.update.$push.history.changedBy, "owner");
    assert.match(write.update.$push.history.reason, /Changed my plans today/);
    assert.equal(write.options.session, session);
  }
});

test("repeated reopen and a cycle rebooked during cancellation do not clear a newer visit", async () => {
  let writes = 0;
  const booking = { ...baseBooking(), status: "cancelled" };
  const Schedule = {
    findOne() { return { select() { return this; }, lean: async () => null }; },
    async findOneAndUpdate() { writes++; return null; },
  };
  assert.equal(await reopenScheduleAfterBookingCancellation(booking, { Schedule }), null);
  assert.equal(writes, 0);
  Schedule.findOne = () => ({ select() { return this; }, lean: async () => ({ _id: "cycle", dueDate: "2027-01-08" }) });
  assert.equal(await reopenScheduleAfterBookingCancellation(booking, { Schedule }), null);
  assert.equal(writes, 1);
  assert.equal(await reopenScheduleAfterBookingCancellation({ ...booking, status: "completed" }, { Schedule }), null);
  assert.equal(writes, 1);
});
