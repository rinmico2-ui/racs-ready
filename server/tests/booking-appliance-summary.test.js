"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const A = require('../public/js/appliance-services');
const source = fs.readFileSync(require.resolve('../public/js/services-multi.js'), 'utf8').replace(/\r\n/g, '\n');
const declaration = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const ends = ['\nfunction ', '\nasync function '].map(marker => source.indexOf(marker, start + 1)).filter(index => index >= 0);
  return source.slice(start, Math.min(...ends));
};
const core = (overrides = {}) => ({ id: 'install-first', type: 'core', serviceId: 'installation', name: 'Aircon Installation', applianceGroupId: 'appliance_panasonic_first', applianceKind: 'aircon', brand: 'Panasonic', airconType: 'split', airconTypeName: 'Split Type', hp: 1, quantity: 1, unitPrice: 3500, totalPrice: 3500, ...overrides });
const sample = () => [core(), core({ id: 'clean-first', serviceId: 'cleaning', name: 'Aircon Cleaning', unitPrice: 1200, totalPrice: 1200 }), core({ id: 'install-second', applianceGroupId: 'appliance_lg_second', brand: 'LG', airconType: 'floor_standing', airconTypeName: 'Floor Standing', hp: 2, unitPrice: 6000, totalPrice: 6000 })];
function fixture(rows = sample()) {
  const state = { selectedServices: structuredClone(rows) }, elements = new Map(), saves = [], messages = [];
  for (const name of ['selectedServiceCountText', 'mobileSelectedServiceCount', 'mobileEstimatedPrice', 'serviceGuideReviewText', 'bookingNextActionText', 'totalPricingSection']) elements.set(name, { textContent: '', classList: { add() {}, remove() {}, toggle() {} } });
  const list = { innerHTML: '', querySelectorAll: () => [] }, counter = { textContent: '' };
  const context = { BookingState: state, window: { ApplianceServices: A }, DOM: { selectedServicesList: list, selectedServiceCount: counter },
    document: { getElementById: id => elements.get(id) || null },
    selectedUnitTotal: () => A.unitCount(state.selectedServices), isRepairBookingService: row => row.type === 'repair', bookingServiceIcon: () => 'bi-snow',
    formatBookingPrice: value => 'PHP ' + Number(value).toLocaleString('en-US'),
    reconcileBookingScheduleAfterServiceChange() {}, syncRelocationDestination() {}, isAirconRelocationService: () => false,
    syncBookingActionBarLayer() {}, setServicePickerGuide() {}, syncServiceCardSelectionState() {}, updatePricingDisplay() {}, updateContinueButtonState() {},
    saveBookingProgress: () => saves.push(true), showBookingToast: message => messages.push(message) };
  vm.runInNewContext(['bookingSelectionSummary', 'updateBookingCartChrome', 'updateSelectedServicesDisplay', 'removeSelectedAppliance', 'commitCoreAppliance'].map(declaration).join('\n'), context);
  return { context, state, elements, list, counter, saves, messages };
}

test('two appliances with three service lines show two appliance cards and correct unit subtotals', () => {
  const f = fixture(); f.context.updateSelectedServicesDisplay();
  assert.equal(f.counter.textContent, '2 aircons');
  assert.equal(f.elements.get('mobileSelectedServiceCount').textContent, '2 aircons \u00b7 3 services');
  assert.equal(f.elements.get('serviceGuideReviewText').textContent, '2 aircons \u00b7 3 services');
  assert.match(f.elements.get('selectedServiceCountText').textContent, /3 services across 2 aircons/);
  assert.equal((f.list.innerHTML.match(/selected-appliance-item/g) || []).length, 2);
  assert.equal((f.list.innerHTML.match(/<li>/g) || []).length, 3);
  assert.match(f.list.innerHTML, /Aircon 1/); assert.match(f.list.innerHTML, /Aircon 2/);
  assert.match(f.list.innerHTML, /PHP 4,700/); assert.match(f.list.innerHTML, /PHP 6,000/);
  assert.equal(f.elements.get('mobileEstimatedPrice').textContent, 'PHP 10,700');
  assert.match(f.list.innerHTML, /editSelectedService\(0\)/); assert.match(f.list.innerHTML, /editSelectedService\(2\)/);
});

