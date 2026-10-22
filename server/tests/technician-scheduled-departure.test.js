'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const schedule = require('../public/js/technician-visit-schedule');
const { isBookingPast } = require('../utils/bookingPolicy');
const { assignmentWorkDecision } = require('../utils/technicianWorkSync');
const routeFile = require.resolve('../routes/technicianApi');
const actualRequire = createRequire(routeFile);
const source = fs.readFileSync(routeFile,'utf8').replace(/\r\n/g,'\n');
const view = fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'),'utf8').replace(/\r\n/g,'\n');
const id = n => String(n).padStart(24,'0');
const NOW = new Date('2026-10-16T00:00:00Z');

test('all service visits use the scheduled Philippine date, including the UTC midnight boundary', () => {
  for (const type of ['core','repair','mixed']) {
    assert.equal(schedule.state({serviceType:type,bookingDate:'2026-10-18'},NOW).code,'SCHEDULE_NOT_TODAY');
    assert.equal(schedule.state({serviceType:type,bookingDate:'2026-10-18'},new Date('2026-10-17T15:59:59Z')).ready,false);
    assert.equal(schedule.state({serviceType:type,bookingDate:'2026-10-17T16:00:00Z'},new Date('2026-10-17T16:00:00Z')).ready,true);
    assert.equal(schedule.state({serviceType:type,bookingDate:'2026-10-15'},NOW).code,'SCHEDULE_MISSED');
  }
  assert.equal(schedule.state({bookingDate:null},NOW).code,'SCHEDULE_REQUIRED');
  assert.equal(schedule.state({bookingDate:'2026-02-30'},NOW).code,'SCHEDULE_REQUIRED');
});

function fixture({date='2026-10-18',type='repair',status='accepted',ready=true,bookingStatus='inspection_scheduled'}={}) {
  const calls={writes:0,kits:0,emails:0};
  const assignment={_id:id(1),bookingId:id(2),technicianId:id(3),serviceType:type,status,bookingDate:date,startTime:'08:00',endTime:'10:00',notes:[],save:async()=>calls.writes++};
  const booking={_id:id(2),technicianId:id(3),assignmentId:id(1),status:bookingStatus,serviceType:type,bookingDate:date,startTime:'08:00',technicianAssistant:{summary:'Preparation report',verifiedByTechnician:true},save:async()=>calls.writes++};
  const tech={_id:id(3),name:'Fixture technician',save:async()=>calls.writes++};
  const query=value=>({select(){return this;},sort(){return this;},populate(){return this;},lean:async()=>value,then:(resolve,reject)=>Promise.resolve(value).then(resolve,reject)});
  const models={Assignment:{findOne:()=>query(assignment)},Technician:{findOne:()=>query(tech)},BookingService:{findById:()=>query(booking),findByIdAndUpdate:async(_id,patch)=>{calls.writes++;Object.assign(booking,patch);}}};
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:[NOW]));} }
  const context={Date:FixedDate,console,global:{},Technician:models.Technician,mongoose:require('mongoose'),BOOKING_WORK_SELECT:'status',assignmentWorkDecision,
    visitSchedule:{...schedule,state:visit=>schedule.state(visit,NOW)},isBookingPast:visit=>isBookingPast(visit,NOW),assertNotMissedSchedule:visit=>isBookingPast(visit,NOW),syncMixedVisitItems:async()=>{},
    dailyKitDepartureReadiness:async()=>{calls.kits++;return ready?{ready:true}:{ready:false,code:'DAILY_KIT_REQUIRED',error:'Complete Daily Preparation first.'};},
    require(name){
      if(name.startsWith('../models/'))return models[name.split('/').at(-1)];
      if(name==='../utils/audit')return{logEvent:async()=>{}};
      if(name==='../utils/mailer')return new Proxy({},{get:()=>async()=>{calls.emails++;}});
      return actualRequire(name);
    }};
  async function call(path,newStatus='en_route') {
    const marker=path==='generic'?'router.patch("/assignments/:id/status",':path==='repair'?'router.post("/repairs/:bookingId/en-route",':'router.post("/repairs/:bookingId/status",';
    const begin=source.indexOf(marker),start=source.indexOf('async (req, res, next) => {',begin),end=source.indexOf('\n});',start);
    const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',context);
    const response={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;}};
    let error;await handler({params:{id:assignment._id,bookingId:booking._id},body:{status:newStatus,startProofUrl:'data:image/png;base64,fixture',arrivalProofUrl:'data:image/png;base64,fixture'},user:{_id:id(4)},app:{get:()=>null}},response,value=>{error=value;});
    assert.ifError(error);return response;
  }
  return{assignment,booking,calls,call};
}

test('starting a mixed return visit opens shared work and preserves Core and approved Repair progress', async () => {
  const f = fixture({ date:'2026-10-16', type:'mixed', status:'on_site', bookingStatus:'repair_approved' });
  f.booking.inspection = { completedAt: new Date('2026-10-15T02:00:00Z') };
  f.booking.services = [
    { _id:id(5), type:'core', status:'arrived', phase:'core' },
    { _id:id(6), type:'repair', status:'repair_approved', phase:'repair_phase_1' },
  ];
  const before = structuredClone(f.booking.services);
  const response = await f.call('status', 'in_progress');
  assert.equal(response.statusCode, 200);
  assert.equal(f.assignment.status, 'in_progress');
  assert.deepEqual(f.booking.services, before);
  assert.equal(f.booking.status, 'in-progress');
  assert.equal(f.booking.repairExecution?.startedAt, undefined);
});

