'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Booking = require('../models/BookingService');
const router = require('../routes/appointmentManagement');
const { activeBookingMatch, activeBookingSummary, activeBookingSummaryPipeline } = require('../utils/activeBookingPolicy');
const view = fs.readFileSync(require.resolve('../views/pages/admin/Appointments/AppointmentsUnified.ejs'), 'utf8').replace(/\r\n/g, '\n');
const id = n => String(n).padStart(24, '0');
const handler = path => router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;

test('active scope retains unfinished older and Manila-midnight jobs and includes every assigned repair phase', () => {
  const match = activeBookingMatch();
  assert.equal(match.bookingDate, undefined);
  for (const status of ['confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'inspection_scheduled', 'inspection_in_progress', 'inspection_completed', 'awaiting_approval', 'repair_approved', 'waiting_parts', 'parts_reserved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress']) assert.ok(match.status.$in.includes(status), status);
  for (const status of ['pending', 'assigned', 'awaiting_assignment', 'pending_reassignment', 'completed', 'cancelled', 'repair_declined', 'repair_completed', 'closed', 'under_warranty']) assert.ok(!match.status.$in.includes(status), status);
  assert.equal(match.archivedAt, null); assert.equal(match.sourceOrderId, null); assert.deepEqual(match.isProject, { $ne: true });
});

test('active status selections stay inside active work and group scheduled work and repair execution correctly', () => {
  assert.deepEqual(activeBookingMatch('confirmed').status.$in, ['confirmed', 'scheduled']);
  assert.deepEqual(activeBookingMatch('in-progress').status.$in, ['in-progress', 'inspection_in_progress', 'repair_in_progress']);
  assert.ok(activeBookingMatch('repair').status.$in.includes('awaiting_approval'));
  assert.deepEqual(activeBookingMatch('completed,pending').status.$in, []);
});

test('active summary counts all jobs, includes repair execution and uses distinct team-member totals', () => {
  const summary = activeBookingSummary({ statuses: [{ _id:'scheduled', count:105 }, { _id:'confirmed', count:2 }, { _id:'inspection_scheduled', count:3 }, { _id:'repair_in_progress', count:4 }], technicians:[{count:5}] });
  assert.equal(summary.all, 114); assert.equal(summary.confirmed, 107); assert.equal(summary.repair, 7); assert.equal(summary['in-progress'], 4); assert.equal(summary.technicians, 5);
  const pipeline = activeBookingSummaryPipeline(activeBookingMatch());
  assert.deepEqual(pipeline[0].$match, activeBookingMatch());
  assert.deepEqual(pipeline[1].$facet.technicians[0].$match, {technicianId:{$ne:null}});
  assert.ok(pipeline[1].$facet.technicians.some(stage => stage.$group?._id === '$technicianIds'));
});

test('active list filters before pagination and summarizes the same scope independently of the selected pill', async t => {
  let counted; const pipelines = [];
  t.mock.method(Booking, 'countDocuments', async query => { counted=query; return 45; });
  t.mock.method(Booking, 'aggregate', async pipeline => { pipelines.push(pipeline); return pipeline.some(stage => stage.$facet) ? [{statuses:[{_id:'confirmed',count:300},{_id:'repair_in_progress',count:45}],technicians:[{count:7}]}] : [{_id:id(1),status:'repair_in_progress',bookingDate:new Date('2026-10-14T16:00:00Z'),startTime:'08:00',technicianId:id(2)}]; });
  let result;
  await handler('/list')({query:{stage:'active',status:'in-progress',activeSummary:'true',compact:'true',page:'2',limit:'20',search:'Fixture'}}, {json:value=>{result=value;},status(){return this;}});
  assert.deepEqual(counted.status.$in, ['in-progress','inspection_in_progress','repair_in_progress']);
  assert.equal(counted.bookingDate, undefined); assert.equal(result.bookings.length,1); assert.equal(result.pagination.total,45); assert.equal(result.pagination.page,2);
  assert.equal(result.activeSummary.all,345); assert.equal(result.activeSummary.technicians,7);
  const list=pipelines.find(pipeline=>pipeline.some(stage=>stage.$skip));
  assert.equal(list.find(stage=>stage.$skip).$skip,20);
  assert.equal(list.at(-1).$project['technicianTeam.name'],1);
  const summary=pipelines.find(pipeline=>pipeline.some(stage=>stage.$facet));
  assert.ok(summary[0].$match.status.$in.includes('confirmed'));
  assert.deepEqual(summary[0].$match.$or,counted.$or);
});

test('overview Active badge uses the identical service-booking scope', async t => {
  let pipeline, result;
  t.mock.method(Booking, 'aggregate', async value => {pipeline=value;return [{filteredStatuses:[{_id:'confirmed',count:900}],activeJobs:[{count:6}]}];});
  await handler('/flow-stats')({query:{}},{json:value=>{result=value;},status(){return this;}});
  assert.equal(result.stages.ACTIVE_JOBS.count,6);
  assert.deepEqual(pipeline[1].$facet.activeJobs[0].$match,activeBookingMatch());
  assert.equal(pipeline[0].$project.archivedAt,1);
});

function browserFixture() {
  const elements={}; const pending=[];
  const element = name => elements[name] ||= {value:'',textContent:'',innerHTML:'',hidden:true,querySelector:()=>null};
  const context={AU:{},URLSearchParams,AbortController,Set,Number,String,Date,Object,Math,
    document:{getElementById:element,querySelectorAll:()=>[]},APPOINTMENTS_API:'/api/admin/appointments',
    APPOINTMENTS_CAN_RESOLVE:true,STATUS_CLASSES:{},STATUS_LABELS:{},RQ_STATUS_LABELS:{repair_in_progress:'Repair In Progress'},
    qEsc:value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    bookingCurrentTechnician:b=>b.technician,bookingNeedsResolution:()=>false,bookingScheduleIssueLabel:()=>'',
    operationsFetchJson:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject}))};
  const start=view.indexOf('  AU.Active={};'), end=view.indexOf('  AU.Active.viewDetail=',start);
  vm.runInNewContext(view.slice(start,end),context);
  return {context,elements,element,pending};
}
const response = (patch={}) => ({bookings:[],pagination:{page:1,limit:20,total:0,pages:0},activeSummary:{all:0},...patch});

