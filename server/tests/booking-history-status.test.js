"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { BookingStatus } = require("../models/BookingStatus");
const BookingService = require("../models/BookingService");
const {
  attachMissingCustomerProjectStatuses,
  hasRecordedBookingStatus,
  presentCustomerBooking,
} = require("../utils/customerBookingPresentation");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const client = read("public/js/book-history.js");
const badgeSource = client.slice(client.indexOf("  function statusBadge("), client.indexOf("  function isRepairBooking("));
const badge = vm.runInNewContext(`${badgeSource}\nstatusBadge;`, {
  escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
});

test("the booking model accepts every lifecycle constant, including project scheduling", async () => {
  for (const status of Object.values(BookingStatus)) {
    const booking = new BookingService({ status, downpaymentAmount: 100 });
    await assert.doesNotReject(booking.validate(["status"]), status);
  }
});

test("large booking conversion sets a real status instead of undefined", async () => {
  const source = read("routes/bookingRoutesNew.js");
  const start = source.indexOf("async function applyProjectScheduling(");
  const end = source.indexOf("const multer = require('multer');", start);
  let created;
  const context = {
    require: name => {
      if (name === "../models/BookingStatus") return { BookingStatus };
      if (name === "../models/User") return { findById: async () => null };
      if (name === "../models/Project") return {
        findOne: async () => null,
        create: async value => { created = value; },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    schedulingEngine: { LARGE_SCALE_MIN_UNITS: 10 },
    console: { warn: (...args) => assert.fail(args.join(" ")) },
  };
  const convert = vm.runInNewContext(`${source.slice(start, end)}\napplyProjectScheduling;`, context);
  const booking = {
    _id: "booking-a", customerId: "customer-a", status: "pending", serviceType: "core",
    quantity: 12, startTime: "08:00", endTime: "17:00", selectedTimeLabel: "Morning",
  };
  const result = await convert(booking, {}, { totalUnits: 12, estimatedTotalHours: 12 });
  assert.equal(result.status, BookingStatus.PENDING_PROJECT_SCHEDULING);
  assert.equal(booking.status, BookingStatus.PENDING_PROJECT_SCHEDULING);
  assert.equal(booking.isProject, true);
  assert.equal(booking.startTime, undefined);
  assert.equal(created.status, BookingStatus.PENDING_PROJECT_SCHEDULING);
  assert.equal(created.bookingId, booking._id);
  await assert.doesNotReject(new BookingService({ status: result.status, downpaymentAmount: 100 }).validate(["status"]));
});

test("valid booking history skips additional project database reads", async () => {
  const bookings = [{ _id: "a", status: "completed" }, { _id: "b", status: "pending_project_scheduling" }];
  const result = await attachMissingCustomerProjectStatuses(bookings, {
    find: () => assert.fail("No project read should be needed"),
  });
  assert.equal(result, bookings);
});

test("legacy status recovery batches only missing-status bookings and never changes workflow state", async () => {
  const bookings = [
    { _id: "a", isProject: true },
    { _id: "b", status: null },
    { _id: "c", status: "cancelled", isProject: true },
    { _id: "d", status: " unknown " },
    { _id: "e", status: "" },
  ];
  const before = JSON.stringify(bookings);
  let reads = 0;
  const projects = {
    find(filter) {
      reads++;
      assert.deepEqual(filter, { bookingId: { $in: ["a", "b", "d", "e"] } });
      return {
        select(fields) { assert.equal(fields, "bookingId status"); return this; },
        maxTimeMS(timeout) { assert.equal(timeout, 3000); return this; },
        lean: async () => [
          { bookingId: "a", status: "pending_project_scheduling", adminNotes: "private" },
          { bookingId: "b", status: "in_progress" },
          { bookingId: "c", status: "planning" },
          { bookingId: "d", status: "completed" },
        ],
      };
    },
  };
  const result = await attachMissingCustomerProjectStatuses(bookings, projects);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(bookings), before);
  assert.equal(result[0].status, undefined);
  assert.equal(result[0].customerProjectStatus, "pending_project_scheduling");
  assert.equal(result[1].customerProjectStatus, "in_progress");
  assert.equal(result[2].customerProjectStatus, undefined);
  assert.equal(result[2].status, "cancelled");
  assert.equal(result[3].customerProjectStatus, "completed");
  assert.equal(result[4].customerProjectStatus, undefined);
  assert.equal(result[0].adminNotes, undefined);
  assert.equal(presentCustomerBooking(result[0]).customerProjectStatus, "pending_project_scheduling");
});

test("empty or placeholder statuses are missing but valid unfamiliar statuses are preserved", () => {
  for (const value of [undefined, null, "", "  ", "Unknown", "undefined", "NULL"]) {
    assert.equal(hasRecordedBookingStatus(value), false);
    assert.match(badge(value), />Status not recorded<\/span>/);
    assert.match(badge(value, "in_progress"), />Project: in progress<\/span>/);
  }
  assert.equal(hasRecordedBookingStatus("awaiting_parts_delivery"), true);
  assert.match(badge("awaiting_parts_delivery"), />awaiting parts delivery<\/span>/);
  assert.match(badge("completed", "planning"), />completed<\/span>/);
  assert.match(badge(undefined, "unknown"), />Status not recorded<\/span>/);
});

test("all current core and repair statuses render labels and appropriate badge colors", () => {
  for (const status of Object.values(BookingStatus)) {
    assert.doesNotMatch(badge(status), /unknown|undefined|Status not recorded/i);
  }
  assert.match(badge("pending_project_scheduling"), /bg-warning[^>]*>Awaiting project scheduling/);
  assert.match(badge("pending_reassignment"), /bg-warning[^>]*>Awaiting new technician/);
  assert.match(badge("rejected"), /bg-danger/);
  assert.match(badge("  CONFIRMED  "), /bg-success[^>]*>confirmed/);
  assert.match(badge("on-the-way"), />on the way<\/span>/);
  assert.match(badge("paid"), /bg-success/);
});

test("status labels remain HTML-escaped for unfamiliar booking and project values", () => {
  for (const html of [badge('<img src=x onerror="alert(1)">'), badge(undefined, "<script>alert(1)</script>")]) {
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;/);
  }
});

