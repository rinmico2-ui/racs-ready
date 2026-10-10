'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCoreServicePayload } = require('../utils/serviceCatalogPayload');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const tier = { hp:.75,price:950.75,durationMinutes:60 };
const payload = hpPricing => ({ active:true,isAirconService:true,airconTypes:[{ type:'split',name:'Split',hpPricing }] });
test('staff can add fractional HP sizes with decimal prices and zero-priced tiers', () => {
  const catalog = normalizeCoreServicePayload({ ...payload([tier,{ hp:4.5,price:0 }]), airconTypes:JSON.stringify(payload([tier,{ hp:4.5,price:0 }]).airconTypes) });
  assert.equal(resolveCoreServicePricing(catalog,{ brand:'Custom Brand',airconType:'split',hp:.75,quantity:2 }).totalPrice,1901.5);
  assert.equal(resolveCoreServicePricing(catalog,{ brand:'Custom Brand',airconType:'split',hp:4.5,quantity:1 }).unitPrice,0);
});
test('staff cannot save incomplete, duplicate, negative, or nonnumeric HP prices', () => {
  for (const rows of [[tier,{ ...tier,price:1 }],[{ hp:0,price:1 }],[{ hp:1,price:'' }],[{ hp:1,price:null }],[{ hp:1,price:-1 }],[{ hp:1,price:'NaN' }],[{ ...tier,durationMinutes:2.5 }]]) {
    assert.throws(() => normalizeCoreServicePayload(payload(rows)), error => error.status === 400 && error.code === 'INVALID_SERVICE_PAYLOAD');
  }
});
test('placeholder brands cannot reach booking pricing', () => {
  for (const brand of ['__other__','__unknown__']) assert.throws(() => resolveCoreServicePricing(payload([tier]),{ brand,airconType:'split',hp:.75,quantity:1 }),/brand/i);
});
