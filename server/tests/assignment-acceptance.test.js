"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const BookingModel = require("../models/BookingService");
const AssignmentModel = require("../models/Assignment");
const { acceptAssignment } = require("../utils/assignmentAcceptance");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const id = "507f191e810c19729de860ea", techId = "507f191e810c19729de860eb";
const userId = "507f191e810c19729de860ec", bookingId = "507f191e810c19729de860ed";
const otherId = "507f191e810c19729de860ef";
const query = value => ({ session: async () => value });
const copy = value => structuredClone(value);
function write(record, update) {
  for (const [key, value] of Object.entries(update.$set || {})) {
    const parts = key.split('.'); let target = record;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  for (const [key, value] of Object.entries(update.$push || {})) (record[key] ??= []).push(value);
}
function fixture(options = {}) {
  let assignment = { _id: id, technicianId: techId, bookingId, status: options.accepted ? "accepted" : "pending_acceptance",
    bookingDate: new Date("2099-01-08"), serviceType: options.kind || "core", notes: [],
    preparationStatus: options.accepted ? "checked_out" : "pending", equipmentCheckedOut: Boolean(options.accepted),
    serviceItemId: options.itemAssignment ? otherId : null,
    acceptedAt: options.accepted ? new Date("2099-01-01") : null };
  let booking = { _id: bookingId, technicianId: options.reassigned ? otherId : techId, assignmentId: id,
    status: options.bookingStatus || "assigned", serviceType: options.kind === "project" ? "core" : options.kind || "core", isProject: options.kind === "project",
    notes: "Keep the customer's instructions.", paymentStatus: "pending", amountPaid: 0,
    maintenance: { paymentOnSite: true, isMaintenance: true },
    services: options.items || [{ _id: otherId, type: options.kind === "repair" ? "repair" : "core", status: "assigned", technicianId: techId, assignmentId: id }] };
  const events = [], updates = []; let tail = Promise.resolve();
  const session = { async withTransaction(work) {
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    const snapshot = { assignment: copy(assignment), booking: copy(booking) };
    events.push("start");
    try { await work(); if (options.failCommit) throw Error("Commit failed"); events.push("commit"); }
    catch (error) { assignment = snapshot.assignment; booking = snapshot.booking; events.push("abort"); throw error; }
    finally { release(); }
  }, async endSession() { events.push("end"); } };
  const models = {
    database: { async startSession() { if (options.failSession) throw options.failSession; return session; } },
    Assignments: {
      findOne(filter) { assert.equal(filter.technicianId, techId); return query(options.foreign ? null : copy(assignment)); },
      async findOneAndUpdate(filter, update, opts) {
        assert.equal(opts.session, session); assert.equal(opts.runValidators, true); updates.push({ type: "assignment", filter, update });
        if (options.assignmentRace) return null;
        if (options.failAssignment) throw Error("Assignment write failed");
        if (filter.status !== assignment.status) return null;
        write(assignment, update);
        await AssignmentModel.hydrate(assignment).validate(['status', 'preparationStatus', 'notes']);
        return copy(assignment);
      },
    },
    Bookings: {
      findById() { return query(options.noBooking ? null : copy(booking)); },
      async findOneAndUpdate(filter, update, opts) {
        assert.equal(opts.session, session); assert.equal(opts.runValidators, true); updates.push({ type: "booking", filter, update });
        if (options.bookingRace) return null;
        if (options.failBooking) throw Error("Booking write failed");
        write(booking, update);
        const document = BookingModel.hydrate(booking);
        await document.validate(Object.keys(update.$set));
        return copy(booking);
      },
    },
    Projects: { findOne(filter) { assert.equal(filter.bookingId, bookingId); return query(options.kind === "project" && !options.noMembership ? { _id: otherId } : null); } },
  };
  return { events, updates, get assignment() { return assignment; }, get booking() { return booking; },
    invoke: () => acceptAssignment({ assignmentId: id, technician: { _id: techId, name: "Assigned Technician" },
      user: { _id: userId }, isScheduleMissed: () => Boolean(options.missed), ...models }),
  };
}

test("acceptance commits the booking and assignment together while retaining customer and payment details", async () => {
  const f = fixture(), result = await f.invoke();
  assert.equal(result.assignment.status, "accepted"); assert.equal(f.booking.status, "confirmed");
  assert.equal(f.booking.services[0].status, "accepted"); assert.equal(f.assignment.notes.length, 1);
  assert.match(f.booking.notes, /^Keep the customer's instructions\./);
  assert.equal(f.booking.amountPaid, 0); assert.equal(f.booking.paymentStatus, "pending");
  assert.equal(f.booking.maintenance.paymentOnSite, true);
  assert.equal(f.assignment.resourcesReserved, false); assert.equal(f.assignment.preparationStatus, "pending");
  assert.deepEqual(f.events, ["start", "commit", "end"]);
});

test("a booking failure, assignment failure, or failed commit leaves neither record partially accepted", async t => {
  for (const fault of ['failBooking', 'failAssignment', 'failCommit']) await t.test(fault, async () => {
    const f = fixture({ [fault]: true });
    await assert.rejects(f.invoke(), /failed/i);
    assert.equal(f.assignment.status, "pending_acceptance"); assert.equal(f.assignment.notes.length, 0);
    assert.equal(f.booking.status, "assigned"); assert.equal(f.booking.notes, "Keep the customer's instructions.");
    assert.ok(f.events.includes("abort")); assert.equal(f.events.at(-1), "end");
  });
});

test("retries repair a previously partial acceptance without resetting checked-out equipment or duplicating notes", async () => {
  const f = fixture({ accepted: true });
  const first = await f.invoke();
  assert.equal(first.alreadyAccepted, true); assert.equal(f.booking.status, "confirmed");
  assert.equal(f.assignment.preparationStatus, "checked_out"); assert.equal(f.assignment.equipmentCheckedOut, true);
  const notes = f.booking.notes, acceptedAt = f.assignment.acceptedAt;
  await f.invoke(); assert.equal(f.booking.notes, notes); assert.deepEqual(f.assignment.acceptedAt, acceptedAt);
  assert.equal(f.updates.filter(row => row.type === 'assignment').length, 0);
});

test("double clicks produce one acceptance and one activity entry", async () => {
  const f = fixture(); const results = await Promise.all([f.invoke(), f.invoke()]);
  assert.equal(results.filter(result => result.alreadyAccepted).length, 1);
  assert.equal(f.assignment.notes.length, 1);
  assert.equal(f.updates.filter(row => row.type === 'assignment').length, 1);
});

test("another technician, changed booking, cancelled visit, missed schedule and write races make no committed acceptance", async t => {
  for (const [options, code] of [[{ foreign: true }, 'ASSIGNMENT_NOT_FOUND'], [{ reassigned: true }, 'ASSIGNMENT_CHANGED'],
    [{ noBooking: true }, 'BOOKING_NOT_FOUND'], [{ bookingStatus: 'cancelled' }, 'BOOKING_UNAVAILABLE'],
    [{ bookingStatus: 'completed' }, 'BOOKING_CHANGED'], [{ missed: true }, 'SCHEDULE_MISSED'],
    [{ assignmentRace: true }, 'ASSIGNMENT_CHANGED'], [{ bookingRace: true }, 'BOOKING_CHANGED']]) {
    await t.test(code, async () => {
      const f = fixture(options); await assert.rejects(f.invoke(), error => error.code === code);
      assert.equal(f.assignment.status, 'pending_acceptance'); assert.equal(f.booking.notes, "Keep the customer's instructions.");
      assert.ok(!f.events.includes('commit'));
    });
  }
});

test("a standalone database explains the infrastructure problem and releases its session", async () => {
  const error = Error("Transaction numbers are only allowed on a replica set member or mongos");
  const f = fixture({ failSession: error });
  await assert.rejects(f.invoke(), err => err.status === 503 && err.code === 'ASSIGNMENT_DATABASE_SETUP_REQUIRED');
  assert.equal(f.assignment.status, 'pending_acceptance');
});

test("repair acceptance opens inspection, mixed acceptance keeps the shared visit, and projects require their own team", async () => {
  const repair = fixture({ kind: 'repair' }); await repair.invoke();
  assert.equal(repair.booking.status, 'inspection_scheduled');
  assert.equal(repair.booking.services[0].status, 'inspection_scheduled'); assert.equal(repair.booking.services[0].phase, 'repair_phase_1');
  const mixed = fixture({ kind: 'mixed', items: [
    { _id: otherId, type: 'core', status: 'assigned' },
    { _id: bookingId, type: 'repair', status: 'inspection_scheduled' },
    { _id: userId, type: 'repair', status: 'repair_in_progress', technicianId: techId },
  ] });
  await mixed.invoke(); assert.equal(mixed.booking.status, 'confirmed'); assert.equal(mixed.booking.services[0].status, 'accepted');
  assert.equal(mixed.booking.services[1].status, 'inspection_scheduled'); assert.equal(mixed.booking.services[2].status, 'repair_in_progress');
  const project = fixture({ kind: 'project', reassigned: true, bookingStatus: 'pending_project_scheduling' });
  await project.invoke(); assert.equal(project.booking.status, 'pending_project_scheduling');
  await assert.rejects(fixture({ kind: 'project', noMembership: true }).invoke(), error => error.code === 'ASSIGNMENT_CHANGED');
});

test("acceptance does not overwrite another technician's service item or rewind work on retry", async () => {
  const f = fixture({ items: [{ _id: otherId, type: 'core', status: 'assigned', technicianId: otherId, assignmentId: otherId }] });
  await f.invoke(); assert.equal(f.booking.services[0].status, 'assigned'); assert.equal(f.booking.services[0].technicianId, otherId);
  const active = fixture({ accepted: true, bookingStatus: 'in-progress', items: [{ _id: otherId, type: 'core', status: 'in_progress' }] });
  await active.invoke(); assert.equal(active.booking.status, 'in-progress'); assert.equal(active.updates.length, 0);
});

test("an individual service assignment can be accepted without changing another technician's visit or restarting repair inspection", async () => {
  const f = fixture({ kind: 'repair', itemAssignment: true, reassigned: true, bookingStatus: 'in-progress', items: [
    { _id: otherId, type: 'repair', status: 'assigned', phase: 'repair_phase_2', schedule: { kind: 'repair' }, technicianId: techId, assignmentId: id },
    { _id: userId, type: 'core', status: 'in_progress', technicianId: otherId, assignmentId: otherId },
  ] });
  await f.invoke(); assert.equal(f.booking.status, 'in-progress');
  assert.equal(f.booking.services[0].status, 'repair_scheduled'); assert.equal(f.booking.services[0].phase, 'repair_phase_2');
  assert.equal(f.booking.services[1].status, 'in_progress'); assert.equal(f.booking.services[1].technicianId, otherId);
  const retired = fixture({ itemAssignment: true, bookingStatus: 'completed' });
  await assert.rejects(retired.invoke(), error => error.code === 'BOOKING_CHANGED');
});

test("a session opened on an unsupported server is still closed after a transaction failure", async () => {
  const events = [], error = Error('Transaction numbers are only allowed on a replica set member or mongos');
  await assert.rejects(acceptAssignment({ assignmentId: id, technician: { _id: techId }, user: { _id: userId },
    isScheduleMissed: () => false, database: { startSession: async () => ({
      withTransaction: async () => { throw error; }, endSession: async () => events.push('end'),
    }) } }), err => err.status === 503);
  assert.deepEqual(events, ['end']);
});

function routeFixture(options = {}) {
  const events = [], notices = [], warnings = []; let handler;
  const assignment = { _id: id, bookingId, technicianId: techId, serviceType: 'core', status: 'accepted', bookingDate: new Date('2099-01-08') };
  const booking = { _id: bookingId, customerId: userId, status: 'confirmed', bookingReference: 'RACS-TEST', customer: {} };
  const context = { mongoose, global: {}, process: { env: {} }, Technician: { findOne: async () => ({ _id: techId, name: 'Assigned Technician' }) },
    router: { post(...args) { handler = args.at(-1); } }, assertNotMissedSchedule() {},
    audit: { logEvent: async () => { if (options.auditFailure) throw Error('Audit offline'); } },
    syncDailyKit: async () => { if (options.kitFailure) throw Error('Kit offline'); return { hasDelta: false }; },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    require(name) {
      if (name.endsWith('/assignmentAcceptance')) return { acceptAssignment: async () => {
        if (options.transactionFailure) throw Error('Transaction failed');
        events.push('commit'); return { assignment, booking, alreadyAccepted: options.alreadyAccepted || false };
      } };
      if (name.endsWith('/availability')) return { resolveAvailabilityStatus: async () => { if (options.availabilityFailure) throw Error('Availability offline'); } };
      if (name.endsWith('/notify')) return { createNotification: async input => {
        assert.equal(events[0], 'commit'); notices.push(input); if (options.notificationFailure) throw Error('Notification offline');
      } };
      if (name.endsWith('/mailer')) return { sendBookingAcceptedEmail: async () => assert.fail('No email on test account') };
      if (name.endsWith('/User')) return { findOne: () => ({ select() { return this; }, lean: async () => null }) };
      throw Error(name);
    },
  };
  const source = read('routes/technicianApi.js'), start = source.indexOf('router.post("/assignments/:id/accept"');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), context);
  return { events, notices, warnings, async invoke() {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await handler({ params: { id }, user: { _id: userId }, app: { get: () => ({ to(room) { return { emit(name, data) { events.push({ room, name, data }); } }; } }) } }, res);
    return res;
  } };
}

