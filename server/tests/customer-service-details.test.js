'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A = require('../public/js/appliance-services');
const { resolveCatalogInspectionFee } = require('../utils/repairInspectionPricing');
const aircon = { type: 'repair', unitCategory: 'aircon', unitType: 'Split Type Aircon', quantity: 1, hp: 1 };

test('new repair entries cover one appliance and reject bulk, fractional or malformed quantities', () => {
  for (const quantity of [0, 2, 40, 41, 1.5, {}, [], [1], null, undefined]) assert.throws(() => A.repairDetails({ ...aircon, quantity }), /each repair appliance separately/);
  assert.deepEqual(A.repairDetails({ ...aircon, quantity: '1' }), { quantity: 1, hp: 1, hpDescription: '1 HP' });
  const rows = [{ ...aircon }]; assert.throws(() => A.setQuantity(rows, 0, 2), /separately/); assert.equal(rows[0].quantity, 1);
});

test('aircon repairs require a supported HP while non-aircon repairs do not show or save it', () => {
  for (const hp of [undefined, null, '', 0, -1, 999, true, {}, [1], 'unknown']) assert.throws(() => A.repairDetails({ ...aircon, hp }), /Choose the aircon HP/);
  for (const hp of A.repairHpValues) assert.equal(A.repairDetails({ ...aircon, hp }).hp, hp);
  assert.equal(A.repairDetails({ unitType: 'Washing Machine', unitCategory: 'appliance', quantity: 1, hp: 3 }).hp, null);
  const prior = { ...aircon, quantity: 3, hp: null };
  assert.equal(A.repairDetails(prior, { prior, allowLegacyHp: true }).quantity, 3);
  assert.equal(A.repairDetails(prior, { prior, allowLegacyHp: true }).hp, null);
  assert.throws(() => A.repairDetails(prior, { prior }), /Choose the aircon HP/);
});

test('repair HP is descriptive and never replaces the catalog inspection fee with a core-service price', () => {
  const categories = [{ slug: 'aircon', active: true, unitTypes: [{ value: aircon.unitType, label: aircon.unitType, inspectionFee: 650 }] }];
  for (const hp of [1, 3, 5]) assert.equal(resolveCatalogInspectionFee({ ...aircon, ...A.repairDetails({ ...aircon, hp }) }, categories, 500).fee, 650);
});

test('the actual booking input validation accepts core services without a model but validates repair model, quantity and HP', () => {
  const filename = path.join(__dirname, '../routes/bookingRoutesNew.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    let parsedServices = services;'), end = source.indexOf('    if (!location', start);
  assert.ok(start > 0 && end > start);
  const context = { require, services: [], validateRepairModel: require('../utils/repairModelPolicy').validateRepairModel,
    schedulingEngine: { MAX_BOOKING_UNITS: 40 }, res: { status() { return this; }, json(body) { throw Error(body.error); } } };
  vm.runInNewContext('function validate(services) {' + source.slice(start, end) + '\nreturn parsedServices;}', context);
  assert.equal(context.validate([{ type: 'core', quantity: 1, brand: 'Carrier' }])[0].model, '');
  const repair = { ...aircon, model: 'MODEL-123', brand: 'Carrier' };
  assert.equal(context.validate([repair])[0].hp, 1);
  for (const model of [undefined, null, '', '  ']) assert.equal(context.validate([{ ...repair, model }])[0].model, '');
  for (const model of [{}, ['MODEL-123'], '<script>', 'A'.repeat(51)]) assert.throws(() => context.validate([{ ...repair, model }]), /model number/i);
  assert.throws(() => context.validate([{ ...repair, quantity: 2 }]), /separately/);
  assert.throws(() => context.validate([{ ...repair, hp: null }]), /Choose the aircon HP/);
  assert.throws(() => context.validate([null]), /valid service details/);
});
