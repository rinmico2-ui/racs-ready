const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {dashboardBookingSummary,buildBookingSummaryPipeline}=require('../utils/dashboardBookingSummary');
const {trackMongoPool,runtimeSnapshot}=require('../middleware/requestTelemetry');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8').replace(/\r\n/g,'\n');

// Evaluate the small set of Mongo expression operators used by the counters.
// This verifies mixed date/status fixtures against the emitted expressions.
function expression(value,row){
  if(typeof value==='string' && value.startsWith('$'))return row[value.slice(1)];
  if(value===null || typeof value!=='object' || value instanceof Date)return value;
  if(Array.isArray(value))return value.map(item=>expression(item,row));
  const [operator,args]=Object.entries(value)[0];
  const values=expression(args,row);
  switch(operator){
    case '$or':return values.some(Boolean);
    case '$and':return values.every(Boolean);
    case '$gte':return values[0]!=null && values[0]>=values[1];
    case '$lte':return values[0]!=null && values[0]<=values[1];
    case '$eq':return values[0]===values[1];
    case '$in':return values[1].includes(values[0]);
    case '$ifNull':return values[0]??values[1];
    case '$cond':return values[0]?values[1]:values[2];
    default:throw Error('Unsupported test operator '+operator);
  }
}

test('dashboard counters count a booking once per day and preserve status, payment and missing-technician rules',()=>{
  const start=new Date('2026-10-12T00:00:00+08:00'),end=new Date('2026-10-12T23:59:59.999+08:00');
  const yesterday=new Date(start.getTime()-86400000),tomorrow=new Date(start.getTime()+86400000);
  const rows=[
    {status:'assigned',paymentStatus:'partial',bookingDate:start,createdAt:start},
    {status:'completed',paymentStatus:'paid',bookingDate:yesterday,createdAt:end},
    {status:'cancelled',paymentStatus:'pending',bookingDate:start},
    {status:'confirmed',paymentStatus:'paid',bookingDate:yesterday,technicianId:null},
    {status:'confirmed',paymentStatus:'paid',bookingDate:yesterday,technicianId:'tech'},
    {status:'pending',paymentStatus:'pending',bookingDate:tomorrow},
    {status:'confirmed'},
  ];
  const pipeline=buildBookingSummaryPipeline(start,end,[]);
  assert.deepEqual(Object.keys(pipeline[0].$project).sort(),['bookingDate','createdAt','paymentStatus','serviceType','status','technicianId']);
  const group=pipeline[1].$facet.totals[0].$group;
  const totals=Object.fromEntries(Object.entries(group).filter(([key])=>key!=='_id').map(([key,value])=>[
    key,rows.reduce((sum,row)=>sum+Number(expression(value.$sum,row)),0),
  ]));
  assert.deepEqual(totals,{totalBookingsAllTime:7,totalBookingsToday:3,completedToday:1,pendingReview:3,confirmedWithoutTechnician:2});
});

test('seven trend days and all booking counters use one bounded aggregate and empty days remain zero',async()=>{
  let calls=0,pipeline,options,disk;
  const Booking={aggregate(value){calls++;pipeline=value;return {allowDiskUse(value){disk=value;return this;},option(value){options=value;return Promise.resolve([
    {totals:[{totalBookingsToday:3}],pipeline:[{_id:'assigned',count:3}],serviceDistribution:[{_id:'core',count:3}],trend0:[{count:2}],trend6:[{count:3}]},
  ]);}};}};
  const result=await dashboardBookingSummary(Booking,{startOfDay:new Date('2026-10-12T00:00:00'),endOfDay:new Date('2026-10-12T23:59:59.999')});
  assert.equal(calls,1);assert.equal(disk,true);assert.equal(options.maxTimeMS,8000);
  assert.equal(result.totalBookingsToday,3);assert.deepEqual(result.trend7.map(day=>day.count),[2,0,0,0,0,0,3]);
  assert.equal(Object.keys(pipeline[1].$facet).filter(key=>key.startsWith('trend')).length,7);
  const first=pipeline[1].$facet.trend0[0].$match;
  assert.equal(first.$or[0].bookingDate.$gte.getDate(),6);
  assert.equal(first.$or[1].createdAt.$gte.getDate(),6);
  assert.equal(first.$or[0].bookingDate.$lte.getHours(),23);
  assert.equal(first.$or[0].bookingDate.$lte.getMilliseconds(),999);
});

function pendingIssuesHandler(kits,bookings,fail=false){
  const source=read('routes/adminApi.js'),begin=source.indexOf('router.get("/daily-kit/pending-issues"');
  const start=source.indexOf('async (req, res, next) => {',begin),end=source.indexOf('\n});',start);
  const reads=[];
  const chain=(value,label)=>({select(fields){reads.push([label,'select',fields]);return this;},populate(){return this;},maxTimeMS(ms){reads.push([label,'limit',ms]);return this;},
    lean:async()=>{if(fail && label==='bookings')throw Error('database unavailable');return value;}});
  const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',{
    require:name=>({
      '../models/DailyKit':{find:query=>{reads.push(['kits','find',query]);return chain(kits,'kits');}},
      '../models/BookingService':{find:query=>{reads.push(['bookings','find',query]);return chain(bookings,'bookings');}},
      '../utils/dailyKitService':{dayBounds:()=>({start:new Date('2026-10-12'),end:new Date('2026-10-13')})},
    })[name],console:{error(){}},
  });
  return {reads,async invoke(){const res={json(body){this.body=body;}};await handler({},res,error=>res.error=error);return res;}};
}

