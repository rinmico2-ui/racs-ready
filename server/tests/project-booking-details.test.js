'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const details = require('../public/js/project-booking-details');
const projectId = '6acd3b47678aa45bd94a7354', bookingId = '6acd3b3f678aa45bd94a733c';
function fixture(quantity = 7) {
  const units = Array.from({ length: quantity }, (_, index) => ({ unitIndex: index + 1, label: 'Appliance ' + (index + 1), problemDescription: index === 0 ? 'Makes noise in the bedroom' : 'Turns off by itself', status: 'pending', repairReview: { state: 'pending' } }));
  const group = { groupIndex: 0, serviceName: 'Midea Split Type Aircon', serviceType: 'repair', unitType: 'Split Type Aircon', brand: 'Midea', model: '', problemDescription: 'Making noise, Turns off by itself', quantity, units };
  return { project: { _id: projectId, bookingId, repair: { serviceType: 'repair', unitInfo: { unitType: '', brand: '', model: '', problemDescription: '' } }, unitGroups: [group] },
    booking: { _id: bookingId, bookingReference: 'RACS-TEST', services: [{ ...JSON.parse(JSON.stringify(group)), name: group.serviceName, type: 'repair' }], projectScheduling: { preferredStartDate: '2026-10-13', preferredCompletionDeadline: '2026-10-22', preferredWorkingDays: ['monday', 'tuesday'], preferredWorkingHours: { start: 'morning', end: '' } } } };
}
test('the reported project reads its seven Midea appliances instead of the empty legacy summary', () => {
  const data = fixture(), before = JSON.stringify(data), view = details.read(data);
  assert.equal(view.services.length, 1); assert.equal(view.services[0].quantity, 7);
  assert.equal(view.services[0].brand, 'Midea'); assert.equal(view.services[0].unitType, 'Split Type Aircon');
  assert.equal(view.services[0].problem, 'Making noise, Turns off by itself');
  assert.equal(view.services[0].units.length, 7);
  assert.equal(view.services[0].units[0].problem, 'Makes noise in the bedroom');
  assert.equal(view.services[0].units[1].problem, 'Turns off by itself');
  assert.equal(JSON.stringify(data), before, 'Reading never mutates project, booking, scope or payment data');
  const html = details.render(view, projectId);
  assert.match(html, /7 units/); assert.match(html, /Not recorded/); assert.match(html, /Review appliances and prices/);
});
test('forty appliances retain all separate labels and reported problems', () => {
  const data = fixture(40); data.project.unitGroups[0].units.forEach((unit, index) => { unit.problemDescription = 'Reported problem for appliance ' + index; });
  const view = details.read(data); assert.equal(view.services[0].units.length, 40);
  assert.equal(new Set(view.services[0].units.map(unit => unit.problem)).size, 40);
});
test('missing project metadata falls back to the matching booking group without replacing review or progress', () => {
  const data = fixture(); const group = data.project.unitGroups[0];
  group.brand = ''; group.unitType = 'Unknown'; group.units[0].repairReview.state = 'declined'; group.units[0].status = 'skipped';
  data.booking.services[0].model = 'Saved model'; data.booking.services[0].units[0].repairReview = { state: 'pending' };
  const view = details.read(data); assert.equal(view.services[0].model, 'Saved model'); assert.equal(view.services[0].brand, 'Midea');
  assert.equal(view.services[0].unitType, 'Split Type Aircon'); assert.equal(view.services[0].units[0].state, 'declined'); assert.equal(view.services[0].units[0].status, 'skipped');
});
test('a project without unit groups can show the linked booking services and legacy appliance info', () => {
  const data = fixture(); data.project.unitGroups = [];
  assert.equal(details.read(data).services[0].brand, 'Midea');
  data.booking.services = []; data.booking.unitInfo = { brand: 'Carrier', model: 'Legacy model', unitType: 'Window Type', problemDescription: 'Cooling is weak in the room' };
  data.booking.quantity = 2;
  const view = details.read(data); assert.equal(view.services[0].brand, 'Carrier'); assert.equal(view.services[0].model, 'Legacy model'); assert.equal(view.services[0].quantity, 2);
});
test('unrelated bookings and nonmatching service IDs cannot fill missing appliance details', () => {
  const data = fixture(); data.project.unitGroups[0].brand = ''; data.booking._id = 'another-booking';
  assert.equal(details.read(data).services[0].brand, '');
  data.booking._id = bookingId; data.project.unitGroups[0].serviceId = 'repair-A'; data.booking.services[0].serviceId = 'repair-B';
  assert.equal(details.read(data).services[0].brand, '');
});
test('mixed projects show core and repair groups without treating all units as repairs', () => {
  const data = fixture(); data.project.unitGroups.push({ groupIndex: 1, serviceName: 'Aircon Installation', serviceType: 'core', quantity: 2, brand: 'Carrier', hp: 1.5 });
  const view = details.read(data); assert.equal(view.services.length, 2); assert.equal(view.hasRepair, true);
  assert.equal(view.services[1].type, 'core'); assert.equal(view.services[1].hp, 1.5);
  assert.match(details.render(view, projectId), /Requested services and units/);
});
test('customer preferences stay separate from an admin revised final work schedule', () => {
  const data = fixture(); data.project.preferredStartDate = '2026-10-18'; data.project.preferredWorkingHours = { start: '09:00', end: '17:00' };
  const view = details.read(data); assert.equal(view.startDate, '2026-10-13'); assert.equal(view.endDate, '2026-10-22');
  assert.equal(details.arrivalLabel(view.arrival), 'Morning (8:00 AM–12:00 PM)');
  assert.equal(details.dateLabel('2026-10-12T16:00:00.000Z'), 'Oct 13, 2026');
  assert.equal(details.arrivalLabel({ start: '09:00', end: '' }), '09:00');
});
test('saved user text is escaped and missing fields do not appear as invented values', () => {
  const data = fixture(); data.project.unitGroups[0].brand = '<img src=x onerror=alert(1)>'; data.project.unitGroups[0].units[0].problemDescription = '<script>alert(1)</script>';
  const html = details.render(details.read(data), projectId);
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
  assert.match(html, /Not recorded/); assert.doesNotMatch(html, /Repair price:/);
});

