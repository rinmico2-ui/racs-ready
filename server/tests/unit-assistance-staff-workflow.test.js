'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const id = '68a000000000000000000001';
const quoteDate = new Date('2026-10-06T08:00:00.000Z');
let request;
let writes;

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
mock('../models/CoreService', { findOne: () => ({ lean: async () => ({ active: true, isAirconService: true }) }) });
mock('../models/BookingService', {});
mock('../models/UnitAssistanceRequest', {
  findOne: async () => request,
  findOneAndUpdate: async (filter, change) => {
    writes.push({ filter, change });
    return { ...request, status: 'quoted', customerId: id };
  },
});
mock('../utils/coreServicePricing', { resolveCoreServicePricing: () => ({
  unitPrice: 1200, airconType: 'split', airconTypeName: 'Split type', hp: 1, duration: 90,
}) });
mock('../utils/notify', { createNotification: async () => {} });

const app = express();
app.use(express.json());
app.use('/api/unit-assistance', require('../routes/unitAssistanceRoutes'));

test('staff quotes respect customer acceptance and quote freshness', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/unit-assistance/staff/${id}/quote`;
  const send = body => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand: 'Carrier', airconType: 'split', hp: 1, verificationMethod: 'customer_contact', ...body }),
  });

  writes = [];
  request = { _id: id, status: 'accepted', quantity: 1, customerId: id, quote: {
    quotedAt: quoteDate, expiresAt: new Date(Date.now() + 86400000),
  } };
  let response = await send({ expectedQuotedAt: quoteDate.toISOString() });
  assert.equal(response.status, 409);
  assert.equal(writes.length, 0, 'an active accepted quote must stay accepted');

  request = { ...request, status: 'quoted' };
  response = await send({ expectedQuotedAt: '2026-10-05T08:00:00.000Z' });
  assert.equal(response.status, 409);
  assert.equal(writes.length, 0, 'stale edits must not replace a newer quote');

  response = await send({ expectedQuotedAt: quoteDate.toISOString() });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
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
