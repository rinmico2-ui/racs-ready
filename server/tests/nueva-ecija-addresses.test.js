'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), axios = require('axios');
const coverage = require('../public/js/nueva-ecija-coverage');
const local = require('../utils/nuevaEcijaAddresses');
const catalog = require('../utils/psgcCatalog');
const { validateCheckoutSelection, authoritativeDeliveryQuote } = require('../utils/orderCheckoutPolicy');

test('coverage uses the province polygon and rejects nearby points inside its bounding box', () => {
  for (const [lat, lng] of [[15.4863,120.9671],[15.362,120.966],[15.98,121.07]]) assert.equal(coverage.contains(lat,lng),true);
  for (const [lat, lng] of [[14.5995,120.9842],[15.25,120.65],[15.8,121.35],[null,null],['',''],[NaN,121]]) assert.equal(coverage.contains(lat,lng),false);
});

test('local catalog covers every Nueva Ecija city and barangay without fabricating coordinates', () => {
  const cities = local.getList('cities');
  assert.equal(cities.length,32);
  assert.equal(cities.reduce((sum, city) => sum + local.getList('barangays',city.code).length,0),849);
  assert.deepEqual(local.getList('barangays','0330100000'),[]);
  const results = local.suggestions('Punc');
  assert.match(results[0].display_name,/Puncan, Carranglan, Nueva Ecija/);
  assert.equal(results[0].lat,null); assert.equal(results[0].lon,null); assert.equal(results[0].match_level,'locality');
  assert.equal(local.suggestions('Manila').length,0);
});

test('customer address validation works offline and refuses forged province, city and barangay combinations', async t => {
  t.mock.method(axios,'get',async () => { throw Error('External catalogs must not be called'); });
  const city = local.getList('cities').find(item => item.name === 'City of Cabanatuan');
  const barangay = local.getList('barangays',city.code)[0];
  const input = { addressProvince:'Nueva Ecija',addressCity:'Cabanatuan',addressBarangay:barangay.name,addressPostal:'3100' };
  const result = await catalog.validateAddressSelection(input);
  assert.equal(result.city,city.name);
  const legacy = await catalog.validateAddressSelection({...input,addressBarangay:'Sumacab Sur'});
  assert.equal(legacy.barangay,'Sumacab South');
  assert.ok(local.getList('cities').some(item=>item.name==='Peñaranda'));
  for (const patch of [{addressProvince:'City of Nueva Ecija'},{addressProvince:'Pampanga'},{addressCity:'Manila'},{addressBarangay:'Invented Barangay'}]) {
    await assert.rejects(catalog.validateAddressSelection({...input,...patch}), error => error.status===400 && error.code==='INVALID_ADDRESS');
  }
});

test('the scoped PSGC endpoints remain usable while their external provider is offline', async t => {
  t.mock.method(axios,'get',async () => { throw Error('offline'); });
  const app = express(); app.use('/api/psgc',require('../routes/psgcRoutes'));
  const server = await new Promise(resolve => { const listener = app.listen(0,'127.0.0.1',()=>resolve(listener)); });
  t.after(()=>{server.closeAllConnections();server.close();});
  const base = `http://127.0.0.1:${server.address().port}/api/psgc`;
  const get = async path => { const response = await fetch(base+path); assert.equal(response.status,200); return (await response.json()).data; };
  assert.equal((await get('/provinces?scope=nueva-ecija'))[0].name,'Nueva Ecija');
  assert.equal((await get('/cities?scope=nueva-ecija')).length,32);
  assert.deepEqual(await get('/barangays?scope=nueva-ecija&city_code=0330100000'),[]);
});

test('delivery checkout and route quotes refuse outside-province pins before requesting a road route', async () => {
  const input = { fulfillmentType:'delivery_installation',paymentMethod:'cod',timeSlot:'09:00',delivery:{address:'Synthetic customer address',contactNumber:'09171234567',preferredDate:'2035-01-02',coordinates:{lat:15.25,lng:120.65}} };
  assert.throws(()=>validateCheckoutSelection(input,{now:new Date('2035-01-01T00:00:00Z')}),error=>error.code==='OUTSIDE_SERVICE_AREA');
  await assert.rejects(authoritativeDeliveryQuote({origin:{lat:15.4863,lng:120.9671},destination:input.delivery.coordinates,farePerKm:40,httpClient:{get(){throw Error('Must not call provider');}}}),error=>error.code==='OUTSIDE_SERVICE_AREA');
  const valid = validateCheckoutSelection({...input,delivery:{...input.delivery,coordinates:{lat:15.4863,lng:120.9671}}},{now:new Date('2035-01-01T00:00:00Z')});
  assert.equal(valid.delivery.coordinates.lat,15.4863);
});
