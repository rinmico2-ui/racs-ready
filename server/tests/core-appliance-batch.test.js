'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../public/js/appliance-services');
const { createModel } = require('../public/js/core-appliance-batch');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const Booking = require('../models/BookingService');
const { buildUnitGroups } = require('../utils/repairUnitWorkflow');
const { projectUnits } = require('../utils/projectWorkOrderPlanning');

const cleaning = '68a000000000000000000001', recharge = '68a000000000000000000002';
const catalog = [
  { _id: cleaning, name: 'Cleaning', active: true, brands: ['Carrier','Midea'], isAirconService: true, airconTypes: [
    { type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }, { hp: 2, price: 800, durationMinutes: 90 }] },
    { type: 'window', name: 'Window Type', hpPricing: [{ hp: 1.5, price: 650, durationMinutes: 75 }] },
  ] },
  { _id: recharge, name: 'Freon Recharging', active: true, brands: ['Carrier','Midea'], isAirconService: true, airconTypes: [
    { type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1000, durationMinutes: 90 }, { hp: 2, price: 1400, durationMinutes: 120 }] },
  ] },
];
const shared = { applianceKind: 'aircon', brand: 'Carrier', airconType: 'split', hp: 1, model: '', quantity: 3 };
function fixture(quantity = 3) {
  let sequence = 0;
  const model = createModel(catalog, { newId: () => `appliance_batch_test_${++sequence}` });
  model.sync({ ...shared, quantity });
  return model;
}

test('matching aircons use one shared selection and produce separate physical units', async () => {
  const model = fixture(); model.selectService(cleaning, true);
  const rows = model.rows();
  assert.equal(rows.length, 3); assert.equal(A.unitCount(rows), 3);
  assert.equal(new Set(rows.map(row => row.applianceGroupId)).size, 3);
  assert.ok(rows.every(row => row.quantity === 1 && row.unitPrice === 500 && row.brand === 'Carrier'));
  assert.equal(model.estimate().total, 1500); assert.equal(model.estimate().minutes, 180);
  await new Booking({ services: rows, paymentMethod: 'gcash' }).validate(['services']);
});

test('different brand, type, HP and model stay attached to their own correctly priced aircon', () => {
  const model = fixture(); model.setDetailsMode('individual');
  model.setDetail(1, 'brand', 'Midea'); model.setDetail(1, 'hp', 2); model.setDetail(1, 'model', 'MODEL-2');
  model.setDetail(2, 'brand', 'Other Brand'); model.setDetail(2, 'airconType', 'window'); model.setDetail(2, 'hp', 1.5);
  model.selectService(cleaning, true);
  const rows = model.rows();
  assert.deepEqual(rows.map(row => row.unitPrice), [500,800,650]);
  assert.deepEqual(rows.map(row => row.hp), [1,2,1.5]);
  assert.deepEqual(rows.map(row => row.brand), ['Carrier','Midea','Other Brand']);
  assert.equal(rows[1].model, 'MODEL-2');
  assert.equal(model.estimate().total, 1950); assert.equal(model.estimate().minutes, 225);
  for (const row of rows) {
    const authoritative = resolveCoreServicePricing(catalog[0], row);
    assert.equal(authoritative.unitPrice, row.unitPrice); assert.equal(authoritative.duration, row.duration);
  }
});

test('copying only brand keeps each type, HP, model and service choice independent', () => {
  const model = fixture(); model.setDetailsMode('individual');
  model.setDetail(1, 'brand', 'Midea'); model.setDetail(1, 'hp', 2); model.setDetail(1, 'model', 'MODEL-2');
  model.setDetail(2, 'airconType', 'window'); model.setDetail(2, 'hp', 1.5);
  const before = model.activeUnits(); model.copy('brand');
  const after = model.activeUnits();
  assert.ok(after.every(unit => unit.brand === 'Carrier'));
  for (let index = 0; index < after.length; index++) for (const key of ['airconType','hp','model','key']) assert.equal(after[index][key], before[index][key]);
});

test('copying an incompatible HP refuses the entire copy without replacing other unit details', () => {
  const model = fixture(); model.setDetailsMode('individual');
  model.setDetail(1, 'airconType', 'window'); model.setDetail(1, 'hp', 1.5);
  const before = model.snapshot();
  assert.throws(() => model.copy('hp'), /Aircon 2/);
  assert.deepEqual(model.snapshot(), before);
  model.copy('airconType');
  assert.equal(model.activeUnits()[1].airconType, 'split'); assert.equal(model.activeUnits()[1].hp, null);
});

test('per-aircon services inherit common choices and additional tasks do not multiply physical unit count', () => {
  const model = fixture(); model.selectService(cleaning, true); model.setServicesMode('individual');
  model.selectService(recharge, true, 1);
  const rows = model.rows(), estimate = model.estimate();
  assert.equal(rows.length, 4); assert.equal(A.unitCount(rows), 3);
  assert.equal(estimate.tasks, 4); assert.equal(estimate.total, 2500); assert.equal(estimate.minutes, 270);
  assert.equal(rows[1].applianceGroupId, rows[2].applianceGroupId);
  const work = projectUnits({ unitGroups: buildUnitGroups({ services: rows }) });
  assert.equal(work.length, 3);
  assert.equal(work[1].serviceTasks.length, 2);
  assert.equal(work[1].durationMinutes, 150);
});

