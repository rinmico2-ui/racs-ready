"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Technician = require("../models/Technician");
const Assignment = require("../models/Assignment");
const Booking = require("../models/BookingService");
const Notification = require("../models/Notification");
const expiry = require("../utils/assignmentExpiry");
const now = new Date("2026-10-14T17:00:00Z");
const techId = new mongoose.Types.ObjectId("670000000000000000000001");

test("malformed product IDs from the production log return 404 without reaching MongoDB", async t => {
  const product = require("../models/HVACProduct");
  const spy = t.mock.method(product, "findById", () => { throw Error("must not query"); });
  const pages = require("../routes/pages");
  const handler = pages.stack.find(layer => layer.route?.path === "/products/:id").route.stack.at(-1).handle;
  for (const id of ['${safeCheckoutImageUrl(inv.imageUrl)}', "2371053227126095406", "4910737825435824692", "undefined", "x".repeat(1000), "", "z".repeat(24)]) {
    const res = { status(code) { this.code = code; return this; }, render(page) { this.page = page; } };
    await handler({ params: { id } }, res, error => { throw error; });
    assert.equal(res.code, 404); assert.equal(res.page, "pages/404");
  }
  assert.equal(spy.mock.callCount(), 0);
});
test("valid ObjectIds still follow the product lookup and missing-product flow", async t => {
  const product = require("../models/HVACProduct"); let received;
  t.mock.method(product, "findById", id => { received = id; return { populate() { return this; }, lean: async () => null }; });
  const handler = require("../routes/pages").stack.find(layer => layer.route?.path === "/products/:id").route.stack.at(-1).handle;
  const id = "67000000000000000000000A";
  const res = { status(code) { this.code = code; return this; }, render() {} };
  await handler({ params: { id } }, res, error => { throw error; });
  assert.equal(received, id); assert.equal(res.code, 404);
});
test("saving a legacy technician repairs the malformed timestamp in the same write", async t => {
  const doc = Technician.hydrate({ _id: techId, name: "Technician", createdAt: {}, availabilityStatus: "Assigned" });
  let written;
  t.mock.method(Technician.collection, "updateOne", async (_filter, update) => { written = update; return { acknowledged: true, matchedCount: 1 }; });
  doc.availabilityStatus = "Available";
  await doc.save();
  assert.deepEqual(doc.createdAt, techId.getTimestamp());
  assert.deepEqual(written.$set.createdAt, techId.getTimestamp());
  assert.equal(written.$set.availabilityStatus, "Available");
});
test("valid technician dates are preserved and malformed new dates/statuses remain invalid", async () => {
  const valid = new Date("2020-01-01T00:00:00Z");
  const old = Technician.hydrate({ _id: techId, name: "Technician", createdAt: valid });
  await old.validate(); assert.deepEqual(old.createdAt, valid);
  await assert.rejects(new Technician({ name: "Technician", createdAt: {} }).validate(), /createdAt/);
  await assert.rejects(new Technician({ name: "Technician", availabilityStatus: "available" }).validate(), /availabilityStatus/);
});
function fixture(t, { busy = false, attendanceStatus = "Available", savedStatus = "Assigned", reassigned = false, failBooking = false } = {}) {
  const assignment = { _id: "assignment", technicianId: techId, bookingId: "booking", serviceName: "Aircon", status: "expired", expiredReason: "No response before deadline" };
  let bookingSaves = 0, techSaves = 0, finished = 0, resolved = 0, notifications = 0;
  const booking = { _id: "booking", status: "assigned", assignmentId: reassigned ? "new-assignment" : assignment._id, technicianId: techId,
    recordStatusHistory() {}, async save() { bookingSaves++; if (failBooking) throw Error("bad booking"); } };
  const tech = Technician.hydrate({ _id: techId, name: "Technician", user: new mongoose.Types.ObjectId(), createdAt: {}, availabilityStatus: savedStatus });
  tech.save = async function() { techSaves++; await this.validate(); };
  t.mock.method(Booking, "findById", async () => booking);
  t.mock.method(Technician, "findById", async () => tech);
  t.mock.method(Assignment, "exists", async filter => filter.technicianId ? busy : false);
  t.mock.method(Assignment, "updateOne", async () => { finished++; });
  t.mock.method(Notification, "exists", async () => true);
  t.mock.method(require("../utils/availability"), "resolveAvailabilityStatus", async (_tech, _attendance, _leave, options) => {
    resolved++; assert.equal(options.today.toISOString(), "2026-10-15T00:00:00.000Z"); return attendanceStatus;
  });
  t.mock.method(require("../utils/notify"), "createNotification", async () => { notifications++; return {}; });
  return { assignment, tech, booking, snapshot: () => ({ bookingSaves, techSaves, finished, resolved, notifications }) };
}
for (const attendanceStatus of ["Available", "Offline", "Unavailable"]) {
  test(`expiry resolves ${attendanceStatus} from attendance/leave and repairs the legacy technician`, async t => {
    const f = fixture(t, { attendanceStatus });
    await expiry.finishExpiry(f.assignment, now);
    assert.equal(f.tech.availabilityStatus, attendanceStatus); assert.deepEqual(f.tech.createdAt, techId.getTimestamp());
    assert.equal(f.booking.status, "pending_reassignment"); assert.equal(f.booking.assignmentId, null); assert.equal(f.booking.reassignmentCount, 1);
    assert.equal(f.snapshot().finished, 1);
  });
}
test("expiry does not free a technician who has another active assignment", async t => {
  const f = fixture(t, { busy: true, savedStatus: "In Progress" }); await expiry.finishExpiry(f.assignment, now);
  assert.equal(f.tech.availabilityStatus, "In Progress"); assert.equal(f.snapshot().resolved, 0);
});
test("an old expired assignment cannot clear a newer booking assignment", async t => {
  const f = fixture(t, { reassigned: true }); await expiry.finishExpiry(f.assignment, now);
  assert.equal(f.booking.assignmentId, "new-assignment"); assert.equal(f.snapshot().bookingSaves, 0);
});
test("expiry notifications target the technician's user and do not duplicate completed notifications", async t => {
  const f = fixture(t); const saved = new Set(); const created = [];
  t.mock.method(Notification, "exists", async filter => saved.has(String(filter.userId)));
  t.mock.method(require("../utils/notify"), "createNotification", async data => { saved.add(String(data.userId)); created.push(data); return {}; });
  await expiry.finishExpiry(f.assignment, now); await expiry.finishExpiry(f.assignment, now);
  assert.equal(created.length, 2); assert.equal(String(created[1].userId), String(f.tech.user));
});
test("the expiry worker retries interrupted expired records, isolates failures, and claims only pending work", async t => {
  const f = fixture(t); const errors = []; const processed = [];
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => work());
  t.mock.method(Assignment, "find", filter => {
    assert.equal(filter.$or[1].status, "expired"); assert.equal(filter.$or[1].expiryProcessedAt, null);
    return { limit() { return this; }, lean: async () => [{ _id: "bad" }, { _id: "retry" }, { _id: "already-accepted" }] };
  });
  t.mock.method(Assignment, "findOneAndUpdate", async (filter, update) => {
    assert.equal(filter.status, "pending_acceptance"); assert.deepEqual(filter.acceptanceDeadline.$lt, now);
    assert.equal(update.$set.status, "expired"); if (filter._id === "bad") throw Error("malformed assignment"); return null;
  });
  t.mock.method(Assignment, "findOne", async ({ _id }) => _id === "retry" ? f.assignment : null);
  t.mock.method(Assignment, "updateOne", async ({ _id }) => { processed.push(_id); });
  await expiry.processAssignmentExpiry({ now, onError: error => errors.push(error) });
  assert.equal(errors.length, 1); assert.deepEqual(processed, ["assignment"]);
});
