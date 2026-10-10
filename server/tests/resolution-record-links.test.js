"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const mongoose = require("mongoose");
const { bookingScheduleNeedsResolution, parseResolutionFocus } = require("../utils/resolutionCenter");
const NOW = new Date("2030-01-03T12:00:00+08:00");
const BOOKING_ID = "507f191e810c19729de860ea";
const ORDER_ID = "507f191e810c19729de860eb";
const routeFile = path.join(__dirname, "../routes/adminApi.js");
const routeSource = fs.readFileSync(routeFile, "utf8").replace(/\r\n/g, "\n");
const actualRequire = createRequire(routeFile);

function query(value) {
  return { sort() { return this; }, allowDiskUse() { return this; }, select() { return this; },
    limit() { return this; }, populate() { return this; }, async lean() { return value; } };
}
async function load({ booking = null, order = null, normalBookings = [], normalOrders = [], filters = {}, focus = `booking:${BOOKING_ID}`, canViewOrders = true, linked = false } = {}) {
  const reads = [];
  const mocks = {
    "../models/ServiceReport": { find: () => query([]) },
    "../models/BookingService": {
      find: filter => { reads.push(["bookings", filter]); return query(normalBookings); },
      findById: id => { reads.push(["booking", id]); return query(booking); },
    },
    "../models/Order": {
      find: filter => { reads.push(["orders", filter]); return query(filter._id || filter.bookingId ? (order ? [order] : []) : normalOrders); },
      distinct: async () => linked ? [BOOKING_ID] : [],
    },
    "../utils/enterpriseSchedulingEngine": { getProjectThresholdHours: async () => 8 },
  };
  const begin = routeSource.indexOf('router.get("/resolution-center",');
  const start = routeSource.indexOf("async (req, res, next) => {", begin);
  const end = routeSource.indexOf("\n});", start);
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } }
  const handler = vm.runInNewContext("(" + routeSource.slice(start, end + 2) + ")", {
    mongoose, Date: FixedDate, console, hasPermission: async () => canViewOrders,
    require: name => mocks[name] || actualRequire(name),
  });
  const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ query: { ...filters, ...(focus ? { focus } : {}) }, user: { role: canViewOrders ? "admin" : "secretary" } }, res, error => { throw error; });
  return { ...res, reads };
}
const booking = overrides => ({ _id: BOOKING_ID, bookingReference: "BOOK-TARGET", status: "awaiting_assignment", bookingDate: "2030-01-01", startTime: "09:00", serviceDurationMinutes: 60, resolutionCases: [], ...overrides });
const order = overrides => ({ _id: ORDER_ID, orderReference: "ORD-TARGET", status: "preparing_unit", fulfillmentType: "delivery_only", delivery: { preferredDate: "2030-01-01" }, timeSlot: "09:00", items: [], ...overrides });

test('a cancelled booking ignores an old reschedule request and only offers cancellation review',async()=>{
  const result=await load({booking:booking({status:'cancelled',cancellationReason:'Customer cancelled',proposedReschedule:{status:'pending'},rescheduleRequest:{status:'pending'}})});
  assert.equal(result.body.cases.length,1);
  const row=result.body.cases[0];
  assert.equal(row.issueType,'cancelled');assert.equal(row.status,'cancelled');assert.equal(row.severity,'high');
  assert.deepEqual(row.issues.map(issue=>issue.issueType),['cancelled']);
  assert.equal(row.requiresReschedule,false);assert.equal(row.canReassign,false);assert.equal(row.isPastDate,false);
  assert.equal(row.daysPast,0);assert.equal(row.proposedReschedule,null);
  assert.deepEqual(Array.from(row.allowedActions),['view','close']);
});

test('a default empty pending proposal cannot create a schedule-change case or hide a missing technician',async()=>{
  const defaultBooking=new (require('../models/BookingService'))();
  const defaultProposal=defaultBooking.proposedReschedule.toObject();
  assert.equal(defaultProposal.status,'pending');assert.equal(defaultProposal.date,undefined);
  const result=await load({booking:booking({proposedReschedule:defaultProposal,rescheduleRequest:defaultBooking.rescheduleRequest.toObject()})});
  const row=result.body.cases[0];
  assert.ok(row.issues.some(issue=>issue.issueType==='no_technician'));
  assert.ok(!row.issues.some(issue=>issue.issueType==='customer_reschedule'));assert.equal(row.proposedReschedule,null);
});

