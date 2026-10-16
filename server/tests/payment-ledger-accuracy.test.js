'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Payment = require('../models/Payment');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const Project = require('../models/Project');
const Technician = require('../models/Technician');
const finance = require('../utils/enterpriseRevenue');
const ledger = require('../utils/paymentLedgerView');
const presentation = require('../utils/paymentPresentation');
const controller = require('../controllers/paymentController');
const id = '507f1f77bcf86cd799439011', bookingId = '507f1f77bcf86cd799439012';
const orderId = '507f1f77bcf86cd799439013', projectId = '507f1f77bcf86cd799439014';
const date = new Date('2026-10-15T16:30:00Z'); // Oct 16, Manila
const query = value => ({ select() { return this; }, lean: async () => value });
const filter = { start: new Date('2026-10-15T16:00:00Z'), end: new Date('2026-10-16T15:59:59.999Z') };

test('payment descriptions resolve mixed service, unit and legacy repair fields without losing collection notes', () => {
  const result = presentation.context({ method:'cash', collectedBy:id, events:[{status:'waiting_for_remittance', note:'Technician collected the balance.'}] }, {
    booking:{ bookingReference:'RACS-FIXTURE', serviceType:'mixed', issueDescription:'Does not cool',
      unitInfo:{problemDescription:'Does not cool'}, repairIssues:['Water leak'], services:[{name:'Repair',problemDescription:'Stops after starting'}] },
    collector:{name:'Fixture Technician'},
  });
  assert.equal(result.issueDescription, 'Does not cool\nWater leak\nStops after starting');
  assert.equal(result.collectionNotes, 'Technician collected the balance.');
  assert.equal(result.collectedByName, 'Fixture Technician');
  assert.equal(result.paymentChannel, 'cash');
});

test('detail endpoint reads actual repair schema fields and technician collection information', async t => {
  t.mock.method(Order, 'findOne', () => query(null));
  let selected;
  t.mock.method(Payment, 'findById', () => query({_id:id, bookingId, method:'cash', amount:550, status:'waiting_for_remittance', collectedBy:id, collectedAt:date}));
  t.mock.method(Booking, 'findById', () => ({ select(fields) {selected=fields;return this;}, lean:async()=>({ _id:bookingId, bookingReference:'RACS-FIXTURE', serviceType:'mixed',
    unitInfo:{problemDescription:'The fan does not rotate.'}, services:[{name:'Fan repair',repairIssue:'Rattles'}], totalPrice:1500, customer:{name:'Fixture'} }) }));
  t.mock.method(Technician, 'findById', () => query({name:'Fixture Technician'}));
  let result;
  await controller.getPayment({params:{id}}, {json(value){result=value;}}, assert.fail);
  assert.ok(selected.includes('unitInfo.problemDescription') && selected.includes('services.repairIssue'));
  assert.equal(result.payment.issueDescription, 'The fan does not rotate.\nRattles');
  assert.equal(result.payment.collectedByName, 'Fixture Technician');
  assert.equal(result.payment.amount, 550);
  assert.equal(result.payment.estimatedFee, 1500);
});

test('project-only payment details resolve the linked booking and customer', async t => {
  t.mock.method(Order, 'findOne', () => query(null));
  t.mock.method(Payment, 'findById', () => query({_id:id,projectId,amount:300,method:'gcash',status:'paid'}));
  t.mock.method(Project, 'findById', () => query({_id:projectId,bookingId,projectReference:'PRJ-FIXTURE'}));
  t.mock.method(Booking, 'findById', value => {assert.equal(value, bookingId);return query({_id:bookingId,bookingReference:'RACS-FIXTURE', customer:{name:'Fixture'},unitInfo:{problemDescription:'Project issue'}});});
  let result;
  await controller.getPayment({params:{id}}, {json(value){result=value;}}, assert.fail);
  assert.equal(result.payment.customerName, 'Fixture');
  assert.equal(result.payment.issueDescription, 'Project issue');
});

test('linked installation mirrors do not override the order amount, reference or receipt', async t => {
  t.mock.method(Payment, 'findById', () => query({_id:id,bookingId,orderId,amount:1000,method:'gcash',status:'paid'}));
  t.mock.method(Booking, 'findById', () => query({_id:bookingId,bookingReference:'INSTALL-FIXTURE',totalPrice:500,estimatedFee:500}));
  t.mock.method(Order, 'findById', () => query({_id:orderId,orderReference:'ORD-FIXTURE',total:20000,subtotal:19000,gcashProofUrl:'data:image/png;base64,fixture',items:[{modelLine:'Fixture Aircon',quantity:2}]}));
  let result;
  await controller.getPayment({params:{id}}, {json(value){result=value;}}, assert.fail);
  assert.equal(result.payment.bookingReference,'ORD-FIXTURE');
  assert.equal(result.payment.estimatedFee,20000);
  assert.match(result.payment.proofUrl,/base64,fixture/);
  assert.equal(result.payment.amount,1000);
});

test('technician remittance history cannot be bypassed through generic payment updates', async t => {
  t.mock.method(Payment,'findById',async()=>({_id:id,collectedBy:id,status:'waiting_for_remittance',save(){assert.fail('must not save');}}));
  let code, payload;
  await controller.updatePayment({params:{id},body:{status:'paid'}},{status(value){code=value;return this;},json(value){payload=value;}},assert.fail);
  assert.equal(code,409);assert.equal(payload.code,'REMITTANCE_REVIEW_REQUIRED');
});

