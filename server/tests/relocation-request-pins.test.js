'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { validPoint } = require('../public/js/relocation-booking-locations');
test('map points reject absent, blank, invalid and outside-country coordinates', () => {
  assert.equal(validPoint({ lat: '15.3', lng: '121.1' }), true);
  for (const place of [undefined, {}, { lat: null, lng: null }, { lat: '', lng: '' }, { lat: NaN, lng: 121 }, { lat: Infinity, lng: 121 }, { lat: 40, lng: 121 }, { lat: 15, lng: 10 }]) assert.equal(validPoint(place), false);
});
test('the real relocation request endpoint requires both pins and saves both addresses and reused aircon details', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/relocationRoutes.js'), 'utf8');
  const writes = []; let submit;
  const query = value => ({ select() { return this; }, lean: async () => value });
  const router = { use() {}, get() {}, post(route, ...handlers) { if (route === '/') submit = handlers.at(-1); } };
  const mocks = {
    express: { Router: () => router }, mongoose: { isValidObjectId: () => true },
    '../middleware/authenticate': { authenticate() {}, requireRole: () => () => {} },
    '../utils/boundedRateLimit': { rateLimit: () => () => {} }, '../utils/rateLimitIdentity': { authenticatedOrIpKey() {} },
    '../models/CoreService': { findOne: () => query({ _id: 'move' }) }, '../models/CustomerAsset': {},
    '../models/RelocationRequest': { create: async record => { writes.push(record); return { ...record, _id: 'quote', status: 'pending_review' }; } },
    '../utils/notify': { createNotification: async () => {} }, '../utils/coreServicePricing': {},
    '../public/js/relocation-booking-locations': { validPoint },
  };
  vm.runInNewContext(source, { require(name) { assert.ok(name in mocks, name); return mocks[name]; }, module: { exports: {} }, console });
  async function call(from, to) {
    let code = 200, data;
    await submit({ body: { serviceId: 'move', scope: 'custom_quote', from, to, preferredDate: '2035-01-20', unit: { brand: 'Carrier', airconType: 'split', model: 'Nexus', hp: 1 } }, user: { _id: 'customer' }, app: { get: () => null } }, { status(value) { code = value; return this; }, json(value) { data = value; return this; } });
    return { code, data };
  }
  const from = { address: 'Test current address', lat: 15.3, lng: 121.1 }, to = { address: 'Test new address', lat: 15.4, lng: 121.2 };
  for (const [a, b] of [[from, { address: to.address }], [{ address: from.address }, to], [from, { ...to, lat: null }]]) {
    const result = await call(a, b); assert.equal(result.code, 400); assert.match(result.data.error, /map pin/); assert.equal(writes.length, 0);
  }
  const result = await call(from, to); assert.equal(result.code, 201); assert.equal(writes.length, 1);
  assert.equal(writes[0].from.lat, 15.3); assert.equal(writes[0].to.lat, 15.4); assert.equal(writes[0].unit.brand, 'Carrier'); assert.equal(writes[0].unit.model, 'Nexus');
});