test('a real pending proposal still creates a schedule-change review, and finished bookings ignore stale requests',async()=>{
  const proposal={status:'pending',date:'2030-01-05',time:'13:00'};
  const result=await load({booking:booking({proposedReschedule:proposal})});
  assert.ok(result.body.cases[0].issues.some(issue=>issue.issueType==='customer_reschedule'));
  assert.equal(result.body.cases[0].proposedReschedule,proposal);
  const customerRequest=await load({booking:booking({rescheduleRequest:{status:'pending',requested:true,requestedDate:'2030-01-05'}})});
  assert.ok(customerRequest.body.cases[0].issues.some(issue=>issue.issueType==='customer_reschedule'));
  for(const status of ['completed','closed','repair_completed']) {
    const finished=await load({booking:booking({status,proposedReschedule:proposal,rescheduleRequest:{status:'pending'}})});
    assert.equal(finished.body.cases.length,0);assert.equal(finished.body.focus.state,'no_active_case');
  }
});

test('pending booking and order payments expose review on later pages without adding duplicate cases', async () => {
  const bookings=Array.from({length:27},(_,i)=>booking({_id:new mongoose.Types.ObjectId().toString(),status:'pending',paymentStatus:i===26?'partial':'pending'}));
  const result=await load({normalBookings:bookings,normalOrders:[order({status:'pending_payment',paymentStatus:'pending'})],focus:null,filters:{page:'2',perPage:'25'}});
  assert.equal(result.code,200);assert.equal(result.body.pagination.page,2);
  assert.equal(result.body.pagination.total,28);
  const pendingBooking=result.body.cases.find(row=>row.sourceType!=='order'&&row.paymentStatus==='pending');
  assert.ok(pendingBooking.allowedActions.includes('verify_payment'));
  const paidBooking=result.body.cases.find(row=>row.paymentStatus==='partial');
  assert.ok(!paidBooking.allowedActions.includes('verify_payment'));
  const focusedOrder=await load({order:order({status:'pending_payment',paymentStatus:'pending'}),focus:`order:${ORDER_ID}`});
  assert.ok(focusedOrder.body.cases[0].allowedActions.includes('verify_payment'));
});

test("Resolve finds a booking outside the overview limit and ignores stale issue/search/page filters", async () => {
  const normalBookings = Array.from({ length: 500 }, (_, i) => ({ _id: String(i), status: "completed" }));
  const result = await load({ booking: booking(), normalBookings, filters: { issue: "customer_reschedule", q: "old-reference", page: "90", severity: "medium" } });
  assert.equal(result.code, 200);
  assert.equal(result.body.focus.state, "open");
  assert.ok(result.body.cases.length > 0);
  assert.ok(result.body.cases.every(item => item.id === BOOKING_ID));
  assert.equal(result.body.pagination.page, 1);
  assert.ok(result.reads.some(([kind, id]) => kind === "booking" && id === BOOKING_ID));
});

test("Resolve loads the exact older aircon order even when its issue type changed", async () => {
  const result = await load({ order: order({ status: "pending_payment" }), focus: `order:${ORDER_ID}`, filters: { issue: "dispatch_overdue" } });
  assert.equal(result.body.cases[0].issueType, "payment_review_overdue");
  assert.equal(result.body.focus.id, ORDER_ID);
  assert.ok(result.reads.some(([kind, filter]) => kind === "orders" && filter._id === ORDER_ID));
});

test("Resolve follows a service visit to its owning aircon order without duplicating its case", async () => {
  const result = await load({ booking: booking(), order: order({ bookingId: { _id: BOOKING_ID } }), linked: true });
  assert.equal(result.body.cases.length, 1);
  assert.equal(result.body.cases[0].sourceType, "order");
  assert.equal(result.body.focus.source, "order");
  assert.equal(result.body.focus.id, ORDER_ID);
});

test("legacy bookings without a public reference can be opened by their ID", async () => {
  const result = await load({ booking: booking({ bookingReference: "" }) });
  assert.equal(result.body.focus.state, "open");
  assert.ok(result.body.cases.every(item => item.id === BOOKING_ID));
});

test("a link with an old Past Date filter still finds a different open issue on the booking", async () => {
  const record = booking({ resolutionCases: [{ issueType: "past_date", sourceStatus: "awaiting_assignment", state: "closed" }] });
  const result = await load({ booking: record, filters: { issue: "past_date" } });
  assert.equal(result.body.cases.length, 1);
  assert.equal(result.body.cases[0].issueType, "no_technician");
  assert.equal(result.body.focus.state, "open");
});

