"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeServiceLocation, resolveMaintenanceLocation, requireServiceLocation } = require("../utils/maintenanceLocation");
const { bookingAssetSeeds, orderAssetSeeds } = require("../utils/maintenanceLifecycle");

const pin = { address: "123 Mabini Street, Tarlac City", lat: 15.48, lng: 120.59 };
const customerId = "507f1f77bcf86cd799439011";
const scheduleId = "507f1f77bcf86cd799439012";
const assetId = "507f1f77bcf86cd799439013";

test("legacy booking and delivery coordinates can be recovered without changing the source", () => {
  const source = { location: { address: pin.address, coordinates: { type: "Point", coordinates: [pin.lng, pin.lat] } } };
  const snapshot = structuredClone(source);
  assert.deepEqual(resolveMaintenanceLocation({ originType: "booking", serviceAddress: "" }, source), normalizeServiceLocation(pin));
  assert.deepEqual(resolveMaintenanceLocation({ originType: "order" }, { delivery: source.location }), normalizeServiceLocation(pin));
  assert.deepEqual(source, snapshot);
});

test("aftercare distinguishes a store pickup with no home pin from a saved delivery location", async () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/maintenanceRoutes.js"), "utf8");
  const start = routes.indexOf("async function maintenanceLocationDetails(");
  const end = routes.indexOf("async function uniqueMaintenanceReference", start);
  let source = { fulfillmentType: "customer_pickup" };
  let lookups = 0;
  const model = { findById() { lookups++; return { select() { return this; }, lean: async () => source }; } };
  const context = { Order: model, BookingService: model, normalizeServiceLocation, resolveMaintenanceLocation };
  vm.runInNewContext(routes.slice(start, end), context);
  const asset = { originType: "order", originId: scheduleId };
  let result = await context.maintenanceLocationDetails(asset);
  assert.equal(result.missingLocationReason, "store_pickup");
  assert.equal(result.location.lat, undefined);
  source = { fulfillmentType: "delivery_installation", delivery: normalizeServiceLocation(pin) };
  result = await context.maintenanceLocationDetails(asset);
  assert.equal(result.missingLocationReason, null);
  assert.equal(result.location.address, pin.address);
  assert.equal(result.location.lat, pin.lat);
  lookups = 0;
  result = await context.maintenanceLocationDetails({ ...asset, serviceLocation: normalizeServiceLocation(pin), serviceAddress: pin.address });
  assert.equal(result.missingLocationReason, null);
  assert.equal(lookups, 0, "a saved service pin is reused directly");
});

test("corrected asset pins take priority and relocated addresses cannot inherit old pins", () => {
  const corrected = { address: "89 Rizal Avenue, Cabanatuan City", lat: 15.5, lng: 121.0 };
  assert.deepEqual(resolveMaintenanceLocation({ serviceAddress: corrected.address, serviceLocation: corrected }, { location: pin }), normalizeServiceLocation(corrected));
  assert.deepEqual(resolveMaintenanceLocation({ originType: "booking", serviceAddress: corrected.address }, { location: pin }), { address: corrected.address });
  assert.deepEqual(resolveMaintenanceLocation({ originType: "order" }, { delivery: null }), { address: "" });
});

test("missing, empty, null, zero and out-of-country pins cannot create maintenance", () => {
  for (const location of [null, { address: pin.address }, { ...pin, lat: null }, { ...pin, lng: "" }, { ...pin, lat: 0 }, { ...pin, lng: 999 }, { ...pin, address: "" }]) {
    assert.throws(() => requireServiceLocation(location), error => error.status === 400 && error.code === "MAINTENANCE_LOCATION_REQUIRED");
  }
  assert.deepEqual(requireServiceLocation({ ...pin, lat: String(pin.lat), lng: String(pin.lng), totalPrice: 1 }), normalizeServiceLocation(pin));
});

