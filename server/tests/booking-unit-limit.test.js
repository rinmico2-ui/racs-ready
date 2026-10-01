"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateBookingUnitLimit } = require("../utils/bookingUnitLimit");

test("booking unit limit counts quantities across Core, Repair, and HP variants", () => {
  assert.equal(validateBookingUnitLimit([
    { type: "core", hp: 0.5, quantity: 15 },
    { type: "core", hp: 1, quantity: 20 },
    { type: "repair", quantity: 5 },
  ]), 40);
  assert.throws(() => validateBookingUnitLimit([
    { type: "core", hp: 0.5, quantity: 40 },
    { type: "core", hp: 1, quantity: 1 },
  ]), error => error.status === 400 && /at most 40 units/.test(error.message));
});

test("booking unit limit rejects fractional, zero, missing, and negative quantities", () => {
  for (const quantity of [0, -1, 1.5, undefined, "not a number"]) {
    assert.throws(() => validateBookingUnitLimit([{ quantity }]));
  }
});

test("customer edit API validates the combined total before pricing changes", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/bookingRoutesNew.js"), "utf8");
  assert.match(route, /async function validatedServiceItems\(inputItems, booking\)[\s\S]*?validateBookingUnitLimit\(inputItems\);[\s\S]*?const contexts =/);
});
