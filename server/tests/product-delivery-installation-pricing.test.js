"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("online product checkout shows free installation and a separate delivery fare", () => {
  const checkout = read("views/partials/aircons.ejs");
  const cartCheckout = read("views/partials/cart-wizard.ejs");
  const orders = read("routes/orderRoutes.js");

  assert.match(checkout, /Free installation\. Delivery fee is based on your location\./);
  assert.match(checkout, /selectedFulfillment === 'delivery_installation'[\s\S]*?reviewInstallFee'\)\.textContent = 'Free'/);
  assert.match(checkout, /reviewTransportFee'\)\.textContent = '₱' \+ _transportFee\.toLocaleString\(\)/);
  assert.doesNotMatch(checkout, /window\.airconInstallFee|Installation Fee <small/);
  assert.match(cartCheckout, /reviewInstallFee'\)\.textContent = 'Free'/);
  assert.match(cartCheckout, /Delivery fee/);
  assert.doesNotMatch(cartCheckout, /Transportation Fee/);
  assert.doesNotMatch(cartCheckout, /window\.airconInstallFee|Installation Fee <small/);
  assert.match(orders, /transportationFee: deliveryQuote\.transportationFee/);
  assert.match(orders, /installationFee: 0, \/\/ Installation is included/);
  assert.match(orders, /const calculatedOrderTotal = enrichedItems\.reduce\([\s\S]*?\+ orderData\.transportationFee/);
});

test("product checkout steps and buttons use plain language", () => {
  const cartCheckout = read("views/partials/cart-wizard.ejs");
  const directCheckout = read("views/partials/aircons.ejs");

  for (const checkout of [cartCheckout, directCheckout]) {
    assert.match(checkout, /How will you get your order\?/);
    assert.match(checkout, /How will you pay\?/);
    assert.match(checkout, /Pay part now/);
    assert.match(checkout, /Pay all now/);
    assert.match(checkout, /Place my order/i);
    assert.match(checkout, /Installation[^\n]*Free|Free installation/);
  }
  assert.match(cartCheckout, /Add address or pickup date/);
  assert.match(cartCheckout, /class="map-coordinate-card" hidden/);
  assert.match(directCheckout, /nextLabels\[currentStep\]/);
});

test("walk-in product orders use the same free-installation policy", () => {
  const walkIn = read("views/partials/walkin-aircon-order.ejs");
  const pos = read("routes/posRoutes.js");

  assert.match(walkIn, /id="waInstallFee">Free<\/strong>/);
  assert.match(walkIn, /id="waTransportFee"/);
  assert.match(pos, /installationFee: 0,[\s\S]*?additionalTotal: quote\.transportationFee/);
  assert.match(pos, /transportationFee = quote\.transportationFee;[\s\S]*?installationFee = 0;/);
});
