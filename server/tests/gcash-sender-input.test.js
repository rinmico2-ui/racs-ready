"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const sender = require("../public/js/gcash-sender-input");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("GCash sender feedback explains length and prefix mistakes", () => {
  assert.equal(sender.check("09171234567").valid, true);
  assert.equal(sender.check("639171234567").normalized, "09171234567");
  assert.equal(sender.check("+63 917 123 4567").normalized, "09171234567");
  assert.match(sender.check("091712345678").message, /12 digits.*11 digits/);
  assert.match(sender.check("08171234567").message, /Start with 09/);
  assert.match(sender.check("0917", true).message, /4 of 11 digits.*Add 7 more/);
  assert.equal(sender.check("0917abc1234567").valid, false);
  assert.equal(sender.check("+09171234567").valid, false);
  assert.equal(sender.check("", true).state, "invalid");
});

test("both product checkout paths show GCash errors beside the field", () => {
  const cart = read("views/partials/cart-wizard.ejs");
  const direct = read("views/partials/aircons.ejs");
  for (const view of [cart, direct]) {
    assert.match(view, /gcash-sender-input\.js\?v=/);
    assert.match(view, /class="gcash-sender-feedback"/);
    assert.match(view, /GcashSenderInput\.update/);
    assert.match(view, /SenderFeedback\(true\)/);
    assert.match(view, /addEventListener\('blur'/);
  }
});
