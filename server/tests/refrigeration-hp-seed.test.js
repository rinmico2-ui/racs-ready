'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeedPlan, SAMPLE_PRICES, HP_SIZES } = require('../scripts/seedRefrigerationHpServices');
const A = require('../public/js/appliance-services');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');

function records() {
  return Object.keys(SAMPLE_PRICES).map((slug, index) => ({
    _id: `service${index}`, name: slug, slug, category: 'service', active: true,
    isAirconService: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 2000, durationMinutes: 60 }] }],
  }));
}

test('seed adds both appliance HP tables without changing aircon settings or source records', () => {
  const original = records(), before = JSON.stringify(original);
  const plan = buildSeedPlan(original, SAMPLE_PRICES);
  assert.equal(JSON.stringify(original), before);
  for (const item of plan) {
    assert.deepEqual(item.addedKinds, ['refrigerator', 'freezer']);
    assert.equal(item.applianceProfiles.length, 2);
    for (const profile of item.applianceProfiles) {
      assert.equal(profile.enabled, true); assert.equal(profile.pricingMode, 'hp');
      assert.deepEqual(profile.hpPricing.map(tier => A.formatHp(tier.hp)), HP_SIZES);
    }
    assert.equal(A.price(item.record, { applianceKind: 'aircon', brand: 'Carrier', airconType: 'split', hp: 1 }).unitPrice, 2000);
  }
});

test('rerunning the seed keeps staff prices, work times and disabled appliance settings', () => {
  const original = records();
  original[0].applianceProfiles = [{ kind: 'refrigerator', enabled: false, pricingMode: 'hp', hpPricing: [{ hp: .125, price: 975, durationMinutes: 85 }] }];
  const first = buildSeedPlan(original, SAMPLE_PRICES);
  assert.deepEqual(first[0].addedKinds, ['freezer']);
  assert.deepEqual(first[0].applianceProfiles[0], original[0].applianceProfiles[0]);
  const second = buildSeedPlan(first.map(item => ({ ...item.record, applianceProfiles: item.applianceProfiles })), SAMPLE_PRICES);
  assert.ok(second.every(item => item.addedKinds.length === 0));
  assert.deepEqual(second[0].applianceProfiles, first[0].applianceProfiles);
});

test('missing, duplicated and archived services or invalid seed tiers stop before writes', () => {
  assert.throws(() => buildSeedPlan(records().slice(0, 1), SAMPLE_PRICES), /existing service/);
  assert.throws(() => buildSeedPlan([...records(), records()[0]], SAMPLE_PRICES), /existing service/);
  for (const change of [{ active: false }, { archivedAt: new Date() }]) {
    assert.throws(() => buildSeedPlan(records().map((record, index) => index ? record : { ...record, ...change }), SAMPLE_PRICES), /Enable/);
  }
  for (const tierChange of [{ price: -1 }, { durationMinutes: 0 }, { hp: 'unknown' }]) {
    const prices = structuredClone(SAMPLE_PRICES);
    Object.assign(prices['freon-recharging'][0].hpPricing[0], tierChange);
    assert.throws(() => buildSeedPlan(records(), prices));
  }
  const prices = structuredClone(SAMPLE_PRICES); prices['leak-testing'][1].pricingMode = 'fixed';
  assert.throws(() => buildSeedPlan(records(), prices), /HP pricing/);
});

test('every seeded HP works in both customer and server quotes and two services count one appliance', () => {
  const catalog = buildSeedPlan(records(), SAMPLE_PRICES).map(item => ({ ...item.record, applianceProfiles: item.applianceProfiles }));
  for (const kind of ['refrigerator', 'freezer']) {
    for (const hp of HP_SIZES) {
      const selection = { applianceKind: kind, brand: 'Midea', hp: A.parseHp(hp), quantity: 2 };
      const lines = A.serviceLines(catalog, selection, catalog.map(item => item._id), `${kind}_${hp.replace('/', '_')}`);
      assert.equal(A.unitCount(lines), 2);
      for (const line of lines) {
        const serverQuote = resolveCoreServicePricing(catalog.find(item => item._id === line.serviceId), { ...selection, unitPrice: 1, duration: 1 });
        assert.equal(serverQuote.unitPrice, line.unitPrice);
        assert.equal(serverQuote.totalPrice, line.totalPrice);
        assert.equal(serverQuote.duration, line.duration);
      }
    }
  }
});
