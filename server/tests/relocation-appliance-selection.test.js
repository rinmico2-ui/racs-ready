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
test('a different-address move creates a request without charging a nearby price or inventing locations', () => {
  const rows = A.serviceLines(catalog, selection, ['move'], 'relocation_group', { scope: 'custom_quote' });
  assert.equal(rows[0].unitPrice, 0); assert.equal(rows[0].totalPrice, 0); assert.equal(rows[0].duration, 0);
  assert.equal(rows[0].brand, 'Carrier'); assert.equal(rows[0].airconType, 'split'); assert.equal(rows[0].hp, 1);
  assert.equal(rows[0].relocation.to.lat, undefined);
});
test('a nearby move may share an appliance with other tasks; a quoted move must stay separate', () => {
  const move = { scope: 'same_property', from: { details: 'Room A' }, to: { details: 'Room B' } };
  const rows = A.serviceLines(catalog, selection, ['move', 'clean'], 'relocation_group', move);
  assert.equal(A.unitCount(rows), 1); assert.equal(rows.reduce((n, row) => n + row.totalPrice, 0), 2100);
  assert.throws(() => A.serviceLines(catalog, selection, ['move', 'clean'], 'relocation_group', { scope: 'custom_quote' }), /own quote/);
});
test('relocation rejects missing scope, missing positions, wrong appliances and multiple units', () => {
  for (const move of [undefined, { scope: 'other' }, { scope: 'same_property' }, { scope: 'same_property', from: { details: 'Room A' }, to: { details: ' ' } }]) assert.throws(() => A.serviceLines(catalog, selection, ['move'], 'relocation_group', move));
  for (const change of [{ quantity: 2 }, { applianceKind: 'freezer' }]) assert.throws(() => A.serviceLines(catalog, { ...selection, ...change }, ['move'], 'relocation_group', { scope: 'custom_quote' }));
});