test('preparation issues read bookings once for all technicians and include unresolved delta items',async()=>{
  const item=(name,ids,status='admin_notified')=>({name,bookingIds:ids,checkoutStatus:'unavailable',resolution:{status}});
  const kits=[{_id:'kit1',technicianId:{_id:'tech1',name:'Technician One'},items:[item('Ladder',['a','b']),item('Gauge',['a']),item('Old',['a'],'resolved')],
    deltaItems:[item('Hose',['b','missing'])]},
    {_id:'kit2',items:[item('Extra',['a'])],deltaItems:[]}];
  const fixture=pendingIssuesHandler(kits,[{_id:'a',bookingReference:'RACS-A',service:{name:'Installation'},location:{address:'Saved address'}},
    {_id:'b',bookingReference:'RACS-B',services:[{name:'Cleaning'},{name:'Repair'}]}]);
  const response=await fixture.invoke();assert.equal(response.error,undefined);
  assert.deepEqual(Array.from(response.body.issues,item=>item.itemName),['Ladder','Gauge','Hose','Extra']);
  const bookingReads=fixture.reads.filter(row=>row[0]==='bookings' && row[1]==='find');assert.equal(bookingReads.length,1);
  assert.deepEqual(Array.from(bookingReads[0][2]._id.$in),['a','b','missing']);
  assert.equal(response.body.issues[0].bookings[0].service,'Installation');assert.equal(response.body.issues[0].bookings[0].address,'Saved address');
  assert.equal(response.body.issues[2].bookings.length,1);assert.equal(response.body.issues[2].bookings[0].service,'Cleaning, Repair');
  assert.equal(response.body.issues[3].technicianName,'Unknown');
});

test('empty preparation issues skip booking reads and failures do not return an empty success result',async()=>{
  const empty=pendingIssuesHandler([],[]);assert.equal((await empty.invoke()).body.issues.length,0);
  assert.equal(empty.reads.some(row=>row[0]==='bookings'),false);
  const fail=pendingIssuesHandler([{items:[{name:'Ladder',bookingIds:['a'],checkoutStatus:'unavailable',resolution:{status:'admin_notified'}}]}],[],true);
  const result=await fail.invoke();assert.match(result.error.message,/database unavailable/);assert.equal(result.body,undefined);
});

test('hidden dashboards do not poll kit issues, overlapping loads coalesce and failures allow a retry',async()=>{
  const source=read('views/pages/admin/admin-dashboard.ejs');const start=source.indexOf('  let prepIssuesLoading = false;');
  const implementation=source.slice(start,source.indexOf('  // Initial load',start));
  let calls=0,resolve;let pending=new Promise(done=>resolve=done);
  const body={innerHTML:''},badge={textContent:5,style:{}},document={hidden:true,getElementById:id=>id==='prepIssuesBody'?body:badge};
  const context=vm.createContext({document,window:{},fetch:()=>{calls++;return pending;}});
  vm.runInContext(implementation,context);
  await context.window.loadPrepIssues();assert.equal(calls,0);
  document.hidden=false;const first=context.window.loadPrepIssues();await context.window.loadPrepIssues();assert.equal(calls,1);
  resolve({ok:false});await first;assert.match(body.innerHTML,/Failed to load/);assert.equal(badge.textContent,5);
  pending=Promise.resolve({ok:true,json:async()=>({issues:[]})});await context.window.loadPrepIssues();assert.equal(calls,2);assert.equal(badge.textContent,0);
});

test('booking monitor never overlaps a slow cycle and retries after a cycle failure',async()=>{
  const source=read('utils/overdueBookingScheduler.js');const start=source.indexOf('let overdueSchedulerStarted = false;');
  const implementation=source.slice(start,source.indexOf('\nmodule.exports',start));
  let callbacks=[],calls=0,release,fail=true;
  const pending=new Promise(done=>release=done);
  const context=vm.createContext({CHECK_INTERVAL_MS:300000,console:{log(){},error(){}},setTimeout:callback=>callbacks.push(callback),setInterval:callback=>callbacks.push(callback),
    checkForUnassignedOverdueBookings:async()=>{calls++;await pending;if(fail)throw Error('timeout');},
    checkForDelayedBookings:async()=>{},checkForServiceDelays:async()=>{},checkForUpcomingUnverifiedBookings:async()=>{},checkForCustomerServiceReminders:async()=>{},
  });
  vm.runInContext(implementation,context);context.startOverdueScheduler();context.startOverdueScheduler();assert.equal(callbacks.length,2);
  const first=callbacks[0]();await callbacks[1]();assert.equal(calls,1);release();await first;
  fail=false;await callbacks[1]();assert.equal(calls,2);
});

test('pool telemetry distinguishes waiting from checked-out connections and records timeout duration',()=>{
  const client=new EventEmitter();client.options={maxPoolSize:20};const before=runtimeSnapshot().databasePool;
  trackMongoPool(client);trackMongoPool(client);
  client.emit('connectionCheckOutStarted');client.emit('connectionCheckOutStarted');
  assert.equal(runtimeSnapshot().databasePool.waiting,before.waiting+2);
  client.emit('connectionCheckedOut',{durationMS:15});client.emit('connectionCheckOutFailed',{reason:'timeout',durationMS:5000});
  const waiting=runtimeSnapshot().databasePool;
  assert.equal(waiting.waiting,before.waiting);assert.equal(waiting.checkedOut,before.checkedOut+1);assert.equal(waiting.checkoutFailures,before.checkoutFailures+1);
  assert.equal(waiting.checkoutDurationTotalMs,before.checkoutDurationTotalMs+5015);assert.equal(waiting.maxPoolSize,20);
  client.emit('connectionCheckedIn');assert.equal(runtimeSnapshot().databasePool.checkedOut,before.checkedOut);
});
