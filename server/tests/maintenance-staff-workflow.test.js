"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const BookingModel = require("../models/BookingService");
const { normalizeServiceLocation, requireServiceLocation } = require("../utils/maintenanceLocation");
const { parseDateOnly } = require("../utils/orderCheckoutPolicy");
const { manilaDateKey } = require("../utils/maintenanceBooking");
const { clampIntervalDays } = require("../utils/maintenanceLifecycle");
const { requiredPermissionForRequest, hasPermission } = require("../middleware/requirePermission");
const { toSecretaryNotificationLink } = require("../utils/notify");
const { isUnpaidAftercareMaintenance } = require("../utils/customerBookingPresentation");
const { resolutionPaymentNeedsReview } = require("../utils/resolutionCenter");
const { manilaDateTime } = require("../utils/bookingDateTime");
const { cancelBookingRecord } = require("../utils/bookingLifecycle");
const source = fs.readFileSync(path.join(__dirname, "../routes/maintenanceRoutes.js"), "utf8");
const id = "507f1f77bcf86cd799439011", customerId = "507f1f77bcf86cd799439012", assetId = "507f1f77bcf86cd799439013";
const pin = { address: "123 Mabini Street, Tarlac City", lat: 15.48, lng: 120.59 };
const query = value => ({ populate() { return this; }, select() { return this; }, session() { return this; }, lean: async () => value });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

function fixture(options = {}) {
  const events = [], slotQueries = [], quotes = [], updates = [], notices = [];
  let booking, stagedPin, savedPin, committed = false, handler, middleware, warnings = 0;
  const asset = { _id: assetId, status: options.inactive ? "retired" : "active", serviceLocation: options.noPin ? {} : pin,
    serviceAddress: pin.address, equipment: { brand: "Carrier", applianceType: "split", capacity: 1 } };
  const schedule = { _id: id, status: options.booked ? "scheduled" : "upcoming", bookingId: options.booked ? id : null,
    dueDate: new Date("2099-01-08"), intervalDays: 90, assetId: asset, customerId: { _id: customerId, email: "customer@example.test", name: "Customer" } };
  const service = { _id: id, name: "Aircon Cleaning", basePrice: 800, hpPricing: [{ hp: 1, price: 1200, durationMinutes: 90 }] };
  const existing = { _id: id, bookingReference: "RACS-TEST-EXISTING" };
  const session = { active: false, startTransaction() { this.active = true; events.push("start"); }, inTransaction() { return this.active; },
    async commitTransaction() { committed = true; savedPin = stagedPin; this.active = false; events.push("commit"); },
    async abortTransaction() { stagedPin = undefined; this.active = false; events.push("abort"); }, async endSession() { events.push("end"); } };
  class Booking {
    constructor(data) { Object.assign(this, data, { _id: id }); booking = this; }
    async save(opts) { assert.equal(opts.session, session); await new BookingModel(this).validate(); events.push("booking"); }
    static async updateOne(filter, update, opts) { assert.equal(opts.session, session); updates.push(update); }
    static findOne() { return query(options.booked || options.concurrentSaved ? existing : null); }
  }
  const context = { mongoose: { ...mongoose, startSession: async () => session }, parseDateOnly, manilaDateKey, normalizeServiceLocation, requireServiceLocation,
    ACTIVE_DUE_STATUSES: ["upcoming", "due", "overdue"], OUTREACH_METHODS: ["phone", "email", "sms", "in_person", "other"],
    MaintenanceSchedule: { findOne(filter) { return query(filter.bookingId ? (options.concurrentSaved ? { bookingId: id, customerId } : null) : schedule); },
      async updateOne(_filter, update, opts) { assert.equal(opts.session, session); updates.push(update); events.push("outreach"); } },
    CoreService: { findOne: () => query(service) }, BookingService: Booking,
    CustomerAsset: { async updateOne(filter, update, opts) { assert.equal(filter.customerId, customerId); assert.equal(opts.session, session); stagedPin = update.$set.serviceLocation; events.push("asset"); } },
    SiteSetting: { find: () => query(options.missingCompany ? [] : [{ key: "companyLocationLat", value: 15.35 }, { key: "companyLocationLng", value: 120.95 }, { key: "farePerKm", value: 40 }]) },
    maintenanceLocation: async () => normalizeServiceLocation(options.noPin ? { address: pin.address } : pin),
    authoritativeDeliveryQuote: async input => { quotes.push(input); return { transportationFee: 250, durationMin: 45, distanceKm: 6.3 }; },
    uniqueMaintenanceReference: async () => "RACS-TEST-MAINT",
    createNotification: async data => { notices.push(data); if (options.failNotify) throw Error("Notification unavailable"); },
    audit: { logEvent: async () => { if (options.failAudit) throw Error("Audit unavailable"); } },
    console: { warn() { warnings++; } }, global: {},
    require(name) {
      if (name === "./scheduleRoutes") return { getTimeSlotsForQuery: async input => {
        slotQueries.push(input); return { statusCode: 200, payload: { timeSlots: [{ startTime: "09:00", available: options.slotAvailable !== false }] } };
      } };
      if (name.includes("maintenanceLifecycle")) return { linkScheduleToBooking: async opts => {
        assert.equal(opts.session, session); assert.equal(opts.actorId, id); events.push("link");
        if (options.failLink) throw Object.assign(Error("Already booked"), { status: 409 });
        return { ...schedule, status: "scheduled", bookingId: id };
      } };
      throw Error(name);
    },
    router: { post(...args) { middleware = args[1]; handler = args.at(-1); } },
  };
  vm.runInNewContext(source.slice(source.indexOf("function isMaintenanceService("), source.indexOf("async function maintenanceLocationDetails(")), context);
  vm.runInNewContext(source.slice(source.indexOf("function requireStaff("), source.indexOf("function customerId(")), context);
  const marker = options.preview ? 'router.post("/admin/schedules/:id/booking-preview",' : 'router.post("/admin/schedules/:id/book",';
  const end = options.preview ? 'router.post("/admin/schedules/:id/book",' : 'router.get("/schedules/:id/booking-location",';
  const begin = source.indexOf(marker);
  vm.runInNewContext(source.slice(begin, source.indexOf(end, begin)), context);
  return { events, slotQueries, quotes, updates, notices, get booking() { return booking; }, get savedPin() { return savedPin; },
    get committed() { return committed; }, get warnings() { return warnings; },
    async invoke(body = {}, role = "admin") {
      const res = response(); let error, permitted = false;
      const req = { params: { id }, body: { serviceId: id, date: "2099-01-09", startTime: "09:00", customerConfirmed: true, ...body },
        user: { _id: id, role, name: "Staff" }, app: { get: () => null } };
      middleware(req, res, () => { permitted = true; });
      if (permitted) await handler(req, res, value => { error = value; });
      return { ...res, error };
    },
  };
}

