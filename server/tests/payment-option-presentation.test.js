"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require('node:vm');

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

const servicesView = read("views/pages/services.ejs");
const servicesScript = read("public/js/services-multi.js");
const cartWizard = read("views/partials/cart-wizard.ejs");
const productWizard = read("views/partials/aircons.ejs");
const customerPaymentCss = read("public/css/customer-payment.css");
const bookingRoutes = read("routes/bookingRoutesNew.js");
const orderRoutes = read("routes/orderRoutes.js");
const orderModel = read("models/Order.js");
const posRoutes = read("routes/posRoutes.js");
const technicianOrders = read("views/pages/technician/technicianorders.ejs");
const paymentController = read("controllers/paymentController.js");
const paymentPolicySource = read("utils/paymentPolicy.js");
const paymentSettingsView = read("views/pages/admin/Settings/System.ejs");
const adminApi = read("routes/adminApi.js");
const paymongoRoutes = read("routes/paymongoRoutes.js");
const serviceRoutes = read("routes/serviceRoutes.js");
const appEntry = read("index.js");

test("service checkout presents payment plans instead of a misleading cash method", () => {
  assert.match(servicesView, /1\. Choose how much to pay now/);
  assert.match(servicesView, /<strong>Full Payment<\/strong>/);
  assert.match(servicesView, /<strong>Down Payment<\/strong>/);
  assert.match(servicesView, /data-method="cod" aria-pressed="false"/);
  assert.doesNotMatch(servicesView, /ent-payment-tab active[^>]*data-method="gcash"/);
  assert.match(servicesScript, /paymentOptionBound/);
});

