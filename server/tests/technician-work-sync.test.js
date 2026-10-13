"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const { assignmentWorkDecision, technicianAssignmentScope, publishBookingWorkUpdate, BOOKING_WORK_SELECT } = require("../utils/technicianWorkSync");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const assignment = { _id: "a1", bookingId: "b1", technicianId: "t1", status: "accepted", serviceType: "core", bookingDate: new Date("2026-10-12T00:00:00+08:00"), startTime: "08:00" };
const booking = { _id: "b1", assignmentId: "a1", technicianId: "t1", status: "confirmed", bookingDate: assignment.bookingDate, startTime: "08:00" };
const query = rows => ({ select() { return this; }, lean: async () => rows });

test("cancelled, rescheduled, archived and reassigned source bookings override accepted assignment snapshots", () => {
  for (const status of ["cancelled", "reschedule-required", "pending_reassignment", "re-scheduled", "completed"]) assert.equal(assignmentWorkDecision(assignment, { ...booking, status }).current, false);
  for (const changes of [{ archivedAt: new Date() }, { technicianId: "another" }, { assignmentId: "new" }, { technicianId: null, assignmentId: null }, { bookingDate: new Date("2026-10-13T00:00:00+08:00") }, { startTime: "11:00" }]) {
    assert.equal(assignmentWorkDecision(assignment, { ...booking, ...changes }).current, false);
  }
  assert.equal(assignmentWorkDecision(assignment, booking).current, true);
  assert.equal(assignmentWorkDecision(assignment, { ...booking, startTime: "8:00 AM" }).current, true);
  assert.equal(assignmentWorkDecision(assignment, null).current, false);
});

test("valid mixed service-item visits and repair follow-up dates survive without using another item's schedule", () => {
  const item = { _id: "item", technicianId: "t1", assignmentId: "a1", status: "accepted", schedule: { date: assignment.bookingDate, startTime: "08:00" } };
  const source = { ...booking, assignmentId: "other", technicianId: "other-tech", bookingDate: new Date("2026-10-13T00:00:00+08:00"), services: [item] };
  assert.equal(assignmentWorkDecision({ ...assignment, serviceItemId: "item" }, source).current, true);
  assert.equal(assignmentWorkDecision({ ...assignment, serviceItemId: "removed" }, source).current, false);
  assert.equal(assignmentWorkDecision({ ...assignment, serviceItemId: "item" }, { ...source, services: [{ ...item, status: "cancelled" }] }).current, false);
  assert.equal(assignmentWorkDecision({ ...assignment, serviceType: "repair" }, { ...booking, bookingDate: source.bookingDate, repairSchedule: { date: assignment.bookingDate, time: "08:00" } }).current, true);
});

test("a closed review note alone does not cancel valid work; historical visits remain and order/project work uses its own workspace", () => {
  assert.equal(assignmentWorkDecision(assignment, { ...booking, resolutionCases: [{ state: "closed" }] }).current, true);
  assert.equal(assignmentWorkDecision({ ...assignment, status: "completed" }, { ...booking, status: "completed" }).historical, true);
  assert.equal(assignmentWorkDecision(assignment, { ...booking, sourceOrderId: "order" }).current, false);
  assert.equal(assignmentWorkDecision(assignment, { ...booking, isProject: true }).current, false);
});

test("work scope excludes the three cancelled sample visits before pagination and counts using two batched reads", async () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({ ...assignment, _id: `a${index}`, bookingId: `b${index}` }));
  const sources = rows.map((row, index) => ({ ...booking, _id: row.bookingId, assignmentId: row._id, status: index < 3 ? "cancelled" : "confirmed" }));
  let reads = 0;
  const scope = await technicianAssignmentScope("t1", {
    Assignments: { find(filter) { reads++; assert.equal(filter.technicianId, "t1"); return query(rows); } },
    Bookings: { find(filter) { reads++; assert.equal(filter._id.$in.length, 4); return query(sources); } },
  });
  assert.equal(reads, 2);
  assert.deepEqual(scope._id.$nin, ["a0", "a1", "a2"]);
  assert.equal(scope.technicianId, "t1");
});

test("the actual assignment-list handler uses the same scope for records and total count", async () => {
  const source = read("routes/technicianApi.js");
  const begin = source.indexOf('router.get("/assignments",');
  const start = source.indexOf("async (req, res, next) => {", begin);
  const end = source.indexOf("\n});", start);
  const filters = [];
  const scoped = { technicianId: "t1", _id: { $nin: ["a0", "a1", "a2"] } };
  const row = { ...assignment, _id: "a3" };
  const Assignments = { find(filter) { filters.push(filter); return { sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [row] }; }, countDocuments: async filter => { filters.push(filter); return 1; } };
  const handler = vm.runInNewContext("(" + source.slice(start, end + 2) + ")", {
    require: name => name.endsWith("Assignment") ? Assignments : { find: () => query([booking]) },
    Technician: { findOne: () => query({ _id: "t1" }) }, technicianAssignmentScope: async () => scoped,
    manilaDateTime: require("../utils/bookingDateTime").manilaDateTime,
    TECHNICIAN_ACTIVE_ASSIGNMENT_STATUSES: ["accepted"], TECHNICIAN_HIDDEN_ASSIGNMENT_STATUSES: ["expired"], assertNotMissedSchedule: () => false,
  });
  let result;
  await handler({ user: { _id: "user" }, query: { status: "today" } }, { json: value => { result = value; } }, error => { throw error; });
  assert.equal(result.items.length, 1); assert.equal(result.total, 1); assert.equal(result.pages, 1);
  assert.deepEqual(filters[0]._id.$nin, scoped._id.$nin);
  assert.deepEqual(filters[1]._id.$nin, scoped._id.$nin);
});