test("list and modal use display-only status recovery without bypassing customer ownership", () => {
  const routes = read("routes/appointmentRoutes.js");
  assert.match(routes, /query\.customerId = req\.user\._id/);
  assert.match(routes, /req\.user\.role === "customer"\) \{\s*try \{\s*customerItems = await attachMissingCustomerProjectStatuses/);
  assert.match(routes, /Customer booking project-status lookup unavailable/);
  assert.match(routes, /if \(hasRecordedBookingStatus\(appt\.status\)\)/);
  assert.match(routes, /appt\.customerProjectStatus = project\.status/);
  assert.match(client, /statusBadge\(displayStatus, b\.customerProjectStatus\)/);
  assert.match(client, /statusBadge\(b\.status, b\.customerProjectStatus\)/);
  assert.match(read("views/pages/book-history.ejs"), /book-history\.js\?v=20260929-service-picker-v9-history-status-v1/);
});

for (const lookupFails of [false, true]) {
  test(`customer history endpoint remains ownership-scoped with ${lookupFails ? "failed" : "successful"} status recovery`, async () => {
    const source = read("routes/appointmentRoutes.js");
    const start = source.indexOf('router.get("/", auth.authenticate, async');
    const end = source.indexOf("\n});", start) + "\n});".length;
    let handler;
    let statusReads = 0;
    const context = {
      router: { get(_url, _auth, callback) { handler = callback; } },
      auth: { authenticate() {} },
      mongoose: { Types: { ObjectId: { isValid: () => false } } },
      console: { warn() {}, error: (...args) => assert.fail(args.join(" ")) },
      CUSTOMER_HISTORY_EXCLUDED_FIELDS: "-paymentProof -statusHistory",
      buildCalendarBookingDateRange: () => null,
      enrichCustomerBooking: value => value,
      presentCustomerBooking,
      presentTechnicianBooking: value => value,
      attachMissingCustomerProjectStatuses: bookings => attachMissingCustomerProjectStatuses(bookings, {
        find(filter) {
          statusReads++;
          assert.deepEqual(filter, { bookingId: { $in: ["own-booking"] } });
          return {
            select() { return this; }, maxTimeMS() { return this; },
            async lean() {
              if (lookupFails) throw new Error("Optional lookup timed out");
              return [{ bookingId: "own-booking", status: "planning" }];
            },
          };
        },
      }),
      BookingService: {
        find(filter) {
          assert.equal(filter.customerId, "customer-a");
          return {
            sort() { return this; }, skip() { return this; }, limit() { return this; },
            select(fields) { assert.equal(fields, context.CUSTOMER_HISTORY_EXCLUDED_FIELDS); return this; },
            async lean() { return [{ _id: "own-booking", customerId: "customer-a", isProject: true, paymentProof: "private" }]; },
          };
        },
        async countDocuments(filter) { assert.equal(filter.customerId, "customer-a"); return 1; },
      },
    };
    vm.runInNewContext(source.slice(start, end), context);
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handler({ query: { page: "0", limit: "8" }, user: { role: "customer", _id: "customer-a" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(statusReads, 1);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].customerProjectStatus, lookupFails ? undefined : "planning");
    assert.equal(res.body.items[0].status, undefined);
    assert.equal(res.body.items[0].paymentProof, undefined);
    assert.equal(res.body.pagination.total, 1);
  });
}
