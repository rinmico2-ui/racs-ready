'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestCategory, selectRequests, quoteValid } = require('../public/js/unit-assistance-customer');
const now = Date.parse('2026-10-09T04:00:00Z');
const active = { expiresAt:new Date(now + 3600000).toISOString() }, expired = { expiresAt:new Date(now - 1).toISOString() };

test('action counts exclude expired quotes and include bookings ready to continue', () => {
  assert.equal(requestCategory({ status:'quoted',quote:active },now),'action');
  assert.equal(requestCategory({ status:'accepted',quote:active },now),'action');
  assert.equal(requestCategory({ status:'quoted',quote:expired },now),'past');
  assert.equal(requestCategory({ status:'accepted',quote:expired },now),'past');
  assert.equal(requestCategory({ status:'quoted' },now),'past');
  assert.equal(quoteValid({ quote:{ expiresAt:'invalid' } },now),false);
  assert.equal(quoteValid({ quote:{ expiresAt:new Date(now).toISOString() } },now),false);
});
test('accepted changes remain in review and completed requests belong in history', () => {
  assert.equal(requestCategory({ status:'pending' },now),'progress');
  assert.equal(requestCategory({ status:'accepted',existingBookingId:'booking',quote:expired },now),'progress');
  for (const status of ['declined','converted','resolved']) assert.equal(requestCategory({ status },now),'past');
});
test('request ordering puts customer actions first without mutating the server list', () => {
  const requests = [{ _id:'past',status:'converted',createdAt:'2026-10-09' },
    { _id:'pending',status:'pending',createdAt:'2026-10-08' },
    { _id:'old-action',status:'quoted',createdAt:'2026-10-06',quote:active },
    { _id:'new-action',status:'quoted',createdAt:'2026-10-07',quote:active }];
  assert.deepEqual(selectRequests(requests,'all','',now).map(row => row._id),['new-action','old-action','pending','past']);
  assert.equal(requests[0]._id,'past');
});
test('request search combines the selected status with custom brands and references', () => {
  const requests = [{ _id:'0123456789abcdef',status:'pending',serviceName:'Aircon installation',brand:'Custom Brand',hp:4.5 },
    { _id:'quote',status:'quoted',quote:{ ...active,brand:'Daikin',airconTypeName:'Split type' },existingBookingReference:'BKG-003' }];
  assert.equal(selectRequests(requests,'progress',' custom brand ',now)[0]._id,requests[0]._id);
  assert.equal(selectRequests(requests,'all','req-89abcdef',now)[0]._id,requests[0]._id);
  assert.equal(selectRequests(requests,'action','BKG-003',now)[0]._id,'quote');
  assert.equal(selectRequests(requests,'past','Daikin',now).length,0);
  assert.equal(selectRequests(requests,'action','split type',now).length,1);
});