test('a service unavailable for one type can still be chosen for the compatible aircons', () => {
  const model = fixture(); model.setDetailsMode('individual');
  model.setDetail(2, 'airconType', 'window'); model.setDetail(2, 'hp', 1.5);
  model.selectService(cleaning, true);
  assert.throws(() => model.selectService(recharge, true), /per aircon/);
  model.setServicesMode('individual'); model.selectService(recharge, true, 0);
  assert.equal(model.rows().length, 4); assert.equal(model.estimate().total, 2650);
  assert.throws(() => model.selectService(recharge, true, 2), /per aircon/);
});

test('changing unit details never charges a stale unsupported service and lets the customer uncheck it', () => {
  const model = fixture(); model.setDetailsMode('individual'); model.selectService(cleaning, true); model.selectService(recharge, true);
  model.setDetail(2, 'airconType', 'window'); model.setDetail(2, 'hp', 1.5);
  assert.equal(model.estimate().ready, false); assert.throws(() => model.rows(), /Aircon 3/);
  model.selectService(recharge, false);
  assert.equal(model.estimate().ready, true); assert.equal(model.rows().length, 3);
});

test('every aircon needs complete details and at least one service before it is committed', () => {
  const model = fixture(); model.setDetailsMode('individual'); model.selectService(cleaning, true); model.setServicesMode('individual');
  model.selectService(cleaning, false, 1);
  assert.throws(() => model.rows(), /Aircon 2/);
  model.selectService(cleaning, true, 1); model.setDetail(1, 'brand', '');
  assert.equal(model.estimate().ready, false); assert.throws(() => model.rows(), /brand/);
});

test('reducing and increasing the quantity keeps the entered details but only bills active units', () => {
  const model = fixture(); model.setDetailsMode('individual'); model.setDetail(2, 'brand', 'Midea'); model.setDetail(2, 'hp', 2);
  model.selectService(cleaning, true);
  const keys = model.activeUnits().map(unit => unit.key);
  model.sync({ ...shared, quantity: 2 });
  assert.equal(model.rows().length, 2); assert.equal(model.estimate().total, 1000);
  model.sync(shared);
  assert.deepEqual(model.activeUnits().map(unit => unit.key), keys);
  assert.equal(model.activeUnits()[2].brand, 'Midea'); assert.equal(model.estimate().total, 1800);
});

test('saved drafts restore unit differences, independent services and stable appliance identities', () => {
  const original = fixture(); original.setDetailsMode('individual'); original.setDetail(1, 'hp', 2);
  original.selectService(cleaning, true); original.setServicesMode('individual'); original.selectService(recharge, true, 1);
  const restored = fixture(); restored.restore(JSON.parse(JSON.stringify(original.snapshot()))); restored.sync(shared);
  assert.deepEqual(restored.rows(), original.rows());
  restored.setDetailsMode('shared'); restored.setDetailsMode('individual');
  assert.equal(restored.activeUnits()[1].hp, 2);
  restored.setServicesMode('shared'); restored.setServicesMode('individual');
  assert.deepEqual(restored.activeUnits()[1].serviceIds, [cleaning,recharge]);
});

test('editing shared details before switching to individual units fills every unit with the latest values', () => {
  const model = fixture();
  model.sync({ ...shared, brand: 'Midea', hp: 2 });
  model.setDetailsMode('individual');
  assert.ok(model.activeUnits().every(unit => unit.brand === 'Midea' && unit.hp === 2));
});

test('returning from a single-unit edit updates its services and keeps the other units independent', () => {
  const model = fixture(); model.setDetailsMode('individual'); model.selectService(cleaning, true); model.setServicesMode('individual');
  model.setDetail(1, 'hp', 2); model.selectService(recharge, true, 1);
  const before = model.activeUnits();
  model.adoptSingleUnit({ ...shared, brand: 'Other Brand', hp: 2 }, [recharge]);
  assert.equal(model.activeUnits()[0].brand, 'Other Brand');
  assert.deepEqual(model.activeUnits()[0].serviceIds, [recharge]);
  assert.deepEqual(model.activeUnits().slice(1), before.slice(1));
  assert.equal(model.activeUnits()[0].key, before[0].key);
});

test('all forty aircons remain forty units when each has two Core service tasks', () => {
  const model = fixture(40); model.selectService(cleaning, true); model.selectService(recharge, true);
  assert.equal(model.rows().length, 80); assert.equal(A.unitCount(model.rows()), 40);
  assert.equal(model.sync({ ...shared, quantity: 41 }), false);
});

test('forged drafts cannot reuse unit identities or add unavailable services, and relocation remains separate', () => {
  const model = fixture(); const value = model.snapshot();
  value.units[1].key = value.units[0].key; value.units[2].key = '<invalid>';
  value.sharedServices = [cleaning,'unknown-service'];
  model.restore(value); model.sync(shared);
  assert.equal(new Set(model.rows().map(row => row.applianceGroupId)).size, 3);
  assert.throws(() => model.selectService('unknown-service', true), /available Core/);
  const moves = createModel([...catalog,{ _id:'move',name:'Aircon Relocation',slug:'aircon-relocation',basePrice:1000 }]);
  moves.sync(shared); assert.throws(() => moves.selectService('move', true), /available Core/);
  const before = model.snapshot();
  model.restore({ ...before, units: [null] });
  assert.deepEqual(model.snapshot(), before);
});
