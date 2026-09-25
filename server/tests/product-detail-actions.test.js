"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const productDetail = fs.readFileSync(
  path.join(__dirname, "../views/pages/product-detail.ejs"),
  "utf8",
);

test("product purchase actions ignore rapid duplicate clicks", () => {
  assert.match(productDetail, /var pdPurchasePending = false/);
  assert.ok((productDetail.match(/if \(pdPurchasePending\) return/g) || []).length >= 2);
  assert.ok((productDetail.match(/setPdPurchaseBusy\(true, '(?:cart|buy)'\)/g) || []).length >= 2);
  assert.ok((productDetail.match(/finally \{[\s\S]*?pdPurchasePending = false;[\s\S]*?setPdPurchaseBusy\(false\)/g) || []).length >= 2);
});

test("desktop and mobile purchase buttons share the guarded action state", () => {
  assert.equal((productDetail.match(/data-pd-purchase/g) || []).length, 5);
  assert.match(productDetail, /querySelectorAll\('\[data-pd-purchase\]'\)/);
  assert.match(productDetail, /pd-action-locked:disabled[\s\S]*?opacity: 1/);
});

test("product page shows only supported purchase promises", () => {
  assert.match(productDetail, /Free installation with delivery/);
  assert.match(productDetail, /Delivery fee shown at checkout/);
  assert.match(productDetail, /<span class="pd-spec-label">Warranty<\/span>/);
  assert.doesNotMatch(productDetail, /Free Delivery|24\/7 Support|GCredit \/ Card Installment/);
  assert.doesNotMatch(productDetail, /Full GCash|GCash Downpayment|Cash at Store Pickup/);
});