for (const role of ["admin", "secretary"]) test(role + " creates an agreed maintenance visit with no deposit and the full travel fee", async () => {
  const f = fixture(), res = await f.invoke({}, role);
  assert.equal(res.error, undefined); assert.equal(res.statusCode, 201);
  assert.equal(f.booking.downpaymentAmount, 0); assert.equal(f.booking.maintenance.paymentOnSite, true);
  assert.equal(f.booking.amountPaid, 0); assert.equal(f.booking.paymentStatus, "pending");
  assert.equal(f.booking.totalPrice, 1450); assert.equal(f.booking.balanceAmount, 1450); assert.equal(f.booking.travelFare, 250);
  assert.equal(f.booking.status, "awaiting_assignment"); assert.equal(f.booking.bookingDate.toISOString(), "2099-01-09T00:00:00.000Z");
  assert.equal(f.slotQueries[0].travelTime, "45"); assert.equal(f.quotes[0].destination.lat, pin.lat);
  assert.deepEqual(structuredClone(f.savedPin), normalizeServiceLocation(pin));
  assert.ok(f.events.indexOf("link") < f.events.indexOf("commit"));
  assert.match(f.notices[0].message, /No downpayment/);
});

test("staff preview and submission use the same quote and travel-aware capacity", async () => {
  const preview = fixture({ preview: true }), booked = fixture();
  const res = await preview.invoke();
  await booked.invoke();
  assert.equal(res.error, undefined); assert.equal(res.body.total, booked.booking.totalPrice);
  assert.equal(res.body.travelFare, 250); assert.equal(res.body.travelTime, 45);
  assert.equal(preview.slotQueries[0].travelTime, "45"); assert.deepEqual(preview.events, []);
});