test("notification, audit, availability and toolkit failures never turn saved acceptance into a false error", async t => {
  for (const fault of ['notificationFailure', 'auditFailure', 'availabilityFailure', 'kitFailure']) await t.test(fault, async () => {
    const f = routeFixture({ [fault]: true }), res = await f.invoke();
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assert.equal(res.body.preparationPending, fault === 'kitFailure');
    assert.equal(f.events[0], 'commit'); assert.ok(f.warnings.length);
    assert.ok(f.events.some(event => event.room === 'customer:' + userId && event.name === 'booking:status-change'));
  });
});

test("a successful retry does not create another staff notification; failed transactions create no events", async () => {
  const retry = routeFixture({ alreadyAccepted: true }); assert.equal((await retry.invoke()).body.alreadyAccepted, true);
  assert.equal(retry.notices.length, 0);
  const failure = routeFixture({ transactionFailure: true }); assert.equal((await failure.invoke()).statusCode, 500);
  assert.equal(failure.notices.length, 0); assert.equal(failure.events.length, 0);
});

test("a normal acceptance uses the service label and emits updates only after saving", async () => {
  const f = routeFixture(), res = await f.invoke(); assert.equal(res.statusCode, 200);
  assert.equal(f.warnings.length, 0); assert.equal(f.notices[0].title, 'Service Assignment Accepted');
  assert.equal(f.events[0], 'commit');
});

