"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');

test('real map click handler retains the selected destination across repeated clicks and can switch back to origin', () => {
  const start = source.indexOf("  map.on('click', function (e)");
  const end = source.indexOf('  technicianMarker.bindTooltip', start);
  assert.ok(start > 0 && end > start);
  let click; const destinations = [];
  const state = { selectedServices: [{ relocation: { scope: 'different_address' } }] };
  const context = { map: { on(name, handler) { assert.equal(name, 'click'); click = handler; } },
    BookingState: state, placingRelocationDestination: true, customerLocationRequestToken: 0, routeRequestToken: 0,
    differentAddressRelocationItem: () => state.selectedServices[0], isWithinPhilippinesMapBounds: () => true,
    relocationLocationController: () => ({ pin(lat, lng) { destinations.push({ lat, lng }); } }),
    getTypedServiceAddressForPin: () => 'Manual origin address', clearServiceRouteEstimate() {},
    setCustomerLocationMarker() {}, reverseGeocode() {}, showError(message) { throw Error(message); } };
  vm.runInNewContext(source.slice(start, end), context);
  click({ latlng: { lat: 15.5, lng: 121.0 } }); click({ latlng: { lat: 15.6, lng: 121.1 } });
  assert.deepEqual(destinations, [{ lat: 15.5, lng: 121.0 }, { lat: 15.6, lng: 121.1 }]);
  assert.equal(context.placingRelocationDestination, true); assert.equal(state.customerLocation, undefined);
  context.placingRelocationDestination = false;
  click({ latlng: { lat: 15.4, lng: 120.9 } }); click({ latlng: { lat: 15.45, lng: 120.95 } });
  assert.equal(state.customerLocation.lat, 15.45); assert.equal(state.customerLocation.lng, 120.95);
  assert.equal(destinations.length, 2);
});

test('background fallback route rendering keeps the relocation viewport stable and still draws the route', () => {
  const implementation = source.match(/function drawStraightLineRoute\([^]*?\n\}/)?.[0];
  assert.ok(implementation);
  for (const relocation of [false, true]) {
    let fits = 0, lines = 0;
    const context = { BookingState: { map: { fitBounds() { fits++; } }, technicianMarker: {}, userMarker: {} },
      differentAddressRelocationItem: () => relocation, bookingDebug() {},
      L: { polyline: () => ({ addTo() { lines++; return this; } }), featureGroup: function () { this.getBounds = () => ({ pad() { return {}; } }); } } };
    vm.runInNewContext(implementation, context); context.drawStraightLineRoute({}, {});
    assert.equal(lines, 1); assert.equal(fits, relocation ? 0 : 1);
  }
});
