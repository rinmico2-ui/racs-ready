"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  customerRepairDetails,
  enrichCustomerBooking,
  isRepairBooking,
} = require("../utils/customerBookingPresentation");

test("normalizes legacy repair details stored outside unitInfo", () => {
  const booking = {
    serviceType: "repair",
    status: "repair_requested",
    brand: "Carrier",
    applianceTypeName: "Split Type Aircon",
    issueDescription: "The unit is leaking and no longer cooling.",
    quantity: 2,
  };

  const details = customerRepairDetails(booking);
  assert.equal(details.applianceCount, 1);
  assert.equal(details.unitCount, 2);
  assert.deepEqual(details.primary, {
    _id: null,
    name: "Split Type Aircon Repair",
    unitType: "Split Type Aircon",
    brand: "Carrier",
    model: "",
    problemDescription: "The unit is leaking and no longer cooling.",
    quantity: 2,
    status: "repair_requested",
    phase: "",
    schedule: null,
    photos: [],
    quotation: null,
  });
});

test("returns every repair appliance with its own details", () => {
  const booking = {
    serviceType: "repair",
    unitInfo: { unitType: "Split Type", brand: "Daikin", model: "FTKC", problemDescription: "Primary issue", photos: ["/one.jpg"] },
    services: [
      { _id: "a", type: "repair", name: "Split Repair", applianceTypeName: "Split Type", brand: "Daikin", model: "FTKC", problemDescription: "Not cooling", quantity: 2, photos: ["/two.jpg"] },
      { _id: "b", type: "repair", name: "Window Repair", applianceTypeName: "Window Type", brand: "LG", repairIssue: "Makes a loud noise", quantity: 1 },
    ],
  };

  const details = customerRepairDetails(booking);
  assert.equal(details.applianceCount, 2);
  assert.equal(details.unitCount, 3);
  assert.equal(details.items[0].problemDescription, "Not cooling");
  assert.deepEqual(details.items[0].photos, ["/two.jpg", "/one.jpg"]);
  assert.equal(details.items[1].unitType, "Window Type");
  assert.equal(details.items[1].brand, "LG");
  assert.equal(details.items[1].problemDescription, "Makes a loud noise");
});

test("does not add repair presentation data to a core-service booking", () => {
  const booking = { _id: "core", serviceType: "core", services: [{ type: "core", name: "Cleaning" }] };
  assert.equal(isRepairBooking(booking), false);
  assert.equal(enrichCustomerBooking(booking).customerRepairDetails, undefined);
});

test("customer My Schedule renders normalized repair fields and all appliances", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/js/book-history.js"), "utf8");
  assert.match(script, /customerRepairDetails\?\.items\?\.length/);
  assert.match(script, /Repair Service Details/);
  assert.match(script, /Reported Problem/);
  assert.match(script, /repairDetails\.items\.map/);
  assert.match(script, /repairSummary\.applianceCount/);
});
