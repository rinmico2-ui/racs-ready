'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), mongoose = require('mongoose');
const Booking = require('../models/BookingService'), Project = require('../models/Project'), Technician = require('../models/Technician'), Tool = require('../models/Tool'), SiteSetting = require('../models/SiteSetting'), WorkOrder = require('../models/WorkOrder'), DailyAssignment = require('../models/DailyAssignment');
const flow = require('../utils/repairUnitWorkflow'), notify = require('../utils/notify'), audit = require('../utils/audit');
const Assignment = require('../models/Assignment');
const originalNotification = notify.createNotification;
const notifications = [];
notify.createNotification = async body => { notifications.push(body); };
const router = require('../routes/repairUnitRoutes');
notify.createNotification = originalNotification;
function query(value) { return { session(){return this;},select(){return this;},limit(){return this;},lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject);} }; }
function fixture(t, standard = false) {
  const customerId = new mongoose.Types.ObjectId(), techUser = new mongoose.Types.ObjectId(), techId = new mongoose.Types.ObjectId();
  const booking = new Booking({ customerId, bookingDate:new Date(), serviceType:'repair', isProject:!standard, repairUnitTracking:true, technicianId:techId, status:'inspection_in_progress', totalPrice:1000, __v:0,
    services:[{name:'Aircon repair',type:'repair',quantity:2,brand:'Carrier',model:'Nexus',problemDescription:'Different cooling problems',units:flow.customerUnits({quantity:2,problemDescription:'Different cooling problems'})}] });
  const project = new Project({bookingId:booking._id,customerId,leadTechnicianId:techId,assignedTechnicians:[{_id:techId}],status:'in_progress',projectPhase:'assessment',assessmentVisit:{status:'arrived'},estimatedTotalHours:3,totalUnits:2,quantity:2,repairUnitTracking:true,__v:0,unitGroups:flow.buildUnitGroups(booking)});
  const principal = standard ? booking : project;
  const writes=[];
  t.mock.method(Booking,'findById',()=>query(booking)); t.mock.method(Project,'findById',()=>query(project)); t.mock.method(Project,'findOne',()=>query(project));
  t.mock.method(Technician,'findOne',()=>query({_id:techId,user:techUser})); t.mock.method(Technician,'find',()=>query([{user:techUser}]));
  t.mock.method(Assignment,'findOne',()=>query({ status: 'in_progress', technicianId: techId, bookingId: booking._id }));
  t.mock.method(Tool,'find',()=>query([]));t.mock.method(SiteSetting,'find',()=>query([]));
  t.mock.method(WorkOrder,'find',()=>query([]));t.mock.method(WorkOrder,'exists',()=>query(null));t.mock.method(DailyAssignment,'find',()=>query([]));
  t.mock.method(mongoose,'startSession',async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}}));
  t.mock.method(standard?Booking:Project,'updateOne',async(filter,change,options)=>{writes.push({filter,change,options});return{modifiedCount:1};});
  t.mock.method(audit,'logEvent',async()=>{});
  const route = method => router.stack.find(layer=>layer.route?.path==='/:scope/:id'+(method==='post'?'/:action':'') && layer.route.methods[method]).route.stack.at(-1).handle;
  async function call(action,role='technician',body={},userId) {
    const req={params:{scope:standard?'booking':'project',id:String(principal._id),action},user:{role,_id:userId || (role==='customer'?customerId:techUser)},body:{version:principal.__v||0,...body},app:{get:()=>null}};
    let result,error; const res={json(value){result=value;},status(){return this;}};
    await route(action?'post':'get')(req,res,value=>{error=value;});
    return{result,error};
  }
  async function inspections() {
    for(const key of ['G1-U001','G1-U002']) { const result=await call('inspect','technician',{key,findings:'Cooling test confirms a damaged capacitor.',diagnosis:'Faulty capacitor',parts:[],laborCategory:'minor'});assert.ifError(result.error); }
    assert.ifError((await call('submit')).error);
  }
  return{booking,project,principal,customerId,techUser,techId,writes,call,inspections};
}
test('customers can only read their own repair appliances', async t=>{
  const f=fixture(t);assert.equal((await f.call(null,'customer')).result.units.length,2);
  assert.equal((await f.call(null,'customer',{},new mongoose.Types.ObjectId())).error.status,403);
});
test('unassigned technicians cannot read another team repair records',async t=>{
  const f=fixture(t);t.mock.method(Technician,'findOne',()=>query({_id:new mongoose.Types.ObjectId()}));
  assert.equal((await f.call(null)).error.status,403);
});
test('staff cannot inspect and technicians cannot approve staff review',async t=>{
  const f=fixture(t);
  assert.equal((await f.call('inspect','admin',{key:'G1-U001',parts:[]})).error.status,403);
  assert.equal((await f.call('review','technician',{action:'approve'})).error.status,403);
  assert.equal(f.writes.length,0);
});
test('customer approval cannot be recorded by staff',async t=>{
  const f=fixture(t);await f.inspections();assert.ifError((await f.call('review','secretary',{action:'approve'})).error);
  assert.equal((await f.call('decide','admin',{decisions:[{key:'G1-U001',approved:true,revision:1}]})).error.status,403);
});
test('inspection requires arrival and every unit must be quoted before submission',async t=>{
  const f=fixture(t);f.project.assessmentVisit.status='pending';
  assert.equal((await f.call('inspect','technician',{key:'G1-U001',parts:[]})).error.status,409);
  f.project.assessmentVisit.status='arrived';assert.equal((await f.call('submit')).error.status,409);
});
test('stale page versions and a lost compare-and-set reject duplicate writes',async t=>{
  const f=fixture(t);assert.equal((await f.call('inspect','technician',{version:100,parts:[]})).error.status,409);
  t.mock.method(Project,'updateOne',async()=>({modifiedCount:0}));
  assert.equal((await f.call('inspect','technician',{key:'G1-U001',findings:'Inspection confirms the cooling problem.',diagnosis:'Broken capacitor',parts:[],laborCategory:'minor'})).error.status,409);
});
test('secretary review waits for customer approval and settled scope excludes declined repairs',async t=>{
  const f=fixture(t);await f.inspections();
  assert.ifError((await f.call('review','secretary',{action:'approve'})).error);
  assert.equal(f.project.projectPhase,'quotation_review');assert.equal(f.project.quotationReview.status,'awaiting_customer');
  assert.ifError((await f.call('decide','customer',{decisions:[{key:'G1-U001',approved:true,revision:1},{key:'G1-U002',approved:false,revision:1}]})).error);
  assert.equal(f.project.projectPhase,'execution');assert.equal(f.project.totalUnits,1);assert.equal(f.project.requestedUnitCount,2);
  assert.equal(f.project.quotationReview.totalAmount,300);assert.equal(f.project.repair.quotation.totalCost,300);
  assert.ok(f.writes.every(write=>write.options.session && write.change.$inc.__v===1));
  assert.ok(notifications.some(notification=>String(notification.userId)===String(f.customerId)));
});
test('standard repair keeps separate appliance decisions and produces only the approved repair invoice',async t=>{
  const f=fixture(t,true);await f.inspections();assert.ifError((await f.call('review','admin',{action:'approve'})).error);
  assert.ifError((await f.call('decide','customer',{decisions:[{key:'G1-U001',approved:true,revision:1},{key:'G1-U002',approved:false,revision:1}]})).error);
  assert.equal(f.booking.status,'repair_approved');assert.equal(f.booking.quotation.totalCost,300);assert.equal(f.booking.services[0].quotation.totalCost,300);
  assert.equal(f.booking.services[0].units[1].repairReview.state,'declined');
  f.booking.status='repair_in_progress';f.booking.repairExecution={status:'in_progress'};assert.ifError((await f.call('complete','technician',{key:'G1-U001',notes:'Capacitor replaced; cooling and electrical tests passed.'})).error);
  assert.equal(f.booking.services[0].units[0].repairReview.state,'completed');
  assert.equal((await f.call(null)).result.readyForCompletion, true);
});
test('accepted repair remains read-only before Start Work, including after arrival',async t=>{
  const f=fixture(t,true); f.booking.status='arrived';
  t.mock.method(Assignment,'findOne',()=>query({status:'on_site'}));
  assert.equal((await f.call(null)).result.canInspect,false);
  const result=await f.call('inspect','technician',{key:'G1-U001',parts:[]});
  assert.equal(result.error.status,409);assert.match(result.error.message,/Start Work/);assert.equal(f.writes.length,0);
});
test('starting the assignment unlocks inspection even while the booking still says inspection scheduled',async t=>{
  const f=fixture(t,true);f.booking.status='inspection_scheduled';
  assert.equal((await f.call(null)).result.canInspect,true);
  const result=await f.call('inspect','technician',{key:'G1-U001',findings:'Electrical tests confirm the damaged capacitor.',diagnosis:'Faulty capacitor',parts:[],laborCategory:'standard'});
  assert.ifError(result.error);assert.equal(result.result.units[0].quotation.totalCost,500);
});
test('supporting repair team members can view records but cannot create quotations',async t=>{
  const f=fixture(t,true),supportId=new mongoose.Types.ObjectId();
  f.booking.technicianTeam=[{technicianId:f.techId,name:'Primary',status:'accepted'},{technicianId:supportId,name:'Support',status:'accepted'}];
  t.mock.method(Technician,'findOne',()=>query({_id:supportId,user:f.techUser}));
  const view=await f.call(null);assert.ifError(view.error);assert.equal(view.result.canInspect,false);assert.match(view.result.blockedReason,/primary technician/);
  assert.equal((await f.call('inspect','technician',{key:'G1-U001',parts:[]})).error.status,409);
});
test('unanswered team invitations block inspection mutations even if an old assignment says in progress',async t=>{
  const f=fixture(t,true);f.booking.technicianTeam=[{technicianId:f.techId,name:'Primary',status:'accepted'},{technicianId:new mongoose.Types.ObjectId(),name:'Support',status:'pending'}];
  assert.equal((await f.call(null)).result.canInspect,false);
  assert.equal((await f.call('inspect','technician',{key:'G1-U001',parts:[]})).error.status,409);assert.equal(f.writes.length,0);
});
test('declined appliance is removed from work-order quantity and its daily allocation without phantom targets',async t=>{
  const f=fixture(t);await f.inspections();assert.ifError((await f.call('review','admin',{action:'approve'})).error);
  const order=new WorkOrder({projectId:f.project._id,unitCount:2,estimatedHours:3,units:[{unitKey:'G1-U001',serviceType:'repair'},{unitKey:'G1-U002',serviceType:'repair'}]});
  order.save=async()=>order;
  const allocation={unitKeys:['G1-U002'],targetUnits:1,status:'pending',save:async()=>{}};
  t.mock.method(WorkOrder,'find',()=>query([order]));t.mock.method(DailyAssignment,'find',()=>query([allocation]));
  assert.ifError((await f.call('decide','customer',{decisions:[{key:'G1-U001',approved:true,revision:1},{key:'G1-U002',approved:false,revision:1}]})).error);
  assert.equal(order.units[1].status,'cancelled');assert.equal(order.unitCount,1);assert.equal(order.estimatedHours,1.5);
  assert.equal(allocation.targetUnits,0);assert.equal(allocation.status,'skipped');
});
test('cancelled repair requests reject changes',async t=>{
  const f=fixture(t);f.booking.status='cancelled';assert.equal((await f.call('inspect','technician',{key:'G1-U001',parts:[]})).error.status,409);assert.equal(f.writes.length,0);
});

