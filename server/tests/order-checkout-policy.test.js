const test = require("node:test");
const assert = require("node:assert/strict");
const {
  authoritativeDeliveryQuote,
  initialOrderLifecycle,
  parseDateOnly,
  validateCheckoutItems,
  validateCheckoutSelection,
} = require("../utils/orderCheckoutPolicy");

const NOW = new Date("2026-08-29T10:00:00+08:00");
const HOURS = [
  { dayOfWeek: 0, open: false },
  { dayOfWeek: 1, open: true, startMinutes: 480, endMinutes: 1080 },
];

test("strict date parsing rejects JavaScript-normalized dates", () => {
  assert.equal(parseDateOnly("2026-02-30"), null);
  assert.equal(parseDateOnly("08/31/2026"), null);
  assert.equal(parseDateOnly("2026-08-31").getDate(), 31);
});

test("pickup checkout requires a future open store day", () => {
  const valid = validateCheckoutSelection({
    fulfillmentType: "customer_pickup",
    paymentMethod: "cash_onsite",
    pickupDate: "2026-08-31",
  }, { storeHours: HOURS, now: NOW });
  assert.equal(valid.pickupDate.getDay(), 1);

  assert.throws(() => validateCheckoutSelection({
    fulfillmentType: "customer_pickup",
    paymentMethod: "cash_onsite",
    pickupDate: "2026-08-30",
  }, { storeHours: HOURS, now: NOW }), /store is closed/i);
});

test("delivery and installation checkout requires server-usable contact, location, date, and time", () => {
  const valid = validateCheckoutSelection({
    fulfillmentType: "delivery_installation",
    paymentMethod: "cod",
    timeSlot: "09:00",
    delivery: {
      address: "123 Enterprise Street, Nueva Ecija",
      contactNumber: "09171234567",
      preferredDate: "2026-08-31",
      coordinates: { lat: 15.2, lng: 120.9 },
    },
  }, { now: NOW });
  assert.equal(valid.delivery.coordinates.lng, 120.9);

  assert.throws(() => validateCheckoutSelection({
    fulfillmentType: "delivery_installation",
    paymentMethod: "cod",
    timeSlot: "09:00",
    delivery: { address: "short", contactNumber: "09171234567", preferredDate: "2026-08-31", coordinates: { lat: 15.2, lng: 120.9 } },
  }, { now: NOW }), /complete delivery address/i);
});

test("new checkout rejects the legacy delivery-only path", () => {
  assert.throws(() => validateCheckoutSelection({
    fulfillmentType: "delivery_only",
    paymentMethod: "cod",
  }, { now: NOW }), /supported fulfillment option/i);
});

test("checkout rejects duplicate product lines and aggregate quantity bypasses", () => {
  const firstId = "64b000000000000000000001";
  const secondId = "64b000000000000000000002";
  assert.throws(() => validateCheckoutItems([
    { inventoryId:firstId, quantity:20 },
    { inventoryId:firstId, quantity:20 },
  ]), /duplicate products/i);
  assert.throws(() => validateCheckoutItems([
    { inventoryId:firstId, quantity:30 },
    { inventoryId:secondId, quantity:11 },
  ]), /more than 40 total units/i);
});

test("delivery checkout rejects contact values that are not phone numbers", () => {
  assert.throws(() => validateCheckoutSelection({
    fulfillmentType:"delivery_installation",
    paymentMethod:"cod",
    timeSlot:"09:00",
    delivery:{
      address:"123 Enterprise Street, Nueva Ecija",
      contactNumber:"javascript:alert(1)",
      preferredDate:"2026-08-31",
      coordinates:{ lat:15.2, lng:120.9 },
    },
  }, { now:NOW }), /valid delivery contact/i);
});

test("delivery quote ignores client claims and uses the routing result", async () => {
  const quote = await authoritativeDeliveryQuote({
    origin: { lat: 15, lng: 121 },
    destination: { lat: 15.1, lng: 121.2 },
    farePerKm: 40,
    httpClient: { get: async () => ({ data: { routes: [{ distance: 12500, duration: 1800, geometry: { type: "LineString", coordinates: [] } }] } }) },
  });
  assert.deepEqual({ distanceKm: quote.distanceKm, durationMin: quote.durationMin, transportationFee: quote.transportationFee, source: quote.source }, {
    distanceKm: 12.5, durationMin: 30, transportationFee: 500, source: "road",
  });
});

test("cash-on-site pickup begins preparation without falsely recording payment", () => {
  assert.deepEqual(initialOrderLifecycle("customer_pickup", "cash_onsite"), { status: "preparing_unit", paymentStatus: "pending" });
  assert.deepEqual(initialOrderLifecycle("delivery_installation", "cod"), { status: "pending_payment", paymentStatus: "pending" });
});
