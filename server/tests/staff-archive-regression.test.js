"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../models/User");
const Technician = require("../models/Technician");
const controller = require("../controllers/adminController");
const audit = require("../utils/audit");
const { writeStaffLifecycle } = require("../utils/staffLifecycleWrite");

const actorId = new mongoose.Types.ObjectId();
const reason = "Employment ended; historical records retained.";

function fixture(t, options = {}) {
  const user = options.profileOnly ? null : User.hydrate({
    _id: new mongoose.Types.ObjectId(), __v: 2, role: options.role || "technician",
    firstName: "Regression", lastName: "Fixture", email: "fixture@example.test",
    phone: "0917-123-4567", passwordHash: "synthetic-hash", currentSessionId: "old-session",
    ...options.user,
  });
  const technician = options.role === "secretary" ? null : Technician.hydrate({
    _id: new mongoose.Types.ObjectId(), __v: 4, user: user?._id,
    name: "Regression Fixture", availabilityStatus: "Available", ...options.technician,
  });
  const models = new Map([[User, user], [Technician, technician]].filter(([, doc]) => doc));
  const stored = new Map([...models].map(([Model, doc]) => [Model, doc.toObject({ virtuals: false })]));
  const writes = [], reversals = [], events = [];
  t.mock.method(mongoose.connection, "getClient", () => ({ topology: { description: {
    servers: new Map([["fixture", { type: "Standalone" }]]),
  } } }));
  t.mock.method(User, "findOne", async query => user && String(query._id) === String(user._id) ? user : null);
  t.mock.method(Technician, "findOne", async () => technician);
  t.mock.method(Technician, "findById", async () => technician);
  for (const name of ["Assignment", "BookingService", "Order", "Project"]) {
    t.mock.method(require(`../models/${name}`), "countDocuments", async () => options.blockers?.[name] || 0);
  }
  t.mock.method(audit, "logEvent", async event => { events.push(event); });
  const apply = (Model, update) => {
    const before = stored.get(Model);
    const after = { ...before, ...update.$set, __v: (before.__v || 0) + (update.$inc?.__v || 0) };
    for (const key of Object.keys(update.$unset || {})) delete after[key];
    stored.set(Model, after);
    return after;
  };
  for (const Model of models.keys()) {
    // Keep real Mongoose query casting and update validation. Only the database
    // driver boundary is replaced, so unrelated required fields are exercised.
    t.mock.method(Model.collection, "findOneAndUpdate", async (filter, update, settings) => {
      writes.push({ Model, filter, update, settings });
      if (options.failTechnician && Model === Technician) throw new Error("Synthetic storage failure");
      if (options.conflict && Model === Technician) return null;
      assert.equal(filter.__v, stored.get(Model).__v);
      return apply(Model, update);
    });
    t.mock.method(Model.collection, "updateOne", async (filter, update) => {
      reversals.push({ Model, filter, update });
      assert.equal(filter.__v, stored.get(Model).__v);
      apply(Model, update);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }
  async function call(action = "archiveStaff", body = { reason }) {
    let status = 200, output, error;
    const res = { status(value) { status = value; return this; }, json(value) { output = value; return this; } };
    await controller[action]({ params: { id: String((user || technician)._id) }, user: { _id: actorId }, body },
      res, value => { error = value; });
    return { status, output, error };
  }
  return { user, technician, stored, writes, reversals, events, call };
}

test("secretary archive tolerates legacy phone formatting and keeps account data unchanged", async t => {
  const f = fixture(t, { role: "secretary" });
  await assert.rejects(f.user.validate(), error => Boolean(error.errors.phone));
  const result = await f.call();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 200);
  const saved = f.stored.get(User);
  assert.equal(saved.active, false);
  assert.equal(saved.phone, "0917-123-4567");
  assert.equal(saved.passwordHash, "synthetic-hash");
  assert.notEqual(saved.currentSessionId, "old-session");
  assert.equal(result.output.staff.passwordHash, undefined);
  assert.equal(result.output.staff.currentSessionId, undefined);
  assert.equal(f.events[0].action, "staff.archive");
});

test("archive updates only lifecycle fields even if a legacy account lacks required profile data", async t => {
  const f = fixture(t, { role: "secretary", user: { firstName: undefined, passwordHash: undefined } });
  const result = await f.call();
  assert.equal(result.error, undefined);
  assert.equal(f.stored.get(User).firstName, undefined);
  assert.deepEqual(Object.keys(f.writes[0].update.$set).sort(), [
    "active", "archiveReason", "archivedAt", "archivedBy", "currentSessionId", "staffLifecycleHistory",
  ].sort());
  assert.equal(f.writes[0].settings.runValidators, true);
});

test("linked technician and login account archive together and preserve previous history", async t => {
  const prior = { action: "restored", at: new Date("2026-01-01"), by: actorId, reason: "Previous event" };
  const f = fixture(t, { user: { staffLifecycleHistory: [prior] }, technician: { staffLifecycleHistory: [prior] } });
  const result = await f.call();
  assert.equal(result.error, undefined);
  for (const Model of [User, Technician]) {
    const saved = f.stored.get(Model);
    assert.equal(saved.active, false);
    assert.equal(String(saved.archivedBy), String(actorId));
    assert.equal(saved.archiveReason, reason);
    assert.equal(saved.staffLifecycleHistory.length, 2);
    assert.equal(saved.staffLifecycleHistory[0].reason, "Previous event");
    assert.equal(saved.staffLifecycleHistory[1].action, "archived");
  }
  assert.equal(f.stored.get(Technician).availabilityStatus, "Offline");
  assert.equal(f.stored.get(User).archivedAt.getTime(), f.stored.get(Technician).archivedAt.getTime());
});

test("legacy technician profile without a user or required name can still be archived", async t => {
  const f = fixture(t, { profileOnly: true, technician: { name: undefined } });
  const result = await f.call();
  assert.equal(result.error, undefined);
  assert.equal(result.output.staff.staffRecordType, "technician_profile");
  assert.equal(f.stored.get(Technician).active, false);
  assert.equal(f.stored.has(User), false);
});

test("short archive reason is rejected before any account changes", async t => {
  const f = fixture(t);
  const result = await f.call("archiveStaff", { reason: "short" });
  assert.equal(result.status, 400);
  assert.equal(result.output.code, "INVALID_ARCHIVE_REASON");
  assert.equal(f.writes.length, 0);
});

test("unfinished work blocks archive with an actionable response", async t => {
  const f = fixture(t, { blockers: { BookingService: 1, Order: 2 } });
  const result = await f.call();
  assert.equal(result.status, 409);
  assert.equal(result.output.code, "ACTIVE_WORK_BLOCKS_ARCHIVE");
  assert.equal(result.output.blockers.total, 3);
  assert.equal(f.writes.length, 0);
});

test("repeated archive does not add history or change the session again", async t => {
  const archived = { active: false, archivedAt: new Date(), archiveReason: reason };
  const f = fixture(t, { user: archived, technician: archived });
  const result = await f.call();
  assert.match(result.output.message, /already archived/);
  assert.equal(f.writes.length, 0);
});

test("retry repairs a previously partial archive instead of treating it as complete", async t => {
  const f = fixture(t, { user: { active: false, archivedAt: new Date() } });
  const result = await f.call();
  assert.equal(result.error, undefined);
  assert.equal(f.stored.get(Technician).active, false);
  assert.ok(f.stored.get(Technician).archivedAt);
});

test("restore works on legacy data and resets both linked records", async t => {
  const archived = { active: false, archivedAt: new Date(), archivedBy: actorId, archiveReason: reason };
  const f = fixture(t, { user: archived, technician: archived });
  const result = await f.call("restoreStaff", {});
  assert.equal(result.error, undefined);
  for (const Model of [User, Technician]) {
    assert.equal(f.stored.get(Model).active, true);
    assert.equal(f.stored.get(Model).archivedAt, null);
    assert.equal(f.stored.get(Model).staffLifecycleHistory.at(-1).action, "restored");
  }
  assert.equal(f.stored.get(User).phone, "0917-123-4567");
  assert.notEqual(f.stored.get(User).currentSessionId, "old-session");
});

test("restore repairs a partial restore when the login account is already active", async t => {
  const f = fixture(t, { technician: { active: false, archivedAt: new Date() } });
  const result = await f.call("restoreStaff");
  assert.equal(result.error, undefined);
  assert.equal(f.stored.get(Technician).active, true);
  assert.equal(f.stored.get(Technician).archivedAt, null);
});

test("failure on the linked profile reverses account archive and session revocation", async t => {
  const f = fixture(t, { failTechnician: true });
  const result = await f.call();
  assert.match(result.error.message, /Synthetic storage failure/);
  assert.equal(f.stored.get(User).active, true);
  assert.equal(f.stored.get(User).archivedAt, null);
  assert.equal(f.stored.get(User).currentSessionId, "old-session");
  assert.equal(f.stored.get(User).staffLifecycleHistory.length, 0);
  assert.equal(f.reversals.length, 1);
  assert.equal(f.events.length, 0);
});

test("concurrent staff changes return a staff-specific conflict and reverse the first write", async t => {
  const f = fixture(t, { conflict: true });
  const result = await f.call();
  assert.equal(result.status, 409);
  assert.equal(result.output.code, "STAFF_CHANGED");
  assert.match(result.output.error, /staff record changed/);
  assert.equal(f.stored.get(User).active, true);
});

test("lifecycle field validation still rejects an invalid actor and does not persist it", async t => {
  const f = fixture(t, { role: "secretary" });
  await assert.rejects(writeStaffLifecycle({ kind: "user", user: f.user, technician: null },
    { action: "archived", actorId: "invalid-id", reason }), error => error.name === "CastError");
  assert.equal(f.writes.length, 0);
});

test("replica-set deployments update the linked records within one transaction", async t => {
  const f = fixture(t);
  let transactions = 0, ended = false;
  class FixtureSession {
    async withTransaction(work) { transactions++; await work(); }
    async endSession() { ended = true; }
  }
  const session = new FixtureSession();
  t.mock.method(mongoose.connection, "getClient", () => ({ topology: { description: {
    servers: new Map([["fixture", { type: "RSPrimary" }]]),
  } } }));
  t.mock.method(mongoose, "startSession", async () => session);
  const result = await f.call();
  assert.equal(result.error, undefined);
  assert.equal(transactions, 1);
  assert.equal(ended, true);
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(write => write.settings.session === session));
});

test("oversized lifecycle reasons still fail update validation", async t => {
  const f = fixture(t, { role: "secretary" });
  await assert.rejects(writeStaffLifecycle({ kind: "user", user: f.user, technician: null },
    { action: "archived", actorId, reason: "x".repeat(501) }), error => error.name === "ValidationError");
  assert.equal(f.writes.length, 0);
});
