"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ServiceCategory = require("../models/ServiceCategory");
const {
  parseInspectionFee,
  resolveCatalogInspectionFee,
} = require("../utils/repairInspectionPricing");

const categories = [{
  name: "Home Appliances",
  slug: "appliance",
  active: true,
  unitTypes: [
    { value: "Refrigerator", label: "Refrigerator", inspectionFee: 750 },
    { value: "Washing Machine", label: "Washing Machine" },
    { value: "Electric Fan", label: "Electric Fan", inspectionFee: 0 },
  ],
}];

test("repair inspection pricing uses a unit override when configured", () => {
  const result = resolveCatalogInspectionFee(
    { unitCategory: "appliance", unitType: "Refrigerator" },
    categories,
    500,
  );

  assert.equal(result.fee, 750);
  assert.equal(result.source, "unit-override");
});

test("repair inspection pricing falls back to the global default", () => {
  const result = resolveCatalogInspectionFee(
    { unitType: "Washing Machine" },
    categories,
    500,
  );

  assert.equal(result.fee, 500);
  assert.equal(result.source, "default");
  assert.equal(result.categorySlug, "appliance");
});

test("zero is a valid explicit inspection-fee override", () => {
  const result = resolveCatalogInspectionFee(
    { unitCategory: "appliance", unitType: "Electric Fan" },
    categories,
    500,
  );

  assert.equal(result.fee, 0);
  assert.equal(result.source, "unit-override");
});

test("unknown and inactive catalog selections are rejected", () => {
  assert.throws(
    () => resolveCatalogInspectionFee({ unitType: "Television" }, categories, 500),
    /not in the active repair catalog/i,
  );
  assert.throws(
    () => resolveCatalogInspectionFee(
      { unitCategory: "appliance", unitType: "Refrigerator" },
      [{ ...categories[0], active: false }],
      500,
    ),
    /category is unavailable/i,
  );
});

test("custom repair categories accept another appliance at the default fee", () => {
  const result = resolveCatalogInspectionFee(
    { unitCategory: "other", unitType: "Television" },
    [{ name: "Other", slug: "other", active: true, isCustom: true, unitTypes: [] }],
    500,
  );

  assert.equal(result.fee, 500);
  assert.equal(result.categorySlug, "other");
  assert.equal(result.unitType, "Television");
});

test("inspection-fee validation accepts currency values within policy limits", () => {
  assert.equal(parseInspectionFee("625.50"), 625.5);
  assert.equal(parseInspectionFee("", { allowEmpty: true }), null);
  assert.equal(parseInspectionFee("   ", { allowEmpty: true }), null);
  assert.throws(() => parseInspectionFee(-1), /between 0 and 100,000/i);
  assert.throws(() => parseInspectionFee(100001), /between 0 and 100,000/i);
});

test("service-category schema persists optional per-unit inspection fees", async () => {
  const category = new ServiceCategory({
    name: "Test Appliances",
    slug: "test-appliances",
    unitTypes: [{ value: "Television", label: "Television", inspectionFee: 900 }],
  });
  await category.validate();
  assert.equal(category.unitTypes[0].inspectionFee, 900);
});
