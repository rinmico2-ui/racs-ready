"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const cartWizardPath = path.join(root, "views/partials/cart-wizard.ejs");
const directWizardPath = path.join(root, "views/partials/aircons.ejs");
const cartWizard = read("views/partials/cart-wizard.ejs");
const directWizard = read("views/partials/aircons.ejs");
const servicesScript = read("public/js/services-multi.js");
const servicesView = read("views/pages/services.ejs");

function assertInlineScriptsCompile(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
}

test("cart and direct-product checkout save short-lived drafts", () => {
  assert.match(cartWizard, /racs_cart_checkout_draft_v1/);
  assert.match(cartWizard, /30 \* 60 \* 1000/);
  assert.match(cartWizard, /cartSignature: cartCheckoutSignature\(\)/);
  assert.match(directWizard, /racs_direct_order_draft_v1/);
  assert.match(directWizard, /30 \* 60 \* 1000/);
  assert.match(directWizard, /variantId: directCheckoutVariantId/);
});

test("checkout drafts cover mobile payment-app lifecycle and reopen on return", () => {
  for (const source of [cartWizard, directWizard]) {
    assert.match(source, /addEventListener\('pagehide'/);
    assert.match(source, /document\.visibilityState === 'hidden'/);
    assert.match(source, /addEventListener\('pageshow'/);
    assert.match(source, /Checkout restored\./);
    assert.match(source, /select the receipt image again/);
  }
  assert.match(cartWizard, /window\.openCheckoutWizard\(\)/);
  assert.match(directWizard, /window\.openProductWizard\(Number\(draft\.groupIdx\)\)/);
});

test("restored manual payments return to the receipt step without persisting evidence", () => {
  assert.match(cartWizard, /if \(needsReceipt && targetStep > 3\) targetStep = 3/);
  assert.match(directWizard, /if \(needsReceipt && targetStep > 4\) targetStep = 4/);
  assert.match(cartWizard, /Payment references and receipt files are intentionally excluded/);
  assert.match(directWizard, /Never persist payment references or uploaded receipt contents/);
  assert.doesNotMatch(cartWizard, /receiptBase64:/);
  assert.doesNotMatch(directWizard, /receiptBase64:/);
});

test("service booking restores its payment choice after returning from a payment app", () => {
  assert.match(servicesScript, /paymentChannel: \['card', 'gcash', 'maya', 'bank_transfer', 'other'\]/);
  assert.match(servicesScript, /window\.addEventListener\('pageshow', event =>/);
  assert.match(servicesScript, /bookingPaymentRestoreNotice/);
  assert.match(servicesView, /Your booking and payment choice were saved/);
});

test("checkout templates still render valid inline JavaScript", async () => {
  const cartHtml = await ejs.renderFile(cartWizardPath, {
    cart: { items: [], totalAmount: 0 },
    user: { phone: "09171234567" },
  });
  const directHtml = await ejs.renderFile(directWizardPath, {
    grouped: [],
    user: { phone: "09171234567" },
  });
  assertInlineScriptsCompile(cartHtml);
  assertInlineScriptsCompile(directHtml);
});
