"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const cart = fs.readFileSync(path.join(__dirname, "../views/partials/cart-wizard.ejs"), "utf8");
const direct = fs.readFileSync(path.join(__dirname, "../views/partials/aircons.ejs"), "utf8");

function paymentFixture() {
  const elements = new Map(), events = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: "", files: [], style: {}, classList: {
        add: cls => classes.add(cls), remove: cls => classes.delete(cls), contains: cls => classes.has(cls),
        toggle: (cls, enabled) => enabled ? classes.add(cls) : classes.delete(cls),
      }, removeAttribute(key) { delete this[key]; } });
    }
    return elements.get(id);
  }
  element("wizardPaymentChannel").value = "gcash";
  element("wizardGcashSenderNumber").value = "09171234567";
  const context = {
    window: { adminGcashNumber: "09171234567", GcashSenderInput: { check: () => ({ valid: true }) } },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener: (type, callback) => events.set(type, callback) },
    currentStep: 3, _autoAdvanceTimer: null, _guidedFocusTimer: null,
    selectedFulfillment: "delivery_installation", SUB_TOTAL: 1000, _transportFee: 20,
    clearTimeout() {}, scheduleCartCheckoutDraftSave() {}, updateNextButtonState() {},
    orderPaymentChannelLabel: () => "GCash", focusCheckoutControl() {}, validateReceiptFile: () => true,
    updateCartGcashSenderFeedback: () => ({ valid: true }),
    scheduleCheckoutAdvance() { throw new Error("Payment must not automatically advance"); },
    FileReader: class { readAsDataURL() { this.onload({ target: { result: "data:image/png;base64,preview" } }); } },
  };
  vm.runInNewContext(cart.slice(cart.indexOf("    window.selectPaymentMethods ="), cart.indexOf("    document.getElementById('wizardGcashSenderNumber')?.addEventListener('blur'")), context);
  return { context, element, events };
}

test("choosing full, partial or pickup payment keeps the customer on the payment step", () => {
  for (const method of ["gcash_full", "cod", "cash_onsite"]) {
    const f = paymentFixture();
    f.context.window.selectPaymentMethods(method);
    assert.equal(f.element("wizardPaymentMethod").value, method);
    assert.equal(f.context.currentStep, 3);
  }
});

test("uploading a valid receipt previews it without progressing to review", () => {
  const f = paymentFixture();
  const input = f.element("gcashProofWizard"); input.files = [{ type: "image/png", size: 1000 }];
  f.events.get("change")({ target: { id: "gcashProofWizard", files: input.files } });
  assert.equal(f.element("gcashProofPreviewWizard").src, "data:image/png;base64,preview");
  assert.equal(f.context.currentStep, 3);
});

test("entering a valid sender number with an existing receipt never advances", () => {
  const f = paymentFixture();
  f.element("gcashProofWizard").files = [{ type: "image/png", size: 1000 }];
  f.events.get("input")({ target: { id: "wizardGcashSenderNumber" } });
  assert.equal(f.context.currentStep, 3);
});

test("payment auto-advance is guarded even if a future caller schedules it", () => {
  let timers = 0;
  const context = { clearTimeout() {}, setTimeout() { timers++; }, _autoAdvanceTimer: null };
  vm.runInNewContext(cart.slice(cart.indexOf("    function scheduleCheckoutAdvance("), cart.indexOf("    function isCompletePhilippinePhone(")), context);
  context.scheduleCheckoutAdvance(3, 500);
  assert.equal(timers, 0);
});

test("the main Next action validates payment before advancing and does not submit from payment", async () => {
  const context = { window: {}, currentStep: 3, validateCheckoutStep: async () => true,
    enterWizardStep(step) { context.currentStep = step; }, submitCartOrder() { throw new Error("Payment Next must not place the order"); } };
  vm.runInNewContext(cart.slice(cart.indexOf("    window.wizardNext ="), cart.indexOf("    window.wizardBack =")), context);
  await context.window.wizardNext();
  assert.equal(context.currentStep, 4);
  context.currentStep = 3;
  context.validateCheckoutStep = async () => false;
  await context.window.wizardNext();
  assert.equal(context.currentStep, 3);
});

test("direct-product payment selection remains separate from step navigation", () => {
  const select = direct.slice(direct.indexOf("      window.selectPaymentMethods ="), direct.indexOf("      // GCash proof preview"));
  assert.doesNotMatch(select, /wizardNext|currentStep\s*(?:=|\+\+|\+=)/);
});
