"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../public/js/services-multi.js"), "utf8");
const view = fs.readFileSync(path.join(__dirname, "../views/pages/services.ejs"), "utf8");
const source = script.match(/function getTypedServiceAddressForPin\(\) \{[\s\S]*?\n\}/)?.[0];
const guideSource = script.match(/function guideToManualAddressPin\(\) \{[\s\S]*?\n\}/)?.[0];

test("an unmatched full house address stays available when the customer places a map pin", () => {
  assert.ok(source, "manual-pin address helper exists");
  const input = { value: "123 Mabini Street, Zone 4, Barangay Poblacion, Cabanatuan City" };
  const state = { customerLocation: null, pendingManualAddress: null };
  const getAddress = vm.runInNewContext(`(${source})`, {
    document: { getElementById: () => input },
    BookingState: state
  });

  assert.equal(getAddress(), input.value);
  state.customerLocation = { address: input.value, manualAddress: input.value };
  assert.equal(getAddress(), input.value);
  state.customerLocation = { address: input.value };
  assert.equal(getAddress(), "", "a provider-generated label is not mistaken for customer-entered house details");
  state.pendingManualAddress = input.value;
  assert.equal(getAddress(), input.value);
});

test("map pin action is ready before an address is entered", () => {
  const button = view.match(/<button[^>]+id="pinTypedAddressBtn"[^>]*>/)?.[0];
  assert.ok(button, "map pin button exists");
  assert.doesNotMatch(button, /\bdisabled\b/);
  assert.doesNotMatch(script, /function syncManualPinAction|address\.length < 5/);
  assert.ok(guideSource, "manual map guide exists");

  const input = { value: "" };
  const status = { textContent: "" };
  let scrolled = false;
  const guide = vm.runInNewContext(`(${guideSource})`, {
    document: { getElementById: id => ({
      locationInput: input,
      locationStatus: status,
      serviceCheckoutMapCard: { scrollIntoView: () => { scrolled = true; } },
      technicianMap: { focus: () => {} },
    })[id] },
    BookingState: { pendingManualAddress: null, map: { invalidateSize: () => {} } },
    window: { setTimeout: callback => callback() },
  });

  guide();
  assert.equal(scrolled, true);
  assert.match(status.textContent, /Place the pin at the service address, then confirm it/);
});

test("short typed addresses are kept when placing a map pin", () => {
  assert.ok(source);
  const input = { value: "Zone 1" };
  const state = { customerLocation: null, pendingManualAddress: null };
  const getAddress = vm.runInNewContext(`(${source})`, {
    document: { getElementById: () => input },
    BookingState: state,
  });
  assert.equal(getAddress(), "Zone 1");
});
