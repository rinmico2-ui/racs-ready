'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../public/js/appliance-services');
const catalog = [{ _id: 'move', slug: 'aircon-relocation', name: 'Aircon Relocation', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1600, durationMinutes: 120 }] }] },
  { _id: 'clean', name: 'Cleaning', isAirconService: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }] }];
const selection = { applianceKind: 'aircon', brand: 'Carrier', model: 'Nexus', quantity: 1, airconType: 'split', hp: 1 };
test('nearby relocation reuses appliance details and saves both room positions with the normal catalog price', () => {
  const rows = A.serviceLines(catalog, selection, ['move'], 'relocation_group', { scope: 'same_property', from: { details: ' Living room ' }, to: { details: ' Bedroom ' } });
  assert.equal(rows[0].brand, 'Carrier'); assert.equal(rows[0].model, 'Nexus'); assert.equal(rows[0].hp, 1);
  assert.equal(rows[0].relocation.model, 'Nexus'); assert.equal(rows[0].relocation.from.details, 'Living room');
  assert.equal(rows[0].relocation.to.details, 'Bedroom'); assert.equal(rows[0].totalPrice, 1600); assert.equal(rows[0].duration, 120);
  assert.equal(A.unitCount(rows), 1);
});
test('a different-address move uses the normal catalog price without inventing map pins', () => {
  const rows = A.serviceLines(catalog, selection, ['move'], 'relocation_group', { scope: 'different_address' });
  assert.equal(rows[0].unitPrice, 1600); assert.equal(rows[0].totalPrice, 1600); assert.equal(rows[0].duration, 120);
  assert.equal(rows[0].brand, 'Carrier'); assert.equal(rows[0].airconType, 'split'); assert.equal(rows[0].hp, 1);
  assert.equal(rows[0].relocation.to.lat, undefined);
});
test('both relocation options are standalone, in either service selection order', () => {
  for (const scope of ['same_property', 'different_address']) for (const ids of [['move', 'clean'], ['clean', 'move']]) {
    assert.throws(() => A.serviceLines(catalog, selection, ids, 'relocation_group', { scope, from: { details: 'Room A' }, to: { details: 'Room B' } }), /on its own/);
  }
});
test('relocation rejects missing scope, missing positions, wrong appliances and multiple units', () => {
  for (const move of [undefined, { scope: 'other' }, { scope: 'same_property' }, { scope: 'same_property', from: { details: 'Room A' }, to: { details: ' ' } }]) assert.throws(() => A.serviceLines(catalog, selection, ['move'], 'relocation_group', move));
  for (const change of [{ quantity: 2 }, { applianceKind: 'freezer' }]) assert.throws(() => A.serviceLines(catalog, { ...selection, ...change }, ['move'], 'relocation_group', { scope: 'different_address' }));
});

test('standalone policy also blocks core and repair on different appliance groups and quantity edits', () => {
  const [move] = A.serviceLines(catalog, selection, ['move'], 'relocation_group', { scope: 'different_address' });
  for (const other of [{ name: 'Cleaning', quantity: 1 }, { type: 'repair', name: 'Washer Repair', quantity: 1 }]) {
    assert.throws(() => A.assertStandaloneServices([move, other]), /on its own/);
    assert.throws(() => A.assertStandaloneServices([other, move]), /on its own/);
  }
  const before = JSON.stringify(move); assert.throws(() => A.setQuantity([move], 0, 2), /one aircon/);
  assert.equal(JSON.stringify(move), before);
});