test("missing pins, changed text with an old pin, inactive aircons and missing company settings cannot create maintenance", async () => {
  for (const [options, body, status] of [[{ noPin: true }, {}, 400], [{}, { address: "Different street, Cabanatuan City" }, 400],
    [{ inactive: true }, {}, 409], [{ missingCompany: true }, {}, 503]]) {
    const f = fixture(options), res = await f.invoke(body);
    assert.equal(res.error?.status, status); assert.equal(f.booking, undefined); assert.equal(f.committed, false);
  }
});

test("a verified changed location is saved only after the booking commits", async () => {
  const location = { address: "89 Rizal Avenue, Cabanatuan City", lat: 15.5, lng: 121 };
  const f = fixture({ noPin: true }), res = await f.invoke({ location });
  assert.equal(res.statusCode, 201); assert.equal(f.savedPin.address, location.address);
  assert.equal(f.quotes[0].destination.lng, location.lng);
  const conflict = fixture({ failLink: true }); const failed = await conflict.invoke({ location });
  assert.equal(failed.error.status, 409); assert.equal(conflict.savedPin, undefined); assert.equal(conflict.committed, false);
  assert.ok(conflict.events.includes("abort"));
});

test("a taken start time and an unconfirmed customer are rejected before booking writes", async () => {
  const f = fixture({ slotAvailable: false }); assert.equal((await f.invoke()).statusCode, 409); assert.equal(f.booking, undefined);
  const noConsent = fixture(); assert.equal((await noConsent.invoke({ customerConfirmed: false })).statusCode, 400);
  assert.equal(noConsent.quotes.length, 0);
});

test("invalid calendar dates and past dates cannot silently roll into another day", async () => {
  for (const date of ["2099-02-30", "2099-13-01", "2020-01-01", "01/09/2099"]) {
    const f = fixture(); assert.equal((await f.invoke({ date })).error.status, 400); assert.equal(f.booking, undefined);
  }
});

test("notification and audit failures after commit still return a successful booking", async () => {
  const f = fixture({ failNotify: true, failAudit: true }), res = await f.invoke();
  assert.equal(f.committed, true); assert.equal(res.statusCode, 201); assert.equal(res.error, undefined); assert.equal(f.warnings, 2);
});

test("repeat and concurrent submissions return the existing booking instead of creating another visit", async () => {
  for (const options of [{ booked: true }, { failLink: true, concurrentSaved: true }]) {
    const f = fixture(options), res = await f.invoke();
    assert.equal(res.statusCode, 200); assert.equal(res.body.alreadyBooked, true); assert.equal(f.committed, false);
  }
});

test("customers and technicians cannot use staff booking or preview endpoints", async () => {
  for (const role of ["customer", "technician"]) for (const preview of [false, true]) {
    const f = fixture({ preview }); assert.equal((await f.invoke({}, role)).statusCode, 403); assert.equal(f.quotes.length, 0);
  }
});

test("secretary maintenance access follows booking view and manage permissions, and notification links stay in the secretary workspace", async () => {
  const user = { role: "secretary", permissionsOverridden: true, permissions: ["appointments.view"] };
  for (const [url, method, permission] of [["/secretary/maintenance", "GET", "appointments.view"],
    ["/api/maintenance/admin/overview?status=due", "GET", "appointments.view"],
    ["/api/maintenance/admin/schedules/" + id + "/booking-preview", "POST", "appointments.view"],
    ["/api/maintenance/admin/schedules/" + id + "/book", "POST", "appointments.manage"],
    ["/api/maintenance/admin/schedules/" + id + "/outreach", "PATCH", "appointments.manage"],
    ["/api/maintenance/admin/schedules/" + id, "PATCH", "appointments.manage"]]) {
    const required = requiredPermissionForRequest(user, { originalUrl: url, method });
    assert.equal(required, permission);
    assert.equal(await hasPermission(user, required), permission === "appointments.view");
  }
  assert.equal(toSecretaryNotificationLink("/admin/maintenance?status=responses"), "/secretary/maintenance?status=responses");
});

