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
const functions = script.slice(
  script.indexOf("function syncPaymentChoiceGuide()"),
  script.indexOf("function selectBookingPaymentChannel(channel")
);

function setupGuide() {
  const elements = new Map();
  const make = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: "", disabled: false, dataset: {},
        classList: {
          add: name => classes.add(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          contains: name => classes.has(name)
        },
        scrollIntoView() {}, focus() {}
      });
    }
    return elements.get(id);
  };
  const channelButton = make("gcashChannel");
  const state = { paymentMethod: null, paymentChannel: null };
  const context = {
    BookingState: state,
    document: {
      getElementById: make,
      querySelector: selector => {
        if (selector === '.customer-payment-options') return make("paymentOptions");
        if (selector.includes('.payment-channel-card')) return channelButton;
        return null;
      }
    },
    window: { paymentMethodsConfig: { gcash: { available: true } } }
  };
  vm.runInNewContext(functions, context);
  return { context, state, get: make, channelButton };
}

test("payment guide requires the amount choice, then the actual payment channel", () => {
  const { context, state, get } = setupGuide();
  context.syncPaymentChoiceGuide();
  assert.equal(get("paymentChoiceGuide").dataset.stage, "1");
  assert.equal(get("confirmBookingBtn").disabled, true);
  assert.equal(get("gcashFields").classList.contains("d-none"), true);

  state.paymentMethod = "cod";
  context.syncPaymentChoiceGuide();
  assert.equal(get("paymentChoiceGuide").dataset.stage, "2");
  assert.equal(get("downpaymentReason").classList.contains("d-none"), false);
  assert.equal(get("bookingPaymentChannelSection").classList.contains("is-needed"), true);
  assert.equal(get("confirmBookingBtn").disabled, true);

  state.paymentChannel = "gcash";
  context.syncPaymentChoiceGuide();
  assert.equal(get("paymentChoiceGuide").dataset.stage, "3");
  assert.equal(get("confirmBookingBtn").disabled, false);
});

test("an unavailable payment channel does not unlock confirmation", () => {
  const { context, state, get, channelButton } = setupGuide();
  state.paymentMethod = "gcash";
  state.paymentChannel = "gcash";
  channelButton.disabled = true;
  context.syncPaymentChoiceGuide();

  assert.equal(get("paymentChoiceGuide").dataset.stage, "2");
  assert.equal(get("confirmBookingBtn").disabled, true);
  assert.equal(get("gcashFields").classList.contains("d-none"), true);
});

test("payment screen shows explicit guidance and map next action is centered", () => {
  assert.match(view, /id="paymentChoiceGuide"[\s\S]*?Choose Full Payment or Down Payment below/);
  assert.match(view, /id="bookingPaymentChannelSection"[\s\S]*?Where will you send the payment/);
  assert.match(view, /id="downpaymentReason"/);
  assert.doesNotMatch(view, /preferredChannel=\['gcash','maya','bank_transfer','other'\]\.find/);
  assert.match(styles, /\.location-next-action\.is-visible\s*\{[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\)/);
  assert.match(styles, /@media \(max-width: 767\.98px\)[\s\S]*?\.location-next-action\.is-visible\s*\{[^}]*transform:\s*none/);
});

test("completed payment fields reveal one fixed confirm-booking action", () => {
  assert.equal((view.match(/id="confirmBookingBtn"/g) || []).length, 1);
  assert.match(view, /id="paymentConfirmAction"[^>]*hidden inert/);
  assert.match(script, /function paymentConfirmationIsReady\(\)/);
  assert.match(script, /validReference && !paymentProofValidationMessage\(receipt\)/);
  assert.match(script, /function syncPaymentConfirmAction\(highlight = false\)/);
  assert.match(script, /action\.parentElement !== document\.body\)[^\n]*document\.body\.appendChild\(action\)/);
  assert.match(script, /field\.addEventListener\(field\.type === 'file' \? 'change' : 'input',[\s\S]*?syncPaymentConfirmAction\(\)/);
  assert.match(styles, /\.payment-confirm-action\.is-visible\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1040/);
  assert.match(styles, /\.payment-confirm-action #confirmBookingBtn\s*\{[^}]*background:\s*#16a34a/);
});

test("payment summary uses the reviewed total and per-unit fallback without multiplying line totals twice", () => {
  assert.match(view, /var total=Number\(bs\.totalFee\)/);
  assert.match(view, /s\.unitPrice\?\?s\.price\?\?\(Number\(s\.totalPrice\|\|0\)\/qty\)/);
  assert.match(view, /var travelFee=Number\(bs\.travelFare\?\?bs\.fare\?\?0\)/);
});
