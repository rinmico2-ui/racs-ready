const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mongoose = require('mongoose');
const Assignment = require('../models/Assignment');
const { bookingOverviewScheduleResolution } = require('../utils/resolutionCenter');
const view = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AppointmentsUnified.ejs'), 'utf8').replace(/\r\n/g, '\n');
const id = '507f191e810c19729de860ea';

function renderer() {
  const helpers = view.slice(view.indexOf('  function bookingStatusLabel('), view.indexOf('  function bookingResolutionUrl('));
  const renderStart = view.indexOf('  AU.Overview.renderTable=function');
  const render = view.slice(renderStart, view.indexOf('  AU.Overview.renderPagination', renderStart));
  const tbody = { innerHTML:'' };
  const context = vm.createContext({ document:{getElementById:()=>tbody}, AU:{Overview:{}},
    STATUS_LABELS:{cancelled:'Cancelled', awaiting_assignment:'Awaiting Assignment', assigned:'Assigned', pending:'Pending'},
    STATUS_CLASSES:{cancelled:'st-cancelled', awaiting_assignment:'st-awaiting_assignment'}, RQ_STATUS_LABELS:{},
    statusLabel:value=>value, APPOINTMENTS_CAN_RESOLVE:true, _ovViewBtn:()=>'<button>View</button>',
    bookingResolutionUrl:()=>'/resolution-center' });
  vm.runInContext(helpers + render, context);
  return row => { context.AU.Overview.renderTable([row]); return tbody.innerHTML; };
}

