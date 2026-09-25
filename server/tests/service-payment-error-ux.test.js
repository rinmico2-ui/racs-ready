"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const script = read("public/js/services-multi.js");
const view = read("views/pages/services.ejs");
const styles = read("public/css/services-mobile-ux.css");
const validation = script.slice(
  script.indexOf("function validateBookingData()"),
  script.indexOf("/**\n * Helper to convert file to base64")
);
const errorHelpers = script.slice(
  script.indexOf("let currentBookingPaymentIssue = null;"),
  script.indexOf("/**\n * Handle booking submission")
);

function validatePayment({ number = "", proof = null, channel = "gcash" } = {}) {
  const fields = {
    cashNumber: { value: number },
    cashProof: { files: proof ? [proof] : [] }
  };
  const context = {
    BookingState: {
      selectedServices: [{ quantity: 1 }],
      customerLocation: { lat: 15.4, lng: 120.9 },
      selectedDate: new Date(2026, 8, 25),
      selectedTimeSlot: { label: "8:00 AM" },
      paymentMethod: "cod",
      paymentChannel: channel
    },
    MAX_BOOKING_UNITS: 40,
    selectedUnitTotal: () => 1,
    isLargeScaleSelection: () => false,
    EnterpriseCalendar: { isProjectMode: () => false },
    isValidPhilippineMobile: value => /^09\d{9}$/.test(value),
    paymentProofValidationMessage: file => !file ? "Upload the payment receipt to continue." : "",
    window: { adminGcashNumber: "09171234567", paymentMethodsConfig: { gcash: { available: true } } },
    document: { getElementById: id => fields[id] || null }
  };
  return vm.runInNewContext(`${validation}\nvalidateBookingData();`, context);
}

test("invalid down-payment sender number identifies the exact input", () => {
  const result = validatePayment({ number: "0917" });
  assert.equal(result.valid, false);
  assert.equal(result.fieldId, "cashNumber");
  assert.match(result.error, /09171234567/);
});

test("after fixing the number, a missing receipt points to the upload field", () => {
  const result = validatePayment({ number: "09171234567" });
  assert.equal(result.valid, false);
  assert.equal(result.fieldId, "cashProof");
  assert.match(result.error, /Upload the payment receipt/);
  assert.equal(validatePayment({ number: "09171234567", proof: { type: "image/png" } }).valid, true);
});

test("payment errors appear before the form and beside their fields", () => {
  assert.ok(view.indexOf('id="paymentError"') < view.indexOf('id="paymentChoiceGuide"'));
  for (const id of ["gcashNumber", "gcashProof", "cashNumber", "cashProof"]) {
    assert.match(view, new RegExp(`id="${id}Error" class="payment-inline-error d-none"`));
  }
  assert.match(script, /function showBookingPaymentError\(issue\)[\s\S]*?payment-field-invalid[\s\S]*?focusBookingPaymentError/);
  assert.match(script, /function focusBookingPaymentError\(\)[\s\S]*?scrollIntoView[\s\S]*?focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /#paymentStep \.payment-field-invalid\s*\{[^}]*border-color:\s*#dc2626/);
});

test("a failed payment focuses and marks the field that needs correction", () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set(["d-none"]);
      const attrs = new Map();
      elements.set(id, {
        textContent: "", firstChild: { textContent: "" }, scrolled: false, focused: false,
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          contains: name => classes.has(name)
        },
        getAttribute: name => attrs.get(name) || null,
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: name => attrs.delete(name),
        scrollIntoView() { this.scrolled = true; },
        focus() { this.focused = true; }
      });
    }
    return elements.get(id);
  };
  const context = {
    document: { getElementById: get, querySelector: () => null },
    window: { setTimeout: callback => callback() },
    BookingState: { paymentChannel: "gcash" }
  };
  vm.runInNewContext(`${errorHelpers}\nshowBookingPaymentError({ error: 'Enter a valid number.', fieldId: 'cashNumber' });`, context);

  assert.equal(get("paymentError").classList.contains("d-none"), false);
  assert.equal(get("paymentErrorMessage").textContent, "Enter a valid number.");
  assert.equal(get("cashNumberError").textContent, "Enter a valid number.");
  assert.equal(get("cashNumber").getAttribute("aria-invalid"), "true");
  assert.equal(get("cashNumber").scrolled, true);
  assert.equal(get("cashNumber").focused, true);
});
