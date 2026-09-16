const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const HVACProduct = require("../models/HVACProduct");

const {
  normalizeProductVariantSerialNumbers,
  normalizeSerialNumbers,
  normalizeVariantSerialNumbers,
} = require("../utils/hvacSerialNumbers");

const read = (relativePath) => fs.readFileSync(
  path.join(__dirname, "..", relativePath),
  "utf8",
);

test("normalizes an aircon variant serial registry", () => {
  assert.deepEqual(
    normalizeSerialNumbers(" aux-001\naux/002, AUX_003 "),
    ["AUX-001", "AUX/002", "AUX_003"],
  );
  assert.deepEqual(
    normalizeVariantSerialNumbers({ quantity: 2, serialNumbers: ["sn-a", "sn-b"] }),
    { quantity: 2, serialNumbers: ["SN-A", "SN-B"] },
  );
});

test("rejects invalid, repeated, and cross-variant serial numbers", () => {
  assert.throws(() => normalizeSerialNumbers(["SN 001"]), /Invalid serial number/);
  assert.throws(() => normalizeSerialNumbers(["SN-1", "sn-1"]), /must be unique/);
  assert.throws(
    () => normalizeProductVariantSerialNumbers([
      { quantity: 1, serialNumbers: ["SN-1"] },
      { quantity: 1, serialNumbers: ["sn-1"] },
    ]),
    /more than one aircon variant/,
  );
  assert.throws(
    () => normalizeVariantSerialNumbers({ quantity: 1.5, serialNumbers: [] }),
    /whole number/,
  );
});

test("HVAC model preserves the serial uniqueness invariant", async () => {
  const product = new HVACProduct({
    modelLine: "Serial validation test",
    brand: new mongoose.Types.ObjectId(),
    category: new mongoose.Types.ObjectId(),
    variants: [
      { capacity: "1.0", sellingPrice: 1000, quantity: 1, serialNumbers: ["SN-SAME"] },
      { capacity: "1.5", sellingPrice: 1500, quantity: 1, serialNumbers: ["sn-same"] },
    ],
  });
  await assert.rejects(product.validate(), /more than one HP variant/);
});

test("empty serial registries stay outside the sparse unique index", () => {
  const product = new HVACProduct({
    modelLine: "No serial registry test",
    brand: new mongoose.Types.ObjectId(),
    category: new mongoose.Types.ObjectId(),
    variants: [
      { capacity: "1.0", sellingPrice: 1000, quantity: 0, serialNumbers: [] },
    ],
  });
  const variant = product.variants[0].toObject();
  assert.equal(Object.hasOwn(variant, "serialNumbers"), false);
});

test("admin inventory saves, displays, and searches aircon serial numbers", () => {
  const model = read("models/HVACProduct.js");
  const api = read("routes/hvacApi.js");
  const page = read("views/pages/admin/Inventory/InventoryList.ejs");

  assert.match(model, /serialNumbers:[\s\S]*type: \[String\]/);
  assert.match(model, /"variants\.serialNumbers": 1/);
  assert.match(api, /assertSerialNumbersAvailable/);
  assert.match(api, /duplicateInventoryError/);
  assert.match(api, /\.\.\.existingData,[\s\S]*?\.\.\.variantData/);
  assert.match(api, /"variants\.serialNumbers": searchPattern/);
  assert.match(api, /serialNumbers: variantData\.serialNumbers/);
  assert.match(page, /data-field="serialNumbers"/);
  assert.match(page, /function parseInventorySerialNumbers/);
  assert.match(page, /function variantSerialSummary/);
  assert.match(page, /serialMatch/);
});
