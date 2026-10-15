'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { Readable } = require('node:stream');
const { normalizeUnitAssistance, quoteMatchesRequest } = require('../utils/unitAssistancePolicy');
const A = require('../public/js/appliance-services');
const { validatePhoto } = require('../utils/unitAssistancePhotos');
const UnitModel = require('../models/UnitAssistanceRequest');
const customerId = '68a000000000000000000001', serviceId = '68a000000000000000000002';
const otherCustomerId = '68a000000000000000000009';
const catalog = { _id: serviceId, name: 'Appliance service', active: true, isAirconService: true,
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }],
  applianceProfiles: [{ kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: [{ hp: 0.125, price: 800, durationMinutes: 90 }] },
    { kind: 'freezer', enabled: true, pricingMode: 'fixed', unitPrice: 900, durationMinutes: 75 }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
const docs = [], stored = [], deleted = [], notifications = [], reads = [];
let createFails = false;
function mock(modulePath, exports) { const filename = require.resolve(modulePath); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
mock('../middleware/authenticate', { authenticate: (req, _res, next) => { req.user = { _id: req.get('x-customer') || customerId, role: req.get('x-role') || 'customer' }; next(); },
  requireRole: roles => (req, res, next) => (Array.isArray(roles) ? roles : [roles]).includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }) });
mock('../utils/boundedRateLimit', { rateLimit: () => (_req, _res, next) => next() });
mock('../utils/rateLimitIdentity', { authenticatedOrIpKey: () => customerId });
mock('../models/CoreService', { findOne: () => ({ lean: async () => catalog }) });
mock('../models/BookingService', {});
const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => key === 'status' && value?.$in ? value.$in.includes(doc.status) : key.includes('.') ? true : String(doc[key]) === String(value));
mock('../models/UnitAssistanceRequest', {
  findOne(filter) { reads.push(filter); const result = () => docs.find(doc => matches(doc, filter)); return { select() { return this; }, lean: async () => result(), then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) }; },
  async create(data) { if (createFails) throw new Error('Fixture insert failed'); const doc = { ...data, _id: String(docs.length + 3).padStart(24, '0'), status: 'pending', bookingId: null }; docs.push(doc); return doc; },
  async findOneAndUpdate(filter, change) { const doc = docs.find(row => matches(row, filter)); if (!doc) return null; Object.assign(doc, change.$set); return doc; },
});
mock('../utils/notify', { createNotification: async data => { notifications.push(data); } });
mock('../utils/unitAssistancePhotos', { MAX_PHOTO_BYTES: 5 * 1024 * 1024, validatePhoto,
  storePhoto: async (file, owner) => { validatePhoto(file); const photo = { fileId: 'photo-' + stored.length, contentType: file.mimetype, length: file.buffer.length }; stored.push({ ...photo, owner }); return photo; },
  deletePhoto: async id => { deleted.push(id); }, downloadPhoto: () => Readable.from(png) });
const app = express(); app.use(express.json()); app.use('/api/unit-assistance', require('../routes/unitAssistanceRoutes'));

