'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dates = require('../utils/reportingDates');
const finance = require('../utils/enterpriseRevenue');
const { bookingReportValue, bookingValueExpression } = require('../utils/bookingReportValue');
const { allocateServiceRevenue, ratingForBooking } = require('../utils/serviceAnalytics');
const { buildTechnicianRatingReport, filterTechnicianRows } = require('../utils/technicianRatingReport');
const { buildCanonicalReviews } = require('../utils/serviceRatingReport');
const { stockCatalog, stockSnapshot } = require('../utils/stockReportData');
const { csvRows, buildReportCsv } = require('../utils/reportCsv');
const { bookingSummary, buildCustomerBookingPdf, createBookingPdfHandler } = require('../utils/customerBookingPdf');
const { sourceSummaryPipeline, parsePeriod } = require('../utils/customerPerformanceSummary');

const collected = new Date('2026-09-30T17:00:00Z');
const payment = { status:'paid', amount:1000, method:'gcash', collectedAt:collected, verifiedAt:new Date('2026-11-01T00:00:00Z') };
const range = { startDate:dates.parseDate('2026-10-01'), endDate:dates.parseDate('2026-10-31',true) };
const refund = { ...payment, refundStatus:'completed', refundAmount:200, refundMethod:'cash', refundedAt:new Date('2026-10-10T04:00:00Z') };

test('report periods use Philippine days identically on UTC and Manila hosts', () => {
  const script = "const d=require('./server/utils/reportingDates');const p=d.period({range:'today'},{now:new Date('2026-10-14T17:15:00Z')});console.log(JSON.stringify([d.dateKey(p.start),p.start.toISOString(),p.end.toISOString(),d.startOfMonth(new Date('2026-05-31T14:00:00Z'),-3).toISOString()]));";
  const outputs = ['UTC','Asia/Manila','America/Los_Angeles'].map(TZ => {
    const result = spawnSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'../..'),env:{...process.env,TZ},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
  });
  outputs.forEach(value=>assert.deepEqual(value,['2026-10-15','2026-10-14T16:00:00.000Z','2026-10-15T15:59:59.999Z','2026-01-31T16:00:00.000Z']));
});
test('invalid custom periods are rejected instead of silently reversing or normalizing dates', () => {
  for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-10-15','2026-10-01'],['oops','2026-10-01']]) assert.throws(()=>dates.period({range:'custom',from,to}),error=>error.status===400);
});
test('cash is recognized when collected, including remittance exceptions, and pending refunds do not reduce it', () => {
  for(const status of ['paid','rejected','unaccounted']) {
    const result=finance.summarizePaymentLedger([{...payment,status,refundAmount:999,refundStatus:'pending'}],range);
    assert.equal(result.grossCollections,1000);assert.equal(result.refunds,0);
  }
});
test('collection and refund method filters apply to their own money events', () => {
  const gcash=finance.summarizePaymentLedger([refund],{...range,methodFilter:'gcash'});
  const cash=finance.summarizePaymentLedger([refund],{...range,methodFilter:'cash'});
  assert.equal(gcash.netCollections,1000);assert.equal(gcash.refunds,0);
  assert.equal(cash.grossCollections,0);assert.equal(cash.netCollections,-200);
});
test('completed product refunds reduce period cash; pending and excluded test refunds do not', () => {
  const result=finance.summarizePaymentLedger([refund],{...range,productRefunds:[
    {status:'completed',amount:300,method:'bank',processedAt:collected},
    {status:'pending',amount:10000,method:'bank',processedAt:collected},
    {status:'completed',amount:10000,method:'bank',processedAt:collected,testDataExcludedAt:collected},
  ]});
  assert.equal(result.refunds,500);assert.equal(result.netCollections,500);
  assert.equal(Object.values(result.byMethod).reduce((a,b)=>a+b,0),result.netCollections);
});
test('refunded payments do not reopen debt and another transaction cannot absorb overpayments', () => {
  assert.equal(finance.outstandingForValue(1000,[{...refund,amount:1000,refundAmount:1000}]),0);
  const debt=finance.outstandingForValue(1000,[{...payment,amount:1500}])+finance.outstandingForValue(1000,[{...payment,amount:100}]);
  assert.equal(debt,900);
});
test('mixed booking value retains core work, inspection and travel while excluding draft quotations', () => {
  const mixed={serviceType:'mixed',discount:100,travelFare:50,services:[{type:'core',quantity:2,totalPrice:1000},{type:'repair',initialCost:250,quotation:{totalCost:5000},approval:{status:'pending'}}]};
  assert.equal(bookingReportValue(mixed),1200);
  mixed.services[1].approval.status='approved';assert.equal(bookingReportValue(mixed),6200);
  mixed.inspectionFeeAmount=250;mixed.inspectionFeeDistanceFare=50;assert.equal(bookingReportValue(mixed),6200);
});
test('discounted service allocations reconcile to the approved booking value', () => {
  const lines=allocateServiceRevenue({services:[{totalPrice:800},{totalPrice:1200}]},1800);
  assert.equal(lines.reduce((sum,row)=>sum+row.allocatedRevenue,0),1800);
  assert.equal(lines[0].allocatedRevenue,720);
});
test('order-linked, archived and explicitly excluded bookings contribute no second service sale', () => {
  for(const field of ['sourceOrderId','archivedAt','testDataExcludedAt']) assert.equal(bookingReportValue({totalPrice:1000,[field]:'value'}),0);
});