test('Active uses one bounded request and rejects stale search and filter responses', async () => {
  const f=browserFixture();const first=f.context.AU.Active.load();
  f.element('activeSearchInput').value='Latest';const second=f.context.AU.Active.load(1);
  assert.equal(f.pending.length,2);assert.equal(f.pending[0].options.signal.aborted,true);
  assert.match(f.pending[1].url,/compact=true/);assert.match(f.pending[1].url,/limit=20&page=1/);assert.match(f.pending[1].url,/search=Latest/);
  f.pending[1].resolve(response({pagination:{page:1,limit:20,total:345,pages:18},activeSummary:{all:345,technicians:8,repair:40}}));await second;
  f.pending[0].resolve(response({activeSummary:{all:1}}));await first;
  assert.equal(f.element('pillAll').textContent,345);assert.equal(f.element('activeStatTechs').textContent,8);assert.equal(f.element('activeJobCount').textContent,345);
  assert.match(f.element('activePagination').innerHTML,/AU.Active.load\(2\)/);
});

test('failed Active requests show retry feedback and preserve already loaded rows and counts', async () => {
  const f=browserFixture();f.element('jobsContainer').innerHTML='Previously loaded jobs';f.element('pillAll').textContent=12;
  const loading=f.context.AU.Active.load();f.pending[0].reject(new Error('The server is temporarily unavailable.'));await loading;
  assert.equal(f.element('activeLoadError').hidden,false);assert.match(f.element('activeLoadErrorText').textContent,/temporarily unavailable/);
  assert.equal(f.element('jobsContainer').innerHTML,'Previously loaded jobs');assert.equal(f.element('pillAll').textContent,12);
});

test('Active rows list the whole team, show repair labels and escape customer and technician text', () => {
  const f=browserFixture();
  f.context.AU.Active.renderJobs([{_id:id(1),bookingReference:'RACS-FIXTURE',bookingDate:'2026-10-14T16:00:00Z',status:'repair_in_progress',customer:{name:'<script>bad</script>'},technicianId:id(2),technicianTeam:[{technicianId:id(2),name:'Primary <Name>',status:'accepted'},{technicianId:id(3),name:'Support <Name>',status:'accepted'}]}]);
  const html=f.element('jobsContainer').innerHTML;
  assert.match(html,/Primary &lt;Name&gt;/);assert.match(html,/Support &lt;Name&gt;/);assert.match(html,/Supporting/);assert.match(html,/Repair In Progress/);assert.doesNotMatch(html,/<script>/);
});
