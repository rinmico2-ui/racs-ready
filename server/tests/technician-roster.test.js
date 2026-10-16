"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../models/User"), Technician = require("../models/Technician");
const { rosterEntry, loadTechnicianRoster } = require("../utils/technicianRoster");
const controller = require("../controllers/adminController");
const { createService } = require("../utils/standardJobTeamService");
const id = number => number.toString(16).padStart(24, "0");
const account = (number, data = {}) => ({ _id: id(number), firstName: "Staff", lastName: String(number), email: `staff${number}@example.test`,
  phone: "09171234567", role: "technician", active: true, emailVerified: true, accountStatus: "active", ...data });
const profile = (number, user, data = {}) => ({ _id: id(100 + number), name: "Old profile name", user, active: true,
  phone: "old phone", userEmail: "old@example.test", availabilityStatus: "Available", ...data });
function query(value) { return { select() { return this; }, populate() { return this; }, session() { return this; }, lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }

test("Staff List account supplies identity and status while operational technician IDs and location remain stable", () => {
  const user = account(1), location = { type: "Point", coordinates: [120.9, 15.4] };
  const result = rosterEntry(profile(1, user, { active: false, archivedAt: new Date(), location }));
  assert.equal(result.name, "Staff 1"); assert.equal(result.email, user.email); assert.equal(result.phone, user.phone);
  assert.equal(result.active, true); assert.equal(result.archivedAt, null); assert.equal(result.assignmentEligible, true);
  assert.equal(String(result._id), id(101)); assert.equal(String(result.technicianId), id(101)); assert.equal(String(result.staffId), id(1));
  assert.deepEqual(result.location, location);
});

for (const [name, data, state] of [
  ["archived", { archivedAt: new Date() }, "archived"], ["inactive", { active: false }, "inactive"],
  ["blocked", { blocked: true }, "blocked"], ["unverified", { emailVerified: false }, "invited"],
  ["invited", { accountStatus: "invited" }, "invited"],
]) test(`${name} accounts cannot be assigned even when their technician profile is active`, () => {
  const row = rosterEntry(profile(1, account(1, data)));
  assert.equal(row.assignmentEligible, false); assert.equal(row.loginState, state); assert.ok(row.assignmentReason);
});

test("secretary/customer accounts linked to technician profiles are excluded", () => {
  for (const role of ["secretary", "customer", "admin", "missing_account"]) assert.equal(rosterEntry(profile(1, account(1, { role }))), null);
});

test("profile-only staff remain visible but cannot receive work they cannot sign in to accept", () => {
  const row = rosterEntry(profile(1, null));
  assert.equal(row.active, true); assert.equal(row.assignmentEligible, false); assert.equal(row.loginState, "missing");
  assert.equal(row.staffId, id(101)); assert.equal(row.user, null);
});

test("roster exposes no password, session, OTP or invitation secrets", () => {
  const row = rosterEntry(profile(1, account(1, { passwordHash: "PRIVATE-PASSWORD", currentSessionId: "PRIVATE-SESSION", loginOtpHash: "PRIVATE-OTP", invitationTokenHash: "PRIVATE-INVITE" })));
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE-|passwordHash|currentSessionId|loginOtpHash|invitationTokenHash/);
});

test("directory includes missing work profiles once and distinguishes them from operational technician IDs", async () => {
  const users = [account(1), account(2), account(3, { archivedAt: new Date(), active: false })];
  const Technician = { find: filter => { assert.deepEqual(filter, {}); return query([profile(1, users[0]), profile(4, null)]); } };
  const User = { find: filter => { assert.deepEqual(filter, { role: "technician" }); return query(users); } };
  const result = await loadTechnicianRoster({ Technician, User, includeMissingAccounts: true, includeInactive: true });
  assert.equal(result.length, 4);
  const missing = result.find(row => row.staffId === id(2));
  assert.equal(missing.technicianId, null); assert.equal(missing.assignmentEligible, false); assert.equal(missing.loginState, "missing_profile");
  assert.equal(result.filter(row => row.staffId === id(1)).length, 1);
});

test("Technician Directory matches Staff List technician identities including archived and profile-only records", async t => {
  const users = [account(1), account(2, { active: false, archivedAt: new Date() }), account(3), account(4, { role: "secretary" })];
  const raw = [profile(1, id(1)), profile(2, id(2)), profile(5, null), profile(6, id(4))];
  t.mock.method(User, "find", filter => query(users.filter(user => typeof filter.role === "string" ? user.role === filter.role : filter.role.$in.includes(user.role))));
  t.mock.method(Technician, "find", () => {
    let population;
    return { select() { return this; }, populate(options) { population = options; return this; }, lean: async () => population
      ? raw.map(row => ({ ...row, user: row.user ? population.transform(users.find(user => user._id === row.user), row.user) : null })) : raw };
  });
  t.mock.method(require("../models/Secretary"), "find", () => query([]));
  let staff, directory;
  await controller.listStaff({}, { json: value => { staff = value.staff; } }, error => { throw error; });
  await controller.listTechnicians({ query: { roster: "all" } }, { set() {}, json: value => { directory = value.technicians; } }, error => { throw error; });
  const expected = staff.filter(row => row.role === "technician").map(row => String(row._id)).sort();
  assert.deepEqual(directory.map(row => String(row.staffId)).sort(), expected);
  assert.equal(directory.find(row => row.staffId === id(1)).name, "Staff 1");
  assert.equal(directory.find(row => row.staffId === id(2)).lifecycleState, "archived");
});

