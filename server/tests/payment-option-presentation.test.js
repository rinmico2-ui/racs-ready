"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

const servicesView = read("views/pages/services.ejs");
const servicesScript = read("public/js/services-multi.js");
const cartWizard = read("views/partials/cart-wizard.ejs");
const productWizard = read("views/partials/aircons.ejs");
const customerPaymentCss = read("public/css/customer-payment.css");
const bookingRoutes = read("routes/bookingRoutesNew.js");
const orderRoutes = read("routes/orderRoutes.js");
const technicianOrders = read("views/pages/technician/technicianorders.ejs");
const paymentController = read("controllers/paymentController.js");
const paymentPolicySource = read("utils/paymentPolicy.js");
const paymentSettingsView = read("views/pages/admin/Settings/System.ejs");
const adminApi = read("routes/adminApi.js");
const serviceRoutes = read("routes/serviceRoutes.js");

test("service checkout presents payment plans instead of a misleading cash method", () => {
  assert.match(servicesView, /Payment Option/);
  assert.match(servicesView, /Pay in Full Now/);
  assert.match(servicesView, /Reserve with Downpayment/);
  assert.match(servicesView, /data-method="cod" aria-pressed="false"/);
  assert.doesNotMatch(servicesView, /ent-payment-tab active[^>]*data-method="gcash"/);
  assert.match(servicesScript, /paymentOptionBound/);
});

test("service and product checkout use one consistent customer payment layout", () => {
  for (const source of [servicesView, cartWizard, productWizard]) {
    assert.match(source, /customer-payment\.css\?v=20260912-consistent-payment-v1/);
    assert.match(source, /customer-payment-options/);
    assert.match(source, /payment-method-copy/);
    assert.match(source, /customer-payment-panel/);
    assert.match(source, /customer-payment-instructions/);
    assert.match(source, /customer-payment-qr/);
    assert.match(source, /customer-payment-fields/);
    assert.match(source, /customer-payment-summary/);
    assert.match(source, /customer-payment-verification/);
  }
  assert.match(customerPaymentCss, /\.customer-payment-options \.payment-method-card/);
  assert.match(customerPaymentCss, /@media \(max-width: 575\.98px\)/);
});

test("service payment evidence is validated on both client and server", () => {
  assert.match(servicesScript, /isValidPhilippineMobile/);
  assert.match(servicesScript, /paymentProofValidationMessage/);
  assert.match(bookingRoutes, /hasValidImageDataUrl\(proofImageBase64\)/);
  assert.match(bookingRoutes, /\['gcash', 'cod'\]\.includes\(bookingPaymentMethod\)/);
});

test("product checkouts collect the GCash sender independently from delivery contact", () => {
  for (const source of [cartWizard, productWizard]) {
    assert.match(source, /id="wizardGcashSenderNumber"/);
    assert.match(source, /GCash Sender Number/);
    assert.match(source, /Reserve with Downpayment/);
    assert.match(source, /Pay at Store Pickup/);
  }
  assert.match(cartWizard, /fd\.append\('gcashNumber', document\.getElementById\('wizardGcashSenderNumber'\)/);
  assert.match(productWizard, /formData\.append\('gcashNumber', document\.getElementById\('wizardGcashSenderNumber'\)/);
});

test("pickup checkout does not offer the delivery downpayment plan", () => {
  const cartPickup = cartWizard.match(/if \(selectedFulfillment === 'customer_pickup'\) \{[\s\S]*?\n\s*\} else \{/);
  const productPickup = productWizard.match(/if \(selectedFulfillment === 'customer_pickup'\) \{[\s\S]*?\n\s*\} else \{/);
  assert.ok(cartPickup);
  assert.ok(productPickup);
  assert.doesNotMatch(cartPickup[0], /data-method="cod"/);
  assert.doesNotMatch(productPickup[0], /data-method="cod"/);
});

test("final order collection is required before completion", () => {
  const collectPosition = technicianOrders.indexOf("await collectOrderPayment(id)");
  const statusUpdatePosition = technicianOrders.indexOf("fetch('/api/orders/'+id+'/status'", collectPosition);
  assert.ok(collectPosition > -1);
  assert.ok(statusUpdatePosition > collectPosition);
  assert.match(orderRoutes, /\["arrived", "installing", "completed"\]\.includes\(order\.status\)/);
  assert.match(orderRoutes, /value > amountDue/);
});

test("payment detail export reads the booking payment option", () => {
  assert.match(paymentController, /bookingPaymentMethod: booking\?\.paymentMethod \|\| order\?\.paymentMethod/);
  assert.doesNotMatch(paymentController, /paymentPaymentMethod/);
});

test("GCash recipient configuration is admin-managed and shared with customer checkout", () => {
  assert.match(paymentPolicySource, /GCASH_RECIPIENT_SETTING_KEY/);
  assert.match(paymentPolicySource, /process\.env\.ADMIN_GCASH_NUMBER/);
  assert.match(paymentSettingsView, /id="gcashRecipientNumber"/);
  assert.match(paymentSettingsView, /gcashNumber: gcashNumber/);
  assert.match(adminApi, /gcashConfigured: Boolean\(effectiveGcashNumber\)/);
  assert.match(serviceRoutes, /gcashNumber, gcashConfigured: Boolean\(gcashNumber\)/);
});

test("unconfigured GCash is disabled in checkout and enforced on the server", () => {
  assert.match(cartWizard, /checkout-payment-unavailable/);
  assert.match(cartWizard, /button\.disabled = true/);
  assert.match(cartWizard, /window\.refreshCheckoutPaymentOptions/);
  assert.match(orderRoutes, /ORDER_GCASH_NOT_CONFIGURED/);
  assert.match(bookingRoutes, /await getGcashRecipientNumber\(\)/);
});
