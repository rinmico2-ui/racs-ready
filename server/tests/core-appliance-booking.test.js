'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('../public/js/appliance-services');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const { validateBookingUnitLimit } = require('../utils/bookingUnitLimit');
const { normalizeCoreServicePayload } = require('../utils/serviceCatalogPayload');
const { projectUnits } = require('../utils/projectWorkOrderPlanning');
const { buildUnitGroups } = require('../utils/repairUnitWorkflow');
const { bookingAssetSeeds } = require('../utils/maintenanceLifecycle');
const CoreService = require('../models/CoreService'), Booking = require('../models/BookingService'), Project = require('../models/Project'), WorkOrder = require('../models/WorkOrder');
const catalog = [{ _id: '6acd3b47678aa45bd94a7354', name: 'Aircon Cleaning', isAirconService: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }] },
  { _id: '6acd3b47678aa45bd94a7355', name: 'Freon Recharging', isAirconService: true, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 800, durationMinutes: 90 }] }], applianceProfiles: [{ kind: 'refrigerator', enabled: true, unitPrice: 900, durationMinutes: 75 }, { kind: 'freezer', enabled: false }] }];
const selection = { applianceKind: 'aircon', brand: 'Carrier', model: 'Nexus', airconType: 'split', hp: 1, quantity: 1 };
function lines(quantity = 1) { return A.serviceLines(catalog, { ...selection, quantity }, catalog.map(service => service._id), 'appliance_test_group'); }
test('one appliance with two services keeps one physical unit and two independently priced tasks', () => {
  const rows = lines(); assert.equal(validateBookingUnitLimit(rows), 1);
  assert.equal(rows.reduce((total, item) => total + item.totalPrice, 0), 1300);
  assert.equal(rows.reduce((total, item) => total + item.duration * item.quantity, 0), 150);
  assert.equal(validateBookingUnitLimit(lines(40)), 40);
  assert.equal(validateBookingUnitLimit(lines(4)), 4, 'four aircons are not eight units');
});
test('shared quantities, details and unique services are enforced against forged grouping', () => {
  for (const changes of [{ quantity: 2 }, { brand: 'Midea' }, { model: 'Different' }, { hp: 2 }, { applianceKind: 'freezer' }, { type: 'repair' }, { serviceId: catalog[0]._id }]) {
    const rows = lines(); Object.assign(rows[1], changes); assert.throws(() => validateBookingUnitLimit(rows));
  }
  assert.throws(() => validateBookingUnitLimit([...lines(40), { serviceId: 'other', quantity: 1 }]), /40/);
  assert.throws(() => validateBookingUnitLimit([{ ...lines()[0], applianceGroupId: '<invalid>' }]));
});
test('legacy independent service rows keep their existing counts', () => {
  assert.equal(validateBookingUnitLimit([{ quantity: 2 }, { quantity: 3, type: 'repair' }]), 5);
});
test('the remaining allowance includes repairs and other appliance groups, without counting shared tasks twice', () => {
  const rows = [...lines(12), { type: 'repair', quantity: 3 }];
  assert.equal(A.remainingUnits(rows), 25);
  assert.equal(A.remainingUnits(rows, 'appliance_test_group'), 37);
  assert.equal(A.remainingUnits(lines(40)), 0);
  assert.equal(A.remainingUnits(lines(40), 'appliance_test_group'), 40);
});
test('booking-history quantity edits update every task for one appliance atomically', () => {
  const rows = lines(); A.setQuantity(rows, 0, 3);
  assert.equal(A.unitCount(rows), 3); assert.equal(rows[1].quantity, 3); assert.equal(rows[0].totalPrice, 1500); assert.equal(rows[1].totalPrice, 2400);
  const before = JSON.stringify(rows); assert.throws(() => A.setQuantity(rows, 1, 41)); assert.equal(JSON.stringify(rows), before);
});
test('refrigeration uses its configured price and duration without aircon HP', () => {
  const result = resolveCoreServicePricing(catalog[1], { applianceKind: 'refrigerator', brand: 'Midea', quantity: 2 });
  assert.equal(result.unitPrice, 900); assert.equal(result.totalPrice, 1800); assert.equal(result.duration, 75); assert.equal(result.hp, null); assert.equal(result.airconType, null);
  assert.throws(() => resolveCoreServicePricing(catalog[0], { applianceKind: 'refrigerator', brand: 'Midea', quantity: 1 }), /not available/);
  assert.throws(() => resolveCoreServicePricing(catalog[1], { applianceKind: 'freezer', brand: 'Midea', quantity: 1 }), /not available/);
  const withHp = resolveCoreServicePricing(catalog[1], { applianceKind: 'refrigerator', brand: 'Midea', hp: 0.125, quantity: 1 });
  assert.equal(withHp.unitPrice, 900, 'a known compressor HP does not change a fixed price');
  assert.equal(withHp.hp, 0.125);
});
test('prices come from the catalog and unsupported or unpriced choices cannot be booked', () => {
  assert.equal(resolveCoreServicePricing(catalog[0], { ...selection, unitPrice: 1 }).unitPrice, 500);
  assert.throws(() => A.price({ ...catalog[1], applianceProfiles: [{ kind: 'freezer', enabled: true }] }, { applianceKind: 'freezer', brand: 'Midea' }), /set a price/);
  assert.throws(() => A.price(catalog[0], { ...selection, hp: 20 }), /unavailable/);
  assert.throws(() => A.price(catalog[0], { ...selection, applianceKind: 'washer' }), /supported appliance/);
});
test('staff multipart settings validate and persist refrigeration compatibility', async () => {
  const payload = normalizeCoreServicePayload({ name: 'Leak Testing', slug: 'leak-testing', category: 'Maintenance', applianceProfiles: JSON.stringify([{ kind: 'freezer', enabled: true, unitPrice: 700, durationMinutes: 60 }]) });
  const service = new CoreService(payload); await service.validate(); assert.equal(service.applianceProfiles[0].unitPrice, 700);
  for (const profile of [{ kind: 'washer', enabled: true }, { kind: 'freezer', enabled: 'false' }, { kind: 'freezer', enabled: true, unitPrice: 0, durationMinutes: 0 }, { kind: 'freezer', enabled: true, durationMinutes: 20 }]) assert.throws(() => normalizeCoreServicePayload({ applianceProfiles: [profile] }));
  assert.throws(() => normalizeCoreServicePayload({ applianceProfiles: [{ kind: 'freezer', enabled: false }, { kind: 'freezer', enabled: false }] }));
});
test('booking and project schemas preserve shared appliance identity and model', async () => {
  const booking = new Booking({ services: lines(4), isMultiService: true });
  assert.equal(booking.services[0].applianceGroupId, 'appliance_test_group'); assert.equal(booking.services[0].model, 'Nexus');
  const groups = buildUnitGroups(booking);
  const project = new Project({ unitGroups: groups, totalUnits: 4 });
  assert.equal(project.unitGroups[1].applianceGroupId, groups[0].applianceGroupId);
});
test('project planning schedules every selected task on each physical appliance without truncation', () => {
  const services = lines(8), groups = buildUnitGroups({ services });
  const units = projectUnits({ totalUnits: 8, unitGroups: groups });
  assert.equal(units.length, 8); assert.equal(units[0].durationMinutes, 150);
  assert.deepEqual(units[0].serviceTasks.map(task => task.name), ['Aircon Cleaning', 'Freon Recharging']);
  assert.equal(units[0].serviceName, 'Aircon Cleaning + Freon Recharging');
  const order = new WorkOrder({ units }); assert.equal(order.units[0].serviceTasks.length, 2);
});
test('the real project generator preserves both tasks and combined work time in saved work orders', async t => {
  const project = new Project({ totalUnits: 8, quantity: 8, unitGroups: buildUnitGroups({ services: lines(8) }), assignedTechnicians: [], totalWorkOrders: 0 });
  const created = [];
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(Project.prototype, 'save', async function () { return this; });
  t.mock.method(WorkOrder, 'find', () => ({ sort() { return this; }, lean: async () => created.map(order => order.toObject()) }));
  t.mock.method(WorkOrder, 'create', async input => { const order = new WorkOrder(input); created.push(order); return order; });
  t.mock.method(WorkOrder.prototype, 'save', async function () { return this; });
  const result = await require('../utils/projectScheduler').generateWorkOrders(project._id, { mode: 'appliance' });
  assert.equal(result.readiness.totalUnits, 8); assert.equal(result.readiness.ready, true);
  assert.equal(created.reduce((total, order) => total + order.unitCount, 0), 8);
  assert.equal(created.reduce((total, order) => total + order.estimatedHours, 0), 20);
  assert.equal(created[0].units[0].serviceTasks.length, 2);
  assert.ok(created[0].checklist.some(item => item.label === 'Complete Aircon Cleaning'));
  assert.ok(created[0].checklist.some(item => item.label === 'Complete Freon Recharging'));
});
test('aftercare creates one saved asset for each physical appliance with several services', () => {
  const seeds = bookingAssetSeeds({ _id: 'booking1', customerId: 'customer1', services: lines(2), location: { address: 'Site', lat: 15, lng: 121 } });
  assert.equal(seeds.length, 2); assert.equal(new Set(seeds.map(seed => seed.assetKey)).size, 2);
  assert.equal(seeds[0].equipment.brand, 'Carrier'); assert.equal(seeds[0].serviceAddress, 'Site');
});
