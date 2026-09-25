"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  customerRepairDetails,
  enrichCustomerBooking,
  isRepairBooking,
  presentCustomerBooking,
} = require("../utils/customerBookingPresentation");
const { isBookingPast } = require("../utils/bookingPolicy");

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

test("customer booking payload removes payment proof and internal operational history", () => {
  const presented = presentCustomerBooking({
    _id: "booking",
    serviceType: "core",
    paymentProof: "data:image/png;base64,secret",
    paymentReference: "private-reference",
    technicianAssistant: { suggestedTools: ["meter"] },
    statusHistory: [{ status: "pending", changedBy: "staff-id" }],
    services: [{ type: "core", name: "Cleaning", statusHistory: [{ changedBy: "staff-id" }] }],
  });

  assert.equal(presented.paymentProof, undefined);
  assert.equal(presented.paymentReference, undefined);
  assert.equal(presented.technicianAssistant, undefined);
  assert.equal(presented.statusHistory, undefined);
  assert.equal(presented.services[0].statusHistory, undefined);
  assert.equal(presented.services[0].name, "Cleaning");
});

test("customer history receives the Manila service-window end for 24-hour afternoon slots", () => {
  const bookingDate = new Date("2026-09-24T16:00:00.000Z"); // Sep 25 in Manila
  const onePm = presentCustomerBooking({ bookingDate, startTime: "13:00", serviceDurationMinutes: 90, status: "pending" });
  const twoThirtyPm = presentCustomerBooking({ bookingDate, startTime: "14:30", serviceDurationMinutes: 90, status: "pending" });
  assert.equal(onePm.scheduleWindowEndAt, "2026-09-25T06:30:00.000Z"); // 2:30 PM Manila
  assert.equal(twoThirtyPm.scheduleWindowEndAt, "2026-09-25T08:00:00.000Z"); // 4:00 PM Manila
  const atOneTwentyTwoPm = new Date("2026-09-25T05:22:00.000Z");
  assert.equal(isBookingPast(onePm, atOneTwentyTwoPm), false);
  assert.equal(isBookingPast(twoThirtyPm, atOneTwentyTwoPm), false);
  assert.equal(isBookingPast(twoThirtyPm, new Date("2026-09-25T08:01:00.000Z")), true);
});

test("history badge uses the server end time and does not claim rescheduling has started", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/js/book-history.js"), "utf8");
  assert.match(script, /new Date\(b\.scheduleWindowEndAt\)/);
  assert.match(script, /!needsConfirmation && isBookingPast\(b\)/);
  assert.match(script, /Requested service time has passed/);
  assert.doesNotMatch(script, /Missed Schedule . being rescheduled/);
});

test("customer My Schedule renders normalized repair fields and all appliances", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/js/book-history.js"), "utf8");
  assert.match(script, /customerRepairDetails\?\.items\?\.length/);
  assert.match(script, /Repair Service Details/);
  assert.match(script, /Reported Problem/);
  assert.match(script, /repairDetails\.items\.map/);
  assert.match(script, /repairSummary\.applianceCount/);
});