test("scheduled and completed cycles reject every manual edit, including date-only and interval-only payloads", async () => {
  for (const status of ["scheduled", "completed"]) for (const body of [{ dueDate: "2099-02-01" }, { intervalDays: 120 }]) {
    let handler;
    const context = { requireStaff() {}, mongoose, MaintenanceSchedule: { findById: async () => ({ status }) },
      router: { patch(...args) { handler = args.at(-1); } } };
    const begin = source.indexOf('router.patch("/admin/schedules/:id",');
    vm.runInNewContext(source.slice(begin, source.indexOf('router.get("/technician/bookings/:bookingId",', begin)), context);
    const res = response(); await handler({ params: { id }, body, user: { _id: id } }, res, error => { throw error; });
    assert.equal(res.statusCode, 409);
  }
});

test("a manual edit racing with a booking aborts instead of overwriting the linked cycle", async () => {
  let handler, filter, committed = false, aborted = false, assetWrites = 0;
  const session = { active: false, startTransaction() { this.active = true; }, inTransaction() { return this.active; },
    async commitTransaction() { committed = true; this.active = false; }, async abortTransaction() { aborted = true; this.active = false; }, async endSession() {} };
  const context = { requireStaff() {}, mongoose: { ...mongoose, startSession: async () => session }, clampIntervalDays,
    MaintenanceSchedule: { findById: async () => ({ _id: id, status: "upcoming", updatedAt: new Date(), assetId }),
      findOneAndUpdate: async (f, _update, opts) => { filter = f; assert.equal(opts.session, session); return null; } },
    CustomerAsset: { findByIdAndUpdate: async () => { assetWrites++; } }, router: { patch(...args) { handler = args.at(-1); } } };
  const begin = source.indexOf('router.patch("/admin/schedules/:id",');
  vm.runInNewContext(source.slice(begin, source.indexOf('router.get("/technician/bookings/:bookingId",', begin)), context);
  const res = response(); let error;
  await handler({ params: { id }, body: { intervalDays: 120 }, user: { _id: id } }, res, e => { error = e; });
  assert.equal(error.status, 409); assert.equal(filter.bookingId, null);
  assert.equal(aborted, true); assert.equal(committed, false); assert.equal(assetWrites, 0);
});

test("staff warnings keep maintenance assignment issues without asking for an upfront deposit", async () => {
  const management = fs.readFileSync(path.join(__dirname, "../routes/appointmentManagement.js"), "utf8");
  let handler, reads = 0;
  const now = new Date("2026-10-11T00:00:00.000Z");
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const base = { bookingDate: new Date("2026-10-11"), startTime: "09:00", paymentStatus: "pending", amountPaid: 0, customer: { name: "Customer" } };
  const maintenance = { ...base, _id: id, status: "awaiting_assignment", maintenance: { isMaintenance: true, paymentOnSite: true } };
  const ordinary = { ...base, _id: customerId, status: "awaiting_assignment" };
  const confirmedMaintenance = { ...maintenance, _id: assetId, status: "confirmed" };
  const context = { Date: FixedDate, requireRole() {}, isUnpaidAftercareMaintenance, manilaDateTime,
    BookingService: { find() { reads++; return { select(fields) { assert.match(fields, /maintenance/); return this; }, lean: async () => reads === 1 ? [] : [maintenance, ordinary, confirmedMaintenance] }; } },
    require: () => ({ parseBookingDateTime: (date, time) => manilaDateTime(date, time === "09:00" ? 540 : 0) }),
    router: { get(...args) { handler = args.at(-1); } }, console };
  const begin = management.indexOf("router.get('/verification-warnings'");
  vm.runInNewContext(management.slice(begin, management.indexOf("router.get('/daily-kits'", begin)), context);
  const res = response(); await handler({}, res);
  assert.equal(res.statusCode, 200);
  const records = new Map(res.body.verifyItems.map(item => [item._id, item]));
  assert.deepEqual(Array.from(records.get(id).issues), ["assignment"]);
  assert.deepEqual(Array.from(records.get(customerId).issues), ["payment", "assignment"]);
  assert.equal(records.has(assetId), false);
  assert.equal(resolutionPaymentNeedsReview(maintenance), false);
  assert.equal(resolutionPaymentNeedsReview(ordinary), true);
});

