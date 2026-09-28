"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const script = read("public/js/services-multi.js");
const styles = read("public/css/services-mobile-ux.css");
const view = read("views/pages/services.ejs");

test("HP counters start at zero and explain the zero-removes behavior", () => {
  assert.ok((script.match(/class="hp-quantity-input" value="0" min="0"/g) || []).length >= 1);
  assert.match(script, /class="form-control text-center hp-quantity-input fw-bold"[\s\S]*?value="0" min="0"/);
  assert.ok((script.match(/Counters start at 0\./g) || []).length >= 2);
  assert.match(styles, /\.cfg-hp-quantity-hint/);
});

test("HP plus selects from zero and minus at one removes the selection", () => {
  assert.ok((script.match(/if \(!checkbox\.checked\) \{/g) || []).length >= 2);
  assert.ok((script.match(/checkbox\.checked = true;[\s\S]*?checkbox\.dispatchEvent\(new Event\('change'/g) || []).length >= 2);
  assert.ok((script.match(/else if \(currentValue === 1\) \{[\s\S]*?checkbox\.checked = false;[\s\S]*?checkbox\.dispatchEvent\(new Event\('change'/g) || []).length >= 2);
  assert.ok((script.match(/quantityInput\.value = 0;/g) || []).length >= 2);
  assert.doesNotMatch(script, /setupHpCardQuantityOverrides\(modalElement\);/);
});

test("HP quantity assets are cache-busted", () => {
  assert.match(view, /services-multi\.js\?v=20260928-session-resilience-v7/);
  assert.match(view, /services-mobile-ux\.css\?v=20260928-mobile-booking-v48/);
});