test("service and product checkout use one consistent customer payment layout", () => {
  for (const source of [servicesView, cartWizard, productWizard]) {
    assert.match(source, /customer-payment\.css\?v=[A-Za-z0-9_-]+/);
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
  assert.match(bookingRoutes, /\['gcash', 'cod', 'cash_after_service'\]\.includes\(bookingPaymentMethod\)/);
});

test("service and installation-order checkout separate payment plans from payment channels", () => {
  for (const source of [servicesView, cartWizard, productWizard]) {
    assert.match(source, source === servicesView ? /<strong>Full Payment<\/strong>/ : /<strong>Pay all now<\/strong>/);
    assert.match(source, source === servicesView ? /<strong>Down Payment<\/strong>/ : /<strong>Pay part now<\/strong>/);
    assert.doesNotMatch(source, /data-channel="card"/);
    assert.match(source, /data-channel="gcash"/);
    assert.match(source, /data-channel="maya"/);
    assert.match(source, /data-channel="bank_transfer"/);
    assert.match(source, /data-channel="other"/);
    assert.match(source, source === servicesView ? /Why do I need a down payment\?/ : /Why pay part now\?/);
    assert.match(source, source === servicesView ? /not an extra fee/ : /not an extra fee/);
    assert.doesNotMatch(source, /data-method="card"/);
    assert.doesNotMatch(source, /Pay by card in person|Pay by credit or debit card at the RACS store/);
  }
  assert.match(servicesScript, /paymentChannel: BookingState\.paymentChannel/);
  assert.match(bookingRoutes, /paymentChannel: normalizedPaymentChannel/);
  assert.match(orderRoutes, /paymentChannel: normalizedPaymentChannel/);
  assert.match(paymongoRoutes, /status\(410\)/);
  assert.match(paymongoRoutes, /Card payments are collected in person/);
});

test("product checkouts collect a channel-specific reference independently from delivery contact", () => {
  for (const source of [cartWizard, productWizard]) {
    assert.match(source, /id="wizardGcashSenderNumber"/);
    assert.match(source, /GCash Sender Number/);
    assert.match(source, /Payment Reference/);
    assert.match(source, /Pay at Store Pickup/);
  }
  assert.match(cartWizard, /fd\.append\('paymentChannel', paymentChannel\)/);
  assert.match(cartWizard, /fd\.append\('paymentReference', paymentReference\)/);
  assert.match(productWizard, /formData\.append\('paymentChannel', paymentChannel\)/);
  assert.match(productWizard, /formData\.append\('paymentReference'/);
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
  assert.match(orderRoutes, /money\(value\) !== amountDue/);
  assert.match(orderRoutes, /code: "ORDER_FINAL_AMOUNT_MISMATCH"/);
  assert.match(orderRoutes, /code: "ORDER_BALANCE_REQUIRED"/);
});

test("payment detail export reads the booking payment option", () => {
  assert.match(paymentController, /bookingPaymentMethod: booking\?\.paymentMethod \|\| order\?\.paymentMethod/);
  assert.doesNotMatch(paymentController, /paymentPaymentMethod/);
});

test("GCash recipient configuration is admin-managed and shared with customer checkout", () => {
  assert.match(paymentPolicySource, /GCASH_RECIPIENT_SETTING_KEY/);
  assert.match(paymentPolicySource, /process\.env\.ADMIN_GCASH_NUMBER/);
  assert.match(paymentSettingsView, /id="gcashRecipientNumber"/);
  assert.match(paymentSettingsView, /methods: readMethods\(\)/);
  assert.match(adminApi, /gcashConfigured: Boolean\(effectiveGcashNumber\)/);
  assert.match(serviceRoutes, /gcashNumber,/);
  assert.match(serviceRoutes, /gcashConfigured: Boolean\(gcashNumber\)/);
  assert.match(paymentPolicySource, /PAYMENT_METHODS_SETTING_KEY/);
  assert.match(paymentSettingsView, /id="paymentCardEnabled"/);
});

test("unconfigured GCash disables only that channel while other methods remain available", () => {
  assert.match(cartWizard, /method\.available !== true/);
  assert.match(cartWizard, /data-channel="maya"/);
  assert.doesNotMatch(cartWizard, /data-channel="card"/);
  assert.match(cartWizard, /window\.refreshCheckoutPaymentOptions/);
  assert.match(orderRoutes, /ORDER_GCASH_NOT_CONFIGURED/);
  assert.match(bookingRoutes, /configuredPaymentMethods\[normalizedPaymentChannel\]\?\.available/);
});

test("customer full-payment and downpayment checkout do not offer card", () => {
  for (const source of [servicesView, cartWizard, productWizard]) {
    assert.doesNotMatch(source, /cardNumber|cvv|cvc|expiryMonth|expiryYear/i);
    assert.doesNotMatch(source, /data-channel="card"/);
  }
  assert.doesNotMatch(orderRoutes, /createCardCheckout|checkoutUrl/);
  assert.doesNotMatch(bookingRoutes, /createCardCheckout|checkoutUrl/);
  assert.match(orderRoutes, /MANUAL_PAYMENT_CHANNELS\.includes\(normalizedPaymentChannel\)/);
  assert.match(bookingRoutes, /MANUAL_PAYMENT_CHANNELS\.includes\(normalizedPaymentChannel\)/);
});

test("aircon order totals include products and transportation but exclude installation", async () => {
  let save;
  const begin = orderModel.indexOf('orderSchema.pre("save",');
  const end = orderModel.indexOf('//', orderModel.indexOf('\n});', begin) + 5);
  vm.runInNewContext(orderModel.slice(begin, end), { orderSchema:{ pre(_event, hook) { save = hook; } } });
  for (const discount of [0, 100, 2000]) {
    const order = { orderReference:'TEST-EXISTING',status:'pending_payment',statusHistory:[],
      items:[{totalPrice:1000.25},{totalPrice:500.50}], discount, transportationFee:250.25, installationFee:9999 };
    await save.call(order);
    assert.equal(order.subtotal, 1500.75);
    assert.equal(order.total, Math.max(0, 1500.75 - discount) + 250.25);
  }
  assert.match(orderRoutes, /const calculatedOrderTotal = enrichedItems\.reduce\([\s\S]*?\+ orderData\.transportationFee/);
  assert.doesNotMatch(orderRoutes, /const calculatedOrderTotal =[\s\S]{0,180}?orderData\.installationFee/);
  assert.match(orderRoutes, /function withPayableOrderPricing\(order\)/);
  assert.match(orderRoutes, /orders = result\[0\]\.map\(\(order\) => withOrderPresentation\(order\)\)/);
  assert.match(orderRoutes, /res\.json\(\{ order: withOrderPresentation\(order\) \}\)/);
  assert.match(posRoutes, /const total = subtotal - discount \+ transportationFee;/);
  const cartExpression = cartWizard.match(/const grandTotal = ([^;]+);/)[1];
  const directExpression = productWizard.match(/let total = (Math\.round\(\(subtotal - directRewardDiscount\(\)[^;]+);/)[1];
  for (const selectedFulfillment of ['customer_pickup','delivery_installation']) {
    const context = { itemTotal:1500.75,subtotal:1500.75,selectedFulfillment,_transportFee:250.25,
      orderRewardDiscount:()=>100,directRewardDiscount:()=>100 };
    const expected = selectedFulfillment === 'customer_pickup' ? 1400.75 : 1651;
    assert.equal(vm.runInNewContext(cartExpression, context), expected);
    assert.equal(vm.runInNewContext(directExpression, context), expected);
  }
});
