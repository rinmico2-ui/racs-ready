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
