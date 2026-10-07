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
    relocation: { scope: 'custom_quote', to: { address: '123 New Street, Manila', lat: 14.6, lng: 121.0 }, notes: 'Second floor' } };
  const context = {
    BookingState: { customerLocation: { address: '45 Old Street, Quezon City', lat: 14.7, lng: 121.1 }, selectedDate: new Date('2027-01-20T00:00:00Z') },
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
  assert.equal(calls[0].payload.from.lat, 14.7);
  assert.equal(calls[0].payload.to.lng, 121.0);
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
    from: { address: 'Quezon City, current property', lat: 14.7, lng: 121.1 },
    to: { address: 'Manila, destination property', lat: 14.6, lng: 121.0 },
    preferredDate: new Date('2027-01-20'),
  });
  await request.validate();
  assert.equal(request.status, 'pending_review');
  assert.equal(request.to.lng, 121.0);
  assert.equal(request.bookingId, null);
  assert.equal(request.quote?.total, undefined);
  request.to.address = '';
  await assert.rejects(request.validate(), /address/i);
});

test('relocation preferred calendar selects a date without looking up or reserving time slots', async () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/enterprise-calendar.js'), 'utf8');
  const requests = [];
  const handlers = [];
  const calendarGrid = {
    innerHTML: '',
    querySelectorAll() {
      return [{ dataset: { date: chosenKey }, addEventListener(type, handler) { if (type === 'click') handlers.push(handler); } }];
    },
  };
  const chosen = new Date();
  chosen.setDate(chosen.getDate() + 3);
  const chosenKey = `${chosen.getFullYear()}-${String(chosen.getMonth() + 1).padStart(2, '0')}-${String(chosen.getDate()).padStart(2, '0')}`;
  const document = {
    getElementById: name => name === 'calendarGrid' ? calendarGrid : null,
    createElement: () => ({}),
    head: { appendChild() {} },
  };
  const window = { BookingState: { selectedServices: [], selectedTimeSlot: { startTime: '09:00' } }, saveBookingProgress() {}, syncScheduleNextAction() {} };
  const context = { document, window, console, URLSearchParams, setTimeout,
    fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => url.includes('projects') ? { projects: [] } : url.includes('holidays') ? { holidays: [], nonWorkingDays: [] } : {} };
    },
  };
  vm.runInNewContext(script, context);
  await window.EnterpriseCalendar.init({ mode: 'preferred', totalEstimatedMinutes: 1200 });
  assert.equal(window.EnterpriseCalendar.getMode(), 'preferred');
  assert.match(calendarGrid.innerHTML, /Choose a preferred day/);
  assert.equal(requests.some(url => url.includes('available-dates') || url.includes('available-times') || url.includes('window-availability')), false);
  await handlers.at(-1)();
  assert.equal(window.EnterpriseCalendar.formatDateKey(window.BookingState.selectedDate), chosenKey);
  assert.equal(window.BookingState.selectedTimeSlot, null);
  assert.equal(requests.some(url => url.includes('time-slots')), false);
});

test('mapping a relocation destination keeps the current pin and updates the move path', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
  const implementation = script.slice(script.indexOf('function setRelocationDestinationPin('), script.indexOf('async function searchRelocationDestination()'));
  const paths = [];
  const marker = (point, options) => ({
    point, options, handlers: {},
    addTo() { return this; }, setLatLng(next) { this.point = next; return this; },
    bindPopup() { return this; }, off(name) { delete this.handlers[name]; },
    on(name, handler) { this.handlers[name] = handler; },
    getLatLng() { return { lat: this.point[0], lng: this.point[1] }; },
  });
  const currentPin = marker([14.7, 121.1], {});
  const map = { removeLayer() {}, fitBounds() {}, setView() {} };
  const item = { relocation: { scope: 'custom_quote', to: { address: '123 New Street, Manila' } } };
  const state = { map, userMarker: currentPin, userCoordinates: { lat: 14.7, lng: 121.1 } };
  const context = {
    BookingState: state, activeRelocationItem: () => item,
    isWithinPhilippinesMapBounds: (lat, lng) => lat >= 4.5 && lat <= 21.5 && lng >= 116 && lng <= 127,
    escapeServiceMapText: value => value, syncRelocationMapSummary() {}, syncLocationContinueAction() {}, scheduleBookingProgressSave() {},
    document: { getElementById: () => ({ textContent: '' }) },
    L: {
      divIcon: value => value, marker,
      polyline: points => { paths.push(points); return { addTo() { return this; } }; },
      featureGroup: () => ({ getBounds: () => ({}) }),
    },
  };
  vm.runInNewContext(implementation, context);
  context.setRelocationDestinationPin(14.6, 121.0);
  assert.equal(state.userMarker, currentPin);
  assert.deepEqual(Array.from(paths[0][0]), [14.7, 121.1]);
  assert.deepEqual(Array.from(paths[0][1]), [14.6, 121.0]);
  assert.equal(item.relocation.to.lat, 14.6);
  state.relocationDestinationMarker.setLatLng([14.61, 121.01]);
  state.relocationDestinationMarker.handlers.dragend({ target: state.relocationDestinationMarker });
  assert.equal(item.relocation.to.lng, 121.01);
  assert.deepEqual(Array.from(paths.at(-1)[1]), [14.61, 121.01]);
});

test('a relocation booking item preserves both locations, quote and existing asset link', async () => {
  const booking = new BookingService({
    customerId: id(1), bookingDate: new Date('2027-01-20'), downpaymentAmount: 100,
    services: [{ name: 'Aircon Relocation', type: 'core', quantity: 1,
      relocation: {
        scope: 'custom_quote', requestId: id(3), assetId: id(4),
        from: { address: 'Old address', lat: 14.7, lng: 121.1 }, to: { address: 'New address', lat: 14.6, lng: 121.0 },
        model: 'Model A', serialNumber: 'SN-123', completedTasks: ['removal.disconnect'],
      },
    }],
  });
  await booking.validate();
  const move = booking.toObject().services[0].relocation;
  assert.equal(move.to.address, 'New address');
  assert.equal(move.to.lat, 14.6);
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
