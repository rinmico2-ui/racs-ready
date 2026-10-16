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

test('itemized cost records come from the same approved expenses, payroll and completed counter sales as profit',async t=>{
  mockDatabase(t,{BookingService:[],Order:[],Payment:[],ProductRefund:[],WalkInSale:[{_id:'counter-cost',status:'completed',completedAt:date('2026-10-14'),createdAt:date('2026-10-14'),totalAmount:1100,totalCost:400,paymentMethod:'cash',items:[{itemName:'Filter',quantity:2,costPrice:200,unitPrice:550,totalPrice:1100}]}],
    Expense:[{_id:'approved-expense',status:'approved',type:'fuel',description:'Visit fuel',expenseDate:date('2026-10-14'),amount:1266},{_id:'pending-expense',status:'pending',expenseDate:date('2026-10-14'),amount:900}],
    Payroll:[{_id:'draft-payroll',status:'draft',payDate:date('2026-10-14'),grossPay:999}]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.operatingProfit,-566);assert.equal(a.costDetails.total,1666);assert.equal(a.costDetails.reconciled,true);
  const expenses=a.costDetails.categories.find(group=>group.key==='expenses');
  assert.equal(expenses.records.length,1);assert.equal(expenses.records[0].description,'Visit fuel');assert.equal(expenses.total,1266);
  assert.equal(a.costDetails.categories.find(group=>group.key==='payroll').records.length,0);
  const sale=a.costDetails.categories.find(group=>group.key==='pos').records[0];
  assert.equal(sale.components[0].sellingPrice,550);assert.equal(sale.salePricing.grossProfit,700);
  assert.equal(a.recognizedRevenue-a.costDetails.total,a.operatingProfit);
});

test('installation costs appear under their order once, with saved usage and service labor details',async t=>{
  mockDatabase(t,{BookingService:[bookings[2]],Order:[{...orders[0],fulfillmentType:'delivery_installation'}],Payment:[],ProductRefund:[],
    ServiceReport:[{bookingId:'included-installation',actualLaborCost:30}],
    ServiceToolUsage:[{orderId:'order',bookingId:'included-installation',itemType:'consumable',itemName:'Tube',quantityUsed:2,unitPrice:5,toolCost:10}]});
  const {analytics:a}=await buildRevenueAnalytics(range),group=a.costDetails.categories.find(group=>group.key==='orders');
  assert.equal(a.orderCost,640);assert.equal(group.total,640);assert.equal(group.records.reduce((sum,row)=>sum+row.amount,0),640);
  assert.equal(group.records.find(row=>row.title==='Tube').amount,10);
  assert.equal(group.records.find(row=>row.title==='Recorded job labor').amount,30);
  assert.equal(a.costDetails.categories.find(group=>group.key==='service').records.length,0);
});
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
  assert.equal(a.totalRevenue,1000);assert.equal(a.cohortNetCollections,900);assert.equal(a.collectionRate,100);assert.equal(a.cohortNetCollectionRate,90);assert.equal(a.outstandingValue,0);
});
test('all report views reconcile completion, cash, requested work and profit independently',async t=>{
  mockDatabase(t);const {analytics:a}=await buildRevenueAnalytics(range),r=a.reconciliation;
  const total=rows=>rows.reduce((sum,row)=>sum+row.amount,0);
  assert.equal(total(a.activity.completed),a.recognizedGrossRevenue);assert.equal(total(a.activity.payments),a.netCollections);assert.equal(total(a.activity.requested),a.totalRevenue);
  assert.equal(a.salesView.serviceRevenue+a.salesView.orderRevenue+a.salesView.posRevenue,a.recognizedGrossRevenue);
  assert.equal(r.netSales,a.recognizedRevenue);assert.equal(r.netCollections,a.netCollections);assert.equal(r.requestedValue,a.totalRevenue);assert.equal(r.unpaidBalance,a.outstandingValue);
  assert.equal(r.netSales-r.savedDirectCosts-r.approvedExpenses-r.payroll,a.operatingProfit);
  assert.equal(Object.values(a.monthlyRevenue).reduce((sum,row)=>sum+row.completedService+row.completedOrders+row.completedPos,0),a.recognizedGrossRevenue);
});
test('walk-in aircon orders and distinct counter SKUs with the same name remain in product totals',async t=>{
  mockDatabase(t,{BookingService:[],Payment:[],ProductRefund:[],Order:[...orders,{...orders[0],_id:'walkin',bookingId:null,salesChannel:'walk_in',total:1500}],WalkInSale:[{
    _id:'counter',status:'completed',completedAt:date('2026-10-14'),createdAt:date('2026-10-14'),paymentMethod:'cash',totalAmount:50,subtotal:50,totalCost:5,
    items:[{toolId:'one',itemName:'Supply',itemType:'consumable',inventoryClass:'merchandise',quantity:1,totalPrice:20,costPrice:2},{toolId:'two',itemName:'Supply',itemType:'consumable',inventoryClass:'merchandise',quantity:1,totalPrice:30,costPrice:3}]
  }]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.orderProductRevenue,2000);assert.equal(a.onlineOrderProductRevenue,1000);assert.equal(a.totalProductRevenue,2050);
  assert.equal(a.productRows.filter(row=>row.channel==='POS').length,2);assert.equal(a.productRows.reduce((sum,row)=>sum+row.revenue,0),a.totalProductRevenue);
  assert.equal(a.reconciliation.orderItemSales+a.reconciliation.orderFeesAndAdjustments,a.salesView.orderRevenue);
  assert.equal(a.reconciliation.counterItemSales+a.reconciliation.counterFeesAndAdjustments,a.salesView.posRevenue);
  assert.equal(Object.values(a.orderFulfillmentMap).reduce((sum,row)=>sum+row.revenue,0),a.salesView.orderRevenue);
});
test('saved costs follow the Philippine completion month on a UTC server',async t=>{
  const previous=process.env.TZ;process.env.TZ='UTC';t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;});
  mockDatabase(t,{BookingService:[],Payment:[],ProductRefund:[],Order:[{...orders[0],completedAt:new Date('2026-09-30T16:30:00Z')}]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.totalPartsCost,600);assert.equal(Object.values(a.monthlyPartsCost).reduce((sum,cost)=>sum+cost,0),600);
});
test('service detail rows include settled refunds, actual labor and local purchases in the same profit equation',async t=>{
  mockDatabase(t,{BookingService:bookings.map(row=>row._id==='prepaid'?{...row,localPurchase:[{partName:'Fixture',actualPurchaseCost:100}]}:row),ServiceReport:[{_id:'report',bookingId:'prepaid',actualLaborCost:40,laborHours:1}]});
  const {analytics:a}=await buildRevenueAnalytics(range),row=a.completedServiceCosts.find(row=>row.bookingId==='prepaid');
  assert.equal(row.revenue,800);assert.equal(row.laborCost,40);assert.equal(row.localPurchaseCost,100);assert.equal(row.grossProfit,660);
  assert.equal(row.grossProfit,row.revenue-row.partsCost-row.consumablesCost-row.laborCost-row.localPurchaseCost);
  assert.equal(a.reconciliation.serviceNetSales,a.serviceProfitability.rows.reduce((sum,row)=>sum+row.revenue,0));
});
test('a POS-only period has finite costs and profit when no service rows exist',async t=>{
  mockDatabase(t,{BookingService:[],Order:[],Payment:[],ProductRefund:[],WalkInSale:[{_id:'counter',status:'completed',completedAt:date('2026-10-14'),createdAt:date('2026-10-14'),paymentMethod:'cash',totalAmount:100,totalCost:12,items:[]}]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.recognizedRevenue,100);assert.equal(a.netCollections,100);assert.equal(a.totalPartsCost,12);assert.equal(a.operatingProfit,88);
});

test('all seven tab breakdowns reconcile independently after source filtering and actual collections', async t=>{
  mockDatabase(t);
  for(const source of ['all','service','order','pos']) {
    const {analytics:a}=await buildRevenueAnalytics({...range,source});
    assert.equal(a.consistency.matches,true,JSON.stringify({source,differences:a.consistency.differences}));
  }
});

test('an order and its installation booking never count the same cash under both service and order filters', async t=>{
  const linked={_id:'mirror',sourceOrderId:'order',serviceType:'core',status:'completed',totalPrice:9000,createdAt:date('2026-10-01'),completedAt:date('2026-10-15')};
  mockDatabase(t,{BookingService:[linked],Order:[{...orders[0],bookingId:'mirror',createdAt:date('2026-10-01')}],Payment:[{_id:'payment',bookingId:'mirror',orderId:'order',status:'waiting_for_remittance',method:'cash',amount:1000,collectedAt:date('2026-10-16')}],ProductRefund:[]});
  const {analytics:service}=await buildRevenueAnalytics({...range,source:'service'});
  const {analytics:order}=await buildRevenueAnalytics({...range,source:'order'});
  assert.equal(service.grossCollections,0);assert.equal(service.recognizedGrossRevenue,0);
  assert.equal(order.grossCollections,1000);assert.equal(order.recognizedGrossRevenue,1000);assert.equal(order.outstandingValue,0);
});

test('legacy booking-only installation payments resolve to their product order without changing stored records',async t=>{
  mockDatabase(t,{BookingService:[{...bookings[0],_id:'mirror',sourceOrderId:'order'}],Order:[{...orders[0],bookingId:'mirror',createdAt:date('2026-10-01')}],Payment:[{_id:'payment',bookingId:'mirror',status:'paid',method:'cash',amount:1000,collectedAt:date('2026-10-16')}],ProductRefund:[]});
  const {analytics:a}=await buildRevenueAnalytics({...range,source:'order'});
  assert.equal(a.grossCollections,1000);assert.equal(a.outstandingValue,0);assert.equal(a.reconciliation.appliedPayments,1000);
  assert.equal(a.activity.payments[0].type,'order');assert.equal(a.consistency.matches,true);
});

test('order payment-method filters follow the actual ledger rather than the checkout preference',async t=>{
  mockDatabase(t,{BookingService:[],Order:[{...orders[0],bookingId:null,paymentMethod:'cash'}],Payment:[payments[2]],ProductRefund:[]});
  const {analytics:gcash}=await buildRevenueAnalytics({...range,source:'order',paymentMethod:'gcash'});
  assert.equal(gcash.recognizedOrderRevenue,1000);assert.equal(gcash.grossCollections,1000);
  const {analytics:cash}=await buildRevenueAnalytics({...range,source:'order',paymentMethod:'cod'});
  assert.equal(cash.recognizedOrderRevenue,0);assert.equal(cash.grossCollections,0);
});

test('a cash refund does not reduce GCash-filtered service profit, and technician totals use net sales',async t=>{
  mockDatabase(t,{BookingService:bookings.filter(row=>row._id==='prepaid'),Order:[],Payment:[payments[0]],ProductRefund:[]});
  const {analytics:gcash}=await buildRevenueAnalytics({...range,source:'service',paymentMethod:'gcash'});
  assert.equal(gcash.refunds,0);assert.equal(gcash.completedServiceCosts[0].revenue,1000);
  const {analytics:all}=await buildRevenueAnalytics({...range,source:'service'});
  assert.equal(all.completedServiceCosts[0].revenue,800);assert.equal(all.topTechnicians[0].revenue,800);
  assert.equal(all.topTechnicians[0].profit,all.completedServiceCosts[0].grossProfit);
});

test('service profit uses changed core prices, approved repair quotes and company-paid purchases',async t=>{
  const booking={_id:'mixed',bookingReference:'RACS-MIXED',status:'completed',serviceType:'mixed',technicianId:'tech',createdAt:date('2026-10-01'),completedAt:date('2026-10-15'),travelFare:100,
    services:[{_id:'core',type:'core',name:'Cleaning',quantity:1,totalPrice:1000,finalCost:400,costUpdatedByTechnician:true},{_id:'repair',type:'repair',name:'Repair',quantity:1,initialCost:200,approval:{status:'approved'},quotation:{totalCost:600}}],
    localPurchase:[{actualPurchaseCost:90,purchaseByType:'customer'},{actualPurchaseCost:50,purchaseByType:'technician'}]};
  mockDatabase(t,{BookingService:[booking],Order:[],Payment:[],ProductRefund:[]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  const core=a.serviceProfitability.rows.find(row=>row.serviceName==='Cleaning'),repair=a.serviceProfitability.rows.find(row=>row.serviceName==='Repair');
  assert.equal(a.recognizedServiceRevenue,1300);assert.equal(core.revenue,450);assert.equal(repair.revenue,850);
  assert.equal(a.serviceDirectCost,50);assert.equal(core.directCost+repair.directCost,50);assert.equal(a.consistency.matches,true);
});

test('completed product refunds follow the selected payment state of their own order',async t=>{
  mockDatabase(t);
  const {analytics:a}=await buildRevenueAnalytics({...range,paymentStatus:'pending'});
  assert.equal(a.refunds,0);assert.equal(a.netCollections,0);
  assert.equal(a.consistency.matches,true);
});

test('future payments cannot qualify completed work for a historical payment-method selection',async t=>{
  mockDatabase(t,{BookingService:[],Order:orders,ProductRefund:[],Payment:[{...payments[2],collectedAt:date('2026-11-01')}]});
  const {analytics:a}=await buildRevenueAnalytics({...range,source:'order',paymentMethod:'gcash'});
  assert.equal(a.recognizedOrderRevenue,0);assert.equal(a.grossCollections,0);assert.equal(a.consistency.matches,true);
});

test('the owner-provided live audit totals reconcile completed sales, unfinished collections and unpaid balances',async t=>{
  const when=date('2026-10-15');
  mockDatabase(t,{BookingService:[{_id:'completed',bookingReference:'FIXTURE-COMPLETED',status:'completed',serviceType:'core',totalPrice:5247,createdAt:when,completedAt:when,paymentStatus:'paid'}],
    Order:[{_id:'unfinished',orderReference:'FIXTURE-UNFINISHED',status:'preparing_unit',total:130654.2,createdAt:when,paymentStatus:'partial',items:[]}],
    Payment:[{_id:'deposit',bookingId:'completed',status:'paid',method:'gcash',amount:262,collectedAt:when},{_id:'balance',bookingId:'completed',status:'waiting_for_remittance',method:'cash',amount:4985,collectedAt:when},
      ...Array.from({length:9},(_,i)=>({_id:'unfinished-'+i,orderId:'unfinished',status:'paid',method:'gcash',amount:i===8?6440:5000,collectedAt:when}))],
    ProductRefund:[],WalkInSale:[{_id:'counter',status:'completed',totalAmount:1100,totalCost:600,paymentMethod:'cash',createdAt:when,completedAt:when}]});
  const {analytics:a}=await buildRevenueAnalytics(range);
  assert.equal(a.recognizedRevenue,6347);assert.equal(a.netCollections,52787);
  assert.equal(a.reconciliation.cashBreakdown.find(row=>row.key==='unfinished_work').collections,46440);
  assert.equal(a.reconciliation.requestedValue,137001.2);assert.ok(Math.abs(a.outstandingValue-84214.2)<0.001);
  assert.equal(a.reconciliation.unmatchedPaymentRecords,0);assert.equal(a.consistency.matches,true);
});