test('starting a repair-only return visit still starts its approved repair', async () => {
  const f = fixture({ date:'2026-10-16', type:'repair', status:'on_site', bookingStatus:'repair_approved' });
  f.booking.inspection = { completedAt: new Date('2026-10-15T02:00:00Z') };
  const response = await f.call('status', 'in_progress');
  assert.equal(response.statusCode, 200);
  assert.equal(f.assignment.status, 'in_progress');
  assert.equal(f.booking.status, 'repair_in_progress');
});

test('actual core, repair and mixed departure handlers reject future dates before kit or stock operations',async()=>{
  for(const type of ['core','repair','mixed'])for(const endpoint of type==='core'?['generic']:['generic','repair']) {
    const f=fixture({type});const response=await f.call(endpoint);
    assert.equal(response.statusCode,409);assert.equal(response.body.code,'SCHEDULE_NOT_TODAY');
    assert.equal(f.calls.writes,0);assert.equal(f.calls.kits,0);assert.equal(f.calls.emails,0);assert.equal(f.assignment.status,'accepted');
  }
});

test('same-day repair and mixed departures require Daily Preparation and permit travel only when confirmed',async()=>{
  for(const type of ['repair','mixed'])for(const endpoint of ['generic','repair']) {
    const blocked=fixture({type,date:'2026-10-16',ready:false});const response=await blocked.call(endpoint);
    assert.equal(response.statusCode,409);assert.equal(response.body.code,'DAILY_KIT_REQUIRED');assert.equal(blocked.calls.writes,0);assert.equal(blocked.calls.kits,1);
    const allowed=fixture({type,date:'2026-10-16'});assert.equal((await allowed.call(endpoint)).statusCode,200);assert.equal(allowed.assignment.status,'en_route');assert.equal(allowed.calls.kits,1);assert.ok(allowed.calls.writes>0);
  }
});

test('repair follow-up dates are checked against the current assignment rather than an old inspection date',async()=>{
  const f=fixture({date:'2026-10-18',bookingStatus:'repair_scheduled'});
  f.booking.bookingDate='2026-10-10';f.booking.repairSchedule={date:'2026-10-18',startTime:'08:00'};
  const response=await f.call('repair');assert.equal(response.body.code,'SCHEDULE_NOT_TODAY');assert.equal(f.calls.writes,0);
  f.booking.repairSchedule.date='2026-10-19';assert.equal((await f.call('repair')).body.code,'ASSIGNMENT_CHANGED');
});

test('past visits and missing schedules cannot start new travel',async()=>{
  for(const endpoint of ['generic','repair'])for(const date of ['2026-10-15',null]) {
    const f=fixture({date});const response=await f.call(endpoint);assert.equal(response.statusCode,409);assert.equal(f.calls.writes,0);assert.equal(f.calls.kits,0);
  }
});

test('future visits already marked En Route cannot progress to arrival or Start Work through either endpoint',async()=>{
  for(const endpoint of ['generic','repairStatus'])for(const [status,next] of [['en_route','on_site'],['on_site','in_progress']]) {
    const f=fixture({status});const response=await f.call(endpoint,next);assert.equal(response.statusCode,409);assert.equal(response.body.code,'SCHEDULE_NOT_TODAY');assert.equal(f.calls.writes,0);
  }
});

test('waiting for customer approval or parts cannot become a repair travel authorization',async()=>{
  for(const bookingStatus of ['awaiting_approval','repair_approved','waiting_parts']) {
    const f=fixture({date:'2026-10-16',bookingStatus});const response=await f.call('repair');assert.equal(response.statusCode,400);assert.equal(f.calls.writes,0);assert.equal(f.calls.kits,0);
  }
});

test('repair and mixed action UI keeps future kit previews accessible and locks travel until preparation',()=>{
  const start=view.indexOf('    function renderDailyPreparationCard'),end=view.indexOf('    function getWizardPageActions(',start);
  const context={window:{RACSVisitSchedule:{...schedule,state:a=>schedule.state(a,NOW)}},canEnRoute:a=>schedule.state(a,NOW).ready};
  vm.runInNewContext(view.slice(start,end)+';window.test={renderDailyPreparationCard,repairDepartureActions};',context);
  for(const type of ['repair','mixed']) {
    const job={_id:id(1),bookingId:id(2),status:'accepted',serviceType:type,bookingDate:'2026-10-18'};
    const future=context.window.test.repairDepartureActions(job);assert.match(future,/openDailyKitModal\('2026-10-18'\)/);assert.match(future,/disabled/);assert.doesNotMatch(future,/onclick="repairEnRoute/);
    assert.match(context.window.test.renderDailyPreparationCard(job),/Future kits are previews/);
    job.bookingDate='2026-10-16';assert.doesNotMatch(context.window.test.repairDepartureActions(job),/onclick="repairEnRoute/);
    job.equipmentCheckedOut=true;assert.match(context.window.test.repairDepartureActions(job),/onclick="repairEnRoute/);
  }
});