test("KPI loading works in its own script scope and reads today's current filter without an undefined variable", async () => {
  const source = read('views/pages/technician/assignments.ejs');
  const start = source.indexOf('    async function updateKpis()'), end = source.indexOf('    window._updateWorkKpis', start);
  const values = new Map(), elements = new Map(), warnings = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '0', style: {} }); return elements.get(id); };
  let filter = 'today';
  const context = { window: { getAssignmentFilter: () => filter, _visibleTodayWorkOrderCount: 3 }, kpiLoading: false, h: null,
    document: { getElementById: element }, console: { warn: (...args) => warnings.push(args) },
    fetch: async () => ({ ok: true, json: async () => ({ total: 8, completed: 2, pending: 1, today: 7, revenue: 500, partsCost: 100,
      grossProfit: 400, completionRate: 25, active: 5 }) }),
    animateKpiValue: (el, value) => { el.textContent = value; }, animateHeroStat: (id, value) => values.set(id, value),
    setKpiText: (id, value) => { element(id).textContent = value; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.updateKpis(); assert.equal(warnings.length, 0); assert.equal(element('kpiToday').textContent, 3);
  assert.equal(values.get('heroToday'), 3);
  filter = 'all'; await context.updateKpis(); assert.equal(element('kpiToday').textContent, 7);
  assert.equal(context.kpiLoading, false);
});

