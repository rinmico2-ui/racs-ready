'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildRevenueReconciliation}=require('../utils/revenueReconciliation');
const {summarizePaymentLedger}=require('../utils/enterpriseRevenue');
const startDate=new Date('2026-09-30T16:00:00Z'),endDate=new Date('2026-10-15T15:59:59.999Z');
const now=new Date('2026-10-14T17:00:00Z');
const base={startDate,endDate};
const sum=(rows,field='amount')=>rows.reduce((total,row)=>total+Number(row[field]||0),0);
test('live-audit shaped fixture explains large collections with 28 missing bookings without inventing completed sales',()=>{
  const payments=Array.from({length:28},(_,i)=>({_id:'payment-'+i,bookingId:'deleted-'+i,status:'paid',method:'gcash',collectedAt:now,amount:i===27?431520.17:10000,refundStatus:'pending',refundAmount:i===27?925227:0}));
  const result=buildRevenueReconciliation({...base,payments,posSales:[{_id:'counter',status:'completed',completedAt:now,totalAmount:1100,paymentMethod:'cash'}]});
  assert.equal(result.reconciliation.grossSales,1100);assert.equal(result.reconciliation.refunds,0);
  assert.ok(Math.abs(result.reconciliation.netCollections-702620.17)<0.001);
  assert.equal(result.reconciliation.unmatchedPaymentRecords,28);assert.ok(Math.abs(result.reconciliation.unmatchedCollections-701520.17)<0.001);
  assert.equal(result.activity.completed.length,1);assert.equal(result.activity.payments.length,29);
  assert.equal(sum(result.activity.payments),result.reconciliation.netCollections);
});
test('sales sources, completed rows, requested values and cash rows each reconcile to their own totals',()=>{
  const done={_id:'done',status:'completed',serviceType:'core',createdAt:new Date('2026-08-01'),completedAt:now,totalPrice:1000,paymentStatus:'paid'};
  const pending={_id:'pending',status:'preparing_unit',createdAt:now,total:900000,paymentStatus:'pending'};
  const payments=[{_id:'deposit',orderId:'pending',status:'paid',method:'gcash',amount:90000,collectedAt:now}];
  const result=buildRevenueReconciliation({...base,recognizedBookings:[done],orders:[pending],payments,cohortPayments:payments});
  assert.equal(sum(result.activity.completed),1000);assert.equal(sum(result.activity.requested),900000);assert.equal(sum(result.activity.payments),90000);
  assert.equal(result.salesView.serviceRevenue+result.salesView.orderRevenue+result.salesView.posRevenue,result.reconciliation.grossSales);
  assert.equal(result.reconciliation.appliedPayments+result.reconciliation.unpaidBalance,result.reconciliation.requestedValue);
  assert.equal(result.reconciliation.paidCoveragePercent,10);assert.equal(result.reconciliation.cashBreakdown.find(row=>row.key==='unfinished_work').collections,90000);
});
test('cash for work outside the creation-date cohort remains linked rather than appearing unmatched',()=>{
  const parent={_id:'old',status:'completed',completedAt:new Date('2026-08-01'),customer:{name:'Fixture'},bookingReference:'BKG-FIXTURE'};
  const payments=[{_id:'cash',bookingId:'old',status:'paid',amount:500,method:'cash',collectedAt:now}];
  const result=buildRevenueReconciliation({...base,payments,parentBookings:[parent]});
  assert.equal(result.reconciliation.unmatchedCollections,0);assert.equal(result.reconciliation.grossCollections,500);
  assert.equal(result.reconciliation.cashBreakdown.find(row=>row.key==='other_completed_work').collections,500);
  assert.equal(result.activity.payments[0].reference,'BKG-FIXTURE');
});
test('actual collection and refund amounts, dates and methods reconcile with the financial ledger',()=>{
  const payment={_id:'cash',bookingId:'booking',status:'refunded',amount:1000,method:'gcash',collectedAt:now,refundStatus:'completed',refundAmount:250,refundMethod:'cash',refundedAt:now};
  const productRefunds=[{_id:'return',sourceType:'order',sourceId:'order',status:'completed',amount:100,method:'bank',processedAt:now}];
  for(const methodFilter of [null,'cash','gcash','bank']){
    const result=buildRevenueReconciliation({...base,payments:[payment],productRefunds,methodFilter});
    const ledger=summarizePaymentLedger([payment],{...base,productRefunds,methodFilter});
    assert.equal(result.reconciliation.grossCollections,ledger.grossCollections);assert.equal(result.reconciliation.refunds,ledger.refunds);
    assert.equal(sum(result.activity.payments),ledger.netCollections);
  }
});
test('project-only deposits apply to the linked requested booking once',()=>{
  const booking={_id:'booking',status:'in_progress',serviceType:'core',totalPrice:5000,createdAt:now,paymentStatus:'partial'};
  const payments=[{_id:'cash',bookingId:'booking',projectId:'project',status:'paid',amount:1000,method:'gcash',collectedAt:now}];
  const result=buildRevenueReconciliation({...base,bookings:[booking],payments,cohortPayments:payments,parentProjects:[{_id:'project',bookingId:'booking',status:'in_progress'}]});
  assert.equal(result.reconciliation.appliedPayments,1000);assert.equal(result.reconciliation.unpaidBalance,4000);assert.equal(result.reconciliation.grossCollections,1000);
});
test('paid labels without a ledger are flagged, while overpayments cannot pay another order',()=>{
  const orders=[{_id:'a',status:'preparing_unit',total:1000,createdAt:now,paymentStatus:'paid'},{_id:'b',status:'preparing_unit',total:1000,createdAt:now,paymentStatus:'paid'}];
  const payments=[{_id:'cash',orderId:'a',status:'paid',amount:2000,method:'cash',collectedAt:now}];
  const result=buildRevenueReconciliation({...base,orders,payments,cohortPayments:payments});
  assert.equal(result.reconciliation.appliedPayments,1000);assert.equal(result.reconciliation.unpaidBalance,1000);assert.equal(result.reconciliation.paidStatusMismatchCount,1);
  assert.equal(result.activity.requested.find(row=>row.reference==='Reference unavailable'&&row.id==='order:b').balance,1000);
});
test('completed service mix includes mixed work, and month keys use Philippine completion dates',()=>{
  const bookings=[{_id:'core',status:'completed',serviceType:'core',totalPrice:1000,completedAt:now},{_id:'repair',status:'repair_completed',serviceType:'repair',initialCost:250,completedAt:now},{_id:'mix',status:'closed',serviceType:'mixed',services:[{type:'core',totalPrice:1000},{type:'repair',initialCost:250}],completedAt:now}];
  const result=buildRevenueReconciliation({...base,recognizedBookings:bookings});
  assert.equal(result.salesView.coreRevenue+result.salesView.repairRevenue+result.salesView.mixRevenue,result.salesView.serviceRevenue);
  assert.equal(result.salesView.mixRevenue,1250);assert.ok(result.activity.completed.every(row=>row.monthKey==='2026-10'));
});

