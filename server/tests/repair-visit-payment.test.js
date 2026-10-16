'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const pricing = require('../public/js/repair-visit-payment');
const collection = require('../utils/repairVisitCollection');
const id = n => n.toString(16).padStart(24,'0');
function mixed() {
  return { _id:id(1), technicianId:id(2), assignmentId:id(3), serviceType:'mixed', status:'awaiting_approval', __v:0,
    totalInitialCost:1750, totalPrice:3880, amountPaid:1750, inspectionFeeCollected:false, travelFare:50,
    services:[{type:'core',status:'completed',initialCost:1200,unitPrice:1200,totalPrice:1200,quantity:1},
      {type:'repair',status:'inspection_completed',initialCost:500,unitPrice:500,finalCost:2630,costUpdatedByTechnician:true,totalPrice:2630,quantity:1}], quotation:{totalCost:2630} };
}

test('first-visit charges never include the later repair price or require a stale inspection flag', () => {
  const bill=pricing.summary(mixed());
  assert.equal(bill.repairInspectionFee,500);assert.equal(bill.coreServiceAmount,1200);assert.equal(bill.phaseOneTarget,1750);
  assert.equal(bill.amountDue,0);assert.equal(bill.settled,true);
});
test('original service line prices remain authoritative without an initial booking snapshot', () => {
  const booking=mixed();delete booking.totalInitialCost;booking.amountPaid=200;
  assert.equal(pricing.summary(booking).initialBookingTotal,1750);
  assert.equal(pricing.summary(booking).amountDue,1550);
  booking.services[1].quantity=2;booking.services[1].initialCost=400;booking.discount=100;
  assert.equal(pricing.summary(booking).initialBookingTotal,1950);
});
test('unverified downpayment amounts and inspection flags do not erase unpaid charges', () => {
  const booking=mixed();booking.amountPaid=0;booking.downpaymentAmount=1750;booking.inspectionFeeCollected=true;
  assert.equal(pricing.summary(booking).amountDue,1750);assert.equal(pricing.summary(booking).settled,false);
});
test('incomplete core work is identified separately and only inspection is collectable until it is done', () => {
  const booking=mixed();booking.services[0].status='in_progress';booking.amountPaid=50;
  const bill=pricing.summary(booking);assert.equal(bill.corePending,true);assert.equal(bill.phaseOneTarget,550);assert.equal(bill.amountDue,500);
  booking.services[0].status='cancelled';booking.amountPaid=550;
  assert.equal(pricing.summary(booking).corePending,false);assert.equal(pricing.summary(booking).amountDue,0);
});
test('a zero-priced inspection still accounts for the actual travel fee and cents', () => {
  const booking={serviceType:'repair',initialCost:0,travelFare:39.75,amountPaid:20,services:[{type:'repair',initialCost:0,quantity:1}]};
  assert.equal(pricing.summary(booking).amountDue,19.75);
});
test('legacy repair appliance records can use the saved booking inspection price', () => {
  const bill=pricing.summary({serviceType:'repair',initialCost:500,travelFare:50,amountPaid:550,services:[{type:'repair',quantity:1,units:[{unitIndex:1}]}]});
  assert.equal(bill.repairInspectionFee,500);assert.equal(bill.settled,true);
});
test('unitemized legacy mixed bookings retain their saved original charges', () => {
  const bill=pricing.summary({serviceType:'mixed',initialCost:500,totalPrice:3500,amountPaid:500,services:[{type:'repair',quantity:1}]});
  assert.equal(bill.initialBookingTotal,3500);assert.equal(bill.amountDue,3000);
});

function fixture() {
  const store={booking:{...mixed(),amountPaid:50,serviceType:'repair',initialCost:500,totalInitialCost:550,services:[mixed().services[1]]},payments:[]};
  let failSave=false,tail=Promise.resolve();
  const deps={
    mongoose:{isValidObjectId:input=>/^[a-f\d]{24}$/i.test(String(input)),async startSession(){return {async withTransaction(work){const before=structuredClone(store);try{await work();}catch(error){Object.assign(store,before);throw error;}},async endSession(){}};}},
    Booking:{findById(){return{async session(){const doc=structuredClone(store.booking);doc.increment=()=>{doc.__v++;};doc.save=async options=>{assert.ok(options.session);if(failSave)throw Error('Booking write failed');const {increment,save,...data}=doc;store.booking=data;};return doc;}};}},
    Assignment:{findOne(filter){return{async session(){return filter.technicianId===id(2)?{status:'in_progress'}:null;}};}},
    Payment:{async create(records,options){assert.ok(options.session);store.payments.push(...structuredClone(records));}},
    async lock(key,work){assert.equal(key,`repair-visit:${id(1)}`);const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;try{return await work();}finally{release();}},
    now:()=>new Date('2026-10-17T06:00:00Z'),
  };
  const collect=collection.createService(deps);
  return{store,collect:(input={},tech=id(2))=>collect(id(1),{_id:tech,name:'Primary'},id(4),{amount:500,method:'gcash',...input}),failSave:()=>{failSave=true;}};
}
test('first-visit collection records only the remaining amount with its payment in one transaction',async()=>{
  const f=fixture();const result=await f.collect({inspectionFee:99999,distanceFare:99999});
  assert.equal(result.phaseOnePayment.amountCollected,500);assert.equal(f.store.booking.amountPaid,550);
  assert.equal(f.store.booking.balanceAmount,2630);assert.equal(f.store.payments.length,1);assert.equal(f.store.payments[0].amount,500);
  assert.equal(f.store.payments[0].status,'waiting_for_remittance');assert.equal(f.store.booking.__v,1);
  assert.equal(f.store.booking.inspectionFeeAmount,500);assert.equal(f.store.booking.inspectionFeeDistanceFare,50);
});
test('repeated and simultaneous first-visit collection requests cannot create duplicate payments',async()=>{
  const f=fixture();const results=await Promise.all([f.collect(),f.collect()]);
  assert.equal(f.store.payments.length,1);assert.equal(f.store.booking.amountPaid,550);
  assert.equal(results.filter(row=>row.alreadyCollected).length,1);assert.equal((await f.collect()).alreadyCollected,true);
});
test('a fully paid visit with a missing inspection flag creates no extra payment',async()=>{
  const f=fixture();f.store.booking.amountPaid=550;
  assert.equal((await f.collect()).alreadyCollected,true);assert.equal(f.store.payments.length,0);
});
test('invalid amounts, methods and supporting technicians cannot collect the first-visit payment',async()=>{
  for(const input of [{amount:499},{amount:'500'},{method:'fake'},{notes:{injected:true}}]){const f=fixture();await assert.rejects(f.collect(input),{status:400});assert.equal(f.store.payments.length,0);}
  const f=fixture();await assert.rejects(f.collect({},id(9)),{status:403});assert.equal(f.store.payments.length,0);
});
test('a failed booking save rolls back the newly inserted collection',async()=>{
  const f=fixture();f.failSave();await assert.rejects(f.collect(),/Booking write failed/);
  assert.equal(f.store.payments.length,0);assert.equal(f.store.booking.amountPaid,50);
});
