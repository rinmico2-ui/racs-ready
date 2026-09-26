"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = relativePath => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("successful booking submission has an unmistakable green confirmation", () => {
  const services = read("views/pages/services.ejs");

  assert.match(services, /ent-inv-header[\s\S]*?linear-gradient\(135deg,#15803d 0%,#16a34a 55%,#22c55e 100%\)/);
  assert.match(services, /ent-inv-logo"><i class="bi bi-check-circle-fill"><\/i>/);
  assert.match(services, /REQUEST RECEIVED/);
  assert.match(services, /\.ent-inv-btn-primary\{[\s\S]*?linear-gradient\(135deg,#16a34a,#15803d\)/);
  assert.match(services, /We received your booking request\. You do not need to send it again\./);
});

test("cart and direct product orders share a green accessible success state", () => {
  const cart = read("views/partials/cart-wizard.ejs");
  const direct = read("views/partials/aircons.ejs");

  assert.match(cart, /class="order-success-panel text-center" role="status" aria-live="polite"/);
  assert.match(cart, /Order Placed Successfully!/);
  assert.match(cart, /class="btn btn-success[^>]*>.*View My Orders/);
  assert.match(cart, /background: linear-gradient\(145deg, #f0fdf4, #dcfce7\)/);

  assert.match(direct, /class="product-order-success-panel text-center" role="status" aria-live="polite"/);
  assert.match(direct, /Order Placed Successfully!/);
  assert.match(direct, /class="btn btn-order-success[^>]*>.*View My Orders/);
  assert.match(direct, /background: linear-gradient\(145deg, #f0fdf4, #dcfce7\)/);
});
