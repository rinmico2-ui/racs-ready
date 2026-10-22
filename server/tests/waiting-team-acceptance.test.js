'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Booking=require('../models/BookingService'),Assignment=require('../models/Assignment');
const router=require('../routes/appointmentManagement');
const id=n=>n.toString(16).padStart(24,'0');
function query(value){return{sort(){return this;},skip(){return this;},limit(){return this;},populate(){return this;},lean:async()=>value};}
test('waiting API includes all technician responses after the primary accepts and still selects pending support invitations',async t=>{
  let filter;
  const booking={_id:id(1),status:'inspection_scheduled',bookingDate:new Date('2099-01-05'),technicianId:{_id:id(2),name:'Primary technician'},assignmentId:{_id:id(4),status:'accepted'},technicianTeam:[
    {technicianId:id(2),assignmentId:id(4),name:'Primary technician',status:'accepted'},
    {technicianId:id(3),assignmentId:id(5),name:'Supporting technician',status:'pending',deadlineAt:new Date('2098-01-01')},
  ]};
  t.mock.method(Assignment,'find',()=>({distinct:async()=>[id(5)]}));
  t.mock.method(Booking,'find',value=>{filter=value;return query([booking]);});t.mock.method(Booking,'countDocuments',async()=>1);
  const handler=router.stack.find(layer=>layer.route?.path==='/waiting-acceptance/list').route.stack.at(-1).handle;
  let response;await handler({query:{limit:'100'}},{json:value=>{response=value;},status(){return this;}});
  assert.equal(response.bookings[0].technicianTeam.length,2);assert.equal(response.bookings[0].technicianTeam[0].role,'primary');
  assert.equal(response.bookings[0].technicianTeam[1].role,'support');assert.equal(response.bookings[0].technicianTeam[1].assignmentId,id(5));
  assert.deepEqual(filter.$or[0].technicianTeam.$elemMatch.status,{$in:['pending','expired']});assert.equal(filter.sourceOrderId,null);assert.deepEqual(filter.isProject,{$ne:true});
});

test('expired team invitations remain visible for schedule recovery without an extension button', async t => {
  const booking={_id:id(1),status:'inspection_scheduled',bookingDate:new Date('2020-01-05'),startTime:'09:30',endTime:'15:15',
    technicianId:{_id:id(2),name:'Primary'},assignmentId:{_id:id(4),status:'expired'},
    technicianTeam:[{technicianId:id(2),assignmentId:id(4),name:'Primary',status:'expired',deadlineAt:new Date('2020-01-05T01:30:00Z')}]};
  t.mock.method(Assignment,'find',()=>({distinct:async()=>[]}));
  t.mock.method(Booking,'find',()=>query([booking]));t.mock.method(Booking,'countDocuments',async()=>1);
  const handler=router.stack.find(layer=>layer.route?.path==='/waiting-acceptance/list').route.stack.at(-1).handle;
  let response;await handler({query:{}},{json:value=>{response=value;}});
  assert.equal(response.bookings[0].technicianTeam[0].status,'expired');assert.equal(response.bookings[0].isPastDate,true);
  const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/acceptance-workspace.js'),'utf8'),context);
  const container={};context.window.RACSAcceptance.render({container,stats:{},records:[{
    ...response.bookings[0],technicians:response.bookings[0].technicianTeam,canResolve:true,
  }],onAction(){}});
  assert.match(container.innerHTML,/Response expired/);assert.match(container.innerHTML,/data-acceptance-action="recover"/);
  assert.doesNotMatch(container.innerHTML,/data-acceptance-action="extend"/);
});
test('acceptance cards show all members, their own response states, and extend the selected supporting invitation',()=>{
  const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/acceptance-workspace.js'),'utf8'),context);
  const members=[{name:'Primary <technician>',assignmentId:id(4),role:'primary',status:'accepted'},{name:'Support',assignmentId:id(5),role:'support',status:'pending',deadlineAt:'2099-01-05T01:00:00Z'}];
  const container={contains:()=>true},stats={};let selected;
  context.window.RACSAcceptance.render({container,stats,records:[{technicians:members,canExtend:true,canRequeue:true}],onAction:(action,_record,member)=>{selected={action,member};}});
  assert.match(container.innerHTML,/Primary &lt;technician&gt;/);assert.match(container.innerHTML,/Supporting/);assert.match(container.innerHTML,/1 \/ 2 accepted/);
  assert.equal((container.innerHTML.match(/data-acceptance-action="extend"/g)||[]).length,1);
  container.onclick({target:{closest:()=>({dataset:{acceptanceAction:'extend',acceptanceIndex:'0',acceptanceMemberIndex:'1'}})}});
  assert.equal(selected.action,'extend');assert.equal(selected.member.assignmentId,id(5));
});

function refreshFixture() {
  const source=fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'),'utf8');
  const refresh=source.match(/window\.refreshOpenAssignmentDetail = async function \(preferredTab\) \{[\s\S]*?\n    \};/)[0];
  let finishInitial;
  const initial=new Promise(resolve=>{finishInitial=resolve;});
  const calls=[];
  const context={window:{_currentDetailId:id(4),showDetail:async()=>{calls.push('fresh detail');await initial;}},
    detailLoadController:{abort:()=>calls.push('abort old detail')},detailLoad:{id:id(4),promise:initial},currentFilter:'today',currentPage:1,
    document:{getElementById:()=>({value:''})},loadAssignments:async()=>calls.push('list'),showDetail:async()=>calls.push('fresh detail'),switchDetailTab:tab=>calls.push(tab)};
  vm.runInNewContext(refresh,context);
  return {context,calls,finishInitial};
}
test('AI refresh cancels the older detail request and loads the list and saved diagnosis together',async()=>{
  const fixture=refreshFixture();
  const refreshing=fixture.context.window.refreshOpenAssignmentDetail('ai-assistant');
  await Promise.resolve();assert.deepEqual(fixture.calls,['abort old detail','list','fresh detail']);
  fixture.finishInitial();await refreshing;
  assert.deepEqual(fixture.calls,['abort old detail','list','fresh detail','ai-assistant']);
});
test('a completed AI refresh does not reopen a job the technician already left',async()=>{
  const fixture=refreshFixture();
  const refreshing=fixture.context.window.refreshOpenAssignmentDetail('ai-assistant');
  fixture.context.window._currentDetailId=id(99);fixture.finishInitial();await refreshing;
  assert.deepEqual(fixture.calls,['abort old detail','list','fresh detail']);
});