// Evaluate the aggregation arithmetic against fixture documents. Unknown
// operators fail rather than accidentally accepting a different pricing rule.
function evaluate(expr,doc,vars={}) {
  const get=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
  if(typeof expr==='string'&&expr.startsWith('$$')) {const [name,...path]=expr.slice(2).split('.');return path.length?get(vars[name],path.join('.')):vars[name];}
  if(typeof expr==='string'&&expr.startsWith('$'))return get(doc,expr.slice(1));
  if(Array.isArray(expr))return expr.map(value=>evaluate(value,doc,vars));
  if(!expr||typeof expr!=='object')return expr;
  const [[op,value]]=Object.entries(expr), ev=x=>evaluate(x,doc,vars), args=()=>ev(value);
  switch(op){
    case '$ifNull': {const [a,b]=args();return a==null?b:a;}
    case '$cond': return ev(value[ev(value[0])?1:2]);
    case '$filter':return ev(value.input).filter(item=>evaluate(value.cond,doc,{...vars,[value.as]:item}));
    case '$map':return ev(value.input).map(item=>evaluate(value.in,doc,{...vars,[value.as]:item}));
    case '$size':return ev(value).length;
    case '$sum':return ev(value).reduce((a,b)=>a+b,0);
    case '$add':return args().reduce((a,b)=>a+b,0);
    case '$multiply':return args().reduce((a,b)=>a*b,1);
    case '$subtract': {const [a,b]=args();return a-b;}
    case '$max':return Math.max(...args());
    case '$gt': {const [a,b]=args();return a>b;}
    case '$eq': {const [a,b]=args();return a===b;}
    case '$ne': {const [a,b]=args();return a!==b;}
    case '$in': {const [a,b]=args();return b.includes(a);}
    case '$not':return !ev(value[0]);
    case '$and':return args().every(Boolean);
    case '$or':return args().some(Boolean);
    default:throw Error('Unsupported test expression '+op);
  }
}
test('customer aggregation and service/revenue reports apply the same booking valuation', () => {
  const fixtures=[{serviceType:'core',totalPrice:900},{serviceType:'repair',estimatedFee:700},{issueDescription:'Legacy repair',inspectionFeeAmount:300},
    {serviceType:'mixed',discount:100,travelFare:50,services:[{type:'core',totalPrice:1000},{type:'repair',quantity:2,initialCost:150,approval:{status:'approved'},quotation:{totalCost:2000}}]},
    {serviceType:'repair',services:[{type:'repair',quotation:{totalCost:999},approval:{status:'pending'}}],initialCost:200},
    {sourceOrderId:'order',totalPrice:1000},{archivedAt:new Date(),totalPrice:1000},
    {serviceType:'mixed',services:[{type:'core',quantity:2,finalCost:300,costUpdatedByTechnician:true},{type:'repair',initialCost:150}]}];
  for(const doc of fixtures) assert.equal(evaluate(bookingValueExpression(),doc),bookingReportValue(doc),JSON.stringify(doc));
});
test('customer spending looks up settled payment refunds and never treats a partial request as completed cash', () => {
  const pipeline=sourceSummaryPipeline(parsePeriod({},new Date('2026-10-15')),true,new Date('2026-10-15'));
  const lookup=pipeline.find(stage=>stage.$lookup?.as==='settledRefunds').$lookup;
  assert.equal(lookup.from,require('../models/Payment').collection.name);
  assert.ok(lookup.pipeline.some(stage=>stage.$match?.$expr?.$and));
  assert.doesNotMatch(JSON.stringify(pipeline),/\["completed","partial"\]/);
});
test('stock includes active HP variants and derives alerts from stock remaining after reservations', () => {
  const products=[{_id:'p',modelLine:'Midea',variants:[{_id:'one',capacity:1,quantity:10,reservedQuantity:9,minStockLevel:2},{_id:'three',capacity:3,quantity:4,minStockLevel:1},{_id:'hidden',active:false,quantity:999}]}];
  const rows=stockCatalog([],products);assert.equal(rows.length,2);assert.equal(rows[0].availableQuantity,1);assert.equal(rows[0].status,'low_stock');
  const summary=stockSnapshot([],products,[{_id:'tool',quantity:3,reservedQuantity:3,minStockLevel:1}]);
  assert.deepEqual(summary,{skuCount:3,units:17,outOfStock:1,lowStock:1});
});
test('technician ratings include repair completions and orders once, and job trends count jobs rather than reviews', () => {
  const date=new Date('2026-10-10T05:00:00Z');
  const report=buildTechnicianRatingReport({now:date,technicians:[{_id:'tech',name:'Fixture',createdAt:new Date('2020-01-01')}],bookings:[
    {_id:'repair',technicianId:'tech',status:'repair_completed',customerRating:5,updatedAt:date,completedAt:date},
    {_id:'unrated',technicianId:'tech',status:'closed',completedAt:date},
    {_id:'installation',technicianId:'tech',status:'completed',sourceOrderId:'order',customerRating:1,completedAt:date},
    {_id:'test',technicianId:'tech',status:'completed',testDataExcludedAt:date,customerRating:1,completedAt:date},
  ],orders:[{_id:'order',technicianId:'tech',status:'completed',customerRating:3,updatedAt:date,completedAt:date}],ratingDocs:[{targetType:'booking',targetId:'repair',score:5,createdAt:date},{targetType:'technician',targetId:'tech',score:1}]});
  assert.equal(report.stats.totalReviews,2);assert.equal(report.stats.avgRating,4);assert.equal(report.technicians[0].jobsCompleted,3);
  assert.equal(report.performanceTrends.jobCounts.at(-1),3);assert.equal(report.performanceTrends.reviewCounts.at(-1),2);assert.equal(report.dataQuality.legacyTechnicianReviewsExcluded,1);
  assert.equal(filterTechnicianRows(report.technicians,{rating:'5'}).length,0);
});
test('hidden normalized reviews suppress legacy copies; pending and orphan reviews are excluded', () => {
  const bookings=[{_id:'done',status:'completed',customerRating:5},{_id:'pending',status:'pending',customerRating:5}];
  assert.deepEqual(buildCanonicalReviews({bookings,ratingDocs:[{targetId:'done',score:5,moderationStatus:'hidden'},{targetId:'orphan',score:5}]}),[]);
  assert.equal(ratingForBooking({_id:'done',customerRating:5},new Map([['done',0]])),0);
});
test('CSV preserves numeric losses and escapes formulas, quotes, multiline text, and Philippine characters', () => {
  const csv=csvRows(['Name','Amount'],[[' \t=HYPERLINK("x")',-100],['Peña, "A"\nB',25]]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\' \t=HYPERLINK(""x"")"'));assert.ok(csv.includes('"-100"'));assert.ok(csv.includes('"Peña, ""A""\nB"'));
  for(const value of ['+cmd','-cmd','@SUM(1)','\r=SUM(1)'])assert.ok(csvRows(['Name'],[[value]]).includes('"\''));
});
test('CSV reports retain filters and server totals without private fields or silently partial results', () => {
  for(const kind of ['overview','revenue','orders','service','inventory','customers','service_ratings','technician_ratings']) {
    const csv=buildReportCsv(kind,{total:1234,paid:2,secret:'PRIVATE',items:[{name:'Aircon',quantity:10,password:'PRIVATE'}]},{from:'2026-10-01',status:'completed'});
    assert.ok(csv.includes('1234'));assert.ok(csv.includes('Paid'));assert.ok(csv.includes('2026-10-01'));assert.ok(csv.includes('Aircon'));assert.ok(!csv.includes('PRIVATE'));
  }
  assert.throws(()=>buildReportCsv('overview',{partial:true}),error=>error.status===503);
  assert.throws(()=>csvRows(['A'],Array.from({length:50001},()=>[1])),error=>error.status===413);
});
test('customer booking summary is a readable PDF and contains only selected display fields', async () => {
  const summary=bookingSummary({bookingReference:'FIXTURE',status:'completed',totalPrice:1000,customer:{name:'Fixture'},internalNotes:'PRIVATE',password:'PRIVATE',services:Array.from({length:40},(_,i)=>({name:'Service '+i,quantity:1}))},[refund]);
  assert.equal(summary.unpaidBalance,0);assert.equal(summary.paymentsReceived,1000);assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  const pdf=await buildCustomerBookingPdf(summary);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>3000);assert.ok(pdf.toString('latin1').includes('%%EOF'));
});
function response(){return{code:200,headers:{},status(code){this.code=code;return this;},json(value){this.body=value;return this;},set(key,value){this.headers[key]=value;return this;},send(value){this.body=value;return this;}};}
test('customer PDF queries ownership in the database and returns 404 for another customer booking', async () => {
  let query,selected,paymentReads=0;
  const handler=createBookingPdfHandler({Booking:{findOne(value){query=value;return{select(fields){selected=fields;return this;},lean:async()=>null};}},Payment:{find(){paymentReads++;}},pricing:async()=>new Map()});
  const res=response();await handler({params:{id:'507f191e810c19729de860ea'},user:{_id:'owner'}},res,error=>{throw error;});
  assert.equal(query.customerId,'owner');assert.equal(query.archivedAt,null);assert.equal(res.code,404);assert.equal(paymentReads,0);assert.ok(!selected.includes('internalNotes'));
});
test('customer PDF includes project payments, enforces private caching, and rejects malformed IDs', async () => {
  let query;
  const chain=value=>({select(){return this;},lean:async()=>value});
  const handler=createBookingPdfHandler({Booking:{findOne:()=>chain({_id:'507f191e810c19729de860ea',totalPrice:1000})},Payment:{find(value){query=value;return chain([payment]);}},pricing:async()=>new Map([['507f191e810c19729de860ea',{projectId:'project',pricing:{total:1000}}]]),render:async()=>Buffer.from('%PDF-fixture')});
  const invalid=response();await handler({params:{id:'invalid'},user:{_id:'owner'}},invalid,error=>{throw error;});assert.equal(invalid.code,400);
  const res=response();await handler({params:{id:'507f191e810c19729de860ea'},user:{_id:'owner'}},res,error=>{throw error;});
  assert.ok(query.$or.some(value=>value.projectId==='project'));assert.equal(res.headers['Cache-Control'],'private, no-store');assert.equal(res.headers['Content-Type'],'application/pdf');
});
test('read-only audit explains legitimate negative period sales without modifying records or exposing identities', () => {
  const input={...range,bookings:[{_id:'done',status:'completed',totalPrice:1000,completedAt:collected,customer:{name:'PRIVATE'}}],
    orders:[],payments:[{...refund,amount:5000,refundAmount:4000,customerEmail:'PRIVATE'}],ratings:[{targetType:'booking',targetId:'missing',score:5}]};
  const before=JSON.stringify(input),report=require('../utils/reportDataAudit').auditReportRecords(input);
  assert.equal(report.mode,'read-only');assert.equal(report.totals.completedSalesBeforeRefunds,1000);
  assert.equal(report.totals.completedSalesAfterPeriodRefunds,-3000);assert.equal(report.findings.orphanWorkReviews,1);
  assert.equal(JSON.stringify(input),before);assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
test('order report drilldown keeps a refunded paid order settled and excludes archived/test records', async () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const file=path.join(__dirname,'../routes/adminApi.js'),source=fs.readFileSync(file,'utf8');
  const start=source.indexOf('router.post("/reports/orders/drilldown"');
  const segment=source.slice(start,source.indexOf('router.get("/reports/orders/export"',start));
  const originalRequire=require('node:module').createRequire(file);
  let handler,query,paymentQuery;
  const chain=rows=>({sort(){return this;},limit(){return this;},lean:async()=>rows});
  vm.runInNewContext(segment,{router:{post(...args){handler=args.at(-1);}},require(name){
    if(name==='../models/Order')return{find(value){query=value;return chain([{_id:'order',status:'completed',total:1000,createdAt:collected,items:[]}]);}};
    if(name==='../models/Payment')return{find(value){paymentQuery=value;return chain([{...refund,orderId:'order'}]);}};
    return originalRequire(name);
  }});
  const res=response();await handler({body:{from:'2026-10-01',to:'2026-10-31'}},res,error=>{throw error;});
  assert.equal(res.body.rows[0].collected,800);assert.equal(res.body.rows[0].balance,0);
  assert.ok(JSON.stringify(query).includes('testDataExcludedAt'));assert.equal(paymentQuery.archivedAt,null);
});
