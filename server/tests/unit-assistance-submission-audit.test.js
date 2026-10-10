'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const id = '68a000000000000000000001', serviceId = '68a000000000000000000002';
const requests = [], notifications = [];
function mock(modulePath,exports) { const filename = require.resolve(modulePath); require.cache[filename] = { id:filename,filename,loaded:true,exports }; }
mock('../middleware/authenticate',{ authenticate:(req,_res,next) => { req.user = { _id:id }; next(); },requireRole:() => (_req,_res,next) => next() });
mock('../utils/boundedRateLimit',{ rateLimit:() => (_req,_res,next) => next() });
mock('../utils/rateLimitIdentity',{ authenticatedOrIpKey:() => id });
mock('../models/CoreService',{ findOne:() => ({ lean:async () => ({ name:'Cleaning',active:true,isAirconService:true,airconTypes:[{ type:'split',hpPricing:[{ hp:1,price:950.75 }] }] }) }) });
mock('../models/BookingService',{});
mock('../models/UnitAssistanceRequest',{
  findOne:filter => ({ select() { return this; },lean:async () => requests.find(item => item.customerId === filter.customerId && item.clientRequestId === filter.clientRequestId) }),
  create:async data => { const row = { ...data,_id:'68a000000000000000000003',status:'pending' }; requests.push(row); return row; },
});
mock('../utils/notify',{ createNotification:async data => { notifications.push(data); } });
const app = express(); app.use(express.json()); app.use('/api/unit-assistance',require('../routes/unitAssistanceRoutes'));
test('unit help saves a typed brand, supports unlisted HP, and deduplicates customer retries', async t => {
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = body => fetch(`http://127.0.0.1:${server.address().port}/api/unit-assistance`,{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ serviceId,brand:'Custom Brand',airconType:'split',hp:4.5,quantity:2,clientRequestId:'unit-request-reference-1',...body }) });
  let response = await send({}); assert.equal(response.status,201); const first = await response.json();
  assert.equal(requests.length,1); assert.equal(requests[0].brand,'Custom Brand'); assert.equal(requests[0].hp,4.5); assert.equal(notifications.length,2);
  response = await send({}); assert.equal(response.status,200); assert.equal((await response.json()).id,first.id); assert.equal(requests.length,1); assert.equal(notifications.length,2);
  response = await send({ clientRequestId:'unit-request-reference-2',hp:1 }); assert.equal(response.status,400); assert.equal(requests.length,1);
  response = await send({ clientRequestId:'invalid' }); assert.equal(response.status,400);
  response = await send({ clientRequestId:'unit-request-reference-3',hp:null,airconType:'',brand:"I don't know" }); assert.equal(response.status,201);
});