test('on-site AI assistance uses only the selected appliance findings without saving or approving a quotation', async t => {
  const f = fixture(t, true); let target;
  f.booking.services[0].units[1].problemDescription = 'The upstairs appliance is not cooling.';
  t.mock.method(require('../utils/aiTechnicianAssistant'), 'generateAssistantReport', async input => { target = input; return { technicianAssistant: { summary: 'Check the capacitor against the measured reading.', probableCauses: [{ cause: 'Capacitor fault' }], possibleParts: [{ name: 'Capacitor' }] } }; });
  const handler = router.stack.find(layer => layer.route?.path === '/:scope/:id/ai-diagnostic').route.stack.at(-1).handle;
  const req = { params: { scope: 'booking', id: String(f.booking._id) }, user: { role: 'technician', _id: f.techUser }, body: { key: 'G1-U002', findings: 'Measured capacitor is below the rated capacitance.' } };
  let response, error; await handler(req, { json: value => { response = value; } }, value => { error = value; });
  assert.ifError(error); assert.match(target.problemDescription, /upstairs appliance/); assert.match(target.problemDescription, /Measured capacitor/);
  assert.equal(response.technicianAssistant.possibleParts[0].name, 'Capacitor'); assert.equal(f.writes.length, 0);
  assert.notEqual(f.booking.approval?.status, 'approved');
});