function chartConfigs(analytics) {
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../views/pages/admin/Reports/RevenueReports.ejs'),'utf8');
  const start=source.indexOf('  const chartConfigs = {'),end=source.indexOf('  // Initialize charts on page load',start);
  const context={currentA:analytics,pesoFmt:value=>Number(value)||0,pct:value=>value,esc:value=>String(value||''),window:{RACSRevenueReconciliation:{serviceCost:row=>Number(row.partsCost||0)+Number(row.consumablesCost||0)+Number(row.laborCost||0)+Number(row.localPurchaseCost||0)}}};
  require('node:vm').runInNewContext(source.slice(start,end)+'\nglobalThis.configs=chartConfigs;',context);
  return context.configs;
}
test('monthly sales details use the same month key and completion rows as the selected chart',()=>{
  const activity={completed:[{date:now,monthKey:'2026-10',type:'service',amount:1000},{date:now,monthKey:'2026-10',type:'order',amount:2000}]};
  const config=chartConfigs({activity,recognizedGrossRevenue:3000,monthlyRevenue:{'Oct 2026':{monthKey:'2026-10',completedService:1000,completedOrders:2000,completedPos:0}}}).revenueTrend;
  assert.equal(config.getRows(0).reduce((sum,row)=>sum+row[5],0),3000);assert.equal(config.getSummary(0)[0].value,3000);
});
test('collection chart details show actual collected amounts rather than full booking values',()=>{
  const config=chartConfigs({grossCollections:15000,grossCollectionMethods:{gcash:10000,cash:5000},recentTransactions:[{method:'gcash',amount:900000}],activity:{payments:[{kind:'collection',type:'order',method:'gcash',amount:10000,date:now},{kind:'collection',type:'service',method:'cash',amount:5000,date:now},{kind:'refund',method:'gcash',amount:-1000,date:now}]}}).paymentMix;
  assert.equal(config.getRows(0).reduce((sum,row)=>sum+row[4],0),10000);assert.equal(config.getSummary(0)[0].value,10000);
});
test('product channel detail totals include walk-in aircons and every matching product beyond the ranking limit',()=>{
  const productRows=Array.from({length:35},(_,i)=>({name:'Fixture '+i,channel:i===0?'Walk-in Aircon':i<30?'Online Order':'POS',quantity:1,revenue:100}));
  const config=chartConfigs({productRows,orderProductRevenue:3000,posProductRevenue:500,totalProductRevenue:3500,totalProductUnits:35}).productChannelMix;
  assert.equal(config.getRows(0).length,30);assert.equal(config.getRows(1).length,5);
  for(const i of [0,1])assert.equal(config.getRows(i).reduce((sum,row)=>sum+row[4],0),config.chartData().datasets[0].data[i]);
});
test('counter payment detail selection and fulfillment detail selection respect their clicked slices',()=>{
  const analytics={posPaymentMethods:{cash:100,gcash:200},activity:{payments:[{kind:'collection',type:'pos',method:'cash',amount:100,date:now},{kind:'collection',type:'pos',method:'gcash',amount:200,date:now}],completed:[{type:'order',fulfillment:'delivery_only',amount:300,date:now},{type:'order',fulfillment:'customer_pickup',amount:400,date:now}]},orderFulfillmentMap:{delivery_only:{count:1,revenue:300},customer_pickup:{count:1,revenue:400}}};
  const config=chartConfigs(analytics);
  assert.equal(config.posPaymentMix.getRows(0).reduce((sum,row)=>sum+row[4],0),100);assert.equal(config.posPaymentMix.getRows(1).reduce((sum,row)=>sum+row[4],0),200);
  assert.equal(config.fulfillmentMix.getRows(0).reduce((sum,row)=>sum+row[4],0),300);assert.equal(config.fulfillmentMix.getRows(2).reduce((sum,row)=>sum+row[4],0),400);
});
test('service chart and detail costs include all saved cost components used by profit',()=>{
  const service={serviceName:'Fixture',serviceCategory:'repair',revenue:1000,partsCost:100,consumablesCost:20,laborCost:30,localPurchaseCost:50,grossProfit:800};
  const config=chartConfigs({completedServiceCosts:[service]}).serviceEconomics;
  assert.equal(config.chartData().datasets[1].data[1],200);assert.equal(config.getSummary(1).find(row=>row.label==='Saved job costs').value,200);assert.equal(config.getRows(1)[0][3],200);
});
