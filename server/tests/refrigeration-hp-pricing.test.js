'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../public/js/appliance-services');
const { normalizeCoreServicePayload } = require('../utils/serviceCatalogPayload');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const { bookingAssetSeeds } = require('../utils/maintenanceLifecycle');
const CoreService = require('../models/CoreService');
const catalog = { _id: 'recharge', name: 'Recharging', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split', hpPricing: [{ hp: 0.125, price: 5000, durationMinutes: 200 }] }],
  applianceProfiles: [{ kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: 0.125, price: 650, durationMinutes: 45 }, { hp: 0.333333, price: 800, durationMinutes: 60 }] },
    { kind: 'freezer', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: 0.125, price: 900, durationMinutes: 75 }] }] };
test('fractional compressor HP parses safely, without rounding common fractions differently', () => {
  assert.equal(A.parseHp('1/8'), 0.125); assert.equal(A.parseHp(' 1 / 3 '), A.parseHp(1 / 3));
  assert.equal(A.formatHp(0.125), '1/8'); assert.equal(A.formatHp(1 / 3), '1/3'); assert.equal(A.formatHp(2), '2');
  for (const value of ['', null, 0, '0.0000000001', '1/0', '1/8x', '-1/8', 'Infinity', 'NaN', '1e3', '1/2/3']) assert.ok(Number.isNaN(A.parseHp(value)), String(value));
});
test('the backend uses only the selected appliance HP price and work time', () => {
  const selection = { applianceKind: 'refrigerator', brand: 'Midea', hp: 0.125, quantity: 3, unitPrice: 1, duration: 1 };
  const fridge = resolveCoreServicePricing(catalog, selection), freezer = resolveCoreServicePricing(catalog, { ...selection, applianceKind: 'freezer' });
  assert.equal(fridge.unitPrice, 650); assert.equal(fridge.totalPrice, 1950); assert.equal(fridge.duration, 45);
  assert.equal(freezer.unitPrice, 900); assert.equal(freezer.duration, 75);
  assert.equal(fridge.airconType, null); assert.equal(fridge.hp, 0.125);
  assert.equal(A.price(catalog, { ...selection, hp: 1 / 3 }).unitPrice, 800);
  for (const hp of [null, '', 5, -1, 'bad']) assert.throws(() => A.price(catalog, { ...selection, hp }));
});
test('staff can save fractional HP tiers without a fixed price, with default pricing preserved for old profiles', async () => {
  const payload = normalizeCoreServicePayload({ name: 'Recharging', slug: 'recharging', category: 'Maintenance', applianceProfiles: JSON.stringify([{ kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: '1/8', price: 650, durationMinutes: 45 }] }]) });
  assert.equal(payload.applianceProfiles[0].hpPricing[0].hp, 0.125);
  const record = new CoreService(payload); await record.validate(); assert.equal(record.applianceProfiles[0].hpPricing[0].price, 650);
  const old = new CoreService({ applianceProfiles: [{ kind: 'freezer', enabled: true, unitPrice: 200, durationMinutes: 30 }] });
  assert.equal(old.applianceProfiles[0].pricingMode, 'fixed');
  assert.equal(A.price(old, { applianceKind: 'freezer', brand: 'TCL' }).unitPrice, 200);
});
test('incomplete, duplicate, nonnumeric and unsupported refrigeration price settings cannot be saved', () => {
  const base = { kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: '1/8', price: 650, durationMinutes: 45 }] };
  for (const change of [{ pricingMode: 'automatic' }, { hpPricing: [] }, { hpPricing: 'bad' },
    { hpPricing: [...base.hpPricing, { hp: 0.125, price: 800, durationMinutes: 60 }] },
    ...[{ hp: 0 }, { price: '' }, { price: -1 }, { durationMinutes: 1.5 }, { durationMinutes: 10081 }, { hp: '1/0' }].map(tier => ({ hpPricing: [{ ...base.hpPricing[0], ...tier }] }))]) {
    assert.throws(() => normalizeCoreServicePayload({ applianceProfiles: [{ ...base, ...change }] }), error => error.status === 400);
  }
});
test('fixed and HP priced tasks keep one physical appliance, and aftercare retains its compressor HP', () => {
  const fixed = { ...catalog, _id: 'cleaning', name: 'Cleaning', applianceProfiles: [{ kind: 'refrigerator', enabled: true, unitPrice: 300, durationMinutes: 30 }] };
  const rows = A.serviceLines([catalog, fixed], { applianceKind: 'refrigerator', brand: 'Midea', hp: 0.125, quantity: 2 }, ['recharge', 'cleaning'], 'compressor_hp_group');
  assert.equal(A.unitCount(rows), 2); assert.equal(rows[0].hp, rows[1].hp);
  assert.equal(rows.reduce((total, row) => total + row.totalPrice, 0), 1900);
  const assets = bookingAssetSeeds({ _id: 'booking1', customerId: 'customer1', services: rows });
  assert.equal(assets.length, 2); assert.equal(assets[0].equipment.capacity, '0.125'); assert.equal(assets[0].equipment.capacityUnit, 'HP');
});
