"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
const guidance = read("public/js/order-checkout-errors.js");
const cart = read("views/partials/cart-wizard.ejs");
const direct = read("views/partials/aircons.ejs");

const context = { window: {} };
vm.runInNewContext(guidance, context);

test("order API errors take customers to the relevant checkout step and field", () => {
  const cases = [
    ["ORDER_DELIVERY_ADDRESS_REQUIRED", 2, 3, "#wizardAddress"],
    ["ORDER_DELIVERY_DATE_INVALID", 2, 3, "#checkoutCalendarContainer"],
    ["ORDER_GCASH_SENDER_INVALID", 3, 4, "#wizardGcashSenderNumber"],
    ["ORDER_PAYMENT_PROOF_REQUIRED", 3, 4, null],
  ];
  for (const [code, cartStep, directStep, selector] of cases) {
    const cartIssue = context.window.OrderCheckoutErrors.issueFor({ code, error: "Fix this field" }, "cart");
    const directIssue = context.window.OrderCheckoutErrors.issueFor({ code, error: "Fix this field" }, "direct");
    assert.equal(cartIssue.step, cartStep);
    assert.equal(directIssue.step, directStep);
    if (selector) {
      assert.equal(cartIssue.focusSelector, selector);
      assert.equal(directIssue.focusSelector, selector);
    }
  }
  assert.equal(context.window.OrderCheckoutErrors.issueFor({ code: "UNKNOWN" }, "cart"), null);
});

test("both checkouts use server error codes and recheck client-required fields", () => {
  assert.match(cart, /OrderCheckoutErrors\?\.issueFor\(data, 'cart'\)/);
  assert.match(cart, /await showCartOrderFailure\(data, res\.status, loadingStartedAt\)/);
  assert.match(cart, /if \(address\.length < 8\)/);
  assert.match(direct, /OrderCheckoutErrors\?\.issueFor\(data, 'direct'\)/);
  assert.match(direct, /if \(addr\.length < 8\)/);
  assert.match(direct, /contactDigits\.length < 7 \|\| contactDigits\.length > 15/);
  assert.match(cart, /OrderCheckoutErrors\.isFutureDate\(date\)/);
  assert.match(direct, /OrderCheckoutErrors\.isFutureDate\(date\)/);
});

test("the client uses the same future-date rule as the Manila order API", () => {
  const now = new Date('2026-09-25T16:30:00.000Z'); // Sep 26 in Manila
  const isFutureDate = context.window.OrderCheckoutErrors.isFutureDate;
  assert.equal(isFutureDate('2026-09-25', now), false);
  assert.equal(isFutureDate('2026-09-26', now), false);
  assert.equal(isFutureDate('2026-09-27', now), true);
  assert.equal(isFutureDate('2026-02-30', now), false);
});
