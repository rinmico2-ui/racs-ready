"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");
const { resolveWalkInCoreSelection, pinWalkInRelocations } = require("../utils/walkInCoreSelection");
const { validateBookingUnitLimit } = require("../utils/bookingUnitLimit");
const { capacityMinutes } = require("../utils/bookingServiceItems");
const { buildUnitGroups } = require("../utils/repairUnitWorkflow");
const { projectUnits } = require("../utils/projectWorkOrderPlanning");

const catalog = {
  _id: "cleaning", active: true, name: "Cleaning", isAirconService: true,
  basePrice: 100, durationMinutes: 30,
  airconTypes: [{ type: "split", name: "Split Type", hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }],
  applianceProfiles: [{ kind: "refrigerator", enabled: true, pricingMode: "fixed", unitPrice: 900, durationMinutes: 75 }],
};
const item = { serviceId: "cleaning", applianceKind: "aircon", applianceGroupId: "appliance_group_001", quantity: 4, brand: "Carrier", model: "Nexus", airconType: "split", hp: 1 };

test("walk-in pricing uses the same saved appliance prices and work time as service booking", () => {
  const aircon = resolveWalkInCoreSelection(catalog, { ...item, unitPrice: 1, duration: 1 });
  assert.equal(aircon.unitPrice, 500);
  assert.equal(aircon.totalPrice, 2000);
  assert.equal(aircon.duration, 60);
  assert.equal(aircon.applianceGroupId, item.applianceGroupId);
  const fridge = resolveWalkInCoreSelection(catalog, { ...item, applianceKind: "refrigerator", airconType: null, hp: null });
  assert.equal(fridge.unitPrice, 900);
  assert.equal(fridge.duration, 75);
  assert.equal(fridge.applianceKind, "refrigerator");
});

test("several services on one appliance group count the appliances once", () => {
  assert.equal(validateBookingUnitLimit([item, { ...item, serviceId: "recharge" }]), 4);
  assert.throws(() => validateBookingUnitLimit([item, { ...item, serviceId: "recharge", quantity: 5 }]), /matching appliance details/);
  assert.throws(() => validateBookingUnitLimit([item, item]), /only once/);
});

test("unsupported appliances and incomplete HP selections remain validation errors", () => {
  assert.throws(() => resolveWalkInCoreSelection(catalog, { ...item, applianceKind: "freezer" }), error => error.status === 400);
  assert.throws(() => resolveWalkInCoreSelection(catalog, { ...item, hp: null }), error => error.status === 400);
});

test("nearby relocation keeps both positions and a different-address move requires its map booking flow", () => {
  const moveCatalog = { ...catalog, slug: "aircon-relocation" };
  const move = { ...item, quantity: 1, relocation: { scope: "same_property", from: { details: "Living room" }, to: { details: "Bedroom" } } };
  const resolved = resolveWalkInCoreSelection(moveCatalog, move);
  assert.equal(resolved.relocation.from.details, "Living room");
  assert.equal(resolved.relocation.to.details, "Bedroom");
  assert.throws(() => resolveWalkInCoreSelection(moveCatalog, { ...move, relocation: { scope: "custom_quote" } }), /both map pins/);
});

test("nearby relocation saves the property pin with both room descriptions and requires valid map coordinates", () => {
  const move = { quantity: 1, relocation: { scope: "same_property", from: { details: "Living room", lat: 80 }, to: { details: "Bedroom", lng: 80 } } };
  pinWalkInRelocations([move], { lat: 15.37, lng: 120.96, address: "Customer property" });
  assert.deepEqual(move.relocation.from, { details: "Living room", lat: 15.37, lng: 120.96, address: "Customer property" });
  assert.deepEqual(move.relocation.to, { details: "Bedroom", lat: 15.37, lng: 120.96, address: "Customer property" });
  assert.throws(() => pinWalkInRelocations([move], { address: "Unpinned property" }), error => error.status === 400);
});

test("admin and secretary render the shared guided page with valid inline scripts", async () => {
  const filename = path.join(__dirname, "../views/pages/admin/Appointments/WalkIn.ejs");
  for (const role of ["admin", "secretary"]) {
    const html = await ejs.renderFile(filename, { user: { role }, airconOrdersEnabled: true });
    assert.match(html, /id="coreApplianceBuilder"/);
    assert.match(html, /id="walkinProgressBack"/);
    assert.match(html, /id="walkinRepairGuide"/);
    assert.match(html, /id="walkinAirconPane"/);
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) assert.doesNotThrow(() => new Function(script[1]));
  }
});

test("walk-in task snapshots preserve per-appliance time for later scheduling and work orders", async () => {
  const Booking = require("../models/BookingService");
  const cleaning = { ...catalog, _id: "670000000000000000000011" };
  const recharge = { ...catalog, _id: "670000000000000000000012", name: "Freon Recharging",
    airconTypes: [{ type: "split", name: "Split Type", hpPricing: [{ hp: 1, price: 800, durationMinutes: 90 }] }] };
  const services = [cleaning, recharge].map(service => ({ ...item, ...resolveWalkInCoreSelection(service, item),
    serviceId: service._id, name: service.name, type: "core" }));
  const booking = new Booking({ quantity: 1, isMultiService: true, services, downpaymentAmount: 500 });
  await booking.validate(["services", "quantity"]);
  assert.equal(booking.quantity, 4);
  assert.equal(capacityMinutes(booking.services), 600);
  const units = projectUnits({ totalUnits: 4, unitGroups: buildUnitGroups(booking) });
  assert.equal(units.length, 4);
  assert.equal(units[0].durationMinutes, 150);
  assert.equal(units[0].serviceTasks.length, 2);
});

test("the walk-in options endpoint returns appliance pricing profiles for the shared picker", async t => {
  const CoreService = require("../models/CoreService"), RepairService = require("../models/RepairService");
  const ServiceCategory = require("../models/ServiceCategory"), Technician = require("../models/Technician");
  const routes = require("../routes/appointmentRoutes");
  function query(records) {
    let fields;
    return {
      select(value) { fields = value.split(/\s+/); return this; },
      sort() { return this; }, populate() { return this; },
      async lean() { return records.map(record => Object.fromEntries(Object.entries(record).filter(([key]) => fields.includes(key)))); },
    };
  }
  t.mock.method(CoreService, "find", () => query([catalog]));
  t.mock.method(RepairService, "find", () => query([]));
  t.mock.method(ServiceCategory, "find", () => query([]));
  t.mock.method(Technician, "find", () => query([{ _id: "tech", name: "Fixture", user: { role: "technician", active: true } }]));
  const handler = routes.stack.find(layer => layer.route?.path === "/walk-in-options").route.stack.at(-1).handle;
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await handler({}, res);
  assert.deepEqual(res.body.coreServices[0].applianceProfiles, catalog.applianceProfiles);
  assert.equal(res.body.coreServices[0].active, true);
  assert.equal(res.body.technicians.length, 1);
});

test("both staff layouts load the address picker for the walk-in customer fields", async () => {
  for (const role of ["admin", "secretary"]) {
    const html = await ejs.renderFile(path.join(__dirname, "../views/layouts", role + ".ejs"), {
      user: { _id: "670000000000000000000001", role, name: "Fixture Staff" },
      body: '<select id="addrProvince"></select><select id="addrCity"></select>', title: "Walk-in booking",
    });
    assert.match(html, /src="\/js\/psgc-handler\.js/);
  }
});
