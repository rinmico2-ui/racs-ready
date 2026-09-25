"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../public/js/services-multi.js"), "utf8");
const selectionSource = script.match(/function applyAddressSearchResult\(result, fallbackAddress, source\) \{[\s\S]*?\n\}/)?.[0];
const mapGuideSource = script.match(/function guideToSelectedAddressMap\(\) \{[\s\S]*?\n\}/)?.[0];

function selectAddress(result, typedAddress) {
  assert.ok(selectionSource, "address selection helper exists");
  const input = { value: typedAddress, classList: { remove() {} } };
  const state = { customerLocation: null, map: null };
  const displayed = [];
  const context = {
    BookingState: state,
    customerLocationRequestToken: 0,
    routeRequestToken: 0,
    clearServiceRouteEstimate() {},
    document: { getElementById: id => id === "locationInput" ? input : null },
    isWithinPhilippinesMapBounds: (lat, lon) => lat >= 4.5 && lat <= 21.5 && lon >= 116 && lon <= 127,
    updateServiceMapSelectionUI: (_lat, _lon, address) => displayed.push(address),
    scheduleBookingProgressSave() {},
    showError(message) { throw new Error(message); },
    // Keep map setup pending: the selected address is committed synchronously.
    window: { _companyBaseLocationPromise: new Promise(() => {}) },
  };
  const apply = vm.runInNewContext(`(${selectionSource})`, context);
  assert.equal(apply(result, typedAddress, "Philippine address match"), true);
  return { input, state, displayed };
}

test("choosing an address suggestion saves its full label and coordinates, not the short search query", () => {
  const fullAddress = "Puncan, Carranglan, Nueva Ecija, Central Luzon, 3123, Philippines";
  const selected = selectAddress({ display_name: fullAddress, lat: 15.98, lon: 121.07, match_level: "suggestion" }, "3123");
  assert.equal(selected.input.value, fullAddress);
  assert.equal(selected.state.customerLocation.address, fullAddress);
  assert.equal(selected.state.customerLocation.matchedAddress, fullAddress);
  assert.equal(selected.state.customerLocation.manualAddress, undefined, "dragging the pin can refresh a provider address");
  assert.equal(selected.state.customerLocation.pinConfirmed, false);
  assert.deepEqual({ ...selected.state.userCoordinates }, { lat: 15.98, lng: 121.07 });
  assert.equal(selected.displayed[0], fullAddress);
});

test("a detailed house address is kept when the provider only matched a wider area", () => {
  const typed = "123 Mabini Street, Barangay Poblacion, Cabanatuan City, Nueva Ecija";
  const selected = selectAddress({ display_name: "Cabanatuan City, Nueva Ecija, Philippines", lat: 15.49, lon: 120.97, match_level: "area" }, typed);
  assert.equal(selected.state.customerLocation.address, typed);
  assert.equal(selected.state.customerLocation.manualAddress, typed);
  assert.equal(selected.input.value, typed);
});

test("selecting a valid suggestion takes the customer to the map pin", () => {
  assert.match(script, /if \(selected\) guideToSelectedAddressMap\(\)/);
  assert.ok(mapGuideSource, "selected-address map guide exists");
  const actions = [];
  const mapCard = {
    setAttribute(name, value) { actions.push(`set ${name}=${value}`); },
    scrollIntoView(options) { actions.push(`scroll ${options.block} ${options.behavior}`); },
    focus(options) { actions.push(`focus ${options.preventScroll}`); }
  };
  const guide = vm.runInNewContext(`(${mapGuideSource})`, {
    document: { getElementById: id => id === "serviceCheckoutMapCard" ? mapCard : { blur() { actions.push("blur input"); } } },
    BookingState: { map: { invalidateSize() { actions.push("resize map"); } } },
    window: { matchMedia: () => ({ matches: false }), setTimeout: callback => callback() }
  });
  guide();
  assert.deepEqual(actions, [
    "blur input",
    "set tabindex=-1",
    "set aria-label=Check your selected service location on the map",
    "scroll center smooth",
    "resize map",
    "focus true"
  ]);
});
