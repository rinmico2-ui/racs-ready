"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeLifecycleReason } = require("../utils/dataLifecycle");
const { cancelBookingRecord } = require("../utils/bookingLifecycle");
const { isAftercareBooking } = require("../utils/maintenanceCancellation");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const client = read("public/js/book-history.js");
function functionSource(name) {
  const start = client.search(new RegExp("^  (?:async )?function " + name + "\\(", "m"));
  assert.ok(start >= 0, name);
  return client.slice(start, client.indexOf("\n  }", start) + 4);
}
const policySource = ["normalizeBookingCancellationReason", "bookingCancellationReasonError"].map(functionSource).join("\n");

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
}
function routeFixture(kind = "customer", overrides = {}) {
  let saves = 0, releases = 0, assignmentUpdates = 0, historyWrites = 0, queries = 0;
  const logs = [];
  const booking = {
    _id: "booking-test", customerId: "owner-test", status: "pending",
    services: [{ status: "scheduled", statusHistory: [] }],
    recordStatusHistory() { historyWrites++; },
    async save() { saves++; }, ...overrides,
  };
  const source = read(kind === "admin" ? "routes/appointmentManagement.js" : "routes/appointmentRoutes.js");
  const start = source.indexOf(kind === "admin" ? "router.post('/:id/cancel'" : "// Cancel appointment (admin/secretary/customer");
  const end = kind === "admin" ? source.indexOf("\n});", start) + 4 : source.indexOf("// Submit reschedule request", start);
  let handler;
  const context = {
    router: { post(...handlers) { handler = handlers.at(-1); } },
    auth: { authenticate() {} }, requireRole() {},
    BookingService: { async findById() { queries++; return booking; } },
    Payment: { exists: async () => false },
    BookingStatus: { COMPLETED: "completed", CANCELLED: "cancelled" },
    cancelBookingRecord, normalizeLifecycleReason,
    isAftercareBooking,
    async reopenScheduleAfterBookingCancellation() {},
    async releaseReservedEquipment({ reason }) { normalizeLifecycleReason(reason, "Release"); releases++; },
    require() { return { async updateMany() { assignmentUpdates++; } }; },
    googleCalendarSync: { isConfigured: () => false }, audit: { logEvent: async () => undefined },
    console: { error(...args) { logs.push(args); }, warn() {}, log() {} },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { context, booking, logs, handler, get saves() { return saves; }, get releases() { return releases; }, get assignmentUpdates() { return assignmentUpdates; }, get historyWrites() { return historyWrites; }, get queries() { return queries; } };
}
const request = (reason, role = "customer") => ({ params: { id: "booking-test" }, body: { reason }, user: { _id: "owner-test", role, email: "owner@example.test" } });

test("client cancellation boundaries match backend after whitespace normalization", () => {
  const context = vm.createContext({});
  vm.runInContext(policySource, context);
  for (const value of ["", "short", "no money", "x".repeat(9), "x".repeat(10), "x".repeat(500), "x".repeat(501), "   no   money   ", " Changed   my plans today "]) {
    let accepted = true;
    try { normalizeLifecycleReason(value, "Cancellation"); } catch (_) { accepted = false; }
    assert.equal(context.bookingCancellationReasonError(value) === undefined, accepted, JSON.stringify(value));
  }
  assert.equal(context.normalizeBookingCancellationReason(" Changed  my\nplans today "), "Changed my plans today");
});

for (const role of ["customer", "admin", "secretary"]) {
  test(`${role} cancellation returns validation error 400 without changing records or logging a server failure`, async () => {
    for (const reason of ["", " ", "short", "no money", "x".repeat(501), "   no   money  "]) {
      const f = routeFixture(), res = response();
      await f.handler(request(reason, role), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, "INVALID_LIFECYCLE_REASON");
      assert.match(res.body.error, /10 and 500/);
      assert.equal(f.saves, 0);
      assert.equal(f.assignmentUpdates, 0);
      assert.equal(f.releases, 0);
      assert.equal(f.booking.status, "pending");
      assert.equal(f.logs.length, 0);
    }
  });
}

test("valid cancellation saves a normalized reason and releases assignments and equipment", async () => {
  const f = routeFixture(), res = response();
  await f.handler(request(" Changed  my\nplans today "), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.booking.status, "cancelled");
  assert.equal(f.booking.cancellationReason, "Changed my plans today");
  assert.equal(f.booking.services[0].status, "cancelled");
  assert.equal(f.saves, 1);
  assert.equal(f.assignmentUpdates, 1);
  assert.equal(f.releases, 1);
  assert.equal(f.historyWrites, 1);
});

test("cancellation retains ownership and paid-booking protections", async () => {
  const other = routeFixture("customer", { customerId: "someone-else" }), denied = response();
  await other.handler(request("Changed my plans today"), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(other.saves, 0);
  const paid = routeFixture(), held = response();
  paid.context.Payment.exists = async () => true;
  await paid.handler(request("Changed my plans today", "admin"), held);
  assert.equal(held.statusCode, 409);
  assert.equal(held.body.code, "REFUND_DECISION_REQUIRED");
  assert.equal(paid.saves, 0);
});

test("the shared customer endpoint delegates linked maintenance to the guarded transaction", async () => {
  const f = routeFixture("customer", { status: "awaiting_assignment", maintenance: {
    isMaintenance: true, paymentOnSite: true, assetId: "asset", scheduleId: "schedule",
  } });
  let transactions = 0;
  f.context.cancelCustomerMaintenance = async values => {
    transactions++;
    assert.equal(values.customerId, "owner-test");
    const cancellation = cancelBookingRecord(f.booking, { actorId: values.customerId, actorName: values.actorName, reason: values.reason });
    return { booking: f.booking, cancellation };
  };
  const res = response();
  await f.handler(request("Changed my plans today"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(transactions, 1);
  assert.equal(f.saves, 0, "the route must not save the transaction's booking again");
  assert.equal(f.assignmentUpdates, 1);
  assert.equal(f.releases, 1);
});

test("ordinary awaiting-assignment bookings keep their existing customer cancellation limit", async () => {
  const f = routeFixture("customer", { status: "awaiting_assignment" }), res = response();
  await f.handler(request("Changed my plans today"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(f.saves, 0);
});

test("completed-booking conflict returns 409 and infrastructure failures remain generic 500", async () => {
  const complete = routeFixture("customer", { status: "completed" }), rejected = response();
  await complete.handler(request("Changed my plans today", "admin"), rejected);
  assert.equal(rejected.statusCode, 409);
  assert.equal(complete.logs.length, 0);
  const unavailable = routeFixture(), error = response();
  unavailable.context.BookingService.findById = async () => { throw new Error("Database private details"); };
  await unavailable.handler(request("Changed my plans today"), error);
  assert.equal(error.statusCode, 500);
  assert.equal(error.body.error, "Failed to cancel appointment");
  assert.equal(unavailable.logs.length, 1);
});

test("admin operations cancellation uses the same reason rules before changing the booking", async () => {
  for (const reason of ["short", "x".repeat(501)]) {
    const f = routeFixture("admin"), res = response();
    await f.handler(request(reason, "admin"), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_LIFECYCLE_REASON");
    assert.equal(f.booking.status, "pending");
    assert.equal(f.saves, 0);
  }
  const f = routeFixture("admin"), res = response();
  await f.handler(request(" Changed  my plans today ", "admin"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.booking.cancellationReason, "Changed my plans today");
});

test("reschedule cancellation rejects short reasons before payment or booking writes", async () => {
  const source = read("routes/appointmentRoutes.js");
  const start = source.indexOf("router.post('/:id/reschedule-action'");
  let handler;
  const context = { router: { post(...handlers) { handler = handlers.at(-1); } }, auth: { authenticate() {} }, normalizeLifecycleReason, require() { return {}; }, console: { error() { assert.fail("Validation must not log a server failure"); } } };
  vm.runInNewContext(source.slice(start, source.indexOf("\nmodule.exports", start)), context);
  for (const reason of ["short", "x".repeat(501)]) {
    const req = request(reason); req.body.action = "cancel";
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /10 and 500/);
  }
});

function clientFixture(fetchImpl) {
  const messages = [], submissions = [];
  let refreshes = 0;
  const context = vm.createContext({ alert: value => messages.push(value),
    fetch: async (url, options) => { submissions.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ message: "Cancelled" }) }; },
    fetchBookings() { refreshes++; },
  });
  vm.runInContext(policySource + "\nconst pendingBookingCancellations=new Set();\n" + functionSource("cancelBooking"), context);
  return { context, messages, submissions, get refreshes() { return refreshes; } };
}

test("client refuses invalid reasons without sending a request, including repeated spaces", async () => {
  const f = clientFixture();
  for (const reason of ["short", "no    money", "x".repeat(501)]) await f.context.cancelBooking("booking-test", reason);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.messages.length, 3);
  assert.match(f.messages[0], /10 to 500/);
});

test("client shows API error text and permits a corrected retry", async () => {
  let attempt = 0;
  const f = clientFixture(async () => ++attempt === 1 ? { ok: false, json: async () => ({ error: "This booking has received payment. Use the Resolution Center." }) } : { ok: true, json: async () => ({ message: "Cancelled" }) });
  await f.context.cancelBooking("booking-test", "Changed my plans today");
  assert.match(f.messages[0], /Use the Resolution Center/);
  assert.doesNotMatch(f.messages[0], /Unknown error/);
  assert.equal(f.refreshes, 0);
  await f.context.cancelBooking("booking-test", " Changed  my\nplans today ");
  assert.equal(f.submissions.length, 2);
  assert.equal(JSON.parse(f.submissions[1].options.body).reason, "Changed my plans today");
  assert.equal(f.refreshes, 1);
});

test("client prevents repeated cancellation requests while one is pending", async () => {
  let release;
  const f = clientFixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.context.cancelBooking("booking-test", "Changed my plans today");
  await f.context.cancelBooking("booking-test", "Changed my plans today");
  assert.equal(f.submissions.length, 1);
  release({ ok: true, json: async () => ({ message: "Cancelled" }) });
  await pending;
  assert.equal(f.refreshes, 1);
});

test("both cancellation dialogs use validation and their fallback prompt does not silently truncate reasons", () => {
  const dialogs = [functionSource("requestDirectBookingCancellation"), client.slice(client.indexOf("  window.bhRescheduleAction"), client.indexOf("  function runAfterClosingDetails"))];
  for (const dialog of dialogs) {
    assert.match(dialog, /inputValidator: bookingCancellationReasonError/);
    assert.match(dialog, /minlength: 10, maxlength: 500/);
    assert.match(dialog, /bookingCancellationReasonError\(value\)/);
    assert.doesNotMatch(dialog, /slice\(0, 500\)/);
  }
});