test('AI diagnostic suggestions require Start Work and submitted quotations remain locked until returned by staff', async t => {
  const f = fixture(t, true); let calls = 0;
  t.mock.method(require('../utils/aiTechnicianAssistant'), 'generateAssistantReport', async () => { calls++; return {}; });
  t.mock.method(Assignment, 'findOne', () => query({ status: 'on_site', technicianId: f.techId, bookingId: f.booking._id })); f.booking.status = 'arrived';
  const handler = router.stack.find(layer => layer.route?.path === '/:scope/:id/ai-diagnostic').route.stack.at(-1).handle;
  let error; await handler({ params: { scope: 'booking', id: String(f.booking._id) }, user: { role: 'technician', _id: f.techUser }, body: { key: 'G1-U001', findings: 'Measured capacitor is below the rated capacitance.' } }, { json() {} }, value => { error = value; });
  assert.equal(error.status, 409); assert.equal(calls, 0);
  t.mock.method(Assignment, 'findOne', () => query({ status: 'in_progress', technicianId: f.techId, bookingId: f.booking._id })); f.booking.status = 'inspection_in_progress';
  await f.inspections(); assert.equal((await f.call('inspect', 'technician', { key: 'G1-U001', findings: 'Changed findings after sending the quotation.', diagnosis: 'Changed diagnosis', parts: [] })).error.status, 409);
});
test('older technician actions cannot skip customer decisions or individual repair completion',async t=>{
  const f=fixture(t,true),guard=require('../utils/repairUnitLegacyGuard');
  async function check(action) { let result,passed=false;await guard({method:'POST',path:`/appointments/${f.booking._id}/${action}`,body:{}},{status(code){result={code};return this;},json(body){result.body=body;}},()=>{passed=true;});return{result,passed}; }
  assert.equal((await check('onsite-approve')).result.code,409);
  assert.equal((await check('technician-schedule-later')).result.code,409);
  await f.inspections();assert.ifError((await f.call('review','admin',{action:'approve'})).error);
  assert.ifError((await f.call('decide','customer',{decisions:[{key:'G1-U001',approved:true,revision:1},{key:'G1-U002',approved:false,revision:1}]})).error);
  assert.equal((await check('start-repair')).result.body.code,'REPAIR_WORK_PLAN_REQUIRED');
  assert.equal((await check('complete-repair')).result.code,409);
  f.booking.status='repair_in_progress';f.booking.repairExecution={status:'in_progress'};assert.ifError((await f.call('complete','technician',{key:'G1-U001',notes:'Replaced capacitor and passed the cooling test.'})).error);
  assert.equal((await check('complete-repair')).passed,true);
});

