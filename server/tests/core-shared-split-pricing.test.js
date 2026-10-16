'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../public/js/appliance-services'),{resolveCoreServicePricing}=require('../utils/coreServicePricing');
const CoreService=require('../models/CoreService');
const catalog=()=>({name:'Cleaning',slug:'cleaning',category:'service',active:true,isAirconService:true,durationMinutes:60,
  airconTypes:[{type:'split',name:'Split Type',hpPricing:[{hp:0.75,price:900,durationMinutes:75},{hp:1,price:1200,durationMinutes:90},{hp:2,price:1800,durationMinutes:120}]},
    {type:'cassette',name:'Cassette Type',hpPricing:[{hp:1,price:1700,durationMinutes:150},{hp:3,price:3200,durationMinutes:180}]}]});
const selected=type=>({applianceKind:'aircon',airconType:type,hp:1,brand:'Carrier',quantity:2});
test('separate cassette prices and work times win while missing capacities use exact split values',()=>{
  const c=catalog(),before=JSON.stringify(c),tiers=A.airconHpOptions(c,'cassette');
  assert.deepEqual(tiers.map(t=>t.hp),[0.75,1,2,3]);
  assert.equal(tiers.find(t=>t.hp===1).price,1700);assert.equal(tiers.find(t=>t.hp===1).durationMinutes,150);
  assert.equal(tiers.find(t=>t.hp===2).price,1800);assert.equal(tiers.find(t=>t.hp===2).durationMinutes,120);
  assert.equal(tiers.find(t=>t.hp===2).pricingSource,'split');assert.equal(JSON.stringify(c),before);
});
test('effective staff tables include suspended prices and identify inherited rows without altering saved records',()=>{
  const c=catalog(),before=JSON.stringify(c),types=A.effectiveAirconTypes(c),suspended=types.find(t=>t.type==='split_suspended');
  assert.equal(suspended.name,'Split Suspended');assert.equal(suspended.hpPricing.length,3);
  assert.ok(suspended.hpPricing.every(t=>t.pricingSource==='split'));assert.equal(JSON.stringify(c),before);
});
test('browser, modern booking and legacy booking use the same suspended and cassette rates',()=>{
  for(const type of ['split_suspended','cassette']){
    const c=catalog(),s=selected(type),browser=A.price(c,s);
    const modern=resolveCoreServicePricing(c,s),{applianceKind,...legacy}=s,old=resolveCoreServicePricing(c,legacy);
    for(const result of [modern,old]){assert.equal(result.unitPrice,browser.unitPrice);assert.equal(result.duration,browser.duration);assert.equal(result.airconType,type);assert.equal(result.totalPrice,browser.unitPrice*2);}
    assert.equal(A.needsVerification(c,s),false);
  }
});
test('Mongoose catalog documents preserve inherited prices, names and work times just like lean documents',()=>{
  const c=new CoreService(catalog()),before=JSON.stringify(c);
  const result=resolveCoreServicePricing(c,selected('split_suspended'));
  assert.equal(result.unitPrice,1200);assert.equal(result.duration,90);assert.equal(result.airconTypeName,'Split Suspended');assert.equal(JSON.stringify(c),before);
});
test('shared pricing never estimates missing HP, borrows a different service or masks an invalid saved price',()=>{
  const c=catalog();
  for(const type of ['split_suspended','cassette'])assert.equal(A.availability(c,{...selected(type),hp:5}).available,false);
  assert.equal(A.availability(c,selected('central')).available,false);
  c.airconTypes[1].hpPricing[0].price=-1;assert.equal(A.availability(c,selected('cassette')).available,false);
  c.airconTypes[0].hpPricing=[];assert.equal(A.availability(c,selected('split_suspended')).available,false);
});
test('explicit free prices stay free and a missing price can use an approved split rate',()=>{
  const c=catalog();c.airconTypes[1].hpPricing[0].price=0;
  assert.equal(A.price(c,selected('cassette')).unitPrice,0);
  c.airconTypes[1].hpPricing[0].price=null;
  assert.equal(A.price(c,selected('cassette')).unitPrice,1200);
});