test("the upcoming reminder monitor does not send a deposit warning for an assigned maintenance visit", async () => {
  const monitor = fs.readFileSync(path.join(__dirname, "../utils/overdueBookingScheduler.js"), "utf8");
  const now = new Date("2026-10-11T00:00:00.000Z");
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const booking = { status: "confirmed", bookingDate: new Date("2026-10-11"), startTime: "09:00", paymentStatus: "pending",
    amountPaid: 0, maintenance: { isMaintenance: true, paymentOnSite: true }, save() { assert.fail("No warning should be claimed for an assigned pay-after-service visit"); } };
  const context = { Date: FixedDate, VERIFY_REMINDER_HOURS: 3, isUnpaidAftercareMaintenance,
    BookingService: { find: () => ({ select(fields) { assert.match(fields, /maintenance/); return Promise.resolve([booking]); } }) },
    parseBookingDateTime: (date, _time) => manilaDateTime(date, 540),
    resolveCustomer() { assert.fail("No payment reminder should be sent"); }, console: { log() {}, error(value) { assert.fail(value); } } };
  const begin = monitor.indexOf("async function checkForUpcomingUnverifiedBookings()");
  vm.runInNewContext(monitor.slice(begin, monitor.indexOf("function customerReminderSlot(", begin)), context);
  await context.checkForUpcomingUnverifiedBookings();
});

for (const [role, failReminder] of [["admin", false], ["secretary", false], ["secretary", true]]) test(role + (failReminder
  ? " cancellation rolls back when the reminder cannot be reopened"
  : " cancellation closes the technician assignment and reopens the maintenance reminder together"), async () => {
  const management = fs.readFileSync(path.join(__dirname, "../routes/appointmentManagement.js"), "utf8");
  let handler, staged = [], committed = [], equipmentReleased = false;
  const session = { async withTransaction(work) { await work(); committed = staged.slice(); }, async endSession() { staged.push("end"); } };
  const booking = { _id: id, bookingReference: "RACS-TEST-MAINT", customerId, status: "assigned",
    maintenance: { isMaintenance: true, scheduleId: id, assetId },
    services: [{ status: "assigned", statusHistory: [] }], async save(opts) { assert.equal(opts.session, session); staged.push("booking"); } };
  const context = { requireRole() {}, normalizeLifecycleReason: require("../utils/dataLifecycle").normalizeLifecycleReason,
    mongoose: { startSession: async () => session }, BookingStatus: { COMPLETED: "completed", CANCELLED: "cancelled" },
    BookingService: { findById: () => ({ session(actual) { assert.equal(actual, session); return Promise.resolve(booking); }, then: resolve => Promise.resolve(booking).then(resolve) }) },
    Assignment: { async updateMany(filter, update, opts) { assert.equal(filter.bookingId, id); assert.equal(update.$set.status, "cancelled"); assert.equal(opts.session, session); staged.push("assignment"); } },
    async releaseReservedEquipment(opts) { assert.equal(opts.filter.bookingId, id); assert.equal(committed.length, 3); equipmentReleased = true; },
    require(name) {
      if (name.endsWith("/bookingLifecycle")) return { cancelBookingRecord };
      if (name.endsWith("/maintenanceLifecycle")) return { async reopenScheduleAfterBookingCancellation(value, opts) {
        assert.equal(value.status, "cancelled"); assert.equal(opts.session, session); staged.push("reminder");
        if (failReminder) throw Error("Reminder update failed");
      } };
      if (name.endsWith("/notify")) return { async createNotification(value) { assert.equal(value.link, "/aftercare"); assert.equal(value.userId, customerId); } };
      throw Error(name);
    }, router: { post(...args) { handler = args.at(-1); } }, console: { log() {}, warn() {}, error() {} } };
  const begin = management.indexOf("router.post('/:id/cancel'");
  vm.runInNewContext(management.slice(begin, management.indexOf("function buildToolContextText(", begin)), context);
  const res = response(); await handler({ params: { id }, body: { reason: "Customer requested another visit" },
    user: { _id: id, name: "Staff", role }, app: { get: () => null } }, res);
  if (failReminder) {
    assert.equal(res.statusCode, 500); assert.deepEqual(committed, []); assert.equal(equipmentReleased, false);
    assert.equal(staged.at(-1), "end"); return;
  }
  assert.equal(res.statusCode, 200); assert.equal(booking.status, "cancelled"); assert.equal(booking.services[0].status, "cancelled");
  assert.deepEqual(committed, ["booking", "assignment", "reminder"]); assert.equal(equipmentReleased, true);
  assert.equal(booking.maintenance.assetId, assetId, "the aircon record is retained");
});