test('reviewed overdue bookings show the payment decision and the separate schedule issue', () => {
  const render = renderer();
  for (const paymentStatus of ['partial', 'paid', 'verified']) {
    const html = render({_id:id, status:'pending', paymentStatus, bookingDate:'2020-01-01',
      overviewScheduleResolution:{required:true, issueType:'past_date'} });
    assert.match(html, /st-payment_verified">Payment verified<\/span>/);
    assert.match(html, /New schedule needed/);
    assert.match(html, />Resolve<\/a>/);
    assert.doesNotMatch(html, />Pending<\/span>|>Needs Resolution<\/span>/);
  }
});

test('schedule warnings do not replace actual booking status, and cancellation always wins over stale flags', () => {
  const render = renderer();
  let html = render({_id:id, status:'awaiting_assignment', bookingDate:'2020-01-01',
    overviewScheduleResolution:{required:true, issueType:'no_technician'} });
  assert.match(html, />Awaiting Assignment<\/span>/);
  assert.match(html, /Technician needed/);
  html = render({_id:id, status:'cancelled', paymentStatus:'paid', bookingDate:'2020-01-01',
    autoReschedulePending:true, isReviewOverdue:true, overviewScheduleResolution:{required:true, issueType:'past_date'} });
  assert.match(html, /st-cancelled">Cancelled<\/span>/);
  assert.doesNotMatch(html, />Resolve<|New schedule needed|Payment verified/);
});

test('a reviewed missed booking stays actionable and never shows an old snapshot as the current technician',()=>{
  const row={_id:id,status:'reschedule-required',bookingDate:'2020-01-01',technicianId:null,technician:{name:'Old technician'},
    resolutionCases:[{issueType:'past_date',sourceStatus:'reschedule-required',state:'closed'}]};
  row.overviewScheduleResolution=bookingOverviewScheduleResolution(row);
  const html=renderer()(row);
  assert.match(html,/>New schedule needed<\/span>/);assert.match(html,/Review saved/);assert.match(html,/>Resolve<\/a>/);
  assert.match(html,/>Unassigned<\/span>/);assert.doesNotMatch(html,/Old technician|Case closed/);
  const future={...row,status:'confirmed',technicianId:'tech',bookingDate:'2030-01-01',resolutionCases:[],overviewScheduleResolution:{required:false}};
  assert.match(renderer()(future),/Old technician/);
});

test('current technician presentation excludes cancelled assignments and keeps real current assignments',()=>{
  const start=view.indexOf('  function bookingCurrentTechnician(');
  const implementation=view.slice(start,view.indexOf('  function bookingNeedsResolution(',start));
  const context=vm.createContext({});vm.runInContext(implementation,context);
  const row={status:'assigned',technicianId:'tech',technician:{name:'Current technician'}};
  assert.equal(context.bookingCurrentTechnician(row,{status:'cancelled'}),null);
  assert.equal(context.bookingCurrentTechnician({...row,technicianId:null},{status:'accepted'}),null);
  assert.equal(context.bookingCurrentTechnician(row,{status:'accepted'}).name,'Current technician');
});

test('cancelled booking details override unfinished service and stale assignment statuses', () => {
  const start = view.indexOf('    function effectiveItemStatus(');
  const code = view.slice(start, view.indexOf('    function buildServiceItemHTML', start));
  const context = vm.createContext({ b:{status:'cancelled'}, data:{assignment:{status:'accepted'}}, isRepair:false });
  vm.runInContext(code, context);
  for (const status of ['pending','assigned','accepted','in-progress']) assert.equal(context.effectiveItemStatus({status}), 'cancelled');
  for (const status of ['completed','repair_completed','repair_declined']) assert.equal(context.effectiveItemStatus({status}), status);
});

function cancellationFixture({ fail, paymentStatus='partial', status='assigned', missing=false, lostAssignmentReference=false } = {}) {
  const file = path.join(__dirname, '../routes/adminApi.js');
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('router.post("/resolution-center/:id/cancel-with-refund"');
  const start = source.indexOf('async (req, res, next) => {', begin);
  const end = source.indexOf('\n});', start);
  const actualRequire = createRequire(file);
  const stored = {booking:{_id:id,status,bookingDate:'2020-01-01',startTime:'08:00',endTime:'10:00',
    customerId:id,assignmentId:id,technicianId:id,technician:{name:'Previous technician'},paymentStatus,
    services:[{status:'pending',statusHistory:[]},{status:'completed',statusHistory:[]}],
    statusHistory:[],resolutionCases:[],cancellationHistory:[]}, assignment:{status:'accepted',notes:[]},
    payment:{_id:id,status:paymentStatus,amount:2793,refundAmount:0,refundStatus:'none',events:[]} };
  const events = [];
  if (lostAssignmentReference) stored.booking.assignmentId = null;
  let draft, session;
  const models = {
    '../models/BookingService':{findById:()=>({session:async value=>{
      assert.equal(value,session);
      if (missing) return null;
      const booking = structuredClone(draft.booking);
      booking.recordStatusHistory = () => assert.fail('Status audit must wait until commit');
      booking.save = async options => { assert.equal(options.session,session); if(fail==='booking') throw Error('Booking save failed');
        const {save,recordStatusHistory,...fields}=booking; draft.booking=structuredClone(fields); };
      return booking;
    }})},
    '../models/Payment':{findOne:()=>({sort(){return this;},session:async value=>{
      assert.equal(value,session);
      if(paymentStatus==='pending') return null;
      const payment = structuredClone(draft.payment);
      payment.save = async options=>{assert.equal(options.session,session);if(fail==='payment')throw Error('Payment save failed');
        const {save,...fields}=payment;draft.payment=structuredClone(fields);};
      return payment;
    }})},
    '../utils/audit':{logEvent:async()=>events.push('audit')},
    '../utils/notify':{createNotification:async()=>events.push('notify')},
  };
  session={withTransaction:async callback=>{
    draft=structuredClone(stored);
    try{await callback();Object.assign(stored,draft);events.push('commit');}
    catch(error){events.push('rollback');throw error;}
  },endSession:async()=>events.push('end')};
  const handler=vm.runInNewContext('('+source.slice(start,end+2)+')', {
    mongoose:{Types:mongoose.Types,startSession:async()=>session},
    require:name=>models[name]||actualRequire(name), console:{error(){}},
    Assignment:{updateMany:async (filter,update,options)=>{
      assert.equal(options.session,session);assert.equal(filter.bookingId,id);
      assert.ok(filter.status.$in.includes('accepted'));assert.ok(filter.status.$in.includes('waiting_for_customer'));
      assert.ok(!filter.status.$in.includes('completed'));
      if(fail==='assignmentBatch')throw Error('Assignment batch failed');
      if(filter.status.$in.includes(draft.assignment.status))Object.assign(draft.assignment,update.$set);
    },findByIdAndUpdate:async (assignmentId,update,options)=>{
      assert.equal(options.session,session);assert.equal(assignmentId,id);
      // Use the real schema to catch the previous string-to-notes-array CastError.
      Assignment.schema.path('notes').cast([update.$push.notes]);
      if(fail==='assignment')throw Error('Assignment write failed');
      Object.assign(draft.assignment,update.$set);draft.assignment.notes.push(update.$push.notes);
    }},
  });
  return {stored,events,async invoke(body={},role='admin'){
    const res={code:200,status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
    await handler({params:{id},body:{reason:'Customer no longer needs this service',refundDecision:'none',...body},
      user:{_id:id,name:'Operations staff',role},app:{get:()=>null}},res,error=>{res.error=error;});
    return res;
  }};
}

test('admin and secretary cancellation updates the booking, unfinished services and assignment together', async () => {
  for(const role of ['admin','secretary']) {
    const fixture=cancellationFixture();
    const result=await fixture.invoke({},role);
    assert.equal(result.error,undefined);assert.equal(result.body.success,true);
    const {booking,assignment}=fixture.stored;
    assert.equal(booking.status,'cancelled');assert.equal(booking.services[0].status,'cancelled');
    assert.equal(booking.services[1].status,'completed');assert.equal(booking.assignmentId,null);
    assert.equal(booking.technician,undefined);assert.ok(booking.cancelledAt);assert.equal(booking.cancelledBy,id);
    assert.equal(booking.statusHistory.length,1);assert.equal(booking.resolutionCases[0].state,'closed');
    assert.equal(assignment.status,'cancelled');assert.equal(assignment.notes.length,1);
    assert.equal(bookingOverviewScheduleResolution(booking).required,false);
    assert.match(renderer()({...booking,overviewScheduleResolution:bookingOverviewScheduleResolution(booking)}),/>Cancelled<\/span>/);
    assert.deepEqual(fixture.events,['commit','end','notify','audit']);
  }
});

test('full refund cancellation queues refund review without claiming money has already been returned',async()=>{
  const fixture=cancellationFixture();const result=await fixture.invoke({refundDecision:'full'});
  assert.equal(result.error,undefined);assert.equal(result.body.refund.status,'pending');assert.equal(result.body.refund.amount,2793);
  assert.equal(fixture.stored.payment.status,'partial');assert.equal(fixture.stored.payment.refundedAt,undefined);
  assert.equal(fixture.stored.payment.events[0].status,'refund_pending');assert.equal(fixture.stored.booking.paymentStatus,'partial');
});

test('cancellation retires an accepted assignment even when the booking lost its assignment reference',async()=>{
  const fixture=cancellationFixture({lostAssignmentReference:true});
  const result=await fixture.invoke();
  assert.equal(result.error,undefined);assert.equal(result.body.success,true);
  assert.equal(fixture.stored.booking.status,'cancelled');assert.equal(fixture.stored.assignment.status,'cancelled');
});

test('failed booking, assignment or refund writes roll back every status and send no success notification',async()=>{
  for(const fail of ['booking','assignment','assignmentBatch','payment']){
    const fixture=cancellationFixture({fail});const before=structuredClone(fixture.stored);
    const result=await fixture.invoke({refundDecision:'full'});
    assert.match(result.error.message,/failed/);assert.equal(result.body,undefined);
    assert.deepEqual(fixture.stored,before);assert.deepEqual(fixture.events,['rollback','end']);
  }
});

test('pending or missing payments cannot be refunded and missing bookings return an error without success',async()=>{
  const pending=cancellationFixture({paymentStatus:'pending'});const before=structuredClone(pending.stored);
  const result=await pending.invoke({refundDecision:'full'});
  assert.equal(result.error.status,400);assert.deepEqual(pending.stored,before);
  const missing=cancellationFixture({missing:true});const absent=await missing.invoke();
  assert.equal(absent.error.status,404);assert.equal(absent.body,undefined);
  assert.deepEqual(missing.events,['rollback','end']);
});
