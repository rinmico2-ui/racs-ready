'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../public/js/appliance-services');

// Mirrors the deployed /api/services coreServices document shapes.
const aircon = { _id: 'a1', name: 'Aircon Cleaning', serviceType: 'AIRCON CLEANING', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1200, durationMinutes: 90 }, { hp: 2, price: 1500, durationMinutes: 105 }] }] };
const fridge = { _id: 'f1', name: 'Freon Recharging', serviceType: 'FRIDGE RECHARGE', active: true,
  applianceProfiles: [{ kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: 0.125, price: 800, durationMinutes: 90 }, { hp: 0.25, price: 950, durationMinutes: 100 }, { hp: 0.5, price: 1100, durationMinutes: 110 }] }] };
const freezer = { _id: 'z1', name: 'Freezer Cleaning', serviceType: 'FREEZER CLEANING', active: true,
  applianceProfiles: [{ kind: 'freezer', enabled: true, pricingMode: 'fixed', unitPrice: 900, durationMinutes: 75 }] };

test('aircon availability follows airconTypes tiers and reports missing tiers', () => {
  const found = A.availability(aircon, { applianceKind: 'aircon', airconType: 'split', hp: 1, quantity: 1, brand: 'Samsung' });
  assert.equal(found.available, true); assert.equal(found.hpNeeded, undefined);
  assert.equal(found.pricing.unitPrice, 1200); assert.equal(found.pricing.duration, 90);
  for (const selection of [{ airconType: 'central', hp: 1 }, { airconType: 'split', hp: 3 }, { airconType: 'split', hp: null }]) {
    const state = A.availability(aircon, { applianceKind: 'aircon', airconType: selection.airconType, hp: selection.hp, quantity: 1, brand: 'Samsung' });
    assert.equal(state.available, false, JSON.stringify(selection));
    assert.equal(state.pricing, undefined, JSON.stringify(selection));
    assert.equal(state.hpNeeded, false, `aircon selections already pin the HP up front: ${selection.airconType}`);
  }
});

test('missing suspended and cassette rates use exact saved split prices and work times', () => {
  for (const type of ['split_suspended','cassette']) {
    const state=A.availability(aircon,{applianceKind:'aircon',airconType:type,hp:1,quantity:1});
    assert.equal(state.available,true);assert.equal(state.pricing.unitPrice,1200);assert.equal(state.pricing.duration,90);
    assert.equal(state.pricing.airconType,type);
  }
});

test('legacy top-level hpPricing documents stay available', () => {
  const legacy = { ...aircon, airconTypes: undefined, hpPricing: [{ hp: 0.75, price: 950, durationMinutes: 80 }] };
  const state = A.availability(legacy, { applianceKind: 'aircon', airconType: 'split', hp: 0.75, quantity: 1, brand: 'Samsung' });
  assert.equal(state.available, true); assert.equal(state.pricing.unitPrice, 950); assert.equal(state.pricing.duration, 80);
});

test('non-aircon availability requires a priced compressor HP tier', () => {
  const missing = A.availability(fridge, { applianceKind: 'refrigerator', quantity: 1, brand: 'LG' });
  assert.equal(missing.available, false); assert.equal(missing.hpNeeded, true);
  assert.equal(missing.reason, 'Choose a compressor HP with a saved price for this service. If you do not know it, use Repair Service for an inspection.');
  const ok = A.availability(fridge, { applianceKind: 'refrigerator', quantity: 2, brand: 'LG', hp: 0.25 });
  assert.equal(ok.available, true); assert.equal(ok.pricing.unitPrice, 950); assert.equal(ok.pricing.hp, 0.25);
  const unsupported = A.availability(fridge, { applianceKind: 'refrigerator', quantity: 1, brand: 'LG', hp: 2 });
  assert.equal(unsupported.available, false, 'a compressor HP without a saved price stays unavailable');
  assert.equal(unsupported.hpNeeded, true);
  assert.equal(unsupported.reason, 'Choose a compressor HP with a saved price for this service. If you do not know it, use Repair Service for an inspection.');
  const neverX = A.availability(aircon, { applianceKind: 'refrigerator', quantity: 1, brand: 'LG', hp: 0.125 });
  assert.equal(neverX.available, false); assert.equal(neverX.reason, 'This service is not available for the selected appliance.');
});

test('fixed-price profiles never require verification and remain available without an HP', () => {
  const state = A.availability(freezer, { applianceKind: 'freezer', quantity: 3, brand: "I don't know" });
  assert.equal(state.available, true); assert.equal(state.hpNeeded, undefined);
  assert.equal(state.pricing.unitPrice, 900); assert.equal(state.pricing.hp, null);
  assert.equal(A.needsVerification(freezer, { applianceKind: 'freezer', quantity: 1 }), false);
});

test('unitPrice skips brand validation while price keeps enforcing it', () => {
  const selection = { applianceKind: 'refrigerator', quantity: 1, hp: 0.125 };
  assert.equal(A.unitPrice(fridge, selection).unitPrice, 800);
  assert.throws(() => A.price(fridge, selection), /brand/);
  assert.equal(A.price(fridge, { ...selection, brand: 'Condura' }).unitPrice, 800);
  assert.equal(A.price(freezer, { applianceKind: 'freezer', quantity: 1, brand: "I don't know" }).unitPrice, 900);
  assert.throws(() => A.price(fridge, { applianceKind: 'freezer', quantity: 1, brand: 'Condura' }), /appliance/);
});
