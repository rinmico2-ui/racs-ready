'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Booking = require('../models/BookingService');
const discovery = require('../utils/coreRepairDiscovery');
const A = require('../public/js/appliance-services');
const pricing = require('../public/js/repair-visit-payment');
const flow = require('../utils/repairUnitWorkflow');
const clone = value => JSON.parse(JSON.stringify(value));
const id = number => String(number).padStart(24,'0');
const now = new Date('2026-10-22T03:00:00Z');
function fixture(options = {}) {
  let state = { booking: clone(new Booking({ _id:id(1), __v:0, serviceType:'core', status:'in-progress', technicianId:id(2), assignmentId:id(3),
    customerId:id(4), bookingDate:'2026-10-22T01:30:00Z', startTime:'570', endTime:'915', quantity:options.quantity || 1,
    technicianTeam:[{technicianId:id(2),assignmentId:id(3),name:'Primary',status:'accepted',respondedAt:now}],
    services:[{_id:id(10),serviceId:id(20),type:'core',name:'Aircon Cleaning',quantity:options.quantity || 1,applianceKind:'aircon',applianceGroupId:'appliance_discovery_01',
      brand:'Carrier',model:'Split',airconType:'split',applianceType:'split',applianceTypeName:'Split Type',hp:1,unitPrice:1000,totalPrice:1000*(options.quantity || 1),duration:60,status:'in_progress',technicianId:id(2),assignmentId:id(3)}],
    travelFare:390,totalPrice:1000*(options.quantity || 1)+390,totalInitialCost:1000*(options.quantity || 1)+390,servicePrice:1000*(options.quantity || 1),
    amountPaid:options.paid ?? 500,downpaymentAmount:500,balanceAmount:890,balanceCollected:options.paid===1390,paymentStatus:options.paid===1390?'paid':'partial',
  }).toObject()), assignment:{_id:id(3),bookingId:id(1),technicianId:id(2),status:'in_progress',serviceType:'core',bookingDate:'2026-10-22T01:30:00Z'},
    payments:[{_id:id(5),amount:options.paid ?? 500,status:'verified'}] };
  let staged, tail=Promise.resolve(); const events=[];
  const current=()=>staged || state;
  const query=read=>({session(){return this},lean(){return this},select(){return this},then(resolve,reject){return Promise.resolve().then(read).then(resolve,reject)}});
  const booking = () => {
    const doc = Booking.hydrate(current().booking);
    Object.defineProperty(doc,'save',{value:async function(config){assert.ok(config.session);await this.validate();if(options.failSave)throw Error('Booking write failed');this.__v=(this.__v||0)+1;staged.booking=clone(this.toObject());events.push('booking');return this}});
    return doc;
  };
  const session={async withTransaction(work){staged=clone(state);try{await work();state=staged;events.push('commit')}catch(error){events.push('rollback');throw error}finally{staged=null}},async endSession(){events.push('end')}};
  const service=discovery.createService({mongoose:{isValidObjectId:mongoose.isValidObjectId,startSession:async()=>session},now:()=>now,
    Booking:{findById:()=>query(booking)},Assignment:{findOne:filter=>query(()=>{
      if(String(filter.technicianId)!==String(current().assignment.technicianId)||filter._id&&String(filter._id)!==String(current().assignment._id))return null;
      const doc=clone(current().assignment);Object.defineProperty(doc,'save',{value:async()=>{staged.assignment=clone(doc);events.push('assignment');return doc}});return doc;
    }),async updateMany(filter,change){Object.assign(staged.assignment,change.$set);return{modifiedCount:1}}},Payment:{find:()=>query(()=>clone(current().payments)),async updateOne(filter,change){
      const payment=staged.payments.find(row=>row._id===String(filter._id));Object.assign(payment,change.$set);payment.events=[...(payment.events||[]),change.$push.events];return{modifiedCount:1};
    }},
    async lock(key,work){assert.equal(key,'booking-payment:'+id(1));const before=tail;let release;tail=new Promise(resolve=>{release=resolve});await before;try{return await work()}finally{release()}},
  });
  const tech={role:'technician',userId:id(6),technician:{_id:id(2),name:'Primary'}},staff={role:'admin',userId:id(7),name:'Operations'};
  const input={version:0,requestId:'discovery-test-000001',serviceItemId:id(10),unitIndex:1,findings:'Cooling test found damaged wiring at the terminal.',recommendedAction:'Replace damaged wiring and test the terminals.',severity:'standard',coreCanContinue:true};
  return{service,tech,staff,input,events,get state(){return state},report:(changes={},actor=tech)=>service.act(id(1),actor,'report',{...input,...changes}),
    act:(action,changes={})=>service.act(id(1),staff,action,{version:state.booking.__v,findingId:String(state.booking.services.at(-1)._id),reason:'Operations reviewed the recorded work and customer scope.',...changes})};
}
test('a discovered repair stays on the same appliance, keeps core progress and adds no inspection or travel charge',async()=>{
  const f=fixture(),original=clone(f.state.booking.services[0]);const result=await f.report();
  assert.equal(result.findings.length,1);assert.equal(f.state.booking.serviceType,'mixed');assert.equal(f.state.assignment.serviceType,'mixed');
  assert.deepEqual(f.state.booking.services[0],original);assert.equal(f.state.booking.services[1].unitPrice,0);assert.equal(f.state.booking.services[1].initialCost,0);
  assert.equal(A.unitCount(f.state.booking.services),1);assert.equal(f.state.booking.quantity,1);assert.equal(f.state.booking.isProject,false);
  assert.equal(A.applianceGroups(f.state.booking.services).length,1);
  assert.equal(result.payment.total,1390);assert.equal(result.payment.amountPaid,500);assert.equal(result.payment.amountDue,890);
  assert.equal(pricing.summary(f.state.booking).repairInspectionFee,0);
  assert.equal(f.state.booking.services[1].units[0].inspection.findings,f.input.findings);
  assert.equal(f.state.payments.length,1);assert.equal(pricing.breakdown(f.state.booking).ready,false);
});
test('simultaneous and repeated reports create one repair and preserve its evidence and quote revision',async()=>{
  const f=fixture();const results=await Promise.all([f.report(),f.report()]);
  assert.equal(f.state.booking.services.length,2);assert.equal(results.filter(row=>row.alreadyRecorded).length,1);
  assert.equal(f.events.filter(row=>row==='assignment').length,1);
  f.state.booking.services[1].units[0].repairReview.revision=2;
  const retry=await f.report();assert.equal(retry.alreadyRecorded,true);assert.equal(f.state.booking.services[1].units[0].repairReview.revision,2);
});
test('the same physical appliance cannot be reported through another core service on its group',async()=>{
  const f=fixture();f.state.booking.services.push({...clone(f.state.booking.services[0]),_id:id(11),serviceId:id(21),name:'Freon Recharging'});
  await f.report();const result=await f.report({version:1,requestId:'discovery-test-000002',serviceItemId:id(11)});
  assert.equal(result.alreadyRecorded,true);assert.equal(f.state.booking.services.filter(row=>row.type==='repair').length,1);
});
test('legacy quantity groups retain seven physical units and select the affected unit explicitly',async()=>{
  const f=fixture({quantity:7});await f.report({unitIndex:7});
  assert.equal(A.unitCount(f.state.booking.services),7);assert.equal(f.state.booking.quantity,7);assert.equal(f.state.booking.isProject,false);
  assert.match(f.state.booking.services[1].units[0].label,/Unit 7/);
});
test('unsafe findings pause only affected unfinished core rows until Operations records a decision',async()=>{
  const f=fixture();f.state.booking.services.push({...clone(f.state.booking.services[0]),_id:id(11),applianceGroupId:'appliance_other_123'});
  await f.report({severity:'unsafe',coreCanContinue:false});
  assert.equal(f.state.booking.services[0].status,'on_hold');assert.equal(f.state.booking.services[1].status,'in_progress');
  assert.equal(discovery.needsReview(f.state.booking),true);
  assert.equal(require('../utils/bookingServiceItems').canTransitionServiceItem(f.state.booking.services[0],'in_progress'),false);
  await assert.rejects(f.act('resume-core',{reason:'no'}),/Decision reason/);
  await f.act('resume-core');assert.equal(f.state.booking.services[0].status,'in_progress');assert.equal(discovery.needsReview(f.state.booking),false);
  assert.equal(f.state.booking.services[0].unitPrice,1000);
});
test('unperformed core work removes its charge, retains payments, and requires the actual overpayment refund',async()=>{
  const f=fixture({paid:1390});await f.report({coreCanContinue:false});await f.act('cancel-core');
  const b=f.state.booking;assert.equal(b.services[0].status,'cancelled');assert.equal(b.services[0].coreRepairHold.state,'not_performed');
  assert.equal(b.totalInitialCost,390);assert.equal(b.amountPaid,1390);assert.equal(b.balanceAmount,0);
  assert.equal(b.services[1].discoveredDuringService.refundReviewAmount,1000);
  assert.equal(discovery.needsReview(b),true);await assert.rejects(f.act('review-refund'),/customer repair decisions/);
  f.state.booking.services[1].units[0].repairReview.state='declined';
  await assert.rejects(f.act('review-refund'),/Record and verify/);
  f.state.payments[0].refundAmount=1000;f.state.payments[0].refundStatus='completed';await f.act('review-refund');
  assert.equal(f.state.booking.amountPaid,390);assert.equal(discovery.needsReview(f.state.booking),false);
});
test('additional approved repair keeps a fully paid original booking credited and reopens the balance',async()=>{
  const f=fixture({paid:1390});await f.report();const b=Booking.hydrate(f.state.booking),unit=b.services[1].units[0];
  unit.quotation={parts:[],laborCost:800,totalCost:800};unit.repairReview.state='approved';
  flow.bookingQuotationSummary(b);
  assert.equal(b.amountPaid,1390);assert.equal(b.balanceAmount,800);assert.equal(b.balanceCollected,false);
  assert.equal(pricing.balance(b).total,2190);assert.deepEqual(pricing.breakdown(b).lines.map(row=>row.amount),[1000,0,800,390]);
  unit.repairReview.state='declined';flow.bookingQuotationSummary(b);assert.equal(b.balanceAmount,0);assert.equal(b.services[0].unitPrice,1000);
});
test('failed booking writes roll back the assignment update and the new repair',async()=>{
  const f=fixture({failSave:true}),before=clone(f.state);await assert.rejects(f.report(),/Booking write failed/);assert.deepEqual(f.state,before);assert.ok(f.events.includes('rollback'));
});
test('stale pages, invalid units, unsafe continuation and malformed reports leave the booking untouched',async()=>{
  for(const extra of [{version:2},{unitIndex:2},{severity:'unsafe',coreCanContinue:true},{findings:'short'},{coreCanContinue:'yes'},
    {requestId:'bad'},{serviceItemId:id(99)},{recommendedAction:{text:'Repair'}}]){
    const f=fixture(),before=clone(f.state);await assert.rejects(f.report(extra));assert.deepEqual(f.state,before);
  }
});
test('supporting technicians and staff cannot create a finding or bypass customer repair approval',async()=>{
  const f=fixture();await assert.rejects(f.report({}, {...f.tech,technician:{_id:id(99)}}),error=>error.status===403);
  await assert.rejects(f.report({},f.staff),error=>error.status===403);assert.equal(f.state.booking.services.length,1);
});
test('the work date, Start Work, accepted team and customer cancellation hold are required',async()=>{
  for(const change of [f=>{f.state.assignment.status='on_site'},f=>{f.state.assignment.bookingDate='2026-10-21T01:30:00Z'},
    f=>{f.state.booking.technicianTeam[0].status='pending'},f=>{f.state.booking.customerCancellation={status:'pending'}},
    f=>{f.state.booking.status='completed'},f=>{f.state.booking.sourceOrderId=id(99)},f=>{f.state.booking.continuation={status:'pending'}}]){
    const f=fixture();change(f);await assert.rejects(f.report());assert.equal(f.state.booking.services.length,1);
  }
});
test('submitted quotations lock further findings and ordinary customer edits remain protected',async()=>{
  const f=fixture();f.state.booking.quotationReview={status:'pending'};await assert.rejects(f.report(),/already under review/);
  delete f.state.booking.quotationReview;await f.report();
  await assert.rejects(require('../utils/customerBookingEditPolicy').assertPaymentNotVerified(f.state.booking),error=>error.code==='REPAIR_FINDING_SCOPE_LOCKED');
});

