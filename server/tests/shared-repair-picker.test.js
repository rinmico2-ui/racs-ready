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
  const selected = { applianceKind: options.adapter.kinds[0], brand: 'Carrier', model: 'MODEL-123', quantity: 1, hp: 1 };
  const rows = options.adapter.serviceLines([], selected);
  assert.equal(rows[0].unitPrice, 700); assert.equal(rows[0].totalPrice, 700); assert.equal(rows[0].duration, 120); assert.equal(rows[0].hp, 1);
  assert.equal(rows[0].type, 'repair'); assert.equal(rows[0].applianceGroupId, undefined); assert.equal(rows[0].applianceKind, undefined);
  assert.equal(rows[0].problemDescription, f.fields.assistanceNotes.value); assert.equal(base.unitCount(rows), 1);
  options.commit(rows, null); assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0].model, 'MODEL-123');
});

test('repair availability uses the inspection catalog rather than the core appliance pricing validator', () => {
  const f=fixture(),{adapter}=f.captured.options;
  const selected={applianceKind:adapter.kinds[0],quantity:1,hp:1,brand:'Carrier'};
  const result=adapter.availability(f.captured.services[0],selected);
  assert.equal(result.available,true);assert.equal(result.pricing.unitPrice,700);assert.equal(result.pricing.duration,120);
  assert.equal(adapter.price(f.captured.services[0],selected).unitPrice,result.pricing.unitPrice);
  assert.match(f.captured.options.priceNotice(selected,{unknown:false}).value,/700/);
  assert.match(f.captured.options.priceNotice(selected,{unknown:true}).value,/Pending staff confirmation/);
  assert.equal(adapter.availability(f.captured.services[0],{...selected,applianceKind:'missing'}).available,false);
});

test('inspection fee display preserves configured, default and free rates and rejects corrupt prices', () => {
  assert.equal(api.inspectionFee({inspectionFee:650},400),650);
  assert.equal(api.inspectionFee({},400),400);assert.equal(api.inspectionFee({inspectionFee:''},400),400);
  assert.equal(api.inspectionFee({inspectionFee:0},400),0);
  for(const value of [-1,Infinity,NaN,true,{},'bad',100001])assert.throws(()=>api.inspectionFee({inspectionFee:value},400),/fee is unavailable/);
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
  const selected = { applianceKind: options.adapter.kinds[0], brand: 'Carrier', model: 'MODEL-123', quantity: 1, hp: 1 };
  assert.deepEqual(Array.from(options.adapter.serviceLines([], selected, [], 'repair-old')[0].photos), ['saved-photo.jpg']);
  assert.equal(options.adapter.serviceLines([], selected, [], 'appliance-new')[0].photos.length, 0);
});
test('editing an unavailable old appliance leaves the saved row intact and reports why it cannot be selected', () => {
  const f = fixture(); f.state.selectedServices.push({ _id: 'old', type: 'repair', unitType: 'Other', unitCategory: 'other', quantity: 1 });
  assert.throws(() => f.component.edit('old'), /no longer available/); assert.equal(f.state.selectedServices.length, 1); assert.equal(f.writes.length, 0);
});

test('repair suggestions match the appliance and remain editable reported symptoms', () => {
  const f = fixture(), options = f.captured.options;
  const choices = options.problemSuggestions({ applianceKind: options.adapter.kinds[0] });
  assert.ok(choices.some(row => row.label === 'Not cooling'));
  assert.ok(choices.every(row => row.text.length >= 10));
  const washer = api.problemSuggestions({ category: 'appliance', value: 'Washing Machine' });
  assert.ok(washer.some(row => row.label === 'Not draining'));
  assert.ok(!washer.some(row => row.label === 'Not cooling'));
  const symptom = choices[0].text;
  f.fields.assistanceNotes.value = options.toggleProblem('It started yesterday after lunch.', symptom);
  const row = options.adapter.serviceLines([], { applianceKind: options.adapter.kinds[0], brand: 'Carrier', quantity: 1, hp: 1 })[0];
  assert.equal(row.problemDescription, `It started yesterday after lunch.\n${symptom}`);
  assert.equal(options.toggleProblem(row.problemDescription, symptom), 'It started yesterday after lunch.');
  assert.equal(options.toggleProblem('I think it is not cooling sometimes.', symptom), `I think it is not cooling sometimes.\n${symptom}`);
});

test('suggestions respect the description limit without losing or duplicating customer notes', () => {
  const text = api.problemSuggestions({ category: 'aircon' })[0].text;
  assert.throws(() => api.toggleProblem('a'.repeat(490), text), /500 characters/);
  assert.equal(api.toggleProblem(text, text), '');
  assert.equal(api.toggleProblem(`Custom note.\n${text}\nKeep this note.`, text), 'Custom note.\nKeep this note.');
});

test('the repair suggestion button updates the real notes input and dispatches the normal draft-change event', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/core-appliance-booking.js'), 'utf8');
  const start = source.indexOf("    host.addEventListener('click', event => {"), end = source.indexOf('    const submit = event => {', start);
  let click, inputEvents = 0, focused = 0, error;
  const choice = api.problemSuggestions({ category: 'aircon' })[0];
  const notes = { value: 'Since yesterday.', maxLength: 500, dispatchEvent(event) { assert.equal(event.type, 'input'); assert.equal(event.bubbles, true); inputEvents++; }, focus() { focused++; } };
  const host = { addEventListener(_name, handler) { click = handler; } };
  const hooks = { repair: true, problemSuggestions: () => [choice], toggleProblem: api.toggleProblem };
  vm.runInNewContext(source.slice(start, end), { host, hooks, selection: () => ({}), field: () => notes, Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, message: value => { error = value; } });
  const button = { dataset: { problemSuggestion: choice.text } };
  const event = { target: { closest: selector => selector === '[data-problem-suggestion]' ? button : null } };
  click(event); assert.equal(notes.value, `Since yesterday.\n${choice.text}`); assert.equal(inputEvents, 1); assert.equal(focused, 1);
  click(event); assert.equal(notes.value, 'Since yesterday.');
  notes.value = 'a'.repeat(490); click(event); assert.equal(notes.value.length, 490); assert.match(error, /500 characters/); assert.equal(inputEvents, 2);
});
