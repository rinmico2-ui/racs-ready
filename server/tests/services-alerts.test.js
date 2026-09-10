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
  assert.match(servicesView, /services-multi\.js\?v=20260910-brand-first-ui/);
});

test("address lookup is user-triggered instead of API-backed autocomplete", () => {
  assert.doesNotMatch(
    servicesScript,
    /debounceTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{\s*fetchAddressSuggestions\(query\)/
  );
  assert.match(
    servicesScript,
    /addressSearchBtn\.addEventListener\('click',[\s\S]*?fetchAddressSuggestions\(query\)/
  );
});

test("core-service configuration advances from brand to type to HP", () => {
  assert.match(servicesView, /id="cfgBackToType"/);
  assert.match(servicesView, /service-config-step-change/);
  assert.match(servicesView, /cfg-step-s">Brand[\s\S]*cfg-step-s">Aircon Type[\s\S]*cfg-step-s">HP Rating/);
  assert.match(servicesScript, /showBrandSection\(service\);\s*showBrandConfigurationStep\(hpContainer\)/);
  assert.match(servicesScript, /function advanceFromBrandSelection/);
  assert.match(servicesScript, /typeSection\.classList\.add\('d-none'\)/);
  assert.match(servicesScript, /renderHpOptionsForType\(type, container\)/);
  assert.match(servicesScript, /showAirconTypeStep\(container\)/);
  assert.match(servicesScript, /typeCard\.setAttribute\('tabindex', '0'\)/);
});

test("core-service primary action explains incomplete configuration", () => {
  assert.match(servicesScript, /function syncConfigurationPrimaryAction/);
  assert.match(servicesScript, /Select an aircon type/);
  assert.match(servicesScript, /Select a brand/);
  assert.match(servicesScript, /Select an HP rating/);
  assert.match(servicesScript, /button\.disabled = !ready/);
});

test("core-service modal uses responsive stage panels and service context", () => {
  assert.match(servicesView, /cfg-service-context/);
  assert.match(servicesView, /cfg-stage-panel/);
  assert.match(servicesView, /cfg-stage-heading/);
  assert.match(servicesView, /cfg-field-help/);
  assert.match(servicesView, /\.cfg-header h5,#quantitySelectionModal \.cfg-header p\{color:#fff!important\}/);
});
