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
  assert.match(servicesScript, /popup: popupClass \?/);
  assert.match(servicesScript, /'service-booking-alert'/);
  assert.doesNotMatch(servicesScript, /toast: true/);
});

test("service dialogs require deliberate acknowledgement", () => {
  assert.match(servicesScript, /allowOutsideClick: false/);
  assert.match(servicesScript, /confirmButtonText: 'Review Details'/);
  assert.match(servicesScript, /confirmButtonText: 'Continue'/);
  assert.match(servicesView, /services-multi\.js\?v=20260925-gcash-real-qr-v42/);
});

test("service-added confirmation is a subtle live-region toast after the configurator closes", () => {
  assert.match(servicesScript, /DOM\.quantityModal\.style\.display = 'none';[\s\S]*?showServiceAddedConfirmation\(service\.name\)/);
  assert.match(servicesScript, /function showServiceAddedConfirmation\(serviceName\)/);
  assert.match(servicesScript, /function showBookingToast\(message, tone = 'success'\)/);
  assert.match(servicesScript, /toast\.setAttribute\('role', 'status'\)/);
  assert.match(servicesScript, /toast\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(servicesScript, /revealNextBookingAction\(\)/);
  assert.match(servicesScript, /Next: add the service location/);
});

test("live address suggestions use the optional provider while manual Search remains available", () => {
  assert.doesNotMatch(
    servicesScript,
    /debounceTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{\s*fetchAddressSuggestions\(query\)/
  );
  assert.match(
    servicesScript,
    /addressSearchBtn\.addEventListener\('click',[\s\S]*?fetchAddressSuggestions\(query\)/
  );
  assert.match(
    servicesScript,
    /input\.addEventListener\('keydown',[\s\S]*?event\.key !== 'Enter'[\s\S]*?fetchAddressSuggestions\(query\)/
  );
  assert.match(servicesScript, /displaySuggestions\(data\)/);
  assert.match(servicesScript, /function fetchLiveAddressSuggestions\(query\)/);
  assert.match(servicesScript, /scheduleLiveAddressSuggestions\(query\)/);
  assert.match(servicesScript, /\/api\/geocoding\/autocomplete\?q=/);
  assert.match(servicesScript, /function applyAddressSearchResult/);
  assert.match(servicesScript, /function resetServiceLocationForTypedAddress/);
  assert.match(servicesView, /Search for an address or place a pin on the map/);
});

test("core-service configuration advances from brand to type to HP", () => {
  assert.match(servicesView, /id="cfgBackToType"/);
  assert.match(servicesView, /service-config-step-change/);
  assert.match(servicesView, /cfg-step-s">Brand[\s\S]*cfg-step-s">Aircon Type[\s\S]*cfg-step-s">HP/);
  assert.match(servicesScript, /showBrandSection\(service\);\s*showBrandConfigurationStep\(hpContainer\)/);
  assert.match(servicesScript, /function advanceFromBrandSelection/);
  assert.match(servicesScript, /typeSection\.classList\.add\('d-none'\)/);
  assert.match(servicesScript, /renderHpOptionsForType\(type, container\)/);
  assert.match(servicesScript, /showAirconTypeStep\(container\)/);
  assert.match(servicesScript, /document\.createElement\('button'\)/);
});

test("core-service primary action explains incomplete configuration", () => {
  assert.match(servicesScript, /function syncConfigurationPrimaryAction/);
  assert.match(servicesScript, /Choose aircon type/);
  assert.match(servicesScript, /Choose a brand/);
  assert.match(servicesScript, /Choose HP/);
  assert.match(servicesScript, /button\.disabled = !ready/);
});

test("core-service modal uses responsive stage panels and service context", () => {
  assert.match(servicesView, /cfg-service-context/);
  assert.match(servicesView, /cfg-stage-panel/);
  assert.match(servicesView, /cfg-stage-heading/);
  assert.match(servicesView, /cfg-field-help/);
  assert.match(servicesView, /\.cfg-header h5,#quantitySelectionModal \.cfg-header p\{color:#fff!important\}/);
});