test('service location falls back to the linked booking and displays its saved pin instead of the customer home address', () => {
  const data = fixture(); data.project.customer = { address: 'Customer home address' };
  data.booking.location = { address: 'The service site', lat: 15.434653, lng: 121.075552 };
  const before = JSON.stringify(data), view = details.read(data), html = details.render(view, projectId);
  assert.equal(view.location.address, 'The service site'); assert.equal(view.location.hasPin, true);
  assert.match(html, /Service location/); assert.match(html, /The service site/);
  assert.match(html, /query=15.434653%2C121.075552/); assert.match(html, /View map pin/);
  assert.doesNotMatch(html, /Customer home address/); assert.equal(JSON.stringify(data), before);
});

test('a revised project site does not borrow an older booking pin for a different address', () => {
  const data = fixture(); data.project.location = { address: 'Revised service site' };
  data.booking.location = { address: 'Original service site', lat: 15, lng: 121 };
  const view = details.read(data); assert.equal(view.location.hasPin, false);
  assert.equal(view.location.address, 'Revised service site');
  assert.match(details.render(view, projectId), /query=Revised%20service%20site/);
  assert.doesNotMatch(details.render(view, projectId), /query=15%2C121/);
  data.booking.location.address = 'Revised service site';
  assert.equal(details.read(data).location.hasPin, true);
});

test('saved GeoJSON pins and zero coordinates work while missing or invalid coordinates do not produce a false pin', () => {
  const data = fixture(); data.booking.location = { address: 'Service site', coordinates: { type: 'Point', coordinates: [121, 0] } };
  assert.equal(details.read(data).location.lat, 0); assert.equal(details.read(data).location.lng, 121);
  assert.equal(details.read(data).location.hasPin, true);
  for (const pin of [{ lat: null, lng: null }, { lat: '', lng: ' ' }, { lat: 91, lng: 121 }, { lat: 15, lng: 181 }, { lat: 'invalid', lng: 121 }]) {
    data.booking.location = { address: 'Service site', ...pin };
    assert.equal(details.read(data).location.hasPin, false);
  }
});

test('an unrelated booking cannot supply a service location and a missing site is not guessed from customer details', () => {
  const data = fixture(); data.booking._id = 'another-booking'; data.booking.location = { address: 'Another customer site', lat: 15, lng: 121 };
  data.project.customer = { address: 'Home address' };
  const html = details.render(details.read(data), projectId);
  assert.match(html, /No service location was recorded/); assert.doesNotMatch(html, /Another customer site|Home address|maps\/search/);
});

test('site addresses are escaped and the service site remains visible without saved service groups', () => {
  const data = { project: { location: { address: '<img src=x onerror=alert(1)>' } } };
  const html = details.render(details.read(data), projectId);
  assert.match(html, /Service location/); assert.match(html, /&lt;img/);
  assert.match(html, /query=%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E|query=%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E/);
  assert.doesNotMatch(html, /<img/); assert.match(html, /No service details were recorded/);
});
