'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildRevenueAnalytics}=require('../utils/revenueAnalytics');
const {clear}=require('../utils/reportCache');
const date=value=>new Date(value+'T04:00:00Z');
const bookings=[
  {_id:'prepaid',paymentStatus:'paid',serviceType:'core',technicianId:'tech',status:'completed',totalPrice:1000,createdAt:date('2026-09-01'),completedAt:date('2026-10-10')},
  {_id:'older-booking',paymentStatus:'partial',serviceType:'core',technicianId:'tech',status:'completed',totalPrice:2000,createdAt:date('2026-09-01'),completedAt:date('2026-10-15')},
  {_id:'included-installation',serviceType:'core',status:'completed',totalPrice:9999,createdAt:date('2026-10-01'),completedAt:date('2026-10-15')},
];
const orders=[{_id:'order',bookingId:'included-installation',status:'completed',total:1000,createdAt:date('2026-09-01'),completedAt:date('2026-10-15'),paymentMethod:'gcash',paymentStatus:'paid',items:[{inventoryId:'aircon',quantity:1,totalPrice:1000,costPrice:600}]}];
const payments=[
  {_id:'prepayment',bookingId:'prepaid',status:'paid',method:'gcash',amount:1000,collectedAt:date('2026-09-10'),refundStatus:'completed',refundMethod:'cash',refundAmount:200,refundedAt:date('2026-10-20')},
  {_id:'current-payment',bookingId:'older-booking',status:'paid',method:'gcash',amount:500,collectedAt:date('2026-10-14')},
  {_id:'order-payment',orderId:'order',status:'paid',method:'gcash',amount:1000,collectedAt:date('2026-10-16')},
];
function values(row,path){return path.split('.').reduce((current,key)=>current.flatMap(value=>Array.isArray(value?.[key])?value[key]:[value?.[key]]),[row]);}
function matches(row,query){
  return Object.entries(query).every(([key,condition])=>{
    if(key==='$or')return condition.some(value=>matches(row,value));
    if(key==='$and')return condition.every(value=>matches(row,value));
    const found=values(row,key);
    if(condition==null)return found.some(value=>value==null);
    if(condition instanceof Date)return found.some(value=>+value===+condition);
    if(typeof condition!=='object')return found.includes(condition);
    return Object.entries(condition).every(([op,target])=>{
      if(op==='$in')return found.some(value=>target.includes(value));
      if(op==='$nin')return found.every(value=>!target.includes(value));
      if(op==='$ne')return found.every(value=>value!==target&&(target!==null||value!=null));
      if(op==='$gte')return found.some(value=>value!=null&&value>=target);
      if(op==='$lte')return found.some(value=>value!=null&&value<=target);
      if(op==='$gt')return found.some(value=>value>target);
      if(op==='$elemMatch')return found.some(value=>value&&matches(value,target));
      throw Error('Unexpected fixture query operator '+op);
    });
  });
}
function mockDatabase(t,overrides={}){
  const rows={BookingService:bookings,Order:orders,Payment:payments,ProductRefund:[{_id:'return',sourceType:'order',sourceId:'order',status:'completed',amount:100,method:'bank',processedAt:date('2026-10-20')}],Technician:[{_id:'tech',name:'Fixture'}]};
  Object.assign(rows,overrides);
  for(const name of ['BookingService','Order','Payment','ProductRefund','Technician','WalkInSale','Inventory','HVACProduct','Tool','Expense','Payroll','ProjectMaterial','ServiceToolUsage','Project','WorkOrder','DailyAssignment','ServiceReport','EquipmentAssignment']){
    const model=require('../models/'+name);
    t.mock.method(model,'find',(query={})=>{const result=(rows[name]||[]).filter(row=>matches(row,query));return{select(){return this;},sort(){return this;},populate(){return this;},lean:async()=>result};});
  }
  clear('revenue-analytics');t.after(()=>clear('revenue-analytics'));
}
const range={from:'2026-10-01',to:'2026-10-31'};
test('revenue engine reconciles completed work, old deposits, current collections and both refund ledgers',async t=>{
  mockDatabase(t);const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.recognizedGrossRevenue,4000);assert.equal(a.grossCollections,1500);assert.equal(a.refunds,300);assert.equal(a.netCollections,1200);assert.equal(a.recognizedRevenue,3700);
  assert.equal(a.totalRevenue,0,'No standalone work was created in this period');
  assert.equal(Object.values(a.monthlyRevenue).reduce((sum,row)=>sum+row.recognized,0),a.recognizedRevenue);
  assert.equal(Object.values(a.monthlyRevenue).reduce((sum,row)=>sum+row.collections,0),a.netCollections);
  assert.equal(a.gcashRevenue+a.codRevenue+a.bankRevenue+a.otherRevenue,a.netCollections);
});
test('technician/service payment filters include current cash for bookings created before the period',async t=>{
  mockDatabase(t);const {analytics:a}=await buildRevenueAnalytics({...range,serviceType:'core',technician:'tech'});
  assert.equal(a.recognizedServiceRevenue,3000);assert.equal(a.grossCollections,500);assert.equal(a.refunds,200);assert.equal(a.netCollections,300);
});
test('payment-method completion filters retain bookings prepaid in an earlier month',async t=>{
  mockDatabase(t);const {analytics:a}=await buildRevenueAnalytics({...range,source:'service',paymentMethod:'gcash'});
  assert.equal(a.recognizedServiceRevenue,3000);assert.equal(a.grossCollections,500);assert.equal(a.refunds,0);
  clear('revenue-analytics');const {analytics:cash}=await buildRevenueAnalytics({...range,source:'service',paymentMethod:'cash'});
  assert.equal(cash.grossCollections,0);assert.equal(cash.refunds,200);assert.equal(cash.netCollections,-200);
});

test('payment-state filters scope cash and refunds to the matching work',async t=>{
  mockDatabase(t);const {analytics:a}=await buildRevenueAnalytics({...range,paymentStatus:'paid'});
  assert.equal(a.recognizedGrossRevenue,2000);assert.equal(a.grossCollections,1000);assert.equal(a.refunds,300);assert.equal(a.netCollections,700);
});
test('cohort collection percentages include completed product returns without reopening the paid balance',async t=>{
  mockDatabase(t,{Order:orders.map(row=>({...row,createdAt:date('2026-10-01')}))});
  const {analytics:a}=await buildRevenueAnalytics({...range,source:'order'});
  assert.equal(a.totalRevenue,1000);assert.equal(a.cohortNetCollections,900);assert.equal(a.collectionRate,90);assert.equal(a.outstandingValue,0);
});
