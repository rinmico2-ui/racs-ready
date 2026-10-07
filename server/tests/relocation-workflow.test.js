const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RelocationRequest = require('../models/RelocationRequest');
const BookingService = require('../models/BookingService');
const CustomerAsset = require('../models/CustomerAsset');
const { RELOCATION_STAGES, taskKeys, allTasksComplete } = require('../utils/relocationChecklist');

const id = n => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

test('custom quote submission reuses the pinned origin and scheduled date without booking payment', async () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../views/pages/services.ejs'), 'utf8');
  const implementation = script.slice(script.indexOf('async function submitRelocationQuoteRequest()'), script.indexOf('async function loadRelocationAssets()'));
  assert.doesNotMatch(implementation, /relocationFromAddress|relocationPreferredDate|relocationToAddress/);
  assert.doesNotMatch(view, /cfgUnknownBrandBtn/);
  assert.match(view, /id="relocationDestinationAddress"/);
  assert.match(script, /<option value="__unknown__">I don\\'t know the unit details<\/option>/);

  const calls = [];
  const item = { serviceId: id(2), brand: "I don't know", hp: null,
    relocation: { scope: 'custom_quote', to: { address: '123 New Street, Manila' }, notes: 'Second floor' } };
  const context = {
    BookingState: { customerLocation: { address: '45 Old Street, Quezon City' }, selectedDate: new Date('2027-01-20T00:00:00Z') },
    pendingRelocationQuoteItem: () => item,
    serializeBookingDate: date => date.toISOString(),
    fetch: async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return { ok: true, json: async () => ({ id: id(3) }) }; },
    clearBookingProgress: () => calls.push({ cleared: true }),
    showError: message => { throw new Error(message); },
    window: { location: { assign: url => calls.push({ redirected: url }) } },
  };
  vm.runInNewContext(implementation, context);
  assert.equal(await context.submitRelocationQuoteRequest(), true);
  assert.equal(calls[0].url, '/api/relocations');
  assert.equal(calls[0].payload.from.address, '45 Old Street, Quezon City');
  assert.equal(calls[0].payload.to.address, '123 New Street, Manila');
  assert.equal(calls[0].payload.preferredDate, '2027-01-20T00:00:00.000Z');
  assert.equal(calls[0].payload.unit.brand, '');
  assert.deepEqual(calls.slice(1), [{ cleared: true }, { redirected: '/relocation-requests' }]);
});

test('selecting a saved aircon reuses its brand and exact catalog type and HP', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
  const implementation = script.slice(script.indexOf('function selectSavedRelocationHp('), script.indexOf('async function loadRelocationAssets()'));
  const status = { textContent: '', classList: { remove() {}, toggle() {} } };
  const assetSelect = { dataset: {}, value: id(4) };
  const checkbox = { value: '1.5', checked: false, dispatchEvent(event) { this.lastEvent = event.type; } };
  const card = { dataset: { type: 'split' }, classList: { add() {} }, setAttribute() {} };
  const fields = new Map([['relocationAssetStatus', status], ['relocationAsset', assetSelect]]);
  const container = { querySelectorAll(selector) { return selector.includes('hp-checkbox') ? [checkbox] : [card]; } };
  const type = { type: 'split', name: 'Split Type', hpPricing: [{ hp: 1.5, price: 2500 }] };
  const state = { currentService: { name: 'Aircon Relocation', airconTypes: [type] }, selectedBrand: '' };
  const context = {
    BookingState: state,
    Event: class { constructor(eventType) { this.type = eventType; } },
    document: { getElementById: id => fields.get(id), querySelector: () => ({ value: 'same_property' }) },
    isAirconRelocationService: () => true,
    activeAirconConfigurationContainer: () => container,
    showBrandSection() {}, showAirconTypeStep() {}, renderHpOptionsForType() {}, syncConfigurationPrimaryAction() {},
  };
  vm.runInNewContext(implementation, context);
  context.applySavedRelocationAsset({ equipment: {
    brand: 'Carrier', applianceType: 'split', capacity: '1.5 HP', capacityUnit: 'HP',
    model: 'Nexus Inverter', serialNumber: 'SN-123',
  } });
  assert.equal(state.selectedBrand, 'Carrier');
  assert.equal(state.selectedAirconType, type);
  assert.equal(assetSelect.dataset.savedHp, '1.5');
  assert.equal(assetSelect.dataset.savedType, 'split');
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.lastEvent, 'change');
  assert.equal(status.textContent.includes('were filled from your saved aircon'), true);
});

