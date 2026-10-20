'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sift=require('sift').default;
const {technicianIssueMatch}=require('../utils/technicianIssueFilters');
const {filterResolutionCases}=require('../utils/resolutionCenter');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function matches(row,filter) {
  if(filter.$and&&!filter.$and.every(entry=>matches(row,entry)))return false;
  if(filter.$or&&!filter.$or.some(entry=>matches(row,entry)))return false;
  if(filter.$expr&&(row.cancellationHistory||[]).at(-1)?.action!==filter.$expr.$eq[1])return false;
  return sift(Object.fromEntries(Object.entries(filter).filter(([key])=>!['$and','$or','$expr'].includes(key))))(row);
}
test('emergency filter selects only currently paused bookings and excludes replaced or completed visits',()=>{
  const match=technicianIssueMatch('booking','emergency');
  const paused={status:'pending_reassignment',technicianId:null,staffingEmergencies:[{}]};
  assert.equal(matches(paused,match),true);
  for(const delta of [{status:'completed'},{technicianId:'replacement'},{staffingEmergencies:[]}])assert.equal(matches({...paused,...delta},match),false);
});
test('declined and legacy cancelled filters distinguish the latest reason from older history',()=>{
  const booking={status:'pending_reassignment',cancellationHistory:[{action:'declined'},{action:'emergency_reported'}]};
  assert.equal(matches(booking,technicianIssueMatch('booking','declined')),false);
  assert.equal(matches({...booking,technicianTeam:[{status:'declined'}]},technicianIssueMatch('booking','declined')),true);
  assert.equal(matches({...booking,cancellationHistory:[{action:'cancelled'}]},technicianIssueMatch('booking','cancelled')),true);
  assert.equal(matches({...booking,status:'cancelled',cancellationHistory:[{action:'cancelled'}]},technicianIssueMatch('booking','cancelled')),false);
});
test('orders expose technician declines separately from cancelled customer orders',()=>{
  const filter=technicianIssueMatch('order','declined');
  assert.equal(matches({status:'technician_declined'},filter),true);assert.equal(matches({status:'cancelled'},filter),false);
  assert.equal(technicianIssueMatch('order',''),null);assert.equal(matches({status:'technician_declined',technicianId:null,staffingEmergencies:[{reason:'Emergency'}]},technicianIssueMatch('order','emergency')),true);
});
function handler(file,anchor,globals) {
  const source=read(file),begin=source.indexOf(anchor),start=source.indexOf('async (req, res',begin),end=source.indexOf('\n});',start);
  assert.ok(begin>=0&&start>begin&&end>start);
  return vm.runInNewContext('('+source.slice(start,end+2)+')',{console:{error(){}},require:name=>name.includes('technicianIssueFilters')?{technicianIssueMatch}:require(name),...globals});
}
const response=()=>({status(code){this.code=code;return this;},json(body){this.body=body;}});
test('the actual booking list applies the same issue filter before count, search, sorting and pagination',async()=>{
  let counted,pipeline;
  const run=handler('routes/appointmentManagement.js',"router.get('/list',",{
    BookingService:{countDocuments:async filter=>{counted=filter;return 12;},aggregate:async value=>{pipeline=value;return[];}},
    FlowStages:{},bookingPendingFilters:()=>[],
  });
  const res=response();await run({query:{technicianIssue:'emergency',search:'Abby',page:'2',limit:'5',compact:'true',status:'pending_reassignment'}},res);
  assert.equal(res.body.pagination.total,12);assert.equal(res.body.pagination.pages,3);
  assert.equal(pipeline[0].$match,counted);assert.equal(pipeline.find(row=>row.$skip).$skip,5);
  assert.deepEqual(JSON.parse(JSON.stringify(counted.$and[0])),technicianIssueMatch('booking','emergency'));
  assert.ok(counted.$or.some(row=>row['customer.name']));
});
test('the actual order list intersects technician issues with fulfillment and preparation before pagination',async()=>{
  let counted,pipeline;
  const run=handler('routes/orderRoutes.js','router.get("/all",',{
    Order:{schema:{path:()=>({enumValues:['preparing_unit','technician_declined']})},countDocuments:async filter=>{counted=filter;return 7;},aggregate:async value=>{pipeline=value;return[];},populate:async()=>{}},
    orderFulfillmentScopeFilter:()=>({fulfillmentType:'delivery_installation'}),listSortStages:()=>[],
  });
  const res=response();await run({query:{technicianIssue:'declined',search:'Abby',preparation:'ready',page:'2',limit:'5',includeKpi:'false'}},res);
  assert.equal(res.body.total,7);assert.equal(res.body.pages,2);assert.equal(pipeline[0].$match,counted);
  assert.equal(counted.fulfillmentType,'delivery_installation');assert.equal(counted.$and.length,3);
  assert.equal(counted.$and.at(-1).status,'technician_declined');assert.ok(counted.$or.some(row=>row['customer.name']));
});
test('resolution emergency filter retains other issue details on a grouped booking',()=>{
  const item={id:'booking',sourceType:'booking',status:'pending_reassignment',staffingEmergency:{reason:'Emergency'},issueType:'past_date',issues:[{issueType:'past_date'},{issueType:'technician_issue'}]};
  const result=filterResolutionCases([item,{...item,id:'old',status:'confirmed'},{...item,id:'decline',staffingEmergency:null}],{issue:'emergency'});
  assert.deepEqual(result,[item]);assert.equal(result[0].issues.length,2);
});
