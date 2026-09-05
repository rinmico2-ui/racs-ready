"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const servicesScript = fs.readFileSync(
  path.join(__dirname, "../public/js/services-multi.js"),
  "utf8",
);
const servicesView = fs.readFileSync(
  path.join(__dirname, "../views/pages/services.ejs"),
  "utf8",
);

test("customer service feedback uses centered enterprise dialogs", () => {
  assert.match(servicesScript, /function showServiceDialog/);
  assert.match(servicesScript, /toast: false/);
  assert.match(servicesScript, /position: 'center'/);
  assert.match(servicesScript, /showConfirmButton: true/);
  assert.match(servicesScript, /popup: 'service-booking-alert'/);
  assert.doesNotMatch(servicesScript, /toast: true/);
});

test("service dialogs require deliberate acknowledgement", () => {
  assert.match(servicesScript, /allowOutsideClick: false/);
  assert.match(servicesScript, /confirmButtonText: 'Review Details'/);
  assert.match(servicesScript, /confirmButtonText: 'Continue'/);
  assert.match(servicesView, /services-multi\.js\?v=20260906-guarded-step-navigation/);
});