test('a generic saved aircon reuses its brand and HP but still asks for its type', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
  const implementation = script.slice(script.indexOf('function selectSavedRelocationHp('), script.indexOf('async function loadRelocationAssets()'));
  const status = { textContent: '', classList: { remove() {}, toggle() {} } };
  const assetSelect = { dataset: {}, value: id(4) };
  const fields = new Map([['relocationAssetStatus', status], ['relocationAsset', assetSelect]]);
  const state = { currentService: { name: 'Aircon Relocation', airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1.5 }] }] }, selectedBrand: '' };
  let typeStepShown = false;
  const context = {
    BookingState: state,
    document: { getElementById: id => fields.get(id), querySelector: () => ({ value: 'same_property' }) },
    isAirconRelocationService: () => true,
    activeAirconConfigurationContainer: () => ({}),
    showBrandSection() {}, showAirconTypeStep() { typeStepShown = true; },
    renderHpOptionsForType() { throw new Error('Generic type must not be guessed'); },
  };
  vm.runInNewContext(implementation, context);
  context.applySavedRelocationAsset({ equipment: { brand: 'Carrier', applianceType: 'air_conditioner', capacity: '1.5', capacityUnit: 'HP' } });
  assert.equal(state.selectedBrand, 'Carrier');
  assert.equal(assetSelect.dataset.savedHp, '1.5');
  assert.equal(typeStepShown, true);
  assert.match(status.textContent, /Choose its aircon type/);
});

test('a relocation quote request requires both locations and starts before booking or assignment', async () => {
  const request = new RelocationRequest({
    customerId: id(1), serviceId: id(2), scope: 'custom_quote',
    from: { address: 'Quezon City, current property' },
    to: { address: 'Manila, destination property' },
    preferredDate: new Date('2027-01-20'),
  });
  await request.validate();
  assert.equal(request.status, 'pending_review');
  assert.equal(request.bookingId, null);
  assert.equal(request.quote?.total, undefined);
  request.to.address = '';
  await assert.rejects(request.validate(), /address/i);
});

test('a relocation booking item preserves both locations, quote and existing asset link', async () => {
  const booking = new BookingService({
    customerId: id(1), bookingDate: new Date('2027-01-20'), downpaymentAmount: 100,
    services: [{ name: 'Aircon Relocation', type: 'core', quantity: 1,
      relocation: {
        scope: 'custom_quote', requestId: id(3), assetId: id(4),
        from: { address: 'Old address' }, to: { address: 'New address' },
        model: 'Model A', serialNumber: 'SN-123', completedTasks: ['removal.disconnect'],
      },
    }],
  });
  await booking.validate();
  const move = booking.toObject().services[0].relocation;
  assert.equal(move.to.address, 'New address');
  assert.equal(String(move.assetId), id(4));
  assert.equal(move.serialNumber, 'SN-123');
  assert.equal(allTasksComplete(booking.services[0]), false);
});

test('completion requires all removal, transport, installation and testing tasks', () => {
  assert.deepEqual(RELOCATION_STAGES.map(stage => stage.key), ['removal', 'transport', 'installation', 'testing']);
  assert.equal(allTasksComplete({ relocation: { completedTasks: taskKeys.slice(0, -1) } }), false);
  assert.equal(allTasksComplete({ relocation: { completedTasks: taskKeys } }), true);
});

test('asset history links the move without replacing installation identity', async () => {
  const asset = new CustomerAsset({
    customerId: id(1), assetKey: 'order:test:unit-1', originType: 'order', originId: id(5), originItemKey: 'unit-1',
    equipment: { brand: 'Carrier', model: 'Model A', serialNumber: 'SN-123' },
    installationDate: new Date('2025-01-01'), serviceAddress: 'Old address',
    serviceHistory: [{ serviceType: 'aircon-relocation', bookingId: id(6), fromAddress: 'Old address', toAddress: 'New address' }],
  });
  await asset.validate();
  assert.equal(asset.equipment.serialNumber, 'SN-123');
  assert.equal(asset.serviceHistory[0].toAddress, 'New address');
  assert.equal(asset.installationDate.toISOString().slice(0, 10), '2025-01-01');
});
