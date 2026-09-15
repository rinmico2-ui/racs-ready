"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findService,
  formatServicePrice,
  mapCoreService,
  mapRepairCategory,
  mapRepairService,
} = require("../utils/chatServiceKnowledge");

test("core chatbot knowledge retains supported aircon types and service inclusions", () => {
  const service = mapCoreService({
    name: "Aircon Cleaning",
    slug: "aircon-cleaning",
    category: "service",
    isAirconService: true,
    applianceTypes: [{ type: "split", name: "Split Type" }],
    airconTypes: [{ type: "cassette", name: "Cassette Type", hpPricing: [{ hp: 2, price: 2400 }] }],
    hpPricing: [{ hp: 1, price: 1200, durationMinutes: 90 }],
    features: ["Chemical coil wash"],
    includedItems: ["Filter re-installation"],
    exclusions: ["Motor replacement"],
    brands: ["Carrier", "Daikin"],
  });

  assert.equal(service.kind, "core");
  assert.deepEqual(service.applianceNames, ["Split Type", "Cassette Type"]);
  assert.deepEqual(service.features, ["Chemical coil wash", "Filter re-installation"]);
  assert.deepEqual(service.exclusions, ["Motor replacement"]);
  assert.equal(service.types[1].hpPricing[0].price, 2400);
});

test("repair chatbot knowledge uses the initial fee and includes appliance diagnostics", () => {
  const service = mapRepairService({
    name: "Refrigerator Repair",
    slug: "refrigerator-repair",
    applianceType: "refrigerator",
    initialPrice: 500,
    basePrice: 1200,
    pricingNote: "Final repair cost follows diagnosis.",
    commonFaults: ["Not cooling", "Leaking"],
    parts: [{ name: "Compressor", price: 4500 }, { name: "Thermostat", price: 850 }],
    estimatedDurationMinutes: 90,
  });

  assert.equal(service.kind, "repair");
  assert.equal(service.applianceName, "Refrigerator");
  assert.ok(service.applianceNames.includes("fridge"));
  assert.deepEqual(service.commonFaults, ["Not cooling", "Leaking"]);
  assert.deepEqual(service.possibleParts, ["Compressor", "Thermostat"]);
  assert.equal(formatServicePrice(service), "₱500 initial inspection/service-call fee");
  assert.equal(findService([service], "Can you fix my fridge?"), service);
});

test("repair services without a configured fee do not invent a price", () => {
  const service = mapRepairService({
    name: "Television Repair",
    applianceType: "television",
  });

  assert.equal(formatServicePrice(service), "Quoted after inspection");
});

test("customer repair categories become searchable appliance knowledge", () => {
  const services = mapRepairCategory({
    name: "Home Appliances",
    slug: "appliance",
    unitTypes: [
      { value: "Washing Machine", label: "Washing Machine", inspectionFee: 750 },
      { value: "Microwave Oven", label: "Microwave" },
      { value: "Electric Kettle", label: "Electric Kettle" },
    ],
  }, 500);

  assert.deepEqual(services.map((service) => service.name), [
    "Washing Machine Repair",
    "Microwave Repair",
    "Electric Kettle Repair",
  ]);
  assert.equal(findService(services, "Do you service washers?"), services[0]);
  assert.equal(findService(services, "My microwave oven needs repair"), services[1]);
  assert.equal(formatServicePrice(services[0]), "₱750 initial inspection/service-call fee");
  assert.equal(formatServicePrice(services[2]), "₱500 initial inspection/service-call fee");
});