test('Submit inspection and quotation saves the final draft and notifies both customer and staff', async t => {
  const f = fixture(t, true);
  const body = { findings: 'The capacitor is below the rated capacitance.', diagnosis: 'Replace the faulty capacitor', parts: [], laborCategory: 'minor', laborPricingMode: 'custom', laborCost: 650, laborPriceReason: 'Includes wiring repair and electrical tests.' };
  assert.ifError((await f.call('inspect', 'technician', { ...body, key: 'G1-U001' })).error);
  const result = await f.call('inspect-and-submit', 'technician', { ...body, key: 'G1-U002' });
  assert.ifError(result.error); assert.equal(result.result.submitted, true); assert.equal(result.result.canPlanRepair, true);
  assert.equal(f.booking.quotationReview.totalAmount, 1300); assert.equal(f.booking.services[0].units[1].quotation.laborPricingMode, 'custom');
  assert.ok(notifications.some(row => row.role === 'admin' && /quotation/i.test(row.title)));
  assert.ok(notifications.some(row => String(row.userId) === String(f.customerId) && /quotation/i.test(row.title)));
});
test('AI diagnostic can use the recorded customer problem first, or the technician own diagnosis', async t => {
  const f = fixture(t, true); let captured;
  t.mock.method(require('../utils/aiTechnicianAssistant'), 'generateAssistantReport', async input => { captured = input; return { technicianAssistant: { summary: 'Check the compressor circuit.', repairComplexity: 'high', possibleParts: ['Capacitor'] } }; });
  const handler = router.stack.find(layer => layer.route?.path === '/:scope/:id/ai-diagnostic').route.stack.at(-1).handle;
  for (const diagnosis of ['', 'The compressor starting circuit has failed.']) {
    let result, error;
    await handler({ params: { scope: 'booking', id: String(f.booking._id) }, user: { role: 'technician', _id: f.techUser }, body: { key: 'G1-U001', findings: '', diagnosis } }, { json: value => { result = value; } }, value => { error = value; });
    assert.ifError(error); assert.equal(result.quoteSuggestion.laborCost, 800); assert.equal(result.quoteSuggestion.parts[0].requiresPrice, true);
    if (diagnosis) assert.ok(captured.problemDescription.includes(diagnosis));
  }
  assert.equal(f.writes.length, 0); assert.notEqual(f.booking.approval.status, 'approved');
});
