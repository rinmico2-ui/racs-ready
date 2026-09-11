"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const wizard = fs.readFileSync(
  path.join(__dirname, "../views/partials/cart-wizard.ejs"),
  "utf8",
);
const checkoutCss = fs.readFileSync(
  path.join(__dirname, "../public/css/cart-checkout-ux.css"),
  "utf8",
);
const calendarScript = fs.readFileSync(
  path.join(__dirname, "../public/js/checkout-calendar.js"),
  "utf8",
);

test("cart checkout has one clear hierarchy and accessible choices", () => {
  assert.match(wizard, /cart-checkout-ux\.css\?v=20260912-checkout-flow-v3/);
  assert.match(wizard, /checkout-calendar\.js\?v=20260912-checkout-mobile/);
  assert.match(wizard, /aria-labelledby="wizardModalTitle"/);
  assert.match(wizard, /modal-fullscreen-sm-down/);
  assert.match(wizard, /role="navigation" aria-label="Checkout steps"/);
  assert.ok(
    wizard.indexOf("checkout-wizard-header") < wizard.indexOf('class="wizard-progress"'),
    "the current task title should appear before progress navigation",
  );
  assert.match(wizard, /checkout-section-number">1/);
  assert.match(wizard, /checkout-section-number">2/);
  assert.match(wizard, /type="button" class="payment-method-card[^\"]*"[^>]*aria-pressed="false"/);
});

test("checkout actions explain the next outcome instead of saying generic next", () => {
  assert.match(wizard, /Continue to details/);
  assert.match(wizard, /Continue to payment/);
  assert.match(wizard, /Review order/);
  assert.match(wizard, /Place order/);
  assert.match(wizard, /modalBody\.scrollTo\(\{ top: 0, behavior:/);
  assert.match(wizard, /setAttribute\('aria-pressed', c\.dataset\.method === method/);
});

test("phone checkout is full-screen, compact, and keeps one dominant action", () => {
  assert.match(checkoutCss, /@media \(max-width: 575\.98px\)/);
  assert.match(checkoutCss, /#checkoutOrderModal \.modal-dialog \{ width: 100%; max-width: none; \}/);
  assert.match(checkoutCss, /#checkoutOrderModal #wizardMap \{ height: 225px; \}/);
  assert.match(checkoutCss, /route-stats-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(checkoutCss, /checkout-map-action span \{ display: inline; \}/);
  assert.match(checkoutCss, /checkout-cancel-btn \{ display: none !important; \}/);
  assert.match(checkoutCss, /checkout-primary-btn \{ width: 100%; min-width: 0; min-height: 48px; \}/);
});

test("mobile calendar removes secondary noise while retaining availability", () => {
  assert.match(calendarScript, /\.co-cal-mode \{ display: none; \}/);
  assert.match(calendarScript, /\.co-cal-legend-item:nth-child\(n\+4\) \{ display: none; \}/);
  assert.match(calendarScript, /\.co-time-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(checkoutCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("progress states retain readable label and icon contrast", () => {
  assert.match(checkoutCss, /wizard-ps\.active > span,[\s\S]*?wizard-ps\.active i[\s\S]*?color: #fff !important/);
  assert.match(checkoutCss, /wizard-ps:hover:not\(\.active\):not\(\.completed\) > span/);
  assert.match(checkoutCss, /color: #1e3a8a !important/);
});

test("blocked device location never blocks manual checkout location", () => {
  assert.match(wizard, /id="mapAccessNotice" role="status" aria-live="polite"/);
  assert.match(wizard, /Automatic location requires HTTPS/);
  assert.match(wizard, /Location access is blocked in your browser settings/);
  assert.match(wizard, /function applyDeviceLocation/);
  assert.match(wizard, /if \(leafletMap && leafletMarker\)[\s\S]*?updateMapSelectionDetails\(flat, flon, name, 'Address search result'\)/);
  assert.doesNotMatch(wizard, /Swal\.fire\('Location unavailable'/);
});

test("checkout street map uses a production-safe provider with an automatic fallback", () => {
  assert.match(wizard, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
  assert.doesNotMatch(wizard, /tileLayer\('https:\/\/\{s\}\.tile\.openstreetmap\.org/);
  assert.match(wizard, /_streetMapLayer\.on\('tileerror'/);
  assert.match(wizard, /_satelliteMapLayer\.addTo\(leafletMap\)/);
});

test("completed checkout fields guide customers to the next required action", () => {
  assert.match(wizard, /function focusCheckoutControl/);
  assert.match(wizard, /function scheduleCheckoutAdvance/);
  assert.match(wizard, /function isCompletePhilippinePhone/);
  assert.match(wizard, /focusCheckoutControl\('#wizardAddress', 420\)/);
  assert.match(wizard, /if \(dateStr\) focusCheckoutControl\('#coTimeSection', 240\)/);
  assert.match(wizard, /if \(timeStr\) scheduleCheckoutAdvance\(2, 550\)/);
  assert.match(wizard, /scheduleCheckoutAdvance\(1, 420\)/);
  assert.match(wizard, /scheduleCheckoutAdvance\(3, 450\)/);
  assert.match(wizard, /if \(file && isCompletePhilippinePhone\(senderNumber\)\) scheduleCheckoutAdvance\(3, 650\)/);
});
