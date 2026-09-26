"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const pages = [
  "../views/pages/admin/Inventory/InventoryList.ejs",
  "../views/pages/secretary/Inventory/InventoryList.ejs",
];

function functionSource(source, name) {
  const pattern = new RegExp(`    function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`);
  const match = source.match(pattern);
  assert.ok(match, `${name} is present`);
  return match[0];
}

for (const relativePath of pages) {
  test(`${relativePath} shows the price and stock for each HP in pesos`, () => {
    const file = path.join(__dirname, relativePath);
    const source = fs.readFileSync(file, "utf8");
    ejs.compile(source, { filename: file });
    assert.match(source, /HP Price &amp; Stock/);
    assert.doesNotMatch(source, /bi-currency-dollar/);

    const helpers = ["fmtPrice", "escapeInventoryText", "renderHpPriceStock"]
      .map((name) => functionSource(source, name)).join("\n");
    const adminStub = relativePath.includes("admin/")
      ? "function variantSerialSummary() { return ''; }\n"
      : "";
    const render = vm.runInNewContext(`${adminStub}${helpers}\nrenderHpPriceStock`, {});

    const inStock = render({ capacity: "0.5", sellingPrice: 32500, quantity: 4, minStockLevel: 2 });
    const lowStock = render({ capacity: "0.75", sellingPrice: 35000, quantity: 1, minStockLevel: 2 });
    const outOfStock = render({ capacity: "1.0", sellingPrice: 38999, quantity: 0 });
    assert.match(inStock, /0\.5 HP/);
    assert.match(inStock, /₱32,500\.00/);
    assert.match(inStock, /4 units in stock/);
    assert.match(lowStock, /1 unit · low stock/);
    assert.match(outOfStock, /₱38,999\.00/);
    assert.match(outOfStock, /Out of stock/);
    assert.match(outOfStock, /is-out/);
    assert.doesNotMatch(render({ capacity: "<script>", sellingPrice: 1, quantity: 1 }), /<script>/);
  });
}