test('identical appliance details do not merge different physical identities or legacy entries', () => {
  const rows = sample(); rows[2] = { ...rows[0], id: 'same-details-second', applianceGroupId: 'appliance_identical_second' };
  assert.equal(A.applianceGroups(rows).length, 2);
  const legacy = rows.map(({ applianceGroupId, ...row }) => row);
  assert.equal(A.applianceGroups(legacy).length, 3);
  assert.equal(A.unitCount(legacy), 3);
});

test('nonadjacent services keep their own appliance and match the authoritative physical-unit count', () => {
  const rows = sample(); const grouped = A.applianceGroups([rows[0], rows[2], rows[1]]);
  assert.deepEqual(grouped.map(group => group.indexes), [[0, 2], [1]]);
  assert.equal(grouped.reduce((sum, group) => sum + group.quantity, 0), A.unitCount(rows));
});

test('legacy quantity groups count physical units once and retain per-unit prices', () => {
  const rows = sample().slice(0, 2).map(row => ({ ...row, quantity: 2, totalPrice: row.totalPrice * 2 }));
  const f = fixture(rows); f.context.updateSelectedServicesDisplay();
  assert.equal(f.counter.textContent, '2 aircons');
  assert.equal((f.list.innerHTML.match(/selected-appliance-item/g) || []).length, 1);
  assert.match(f.list.innerHTML, /Aircons 1\u20132/);
  assert.match(f.list.innerHTML, /PHP 9,400/); assert.match(f.list.innerHTML, /PHP 3,500 each/);
  assert.equal(f.context.bookingSelectionSummary().serviceCount, 4);
});

test('repair appliances stay separate with their issue and evidence intact', () => {
  const f = fixture([...sample(), { id: 'repair-washer', type: 'repair', unitType: 'Washing Machine', brand: 'Midea', quantity: 1, totalPrice: 600, problemDescription: 'Does not drain', photos: ['saved-photo'] }]);
  f.context.updateSelectedServicesDisplay();
  assert.equal(f.counter.textContent, '3 appliances');
  assert.equal(f.context.bookingSelectionSummary().groups.length, 3);
  assert.match(f.list.innerHTML, /Does not drain/); assert.match(f.list.innerHTML, /1 photo/);
  assert.match(f.list.innerHTML, /Washing Machine 1/);
});

test('removing an appliance removes all its services and preserves the other appliance and totals', () => {
  const f = fixture(), other = f.state.selectedServices[2];
  f.context.removeSelectedAppliance(0);
  assert.equal(f.state.selectedServices.length, 1); assert.equal(f.state.selectedServices[0], other);
  assert.equal(f.counter.textContent, '1 aircon');
  assert.equal(f.elements.get('mobileEstimatedPrice').textContent, 'PHP 6,000');
  assert.equal(f.saves.length, 1); assert.match(f.messages[0], /Aircon 1 and its services/);
  f.context.removeSelectedAppliance(-1); f.context.removeSelectedAppliance(9); f.context.removeSelectedAppliance('0');
  assert.equal(f.state.selectedServices.length, 1); assert.equal(f.saves.length, 1);
});

test('editing the first appliance keeps its position, identity and the other appliance unchanged', () => {
  const f = fixture(), other = f.state.selectedServices[2];
  const replacement = { ...f.state.selectedServices[0] };
  f.context.commitCoreAppliance([replacement], replacement.applianceGroupId);
  assert.equal(f.state.selectedServices[0], replacement);
  assert.equal(f.state.selectedServices[1], other);
  const groups = f.context.bookingSelectionSummary().groups;
  assert.equal(groups[0].primary.brand, 'Panasonic'); assert.equal(groups[0].title, 'Aircon 1');
  assert.equal(groups[1].primary.brand, 'LG'); assert.equal(groups[1].title, 'Aircon 2');
  const before = [...f.state.selectedServices];
  assert.throws(() => f.context.commitCoreAppliance([replacement], 'appliance_removed_before_save'), /changed/);
  assert.deepEqual(f.state.selectedServices, before);
});

test('saved names and unit details remain text in the grouped summary', () => {
  const f = fixture([core({ brand: '<img src=x onerror=alert(1)>', name: '<script>bad</script>' })]);
  f.context.updateSelectedServicesDisplay();
  assert.doesNotMatch(f.list.innerHTML, /<img|<script/);
  assert.match(f.list.innerHTML, /&lt;img/); assert.match(f.list.innerHTML, /&lt;script/);
});