test('unknown fields retain the appliance and optional model without creating a price', () => {
  for (const applianceKind of A.kinds) {
    const selection = normalizeUnitAssistance(catalog, { applianceKind, quantity: 2, model: ' REF-123 ', notes: ' wall mounted ' });
    assert.equal(selection.brand, "I don't know"); assert.equal(selection.hp, null); assert.equal(selection.model, 'REF-123'); assert.equal(selection.notes, 'wall mounted');
    assert.equal(selection.applianceKind, applianceKind); assert.equal(selection.unitPrice, undefined);
  }
  assert.equal(normalizeUnitAssistance(catalog, { applianceKind: 'refrigerator', quantity: 1, hp: '1/8' }).hp, 0.125);
});
test('server rejects unsupported options, malformed scalar fields and invalid quantities', () => {
  for (const fields of [{ applianceKind: 'washing_machine' }, { brand: {} }, { notes: [] }, { model: '<script>' }, { model: 'x'.repeat(51) },
    { quantity: 0 }, { quantity: 41 }, { quantity: 1.5 }, { quantity: true }, { hp: {} }, { hp: 0 }, { hp: '-1' }, { airconType: 'invented' }, { applianceKind: 'freezer', airconType: 'split' }]) {
    assert.throws(() => normalizeUnitAssistance(catalog, { quantity: 1, ...fields }), error => error.status === 400);
  }
  assert.throws(() => normalizeUnitAssistance({ ...catalog, applianceProfiles: [] }, { applianceKind: 'freezer', quantity: 1 }), /unavailable/);
  assert.throws(() => normalizeUnitAssistance(null, { quantity: 1 }), /unavailable/);
});
test('unknown brand permits fixed pricing while missing HP stays unpriced', () => {
  const fixed = { applianceKind: 'freezer', brand: "I don't know", quantity: 1 };
  assert.equal(A.price(catalog, fixed).unitPrice, 900); assert.equal(A.needsVerification(catalog, fixed), false);
  const hp = { ...fixed, applianceKind: 'refrigerator' }; assert.equal(A.needsVerification(catalog, hp), true);
  assert.throws(() => A.price(catalog, hp), /HP/);
  assert.equal(A.needsVerification(catalog, { ...hp, hp: '1/8' }), false);
  assert.equal(A.needsVerification(catalog, { applianceKind: 'aircon', airconType: null, hp: null }), true);
});
test('request schema supports all three appliances and bounded model details', async () => {
  for (const applianceKind of A.kinds) {
    const doc = new UnitModel({ customerId, serviceId, serviceName: catalog.name, applianceKind, quantity: 1, model: 'MODEL-123' });
    await doc.validate(); assert.equal(doc.status, 'pending'); assert.equal(doc.bookingId, null); assert.equal(doc.quote?.unitPrice, undefined);
  }
  await assert.rejects(new UnitModel({ customerId, serviceId, serviceName: catalog.name, applianceKind: 'forged', quantity: 1 }).validate());
});
test('only accepted, current, matching quotes may enter payment, including fixed-price null HP', () => {
  const item = { serviceId, applianceKind: 'freezer', quantity: 2, brand: "I don't know" };
  const pricing = { unitPrice: 900, hp: null, airconType: null };
  const request = { ...item, status: 'accepted', quote: { ...pricing, brand: item.brand, expiresAt: new Date(Date.now() + 60000) } };
  assert.equal(quoteMatchesRequest(request, item, pricing), true);
  for (const change of [{ status: 'pending' }, { status: 'quoted' }, { applianceKind: 'refrigerator' }, { quantity: 1 }, { bookingId: 'used' }, { existingBookingId: 'other' },
    { quote: { ...request.quote, expiresAt: null } }, { quote: { ...request.quote, expiresAt: 'invalid' } }, { quote: { ...request.quote, expiresAt: new Date(0) } }, { quote: { ...request.quote, unitPrice: 1 } }]) {
    assert.equal(quoteMatchesRequest({ ...request, ...change }, item, pricing), false);
  }
});
test('photos must match their image bytes and cannot exceed five MB', () => {
  assert.equal(validatePhoto({ buffer: png, mimetype: 'image/png' }), 'image/png');
  for (const file of [{ buffer: Buffer.from('<svg/>'), mimetype: 'image/png' }, { buffer: png, mimetype: 'image/jpeg' }, { buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/png' }]) assert.throws(() => validatePhoto(file), error => error.status === 400);
});
test('API supports unpaid appliance requests, photos, ownership and verified catalog quotes', async t => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/unit-assistance`;
  const send = body => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId, quantity: 2, clientRequestId: 'appliance-help-request-1', applianceKind: 'refrigerator', ...body }) });
  let response = await fetch(base, { method: 'POST' }); assert.equal(response.status, 400);
  response = await send({ serviceId: [serviceId] }); assert.equal(response.status, 400);
  response = await send({ status: 'accepted', unitPrice: 1, quote: { unitPrice: 1 } }); assert.equal(response.status, 201); const id = (await response.json()).id;
  assert.equal(docs[0].hp, null); assert.equal(docs[0].applianceKind, 'refrigerator'); assert.equal(docs[0].quote, undefined); assert.equal(notifications.length, 2);
  assert.equal(docs[0].status, 'pending', 'client status and prices cannot approve an unidentified unit');
  response = await send({}); assert.equal(response.status, 200); assert.equal((await response.json()).id, id); assert.equal(docs.length, 1);
  const quote = await fetch(`${base}/staff/${id}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-role': 'admin' }, body: JSON.stringify({ brand: 'Midea', hp: '1/8', verificationMethod: 'model_label' }) });
  assert.equal(quote.status, 200, JSON.stringify(await quote.clone().json())); assert.equal(docs[0].quote.hp, 0.125); assert.equal(docs[0].quote.unitPrice, 800); assert.equal(docs[0].status, 'quoted');
  const form = () => { const data = new FormData(); data.append('serviceId', serviceId); data.append('applianceKind', 'freezer'); data.append('quantity', '1'); data.append('clientRequestId', 'appliance-photo-request-1'); data.append('photos', new Blob([png], { type: 'image/png' }), 'label.png'); return data; };
  response = await fetch(base, { method: 'POST', body: form() }); assert.equal(response.status, 201); const photoId = (await response.json()).id;
  assert.equal(stored.length, 1); assert.equal(stored[0].owner, customerId);
  response = await fetch(base, { method: 'POST', body: form() }); assert.equal(response.status, 200); assert.equal(stored.length, 1, 'a retry does not store another photo');
  response = await fetch(`${base}/${photoId}/photos/0`, { headers: { 'x-customer': otherCustomerId } }); assert.equal(response.status, 404); assert.equal(reads.at(-1).customerId, otherCustomerId);
  response = await fetch(`${base}/${photoId}/photos/0`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  response = await fetch(`${base}/${photoId}/photos/0`, { headers: { 'x-role': 'admin' } }); assert.equal(response.status, 200);
  response = await fetch(`${base}/${photoId}/photos/0`, { headers: { 'x-role': 'technician' } }); assert.equal(response.status, 403);
  response = await fetch(`${base}/${photoId}/photos/2`); assert.equal(response.status, 404);
  const bad = form(); bad.append('photos', new Blob(['<svg/>'], { type: 'image/png' }), 'fake.png');
  response = await fetch(base, { method: 'POST', body: bad }); assert.equal(response.status, 400); assert.equal(stored.length, 1);
  const excess = form(); excess.append('photos', new Blob([png], { type: 'image/png' }), 'a.png'); excess.append('photos', new Blob([png], { type: 'image/png' }), 'b.png');
  response = await fetch(base, { method: 'POST', body: excess }); assert.equal(response.status, 400);
  createFails = true; const failed = form(); failed.set('clientRequestId', 'appliance-photo-request-2');
  const originalError = console.error; console.error = () => {};
  try { response = await fetch(base, { method: 'POST', body: failed }); assert.equal(response.status, 500); } finally { console.error = originalError; createFails = false; }
  assert.equal(deleted.length, 1, 'uploaded evidence is removed if the request cannot be saved');
});
