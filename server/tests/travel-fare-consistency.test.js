"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { authoritativeDeliveryQuote } = require("../utils/orderCheckoutPolicy");

const serviceScript = fs.readFileSync(path.join(__dirname, "../public/js/services-multi.js"), "utf8");
const pricingFunctions = ["getServiceFarePerKm", "calculateServiceTravelFare"]
  .map(name => {
    const match = serviceScript.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `${name} must be available`);
    return match[0];
  }).join("\n");

test("service booking and product checkout charge the shown road distance at the configured rate", async () => {
  const booking = vm.runInNewContext(`${pricingFunctions}\ncalculateServiceTravelFare(74.933)`, {
    window: { _farePerKm: 30 },
  });
  const order = await authoritativeDeliveryQuote({
    origin: { lat: 15, lng: 121 },
    destination: { lat: 15.1, lng: 121.2 },
    farePerKm: 30,
    httpClient: { get: async () => ({ data: { routes: [{ distance: 74933, duration: 10800 }] } }) },
  });
  assert.equal(booking, 2247);
  assert.equal(order.distanceKm, 74.9);
  assert.equal(order.transportationFee, booking);
  assert.doesNotMatch(serviceScript, /adjustedDistance\s*\*\s*farePerKm|travel adjustment/);
  assert.match(serviceScript, /distanceInfoElement\.textContent = `\$\{distance\.toFixed\(1\)\} km × ₱\$\{rate\.toLocaleString\(\)\}\/km = ₱\$\{fare\.toLocaleString\(\)\}`/);
});
