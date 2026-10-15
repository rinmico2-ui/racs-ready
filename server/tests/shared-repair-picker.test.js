'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const api = require('../public/js/repair-appliance-booking');
const base = require('../public/js/appliance-services');
const categories = [{ slug: 'aircon', name: 'Aircon', unitTypes: [{ value: 'Split Aircon', label: 'Split', inspectionFee: 700 }, { value: 'Other', label: 'Other' }] },
  { slug: 'other', name: 'Other', isCustom: true, unitTypes: [{ value: 'Anything', label: 'Anything' }] }];
test('repair appliance choices omit Other from configured categories and fallback options', () => {
  assert.deepEqual(api.catalog(categories).map(unit => unit.value), ['Split Aircon']);
  assert.ok(api.catalog([]).some(unit => unit.value === 'Washing Machine'));
  assert.ok(api.catalog([]).every(unit => !/other/i.test(unit.value)));
  assert.deepEqual(api.catalog([{ slug: 'inactive', name: 'Inactive', active: false, unitTypes: [{ value: 'Hidden' }] }]), []);
});
test('repair draft identities survive catalog reordering', () => {
  const second = { slug: 'appliance', name: 'Appliances', unitTypes: [{ value: 'Washer', label: 'Washer' }] };
  const first = api.catalog([...categories, second]).find(unit => unit.value === 'Washer');
  const reordered = api.catalog([second, ...categories]).find(unit => unit.value === 'Washer');
  assert.equal(first.kind, reordered.kind);
});
function fixture() {
  let captured;
  const fields = { assistanceNotes: { value: 'The appliance does not cool anymore.' }, assistancePhotos: { files: [] } };
  const source = fs.readFileSync(path.join(__dirname, '../public/js/repair-appliance-booking.js'), 'utf8');
  const context = { crypto: require('node:crypto').webcrypto, window: { ApplianceServices: base,
    CoreApplianceBooking: { create: () => ({ mount(services, options) { captured = { services, options }; }, sync() {}, edit() {} }) } } };
  vm.runInNewContext(source, context);
  const state = { selectedServices: [] }, writes = [], requests = [];
  const component = context.window.RepairApplianceBooking.create();
  component.mount({ host: { querySelector: selector => fields[selector.match(/name="([^"]+)"/)[1]], addEventListener() {} }, state, categories,
    coreServices: [{ brands: ['Carrier'] }], defaultInspectionFee: 500, inspectionDuration: 120,
    commit: (...args) => writes.push(args), assistance: (...args) => { requests.push(args); return { id: 'request' }; } });
  return { captured, state, writes, requests, fields, component };
}
test('repair uses the shared builder with catalog inspection fees and produces repair rows without Core grouping', () => {
  const f = fixture(), options = f.captured.options;
  const selected = { applianceKind: options.adapter.kinds[0], brand: 'Carrier', model: 'MODEL-123', quantity: 2 };
  const rows = options.adapter.serviceLines([], selected);
  assert.equal(rows[0].unitPrice, 700); assert.equal(rows[0].totalPrice, 1400); assert.equal(rows[0].duration, 120);
  assert.equal(rows[0].type, 'repair'); assert.equal(rows[0].applianceGroupId, undefined); assert.equal(rows[0].applianceKind, undefined);
  assert.equal(rows[0].problemDescription, f.fields.assistanceNotes.value); assert.equal(base.unitCount(rows), 2);
  options.commit(rows, null); assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0].model, 'MODEL-123');
});
test('repair staff requests carry the selected appliance and problem without hidden model, brand or Core service fields', async () => {
  const f = fixture(), options = f.captured.options;
  await options.assistance({ applianceKind: options.adapter.kinds[0], serviceId: 'repair-inspection', brand: 'STALE', model: 'STALE', notes: 'The appliance does not cool anymore.', quantity: 2, clientRequestId: 'request-token' }, []);
  const payload = f.requests[0][0];
  assert.equal(payload.requestType, 'repair'); assert.equal(payload.repairUnitType, 'Split Aircon'); assert.equal(payload.repairUnitCategory, 'aircon');
  assert.equal(payload.problemDescription, 'The appliance does not cool anymore.');
  assert.equal(payload.brand, undefined); assert.equal(payload.model, undefined); assert.equal(payload.serviceId, undefined);
});

test('repair editing retains only that saved appliance photos and a new appliance cannot inherit them', () => {
  const f = fixture(), options = f.captured.options;
  f.state.selectedServices.push({ id: 'repair-old', type: 'repair', unitType: 'Split Aircon', photos: ['saved-photo.jpg'], quantity: 1 });
  const selected = { applianceKind: options.adapter.kinds[0], brand: 'Carrier', model: 'MODEL-123', quantity: 1 };
  assert.deepEqual(Array.from(options.adapter.serviceLines([], selected, [], 'repair-old')[0].photos), ['saved-photo.jpg']);
  assert.equal(options.adapter.serviceLines([], selected, [], 'appliance-new')[0].photos.length, 0);
});
test('editing an unavailable old appliance leaves the saved row intact and reports why it cannot be selected', () => {
  const f = fixture(); f.state.selectedServices.push({ _id: 'old', type: 'repair', unitType: 'Other', unitCategory: 'other', quantity: 1 });
  assert.throws(() => f.component.edit('old'), /no longer available/); assert.equal(f.state.selectedServices.length, 1); assert.equal(f.writes.length, 0);
});
