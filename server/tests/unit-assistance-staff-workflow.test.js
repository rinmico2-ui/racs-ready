'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const id = '68a000000000000000000001';
const quoteDate = new Date('2026-10-06T08:00:00.000Z');
let request;
let writes;
const catalogReads = [];
const queueReads = [];
const notifications = [];

function mock(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

mock('../middleware/authenticate', {
  authenticate: (req, _res, next) => { req.user = { _id: id }; next(); },
  requireRole: () => (_req, _res, next) => next(),
});
mock('../utils/boundedRateLimit', { rateLimit: () => (_req, _res, next) => next() });
mock('../utils/rateLimitIdentity', { authenticatedOrIpKey: () => 'staff' });
mock('../models/CoreService', {
  findOne: () => ({ lean: async () => ({ active: true, isAirconService: true }) }),
  find(filter) {
    catalogReads.push(filter);
    return { select(fields) { catalogReads.push(fields); return this; }, lean: async () => [
      { brands: ['Carrier', ' LG ', 'unknown', '__other__', "I don't know", ''] },
      { brands: ['carrier', 'LG', 'Panasonic', 'A'.repeat(81)] },
      { brands: null },
    ] };
  },
});
mock('../models/BookingService', {});
mock('../models/UnitAssistanceRequest', {
  find(filter) {
    queueReads.push(filter);
    return { populate(path, fields) { queueReads.push({ path, fields }); return this; }, sort() { return this; }, limit() { return this; },
      lean: async () => [{ _id: id, requestType: 'repair', serviceId: null, status: 'pending' }] };
  },
  findOne: async () => request,
  findOneAndUpdate: async (filter, change) => {
    writes.push({ filter, change });
    return { ...request, status: 'quoted', customerId: id };
  },
});
mock('../utils/coreServicePricing', { resolveCoreServicePricing: () => ({
  unitPrice: 1200, airconType: 'split', airconTypeName: 'Split type', hp: 1, duration: 90,
}) });
mock('../utils/notify', { createNotification: async value => { notifications.push(value); } });

const app = express();
app.use(express.json());
app.use('/api/unit-assistance', require('../routes/unitAssistanceRoutes'));

test('staff identification supplies catalog brand choices for core and repair requests', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/unit-assistance/staff`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.brands.map(brand => brand.toLowerCase()), ['carrier', 'lg', 'panasonic']);
  assert.equal(payload.requests[0].requestType, 'repair');
  assert.equal(payload.requests[0].serviceId, null);
  assert.deepEqual(catalogReads, [{ active: true }, 'brands']);
  assert.ok(queueReads.some(row => row.path === 'serviceId' && row.fields.split(' ').includes('brands')));
});

test('staff quotes respect customer acceptance and quote freshness', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/unit-assistance/staff/${id}/quote`;
  const send = body => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand: 'Carrier', model: 'MODEL-123', airconType: 'split', hp: 1, verificationMethod: 'customer_contact', ...body }),
  });

  writes = [];
  request = { _id: id, status: 'accepted', quantity: 1, customerId: id, quote: {
    quotedAt: quoteDate, expiresAt: new Date(Date.now() + 86400000),
  } };
  let response = await send({ expectedQuotedAt: quoteDate.toISOString() });
  assert.equal(response.status, 409);
  assert.equal(writes.length, 0, 'an active accepted quote must stay accepted');

  request = { ...request, status: 'quoted' };
  for (const brand of ["I don't know", 'unknown', '__other__', '   ']) {
    response = await send({ brand, expectedQuotedAt: quoteDate.toISOString() });
    assert.equal(response.status, 400); assert.equal(writes.length, 0, 'staff must identify the brand before quoting');
  }
  for (const model of ['<script>', {}, ['MODEL-123'], 'A'.repeat(51)]) {
    response = await send({ model, expectedQuotedAt: quoteDate.toISOString() });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /model/i); assert.equal(writes.length, 0);
  }
  response = await send({ expectedQuotedAt: '2026-10-05T08:00:00.000Z' });
  assert.equal(response.status, 409);
  assert.equal(writes.length, 0, 'stale edits must not replace a newer quote');

  response = await send({ expectedQuotedAt: quoteDate.toISOString() });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(writes.at(-1).change.$set.model, 'MODEL-123');
  assert.equal(writes.at(-1).filter['quote.quotedAt'].toISOString(), quoteDate.toISOString());

  request = { ...request, status: 'accepted', quote: {
    quotedAt: quoteDate, expiresAt: new Date(Date.now() - 86400000),
  } };
  response = await send({ expectedQuotedAt: quoteDate.toISOString() });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(writes.at(-1).filter.status, 'accepted');
  assert.equal(writes.at(-1).change.$set.status, 'quoted');
  assert.equal(writes.at(-1).change.$set.acceptedAt, null);
});

test('staff can quote core requests without a model and preserves existing model details when omitted', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const priorModel of [undefined, '', 'SAVED-123']) {
    writes = [];
    request = { _id: id, requestType: 'core', status: 'pending', quantity: 1, customerId: id, model: priorModel };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/unit-assistance/staff/${id}/quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Carrier', airconType: 'split', hp: 1, verificationMethod: 'customer_contact' }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].change.$set.model, priorModel || '');
    assert.equal(writes[0].change.$set.quote.unitPrice, 1200);
    assert.equal(notifications.at(-1).userId, id);
    assert.equal(notifications.at(-1).type, 'system');
    assert.equal(notifications.at(-1).link, '/unit-assistance?requestId=' + id);
  }
});
