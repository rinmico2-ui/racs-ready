"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const view = read("views/pages/services.ejs");
const script = read("public/js/services-multi.js");
const styles = read("public/css/services-mobile-ux.css");

test("travel fee is the primary result beside the selected location", () => {
  const locationStep = view.slice(view.indexOf('id="locationStep"'), view.indexOf('id="manualCalendar"'));
  assert.ok(locationStep.indexOf('id="serviceMapAddress"') < locationStep.indexOf('id="mapInfoFare"'));
  assert.ok(locationStep.indexOf('id="mapInfoFare"') < locationStep.indexOf('id="technicianMap"'));
  assert.match(locationStep, /class="service-route-total"[\s\S]*?id="mapInfoFare"/);
  assert.match(locationStep, /id="serviceMapCoordinates"[\s\S]*?<\/details>/);
  assert.match(locationStep, /id="locationFareDetailsButton"[\s\S]*?See travel fee details/);
  assert.match(styles, /\.service-route-total strong\s*\{[^}]*font-size:\s*1\.75rem/);
});

test("confirmed location copy keeps the address, fee, and pin instruction without repeated paragraphs", () => {
  const locationStep = view.slice(view.indexOf('id="locationStep"'), view.indexOf('id="manualCalendar"'));
  assert.match(locationStep, /id="locationDetailsTitle">Your service location/);
  assert.match(locationStep, /id="mapInfoFare"/);
  assert.match(locationStep, /id="mapInfoDistance"/);
  assert.match(locationStep, /id="fareRateDisplay"/);
  assert.match(locationStep, /Drag the green pin if needed/);
  assert.doesNotMatch(locationStep, /Check before scheduling|Added to your service price|Full amount shown above/);
  assert.match(script, /locationStatus\.hidden = !pinNeedsConfirmation/);
  assert.match(script, /distanceInfoElement\.textContent = `\$\{distance\.toFixed\(1\)\} km ×/);
});

test("sticky next action shows the fare and links back to its breakdown", () => {
  assert.match(script, /if \(message\) message\.textContent = `Travel fee \$\{fareText\} · \$\{distanceText\}`/);
  assert.match(script, /function showServiceTravelDetails\(\)[\s\S]*?panel\.scrollIntoView/);
  assert.match(script, /function confirmServiceAddressPin\(\)[\s\S]*?showServiceTravelDetails\(\)/);
  assert.match(styles, /\.location-fare-details\[hidden\] \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.location-next-action\.is-visible \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test("changing the pin clears the old fee and ignores late route results", () => {
  assert.match(script, /function clearServiceRouteEstimate\(\)[\s\S]*?delete distance\.dataset\.ready;[\s\S]*?BookingState\.travelFare = null/);
  assert.match(script, /map\.on\('click',[\s\S]*?clearServiceRouteEstimate\(\)/);
  assert.match(script, /function calculateDistanceAndFare\(requestToken = routeRequestToken\)[\s\S]*?if \(requestToken !== routeRequestToken\) return;/);
  assert.doesNotMatch(script, /updateDistanceInfo\(routeData\.distance, Math\.round\(routeData\.distance/);
});

test("the fixed action shows the calculated fare only for a confirmed pin", () => {
  const source = script.match(/function syncLocationContinueAction\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const classes = () => {
    const values = new Set();
    return {
      add: value => values.add(value),
      remove: (...items) => items.forEach(item => values.delete(item)),
      contains: value => values.has(value),
      toggle: (value, force) => force ? values.add(value) : values.delete(value),
    };
  };
  const body = { appendChild: element => { element.parentElement = body; } };
  const action = { parentElement: null, classList: classes(), setAttribute() {}, toggleAttribute() {}, offsetWidth: 100 };
  const location = { lat: 15.45, lng: 120.95, pinConfirmed: true };
  const elements = {
    locationNextAction: action,
    locationStep: { classList: { contains: () => true } },
    mapInfoDistance: { textContent: "13.1 km", dataset: { ready: "true" } },
    mapInfoFare: { textContent: "₱393" },
    locationContinueButton: { disabled: true },
    locationFareDetailsButton: { hidden: true },
    locationContinueLabel: { textContent: "" },
    locationNextEyebrow: { textContent: "" },
    locationNextMessage: { textContent: "" },
  };
  const sync = vm.runInNewContext(`(${source})`, {
    BookingState: { currentStep: 3, customerLocation: location },
    document: { body, getElementById: id => elements[id] },
    window: { clearTimeout() {}, setTimeout: () => 1 },
  });
  sync();
  assert.equal(elements.locationNextMessage.textContent, "Travel fee ₱393 · 13.1 km");
  assert.equal(elements.locationFareDetailsButton.hidden, false);
  assert.equal(elements.locationContinueButton.disabled, false);

  location.pinConfirmed = false;
  sync();
  assert.equal(elements.locationFareDetailsButton.hidden, true);
  assert.equal(elements.locationContinueLabel.textContent, "Check Map Pin");
});