test("the Accept button distinguishes a saved acceptance from an unreadable response or failed connection", async () => {
  const source = read('views/pages/technician/assignments.ejs');
  const start = source.indexOf('    window.acceptAssign = async function'), end = source.indexOf('    let _standardPreparationAssignmentId', start);
  for (const mode of ['success', 'html', 'network', 'refresh']) {
    const notices = [], context = { window: {}, currentFilter: 'pending', currentPage: 1, confirm: () => true,
      fetch: async () => {
        if (mode === 'network') throw Error('Network unavailable');
        return { ok: true, status: 200, json: async () => { if (mode === 'html') throw Error('Not JSON'); return { success: true }; } };
      }, showNotification: notice => notices.push(notice),
      loadAssignments: () => { if (mode === 'refresh') throw Error('Page failed'); }, loadPreparation() {},
    };
    vm.runInNewContext(source.slice(start, end), context);
    await context.window.acceptAssign(id);
    if (mode === 'success') assert.equal(notices[0].type, 'success');
    if (mode === 'html' || mode === 'network') assert.ok(!notices.some(notice => notice.type === 'success'));
    if (mode === 'refresh') { assert.equal(notices.at(-1).title, 'Acceptance Saved'); assert.match(notices.at(-1).message, /acceptance is saved/); }
  }
});
