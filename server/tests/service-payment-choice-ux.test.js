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
const confirmationFunctions = script.slice(
  script.indexOf("function paymentProofValidationMessage(file)"),
  script.indexOf("let currentBookingPaymentIssue = null;")
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

test("the payment step keeps one guided confirm-booking action visible", () => {
  assert.equal((view.match(/id="confirmBookingBtn"/g) || []).length, 1);
  assert.match(view, /id="paymentConfirmAction"[^>]*hidden inert/);
  assert.match(view, /id="paymentConfirmTitle"/);
  assert.match(script, /function getPaymentConfirmationState\(\)/);
  assert.match(script, /function paymentConfirmationIsReady\(\)/);
  assert.match(script, /return getPaymentConfirmationState\(\)\.ready/);
  assert.match(script, /function syncPaymentConfirmAction\(highlight = false\)/);
  assert.match(script, /action\.parentElement !== document\.body\)[^\n]*document\.body\.appendChild\(action\)/);
  assert.match(script, /field\.addEventListener\(field\.type === 'file' \? 'change' : 'input',[\s\S]*?syncPaymentConfirmAction\(\)/);
  assert.match(styles, /\.payment-confirm-action\.is-visible\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1040/);
  assert.match(styles, /\.payment-confirm-action #confirmBookingBtn\s*\{[^}]*background:\s*#16a34a/);
  assert.match(styles, /\.payment-confirm-action:not\(\.is-ready\)/);
});

test("large-scale projects show the final action before it is ready and unlock it after payment evidence", () => {
  const elements = new Map();
  const make = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, value: "", files: [], hidden: true, disabled: false, textContent: "", dataset: {}, offsetWidth: 10,
        parentElement: null,
        classList: {
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
        },
        setAttribute() {}, toggleAttribute() {},
      });
    }
    return elements.get(id);
  };
  const body = { appendChild(node) { node.parentElement = body; } };
  const action = make("paymentConfirmAction");
  action.parentElement = body;
  const state = {
    currentStep: 6,
    isProject: true,
    projectScheduling: { startDate: "2026-10-01", endDate: "2026-10-08" },
    paymentMethod: null,
    paymentChannel: null,
    draftPersistenceDisabled: false,
  };
  const context = {
    BookingState: state,
    document: { body, getElementById: make },
    window: { paymentMethodsConfig: { bank_transfer: { available: true } } },
    currentBookingReward: () => ({ discount: 0 }), bookingLoyaltyPending: null, bookingLoyaltyError: '',
    bookingRequiresProjectSchedule: () => Boolean(state.isProject),
  };
  vm.runInNewContext(confirmationFunctions, context);

  context.syncPaymentConfirmAction();
  assert.equal(action.hidden, false);
  assert.equal(action.classList.contains("is-visible"), true);
  assert.equal(make("confirmBookingBtn").disabled, true);
  assert.match(make("paymentConfirmTitle").textContent, /Choose Full Payment/);

  state.paymentMethod = "cod";
  state.paymentChannel = "bank_transfer";
  make("cashNumber").value = "PROJECT-REF-100";
  make("cashProof").files = [{ type: "image/png", size: 2000 }];
  context.syncPaymentConfirmAction();

  assert.equal(make("confirmBookingBtn").disabled, false);
  assert.equal(action.classList.contains("is-ready"), true);
  assert.equal(make("paymentConfirmTitle").textContent, "Ready to send your project request");
  context.bookingLoyaltyPending = {};
  context.syncPaymentConfirmAction();
  assert.equal(make("confirmBookingBtn").disabled, true);
  assert.match(make("paymentConfirmTitle").textContent, /Confirm your loyalty price/);
});

test("payment summary uses the reviewed total and per-unit fallback without multiplying line totals twice", () => {
  assert.match(view, /var total=Number\(bs\.totalFee\)/);
  assert.match(view, /s\.unitPrice\?\?s\.price\?\?\(Number\(s\.totalPrice\|\|0\)\/qty\)/);
  assert.match(view, /var travelFee=Number\(bs\.travelFare\?\?bs\.fare\?\?0\)/);
});