test("new booking and order aircons keep their service map pin, and relocation uses its destination", () => {
  const base = { _id: scheduleId, customerId, location: pin, services: [{ _id: "item1", name: "Cleaning", brand: "Carrier" }] };
  assert.deepEqual(bookingAssetSeeds(base)[0].serviceLocation, normalizeServiceLocation(pin));
  const moved = { address: "89 Rizal Avenue, Cabanatuan City", lat: 15.5, lng: 121 };
  base.services[0].relocation = { to: moved };
  assert.deepEqual(bookingAssetSeeds(base)[0].serviceLocation, normalizeServiceLocation(moved));
  assert.deepEqual(resolveMaintenanceLocation({ originType: "booking", originItemKey: "service-item1-unit-1" }, base), normalizeServiceLocation(moved));
  assert.deepEqual(orderAssetSeeds({ _id: scheduleId, userId: customerId, delivery: { address: pin.address, coordinates: { coordinates: [pin.lng, pin.lat] } }, items: [{ inventoryId: assetId, isHvac: true }] })[0].serviceLocation, normalizeServiceLocation(pin));
});

function bookingRouteFixture({ foreign = false, failLink = false, savedSource = null } = {}) {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/maintenanceRoutes.js"), "utf8");
  const start = routes.indexOf('router.post("/schedules/:id/book",');
  const end = routes.indexOf('router.post("/schedules/:id/respond",', start);
  const events = [], quotes = [], lookups = [];
  let stagedLocation, savedLocation, createdBooking, handler;
  const schedule = { _id: scheduleId, status: "upcoming", dueDate: "2027-01-08", customerId: { _id: customerId, email: "customer@example.test" }, assetId: { _id: assetId, status: "active", equipment: { brand: "Carrier", capacity: 1 }, serviceAddress: "" } };
  const query = value => ({ populate() { return this; }, select() { return this; }, lean: async () => value });
  const session = { active: false, startTransaction() { this.active = true; events.push("start"); }, inTransaction() { return this.active; }, async commitTransaction() { this.active = false; savedLocation = stagedLocation; events.push("commit"); }, async abortTransaction() { this.active = false; stagedLocation = undefined; events.push("abort"); }, async endSession() { events.push("end"); } };
  class Booking {
    constructor(data) { Object.assign(this, data, { _id: "newBooking" }); }
    async save(options) { assert.equal(options.session, session); createdBooking = this; events.push("booking"); }
    static exists() { return Promise.resolve(false); }
    static findOne() { return query(null); }
    static async updateOne(_filter, _update, options) { assert.equal(options.session, session); }
  }
  const context = {
    router: { post(_path, _auth, action) { handler = action; } }, auth: { requireRole: () => null },
    mongoose: { isValidObjectId: value => /^[a-f0-9]{24}$/i.test(value), startSession: async () => session },
    MaintenanceSchedule: { findOne(filter) { lookups.push(filter); return query(foreign || filter.bookingId ? null : schedule); } },
    CustomerAsset: { async updateOne(filter, update, options) { assert.equal(filter.customerId, customerId); assert.equal(options.session, session); stagedLocation = update.$set.serviceLocation; events.push("asset"); } },
    BookingService: Booking, SiteSetting: { find: () => query([{ key: "companyLocationLat", value: 15.359 }, { key: "companyLocationLng", value: 120.957 }, { key: "farePerKm", value: 40 }]) },
    CoreService: { find: () => query([{ _id: "cleaning", name: "Aircon Cleaning" }]) },
    customerId: req => req.user._id, ACTIVE_DUE_STATUSES: ["upcoming", "due", "overdue"],
    requireServiceLocation, maintenanceLocation: async () => savedSource || ({ address: "" }), isMaintenanceService: () => true,
    maintenanceServiceQuote: () => ({ price: 1500, durationMinutes: 90 }),
    authoritativeDeliveryQuote: async input => { quotes.push(input); return { transportationFee: 250, durationMin: 20, distanceKm: 6 }; },
    manilaDateKey: () => "2027-01-08", firstMaintenanceSlot: async () => ({ date: "2027-01-09", startTime: "09:00" }),
    require: () => ({ getTimeSlotsForQuery: () => {} }), parseTimeMinutes: () => 540, minutesLabel: minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`,
    uniqueMaintenanceReference: async () => "RACS-20270109-MTEST", linkScheduleToBooking: async () => { events.push("link"); if (failLink) throw new Error("Schedule was already booked"); },
    createNotification: async () => {}, audit: { logEvent: async () => {} }, global: {}, Date, Number, String, Promise,
  };
  vm.runInNewContext(routes.slice(start, end), context);
  return { events, quotes, lookups, get savedLocation() { return savedLocation; }, get createdBooking() { return createdBooking; }, async invoke(location) {
    const result = {};
    const res = { status(value) { result.status = value; return this; }, json(value) { result.data = value; return this; } };
    await handler({ params: { id: scheduleId }, body: { location, totalPrice: 1, travelFare: 0 }, user: { _id: customerId }, app: { get: () => null } }, res, error => { result.error = error; });
    return result;
  } };
}

test("selected location creates a server-priced maintenance visit and persists its pin in the booking transaction", async () => {
  const fixture = bookingRouteFixture();
  const result = await fixture.invoke(pin);
  assert.equal(result.status, 201);
  assert.deepEqual(structuredClone(fixture.savedLocation), normalizeServiceLocation(pin));
  assert.equal(fixture.createdBooking.totalPrice, 1750);
  assert.equal(fixture.createdBooking.travelFare, 250);
  assert.equal(fixture.quotes[0].destination.lat, pin.lat);
  assert.equal(fixture.createdBooking.location.address, pin.address);
  assert.equal(fixture.createdBooking.downpaymentAmount, 0);
  assert.deepEqual(fixture.events, ["start", "booking", "link", "asset", "commit", "end"]);
});

test("invalid or foreign-customer locations cannot reach pricing or booking writes", async () => {
  const invalid = bookingRouteFixture();
  assert.equal((await invalid.invoke({ address: pin.address })).error.status, 400);
  assert.equal(invalid.quotes.length, 0);
  assert.equal(invalid.events.length, 0);
  const foreign = bookingRouteFixture({ foreign: true });
  assert.equal((await foreign.invoke(pin)).status, 404);
  assert.equal(foreign.lookups[0].customerId, customerId);
  assert.equal(foreign.quotes.length, 0);
});

test("maintenance can reuse the original saved pin without submitting a new location", async () => {
  const fixture = bookingRouteFixture({ savedSource: normalizeServiceLocation(pin) });
  assert.equal((await fixture.invoke(undefined)).status, 201);
  assert.deepEqual(structuredClone(fixture.savedLocation), normalizeServiceLocation(pin));
  assert.equal(fixture.createdBooking.location.address, pin.address);
  assert.equal(fixture.quotes[0].destination.lat, pin.lat);
});

test("a concurrent booking conflict aborts the transaction without saving the requested location", async () => {
  const fixture = bookingRouteFixture({ failLink: true });
  assert.match((await fixture.invoke(pin)).error.message, /already booked/);
  assert.equal(fixture.savedLocation, undefined);
  assert.ok(fixture.events.includes("abort"));
  assert.ok(!fixture.events.includes("commit"));
});

test("replaying an old source completion preserves a customer's corrected service location", async () => {
  const lifecycle = fs.readFileSync(path.join(__dirname, "../utils/maintenanceLifecycle.js"), "utf8");
  const start = lifecycle.indexOf("async function upsertAsset(");
  const end = lifecycle.indexOf("async function syncMaintenanceFromBooking", start);
  const current = { assetKey: "source", serviceAddress: pin.address, serviceLocation: normalizeServiceLocation(pin) };
  const context = { CustomerAsset: { async findOneAndUpdate(_filter, update) { Object.assign(current, update.$set); return current; } } };
  vm.runInNewContext(lifecycle.slice(start, end), context);
  await context.upsertAsset({ assetKey: "source", serviceAddress: "Old address", serviceLocation: {} }, {});
  assert.equal(current.serviceAddress, pin.address);
  assert.deepEqual(current.serviceLocation, normalizeServiceLocation(pin));
});
