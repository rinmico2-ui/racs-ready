"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const DailyAssignment = require("../models/DailyAssignment");
const DailyKit = require("../models/DailyKit");
const WorkOrder = require("../models/WorkOrder");
const Technician = require("../models/Technician");
const kits = require("../utils/dailyKitService");
const { projectDailyPreparation } = require("../utils/projectDailyPreparation");
const P = "6acd3b47678aa45bd94a7354", T = "670000000000000000000001", T2 = "670000000000000000000002", W = "670000000000000000000003", D = "670000000000000000000004";
const now = new Date("2026-10-14T18:30:00Z"); // 02:30 October 15 in Manila, October 14 on a UTC host.
const query = value => ({ select() { return this; }, lean: async () => value });
function fixture(t, { status = "confirmed", delta = false, missingCoverage = false, second = false, rowsMissing = false, returned = false } = {}) {
  const rows = rowsMissing ? [] : [{ _id: D, technicianId: T, workOrderId: W }, ...(second ? [{ _id: "day-two", technicianId: T2, workOrderId: W }] : [])];
  const kit = { technicianId: T, status, hasDelta: delta, dailyAssignmentIds: missingCoverage ? [] : [D],
    items: returned ? [{ category: "equipment", name: "Ladder", returnPendingQuantity: 1 }] : [], deltaItems: delta ? [{ name: "Cleaner", resolution: { status: "approved" } }] : [] };
  const syncs = [];
  t.mock.method(DailyAssignment, "find", filter => {
    assert.equal(filter.date.$gte.toISOString(), "2026-10-14T16:00:00.000Z");
    assert.equal(filter.date.$lt.toISOString(), "2026-10-15T16:00:00.000Z");
    assert.deepEqual(filter.planningOnly, { $ne: true }); return query(rows);
  });
  t.mock.method(WorkOrder, "find", () => query([{ _id: W }]));
  t.mock.method(Technician, "find", () => query([{ _id: T, name: "Lead" }, { _id: T2, name: "Crew member" }]));
  t.mock.method(DailyKit, "find", () => query([kit, ...(second ? [{ technicianId: T2, status: "draft", dailyAssignmentIds: ["day-two"] }] : [])]));
  t.mock.method(kits, "syncDailyKit", async (id, date) => { syncs.push({ id, date }); return id === T ? kit : { technicianId: T2, status: "draft", dailyAssignmentIds: ["day-two"] }; });
  return { kit, syncs };
}
test("early-morning Manila mobilization synchronizes the current Philippine work date on a UTC server", async t => {
  const f = fixture(t);
  const result = await projectDailyPreparation(P, { date: now, synchronize: true, viewerTechnicianId: T });
  assert.equal(result.ready, true); assert.equal(result.date, "2026-10-15");
  assert.deepEqual(f.syncs, [{ id: T, date: "2026-10-15" }]); assert.equal(result.crew[0].isViewer, true);
});
test("preparation preview reads already-generated kits without checkout or synchronization writes", async t => {
  const f = fixture(t);
  const result = await projectDailyPreparation(P, { date: now, viewerTechnicianId: T });
  assert.equal(result.ready, true); assert.equal(f.syncs.length, 0);
});
for (const [kind, options, expected] of [
  ["draft", { status: "draft" }, "DAILY_KIT_REQUIRED"],
  ["delta with field decisions", { delta: true }, "DAILY_KIT_DELTA_REQUIRED"],
  ["awaiting equipment receipt", { returned: true }, "DAILY_KIT_RETURN_PENDING"],
  ["missing project job", { missingCoverage: true }, "DAILY_KIT_JOB_NOT_INCLUDED"],
]) {
  test(`project departure shares standard preparation gates for ${kind}`, async t => {
    fixture(t, options);
    const result = await projectDailyPreparation(P, { date: now, synchronize: true });
    assert.equal(result.ready, false); assert.equal(result.crew[0].code, expected);
  });
}
test("every scheduled crew member must prepare their own kit", async t => {
  fixture(t, { second: true });
  const result = await projectDailyPreparation(P, { date: now, synchronize: true, viewerTechnicianId: T });
  assert.equal(result.ready, false); assert.equal(result.crew[0].ready, true); assert.equal(result.crew[1].ready, false);
  assert.match(result.error, /Crew member/); assert.equal(result.crew[1].isViewer, false);
});
test("absence of committed work gives a schedule blocker instead of silently bypassing kits", async t => {
  fixture(t, { rowsMissing: true });
  const result = await projectDailyPreparation(P, { date: now });
  assert.equal(result.ready, false); assert.equal(result.code, "PROJECT_WORK_NOT_SCHEDULED");
});
test("cancelled work-order allocations do not block the live project crew", async t => {
  fixture(t);
  t.mock.method(WorkOrder, "find", () => query([]));
  const result = await projectDailyPreparation(P, { date: now });
  assert.equal(result.scheduled, false); assert.equal(result.crew.length, 0);
});
function routeFixture(t, { preparationReady = true, noWork = false, phase = "execution", stage = "en-route", purchaseBlocker = null } = {}) {
  const source = fs.readFileSync(require.resolve("../routes/projectRoutes"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(`router.put("/projects/:id/mobilize/${stage}"`); const end = source.indexOf("\n});", start) + 4;
  let handler, moved = 0;
  const context = {
    router: { put(_path, _auth, _role, callback) { handler = callback; } }, auth: { authenticate() {}, requireRole() {} },
    requireProjectLead: async () => ({ tech: { _id: T }, project: { _id: P, status: "in_progress", assignedTechnicians: [], leadAcceptedAt: now, projectPhase: phase, isLargeScale: false } }),
    assertProjectPurchaseReady: async () => { if (purchaseBlocker) throw Object.assign(Error("Office preparation required"), { status: 409, code: purchaseBlocker }); }, teamAllAccepted: () => true,
    scheduledWorkOrdersForDay: async () => noWork ? [] : [{ status: "accepted", async save() { moved++; } }],
    assertProjectDailyKitsReady: async () => { if (!preparationReady) throw Object.assign(Error("Confirm Crew member's kit"), { status: 409, code: "DAILY_KIT_REQUIRED", preparation: { ready: false, crew: [{ technicianId: T, ready: false }] } }); },
    recordProjectOrderStage: async () => {}, emitPurchaseProjectUpdate() {}, emitProjectPhase() {}, console: { error() {} }, Date,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  return { res, moved: () => moved, run: () => handler({ app: { get() {} } }, res) };
}
test("the real project mobilize route returns structured kit blockers without moving work orders", async t => {
  const f = routeFixture(t, { preparationReady: false }); await f.run();
  assert.equal(f.res.statusCode, 409); assert.equal(f.res.body.code, "DAILY_KIT_REQUIRED");
  assert.equal(f.res.body.preparation.ready, false); assert.equal(f.moved(), 0);
});
test("the real project mobilize route releases prepared crew work", async t => {
  const f = routeFixture(t); await f.run(); assert.equal(f.res.statusCode, 200); assert.equal(f.res.body.phase, "en_route"); assert.equal(f.moved(), 1);
});
test("new requirements after arrival block Start Work without moving any work order", async t => {
  const f = routeFixture(t, { stage: "start", preparationReady: false }); await f.run();
  assert.equal(f.res.statusCode, 409); assert.equal(f.res.body.preparation.ready, false); assert.equal(f.moved(), 0);
});
test("prepared crew can start after arrival", async t => {
  const f = routeFixture(t, { stage: "start" }); await f.run();
  assert.equal(f.res.statusCode, 200); assert.equal(f.res.body.phase, "in_progress"); assert.equal(f.moved(), 1);
});
test("Start Work still requires arrival before any kit or work-order change", async t => {
  const f = routeFixture(t, { stage: "start", noWork: true }); await f.run();
  assert.equal(f.res.statusCode, 400); assert.match(f.res.body.error, /arrive/); assert.equal(f.moved(), 0);
});
for (const code of ["ORDER_PAYMENT_NOT_VERIFIED", "ORDER_PREPARATION_REQUIRED"]) {
  test(`confirmed kits cannot bypass ${code}`, async t => {
    const f = routeFixture(t, { purchaseBlocker: code }); await f.run();
    assert.equal(f.res.statusCode, 409); assert.equal(f.res.body.code, code); assert.equal(f.moved(), 0);
  });
}
test("project work selection uses the same Manila day boundaries as kit generation", async () => {
  const source = fs.readFileSync(require.resolve("../routes/projectRoutes"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("async function scheduledWorkOrdersForDay("); const end = source.indexOf("\nasync function assertProjectDailyKitsReady", start);
  let filter;
  const context = { projectDayBounds: kits.dayBounds, DailyAssignment: { find(query) { filter = query; return { select() { return this; }, lean: async () => [{ workOrderId: W }] }; } },
    WorkOrder: { find: async query => query }, Date };
  const select = vm.runInNewContext(source.slice(start, end) + "\nscheduledWorkOrdersForDay;", context);
  await select(P, ["accepted"], now);
  assert.equal(filter.date.$gte.toISOString(), "2026-10-14T16:00:00.000Z");
  assert.equal(filter.date.$lt.toISOString(), "2026-10-15T16:00:00.000Z");
});
test("both GPS paths update only the authenticated technician using GeoJSON longitude/latitude order", async t => {
  const location = require("../controllers/technicianLocationController");
  const updates = [];
  t.mock.method(Technician, "findOneAndUpdate", async (filter, update) => { updates.push({ filter, update }); return { _id: T, location: update.location }; });
  t.mock.method(require("../models/BookingService"), "find", async () => []);
  const req = { user: { _id: "owner", role: "technician" }, body: { lat: 15.4, lng: 120.9 } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await location.updateLocation(req, res);
  assert.deepEqual(updates[0].filter, { user: "owner" }); assert.deepEqual(updates[0].update.location.coordinates, [120.9, 15.4]);
  for (const router of [require("../routes/authRoutes"), require("../routes/technicianApi")]) {
    assert.ok(router.stack.some(layer => layer.route?.path?.endsWith("/location") && layer.route.methods.post && layer.route.stack.at(-1).handle === location.updateLocation));
  }
});
test("GPS rejects invalid coordinates and non-technicians without a database write", async t => {
  const spy = t.mock.method(Technician, "findOneAndUpdate", async () => { throw Error("must not write"); });
  const location = require("../controllers/technicianLocationController");
  for (const body of [{ lat: "15", lng: 120 }, { lat: 91, lng: 120 }, { lat: 15, lng: Infinity }]) {
    const res = { status(code) { this.code = code; return this; }, json() {} };
    await location.updateLocation({ user: { role: "technician" }, body }, res); assert.equal(res.code, 400);
  }
  const res = { status(code) { this.code = code; return this; }, json() {} };
  await location.updateLocation({ user: { role: "customer" }, body: { lat: 15, lng: 120 } }, res);
  assert.equal(res.code, 403); assert.equal(spy.mock.callCount(), 0);
});
test("the preparation endpoint rejects unassigned technicians before reading crew kits", async () => {
  const source = fs.readFileSync(require.resolve("../routes/projectRoutes"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('router.get("/projects/:id/daily-preparation"'); const end = source.indexOf("\n});", start) + 4;
  let handler, reads = 0;
  vm.runInNewContext(source.slice(start, end), { router: { get(_path, _auth, _role, fn) { handler = fn; } }, auth: { authenticate() {}, requireRole() {} },
    mongoose: { Types: { ObjectId: { isValid: () => true } } }, requireTechnicianProjectMember: async () => { throw Object.assign(Error("Not assigned"), { status: 403 }); },
    projectDailyPreparation: async () => { reads++; } });
  const res = { status(code) { this.code = code; return this; }, json() {} };
  await handler({ params: { id: P }, user: {}, query: {} }, res);
  assert.equal(res.code, 403); assert.equal(reads, 0);
});