test("deleted linked accounts do not reappear as profile-only staff", async () => {
  let options;
  const result = await loadTechnicianRoster({ Technician: { find: () => ({ select() { return this; }, populate(value) { options = value; return this; },
    lean: async () => [profile(1, options.transform(null, id(1)))] }) } });
  assert.deepEqual(result, []);
});

for (const source of ["booking", "order"]) test(`${source} team picker checks only eligible Staff List accounts and reports account setup problems`, async () => {
  const profiles = [profile(1, account(1), { active: false }), profile(2, account(2, { emailVerified: false })),
    profile(3, account(3, { active: false })), profile(4, account(4, { archivedAt: new Date() })), profile(5, null)];
  const calls = [];
  const service = createService({ Technician: { find: () => query(profiles) }, slots: async (input, exclusions) => {
    calls.push({ input, exclusions }); return { statusCode: 200, payload: { timeSlots: [{ startTime: "08:00", available: true }] } };
  } });
  const job = { _id: id(300), bookingDate: new Date("2099-01-05T00:00:00+08:00"), startTime: "08:00", endTime: "10:00",
    delivery: { preferredDate: new Date("2099-01-05T00:00:00+08:00") }, timeSlot: "08:00", items: [{ quantity: 1 }] };
  const result = await service.candidates(source, job);
  assert.equal(calls.length, 1); assert.equal(calls[0].input.technicianId, id(101));
  assert.equal(calls[0].exclusions.existingAppointment, true);
  assert.equal(result.candidates.find(row => row.technicianId === id(101)).name, "Staff 1");
  assert.equal(result.candidates.find(row => row.technicianId === id(102)).available, false);
  assert.match(result.candidates.find(row => row.technicianId === id(102)).reason, /setup/);
  assert.ok(result.candidates.every(row => ![id(103), id(104)].includes(row.technicianId)));
});

test("creating a missing work profile uses the exact staff account and an idempotent validated upsert", async t => {
  const user = account(1); let write, event;
  t.mock.method(User, "findOne", filter => { assert.equal(filter._id, user._id); assert.equal(filter.role, "technician"); return query(user); });
  t.mock.method(Technician, "findOneAndUpdate", async (filter, update, options) => {
    write = { filter, update, options }; return { _id: id(101) };
  });
  t.mock.method(require("../utils/audit"), "logEvent", async value => { event = value; });
  let result;
  await controller.createStaffWorkProfile({ params: { id: user._id }, user: { _id: id(9) } }, { json: value => { result = value; } }, error => { throw error; });
  assert.equal(write.filter.user, user._id); assert.equal(write.update.$setOnInsert.name, "Staff 1");
  assert.equal(write.update.$setOnInsert.userEmail, user.email); assert.equal(write.options.upsert, true); assert.equal(write.options.runValidators, true);
  assert.equal(write.options.setDefaultsOnInsert, false); assert.equal(write.update.$set, undefined);
  assert.equal(result.technicianId, id(101)); assert.equal(event.action, "staff.work_profile_ready");
});

test("work profile setup rejects archived/blocked or non-technician staff before creating anything", async t => {
  t.mock.method(User, "findOne", () => query(null));
  let status, result;
  await controller.createStaffWorkProfile({ params: { id: id(1) }, user: { _id: id(9) } },
    { status(value) { status = value; return this; }, json(value) { result = value; } }, error => { throw error; });
  assert.equal(status, 409); assert.match(result.error, /active technician/);
});

test("existing team roster reload is scoped to selected technician IDs and uses the assignment transaction", async () => {
  const session = { fixture: true }; let actualSession, filter;
  const result = await loadTechnicianRoster({ session, technicianIds: [id(101)], Technician: { find(value) {
    filter = value; return { populate() { return this; }, select() { return this; }, session(value) { actualSession = value; return this; }, lean: async () => [profile(1, account(1))] };
  } } });
  assert.deepEqual(filter, { _id: { $in: [id(101)] } }); assert.equal(actualSession, session); assert.equal(result[0].assignmentEligible, true);
});

test("order eligible-technician endpoint uses Staff List names and future availability instead of current busy status", async t => {
  const order = { _id: id(300), fulfillmentType: "delivery_only", delivery: { preferredDate: new Date("2099-01-05T00:00:00+08:00") },
    timeSlot: "08:00", items: [{ quantity: 1 }] };
  const profiles = [profile(1, account(1), { availabilityStatus: "Assigned" }), profile(2, account(2, { emailVerified: false }))];
  t.mock.method(Technician, "find", () => query(profiles));
  t.mock.method(require("../models/Order"), "findById", () => query(order));
  for (const name of ["Order", "BookingService", "Assignment", "DailyAssignment", "LeaveRequest"]) {
    t.mock.method(require(`../models/${name}`), "find", () => query([]));
  }
  t.mock.method(require("../models/TechnicianSchedule"), "find", () => query([]));
  const router = require("../routes/orderRoutes");
  const endpoint = router.stack.find(layer => layer.route?.path === "/:id/eligible-technicians").route.stack.at(-1).handle;
  let result, status = 200;
  await endpoint({ params: { id: order._id } }, { status(value) { status = value; return this; }, json(value) { result = value; } });
  assert.equal(status, 200); assert.equal(result.available.length, 1);
  assert.equal(result.available[0].name, "Staff 1"); assert.equal(result.available[0].available, true);
  assert.equal(result.offlinePresent.length, 1); assert.match(result.offlinePresent[0].reason, /setup/);
});