test('all technician collection states, legacy completed payments and refunds use the same financial rules', () => {
  const summary=ledger.newSummary(date);
  const rows=['paid','verified','payment_collected','waiting_for_remittance','remitted','partial','rejected','unaccounted','completed'].map((status,index)=>({_id:String(index),status,method:'cash',amount:100,collectedAt:date}));
  rows.push({status:'pending',amount:999999,method:'gcash',submittedAt:date}, {status:'failed',amount:999999,method:'gcash',submittedAt:date},
    {status:'refunded',amount:100,method:'gcash',collectedAt:date,refundedAt:date,refundStatus:'completed',refundAmount:40});
  rows.forEach(row=>ledger.add(summary,row,filter));
  const expected=finance.summarizePaymentLedger(rows,{...filter, startDate:filter.start,endDate:filter.end});
  assert.equal(summary.grossCollections,1000);assert.equal(summary.refunds,40);assert.equal(summary.netCollections,960);
  assert.equal(summary.collectedRecords,10);assert.equal(summary.total,12);
  assert.equal(summary.netCollections,expected.netCollections);
  assert.equal(summary.trend.find(row=>row.date==='2026-10-16').amount,1000);
});

test('a refund paid by another method only reduces that method in the selected date range', () => {
  const summary=ledger.newSummary(date);
  ledger.add(summary,{status:'refunded',amount:1000,method:'gcash',collectedAt:new Date('2026-09-01'),refundedAt:date,refundAmount:200,refundStatus:'completed',refundMethod:'cash'}, {...filter,method:'cash'});
  assert.equal(summary.grossCollections,0);assert.equal(summary.refunds,200);assert.equal(summary.netCollections,-200);
});

test('pagination retains one page while financial totals cover more than 1,000 matching records', async t => {
  const records=Array.from({length:2011},(_,index)=>({_id:String(index),status:'waiting_for_remittance',amount:10,method:'cash',collectedAt:date,submittedAt:date,
    _booking:[{bookingReference:'FIXTURE-'+index,customer:{name:'Fixture'}}]}));
  let pipeline, closed=false;
  t.mock.method(Payment,'aggregate',stages=>{pipeline=stages;return{option(){return this;},cursor(){return{async *[Symbol.asyncIterator](){yield* records;},async close(){closed=true;}};}};});
  const result=await ledger.buildPaymentLedgerView({from:'2026-10-16',to:'2026-10-16',page:'21',pageSize:'50'});
  assert.equal(result.pagination.total,2011);assert.equal(result.pagination.totalPages,41);
  assert.equal(result.payments.length,50);assert.equal(result.payments[0].bookingReference,'FIXTURE-1000');
  assert.equal(result.summary.grossCollections,20110);assert.equal(closed,true);
  assert.equal(pipeline.some(stage=>stage.$limit),false);
  const selected=pipeline.find(stage=>stage.$project).$project;
  assert.equal(selected.proofUrl,undefined);assert.equal(selected.customerSignature,undefined);assert.equal(selected.events,undefined);
  assert.equal(pipeline.find(stage=>stage.$lookup?.as==='_booking').$lookup.from,Booking.collection.name);
  const legacyLookup = pipeline.find(stage=>stage.$lookup?.as==='_legacyOrder').$lookup;
  assert.deepEqual(legacyLookup.pipeline[0].$match.$expr.$and[0], { $ne: ['$$booking', null] }, 'order-only payments must never join orders with missing booking IDs');
  assert.deepEqual(legacyLookup.pipeline.at(-1), { $limit: 1 });
  assert.equal(result.payments[0]._booking,undefined);
});

test('filters validate actual model enums, reject query objects and use complete Philippine days', () => {
  for(const query of [{status:{$ne:'pending'}},{status:'unknown'},{method:['cash']},{page:'-1'},{pageSize:'10000'},{from:'2026-02-30'},{from:'2026-10-20',to:'2026-10-01'}]) {
    assert.throws(()=>ledger.filters(query),error=>error.status===400);
  }
  const result=ledger.filters({date:'2026-10-16',status:'waiting_for_remittance',method:'cash'});
  assert.equal(result.start.toISOString(),'2026-10-15T16:00:00.000Z');assert.equal(result.end.toISOString(),'2026-10-16T15:59:59.999Z');
  assert.equal(result.match.status,'waiting_for_remittance');assert.equal(result.method,'cash');
});

test('payments UI receives full-ledger totals instead of recalculating them from the visible page', () => {
  const script=fs.readFileSync(path.join(__dirname,'../public/js/admin-payments.js'),'utf8');
  const start=script.indexOf('  function updateStats(summary) {'), end=script.indexOf('  async function loadPayments()',start);
  const nodes={};const put=(id,value)=>{(nodes[id]||={}).textContent=value;};
  const document={getElementById:id=>nodes[id]||null};
  const context={document,put,formatCurrency:value=>'PHP '+Number(value||0).toFixed(2)};
  vm.runInNewContext(script.slice(start,end)+'\nglobalThis.render=updateStats;',context);
  context.render({total:2011,grossCollections:20110,netCollections:20100,refunds:10,collectedRecords:2011,statuses:{waiting_for_remittance:{count:2011,amount:20110}},trend:[]});
  assert.equal(nodes.kpiTotalRevenue.textContent,'PHP 20110.00');
  assert.equal(nodes.paymentsNetTotal.textContent,'PHP 20100.00');
  assert.equal(nodes.kpiPartialCount.textContent,2011);
});
