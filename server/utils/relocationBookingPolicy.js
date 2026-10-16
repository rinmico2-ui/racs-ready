'use strict';

const coverage = require('../public/js/nueva-ecija-coverage');
const A = require('../public/js/appliance-services');
const { validPoint } = require('../public/js/relocation-booking-locations');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

// The appointment address is always the pickup property. Never trust a second
// client-supplied origin, quote price, or request reference on a new booking.
function normalizeRelocation(relocation, location, quantity = 1) {
  if (Number(quantity) !== 1) fail('Book one aircon relocation at a time.');
  if (!['same_property', 'different_address'].includes(relocation?.scope) || relocation.requestId) {
    fail('Choose a nearby move or another address in the normal service booking. Relocation quote requests are no longer used.');
  }
  if (!validPoint(location) || clean(location?.address, 300).length < 8) fail('Confirm the current aircon address and map pin.');
  const origin = { address: clean(location.address, 300), lat: Number(location.lat), lng: Number(location.lng) };
  const from = { ...origin, details: clean(relocation.from?.details, 500) };
  let to;
  if (relocation.scope === 'same_property') {
    const details = clean(relocation.to?.details, 500);
    if (from.details.length < 2 || details.length < 2) fail('Describe the current and new aircon positions on the same property.');
    to = { ...origin, details };
  } else {
    if (!validPoint(relocation.to) || clean(relocation.to?.address, 300).length < 8) fail('Confirm the new aircon address and map pin.');
    if (!coverage.contains(relocation.to.lat, relocation.to.lng)) fail(coverage.message);
    if (Number(relocation.to.lat) === origin.lat && Number(relocation.to.lng) === origin.lng) fail('Choose a different destination pin, or select a nearby move on the same property.');
    to = { address: clean(relocation.to.address, 300), lat: Number(relocation.to.lat), lng: Number(relocation.to.lng), details: clean(relocation.to.details, 500) };
  }
  if (relocation.assetId && !/^[a-f\d]{24}$/i.test(String(relocation.assetId))) fail('Invalid aircon asset.');
  return { scope: relocation.scope, from, to, ...(relocation.assetId ? { assetId: relocation.assetId } : {}),
    model: clean(relocation.model, 80), serialNumber: clean(relocation.serialNumber, 100), notes: clean(relocation.notes, 1000) };
}

function assertStandaloneServices(rows) {
  try { A.assertStandaloneServices(rows); } catch (error) { error.status = 400; throw error; }
}

module.exports = { normalizeRelocation, assertStandaloneServices };