test("booking and order Resolve links identify the record without forcing an issue or reference filter", () => {
  const page = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Appointments/AppointmentsUnified.ejs"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "../public/js/admin-aircon-orders.js"), "utf8");
  for (const [source, name, context, record, type] of [
    [page, "bookingResolutionUrl", { APPOINTMENTS_CAN_RESOLVE: true, APPOINTMENTS_RESOLUTION_PATH: "/admin/operations/resolution-center" }, booking(), "booking"],
    [client, "resolutionUrl", { resolutionPath: "/admin/operations/resolution-center" }, order(), "order"],
  ]) {
    const fn = source.match(new RegExp("  function " + name + "\\([^]*?\\n  \\}"))[0];
    const buildUrl = vm.runInNewContext(fn + ";" + name, { ...context, URLSearchParams });
    const url = new URL(buildUrl(record).replace(/&amp;/g, "&"), "http://localhost:5000");
    assert.equal(url.searchParams.get("focus"), `${type}:${record._id}`);
    assert.equal(url.searchParams.get("open"), "resolve");
    assert.equal(url.searchParams.has("issue"), false);
    assert.equal(url.searchParams.has("q"), false);
  }
});

test("cleared and removed records return distinct explanations without inventing cases", async () => {
  const cleared = await load({ booking: booking({ status: "completed" }) });
  assert.equal(cleared.body.focus.state, "no_active_case");
  assert.equal(cleared.body.cases.length, 0);
  const missing = await load();
  assert.equal(missing.body.focus.state, "not_found");
  assert.equal(missing.body.cases.length, 0);
});

test("exact-record lookup preserves order permissions and rejects malformed links", async () => {
  const denied = await load({ focus: `order:${ORDER_ID}`, canViewOrders: false });
  assert.equal(denied.code, 403);
  assert.equal(denied.reads.length, 0);
  const invalid = await load({ focus: "booking:invalid" });
  assert.equal(invalid.code, 400);
  assert.equal(invalid.reads.length, 0);
  assert.equal(parseResolutionFocus("other:" + BOOKING_ID), null);
});

test("expired booking stages shown by the booking workspace also appear in the Center", async () => {
  for (const status of ["payment_verified", "assigned", "repair_requested", "pending_inspection", "ready_for_repair"]) {
    const record = booking({ status });
    assert.equal(bookingScheduleNeedsResolution(record, NOW), true, status);
    const result = await load({ booking: record });
    assert.ok(result.body.cases.some(item => item.issueType === "past_date"), status);
  }
  assert.equal(bookingScheduleNeedsResolution(booking({ bookingDate: "2030-01-04" }), NOW), false);
});

test("assignment recovery respects the same grace period as the booking workspace", () => {
  const record = booking({ bookingDate: "2030-01-03", startTime: "12:00" });
  assert.equal(bookingScheduleNeedsResolution(record, new Date("2030-01-03T12:29:00+08:00")), false);
  assert.equal(bookingScheduleNeedsResolution(record, new Date("2030-01-03T12:31:00+08:00")), true);
});

test("multiple issues for a booking produce one queue card and one KPI count", async () => {
  const result = await load({ booking: booking() });
  assert.equal(result.body.cases.length, 1);
  assert.equal(result.body.cases[0].issueType, "past_date");
  assert.deepEqual(Array.from(result.body.cases[0].issues, issue => issue.issueType), ["past_date", "no_technician"]);
  assert.equal(result.body.summary.total, 1);
  assert.equal(result.body.summary.bySource.booking, 1);
  assert.equal(result.body.summary.bySeverity.critical, 1);
  assert.equal(result.body.summary.byIssue.past_date, 1);
  assert.equal(result.body.summary.byIssue.no_technician, 1);
});

test("pagination and secondary-issue filters count unique bookings before slicing pages", async () => {
  const normalBookings = Array.from({ length: 14 }, (_, i) => booking({ _id: i.toString(16).padStart(24, "0"), bookingReference: `BOOK-${i}` }));
  const result = await load({ focus: null, normalBookings, filters: { page: "2", perPage: "10", issue: "no_technician" } });
  assert.equal(result.body.pagination.total, 14);
  assert.equal(result.body.pagination.pages, 2);
  assert.equal(result.body.cases.length, 4);
  assert.equal(new Set(result.body.cases.map(item => item.id)).size, 4);
  assert.ok(result.body.cases.every(item => item.issueType === "no_technician" && item.issues.length === 2));
  assert.equal(result.body.summary.total, 14);
});