test('bookings that already included repair cannot add a core-service repair finding',async()=>{
  const f=fixture();
  f.state.booking.serviceType='mixed';f.state.assignment.serviceType='mixed';
  f.state.booking.services.push({_id:id(30),type:'repair',name:'Booked repair',quantity:1,status:'inspection_pending',units:[{unitIndex:1,repairReview:{state:'pending'}}]});
  const before=clone(f.state);
  assert.equal(discovery.canAdd(f.state.booking),false);
  assert.equal((await f.service.read(id(1),f.tech)).canAdd,false);
  await assert.rejects(f.report(),error=>error.code==='CORE_ONLY_REPAIR_FINDING');
  assert.deepEqual(f.state,before);
});

test('a booking that began with core work can report another appliance after its first finding makes it mixed',async()=>{
  const f=fixture({quantity:2});await f.report();
  assert.equal(f.state.booking.serviceType,'mixed');assert.equal(discovery.canAdd(f.state.booking),true);
  const result=await f.report({version:f.state.booking.__v,requestId:'discovery-test-000002',unitIndex:2});
  assert.equal(result.findings.length,2);assert.equal(f.state.booking.services.length,3);
});
test('legacy repricing cannot replace core charges or bypass the appliance quotation workflow',()=>{
  const f=fixture();assert.throws(()=>Booking.hydrate(f.state.booking).updateServiceCost(0,9000,id(2),'Found a repair'),error=>error.code==='REPAIR_QUOTATION_REQUIRED');
});
test('the real payment ledger stays authoritative when an older booking snapshot is stale',async()=>{
  const f=fixture();f.state.payments[0].amount=900;
  const preview=await f.service.read(id(1),f.tech);assert.equal(preview.payment.amountPaid,900);
  const result=await f.report();assert.equal(result.payment.amountPaid,900);assert.equal(result.payment.amountDue,490);
  assert.equal(f.state.payments[0].amount,900);
});
test('paused core work and an unresolved refund block final mixed collection until reviewed',async()=>{
  const f=fixture();await f.report({coreCanContinue:false});const b=Booking.hydrate(f.state.booking);
  b.services[1].units[0].repairReview.state='approved';b.services[1].units[0].quotation={parts:[],laborCost:800,totalCost:800};flow.bookingQuotationSummary(b);
  assert.equal(pricing.breakdown(b).ready,false);assert.match(pricing.breakdown(b).blockedReason,/Operations/);
});
test('refund requests queue the exact overpayment without pretending money was returned, then close only the reviewed unperformed visit',async()=>{
  const f=fixture({paid:1390});await f.report({coreCanContinue:false});await f.act('cancel-core');
  f.state.booking.services[1].units[0].repairReview.state='declined';
  await f.act('queue-refund');assert.equal(f.state.payments[0].refundAmount,1000);assert.equal(f.state.payments[0].refundStatus,'pending');
  assert.equal(f.state.booking.amountPaid,1390);await assert.rejects(f.act('review-refund'),/Record and verify/);
  await assert.rejects(f.act('queue-refund'),/already has a refund/);await assert.rejects(f.act('close-visit'),/Resolve every/);
  f.state.payments[0].refundStatus='completed';await f.act('review-refund');await f.act('close-visit');
  assert.equal(f.state.booking.status,'cancelled');assert.equal(f.state.assignment.status,'cancelled');
  assert.equal(f.state.booking.amountPaid,390);assert.equal(f.state.booking.services[0].status,'cancelled');
});