test("stale status actions reject before toolkit, attendance, status or stock writes", async () => {
  const source = read("routes/technicianApi.js");
  const begin = source.indexOf('router.patch("/assignments/:id/status",');
  const start = source.indexOf("async (req, res, next) => {", begin);
  const end = source.indexOf("\n});", start);
  const handler = vm.runInNewContext("(" + source.slice(start, end + 2) + ")", {
    require(name) {
      if (name.endsWith("Assignment")) return { findOne: async () => assignment };
      if (name.endsWith("Technician")) return { findOne: async () => ({ _id: "t1" }) };
      if (name === "mongoose") return mongoose;
      if (name.endsWith("BookingService")) return { findById: () => query({ ...booking, status: "cancelled" }) };
      return {};
    }, assignmentWorkDecision, BOOKING_WORK_SELECT,
    dailyKitDepartureReadiness: () => assert.fail("Stale jobs must not issue or check equipment"),
  });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ params: { id: "507f191e810c19729de860ea" }, body: { status: "en_route" }, user: { _id: "u1" } }, res, error => { throw error; });
  assert.equal(res.code, 409); assert.equal(res.body.code, "ASSIGNMENT_CHANGED");
  assert.equal(assignment.status, "accepted");
});

test("admin booking updates reach the old and new technician account rooms once without a global broadcast", async () => {
  const sent = [];
  function operator(rooms) { return { to(room) { return operator([...rooms, room]); }, emit(event, payload) { sent.push({ rooms, event, payload }); } }; }
  await publishBookingWorkUpdate({ io: { to: room => operator([room]) }, booking: { _id: "b1", customerId: "customer", technicianId: null, status: "cancelled" }, technicianIds: ["new"],
    Assignments: { find: () => query([{ technicianId: "old" }]) },
    Technicians: { find(filter) { assert.deepEqual(new Set(filter._id.$in), new Set(["old", "new"])); return query([{ user: "old-user" }, { user: "new-user" }]); } },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(new Set(sent[0].rooms), new Set(["admin-room", "customer:customer", "tech:old", "tech:new", "user:old-user", "user:new-user"]));
  assert.equal(sent[0].event, "booking:updated"); assert.equal(sent[0].payload.status, "cancelled");
});

test("staff order reschedules emit the current schedule event before the customer-only notification branch", async () => {
  const source = read("routes/orderRoutes.js");
  const begin = source.indexOf("async function announceCustomerOrderSchedule");
  const code = source.slice(begin, source.indexOf('\nrouter.post("/:id/admin-reschedule"', begin));
  const updates = [];
  const handler = vm.runInNewContext(code + "\nannounceCustomerOrderSchedule;", { emitOrderStatus: (req, order, extra) => updates.push({ order, extra }), require() { assert.fail("Staff rescheduling should not run the customer-only branch"); } });
  await handler({ orderCustomerReschedule: false }, { _id: "order", status: "technician_accepted" });
  assert.equal(updates.length, 1); assert.equal(updates[0].extra.scheduleUpdated, true);
});

test("both technician templates and all their inline scripts compile", () => {
  for (const filename of ["assignments.ejs", "technicianorders.ejs"]) {
    const source = read(`views/pages/technician/${filename}`);
    require("ejs").compile(source, { client: true });
    for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1].replace(/<%[\s\S]*?%>/g, "null"));
    assert.match(source, /technician-work-updates\.js/);
  }
});

test("live updates coalesce event bursts, refresh after reconnect and preserve an open action dialog", async () => {
  const timers = new Map(), events = {}, listeners = {};
  let nextId = 0, calls = 0, dialog = false, polling;
  const document = { readyState: "complete", hidden: false, querySelector: () => dialog ? {} : null, addEventListener(name, fn) { listeners[name] = fn; } };
  const window = { socket: { on(name, fn) { events[name] = fn; }, off() {} }, addEventListener(name, fn) { listeners[name] = fn; },
    setTimeout(fn) { timers.set(++nextId, fn); return nextId; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { polling = fn; },
    async _refreshTechnicianWork() { calls++; },
  };
  vm.runInNewContext(read("public/js/technician-work-updates.js"), { window, document, console });
  const flush = async () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) await fn(); };
  events["booking:updated"](); events["order:status-change"](); events.connect();
  assert.equal(timers.size, 1); await flush(); assert.equal(calls, 1);
  dialog = true; events["booking:rescheduled"](); await flush(); assert.equal(calls, 1);
  dialog = false; await flush(); assert.equal(calls, 2);
  document.hidden = true; polling(); assert.equal(timers.size, 0);
  document.hidden = false; listeners.visibilitychange(); await flush(); assert.equal(calls, 3);
});

test("live updates never launch overlapping requests and retain events received during a refresh", async () => {
  const timers = new Map(), events = {};
  let nextId = 0, calls = 0, release;
  const window = { socket: { on(name, fn) { events[name] = fn; }, off() {} }, addEventListener() {}, setInterval() {},
    setTimeout(fn) { timers.set(++nextId, fn); return nextId; }, clearTimeout(id) { timers.delete(id); },
    _refreshTechnicianWork() { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); },
  };
  const document = { readyState: "complete", hidden: false, querySelector: () => null, addEventListener() {} };
  vm.runInNewContext(read("public/js/technician-work-updates.js"), { window, document, console });
  const take = () => { const fn = [...timers.values()].at(-1); timers.clear(); return fn; };
  events["booking:updated"](); const running = take()();
  events["order:status-change"](); await take()(); assert.equal(calls, 1);
  release(); await running; assert.equal(timers.size, 1);
  await take()(); assert.equal(calls, 2);
});
