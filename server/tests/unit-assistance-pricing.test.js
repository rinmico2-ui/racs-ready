const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const UnitAssistanceRequest = require('../models/UnitAssistanceRequest');

const catalog = {
  active: true, isAirconService: true, basePrice: 500,
  airconTypes: [
    { type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1200, durationMinutes: 90 }] },
    { type: 'window', name: 'Window Type', hpPricing: [{ hp: 1, price: 900, durationMinutes: 60 }] },
  ],
};

test('aircon pricing uses the exact type and HP catalog tier', () => {
  assert.deepEqual(resolveCoreServicePricing(catalog, {
    brand: 'Carrier', airconType: 'split', hp: 1, quantity: 2, unitPrice: 1,
  }), {
    unitPrice: 1200, totalPrice: 2400, duration: 90,
    airconType: 'split', airconTypeName: 'Split Type', hp: 1,
  });
});

test('unknown type or HP cannot fall back to base price', () => {
  assert.throws(() => resolveCoreServicePricing(catalog, { brand: "I don't know", hp: 1, quantity: 1 }), /type/i);
  assert.throws(() => resolveCoreServicePricing(catalog, { brand: 'Carrier', airconType: 'split', quantity: 1 }), /HP/i);
  assert.throws(() => resolveCoreServicePricing(catalog, { brand: 'Carrier', airconType: 'split', hp: 2, quantity: 1 }), /unavailable/i);
  assert.throws(() => resolveCoreServicePricing(catalog, { brand: 'Carrier', airconType: 'split', hp: 1, quantity: 0 }), /units/i);
});

test('unknown brand can still use exact price when type and HP are known', () => {
  assert.equal(resolveCoreServicePricing(catalog, {
    brand: "I don't know", airconType: 'window', hp: 1, quantity: 1,
  }).unitPrice, 900);
});

test('legacy HP catalog and plain Core service stay supported', () => {
  assert.equal(resolveCoreServicePricing({ active: true, isAirconService: true,
    hpPricing: [{ hp: 1.5, price: 1750 }] }, {
    brand: 'Midea', hp: 1.5, quantity: 1,
  }).unitPrice, 1750);
  assert.equal(resolveCoreServicePricing({ active: true, basePrice: 800, durationMinutes: 45 }, {
    quantity: 3,
  }).totalPrice, 2400);
});

test('an unknown unit can be saved as an unpaid request before a quote exists', async () => {
  const request = new UnitAssistanceRequest({
    customerId: '507f1f77bcf86cd799439011',
    serviceId: '507f1f77bcf86cd799439012',
    serviceName: 'Aircon Cleaning', quantity: 2,
    brand: "I don't know", notes: 'Wall mounted',
  });
  await request.validate();
  assert.equal(request.status, 'pending');
  assert.equal(request.bookingId, null);
  assert.equal(request.quote?.unitPrice, undefined);
});
