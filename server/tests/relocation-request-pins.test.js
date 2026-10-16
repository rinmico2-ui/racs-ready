'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { validPoint } = require('../public/js/relocation-booking-locations');
test('map points reject absent, blank, invalid and outside-country coordinates', () => {
  assert.equal(validPoint({ lat: '15.3', lng: '121.1' }), true);
  for (const place of [undefined, {}, { lat: null, lng: null }, { lat: '', lng: '' }, { lat: NaN, lng: 121 }, { lat: Infinity, lng: 121 }, { lat: 40, lng: 121 }, { lat: 15, lng: 10 }]) assert.equal(validPoint(place), false);
});
test('retired quotation endpoints return the normal booking link without a database write', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/relocationRoutes.js'), 'utf8');
  const routes = new Map();
  const router = { use() {}, get() {}, post(route, ...handlers) { routes.set(route, handlers.at(-1)); } };
  const mocks = { express: { Router: () => router }, mongoose: {}, '../models/RelocationRequest': {},
    '../middleware/authenticate': { authenticate() {}, requireRole: () => () => {} } };
  vm.runInNewContext(source, { require(name) { assert.ok(name in mocks, name); return mocks[name]; }, module: { exports: {} } });
  for (const route of ['/', '/mine/:id/decision', '/staff/:id/assessment', '/staff/:id/quote']) {
    let code, body;
    await routes.get(route)({ body: {} }, { status(value) { code = value; return this; }, json(value) { body = value; } });
    assert.equal(code, 410); assert.equal(body.code, 'RELOCATION_NORMAL_BOOKING'); assert.equal(body.bookingUrl, '/services');
  }
});
