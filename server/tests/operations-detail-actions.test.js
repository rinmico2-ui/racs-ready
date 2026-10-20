'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve(file),'utf8').replace(/\r\n/g,'\n');
const helper=read('../public/js/operations-detail-actions');
const bookings=read('../views/pages/admin/Appointments/AppointmentsUnified.ejs');
const orders=read('../public/js/admin-aircon-orders');

function modalFixture({showing=false}={}){
  const element=new EventTarget(),classes=new Set(['show']);
  element.classList={contains:name=>classes.has(name)};
  const calls=[];
  const controller={_isTransitioning:showing,hide(){calls.push('hide');classes.delete('show');this._isTransitioning=true;}};
  const window={bootstrap:{Modal:{getInstance:()=>controller}}};
  vm.runInNewContext(helper,{window});
  return{element,controller,calls,window};
}

test('a details action waits for modal cleanup before opening the next workflow',async()=>{
  const f=modalFixture();
  const pending=f.window.RACSDetailActions.afterClose(f.element,()=>f.calls.push('next'));
  assert.deepEqual(f.calls,['hide']);
  f.element.dispatchEvent(new Event('hidden.bs.modal'));await pending;
  assert.deepEqual(f.calls,['hide','next']);
});

test('an action triggered during the opening animation waits for shown and hidden events',async()=>{
  const f=modalFixture({showing:true});
  const pending=f.window.RACSDetailActions.afterClose(f.element,()=>f.calls.push('next'));
  assert.deepEqual(f.calls,[]);
  f.controller._isTransitioning=false;f.element.dispatchEvent(new Event('shown.bs.modal'));
  assert.deepEqual(f.calls,['hide']);
  f.element.dispatchEvent(new Event('hidden.bs.modal'));await pending;
  assert.deepEqual(f.calls,['hide','next']);
});

test('an already selected workflow reloads once and switching uses the normal tab event',()=>{
  const f=modalFixture(),calls=[];let active=true;
  f.window.document={querySelector:()=>({classList:{contains:()=>active}})};
  f.window.bootstrap.Tab={getOrCreateInstance:()=>({show:()=>calls.push('show')})};
  f.window.RACSDetailActions.showTab('queue',()=>calls.push('load'));
  active=false;f.window.RACSDetailActions.showTab('queue',()=>calls.push('load'));
  assert.deepEqual(calls,['load','show']);
});

test('an opening modal without its visible class still waits for shown before closing',async()=>{
  const f=modalFixture({showing:true});f.controller._isShown=true;
  f.element.classList.contains=()=>false;
  const pending=f.window.RACSDetailActions.afterClose(f.element,()=>f.calls.push('next'));
  f.controller._isTransitioning=false;f.element.dispatchEvent(new Event('shown.bs.modal'));
  assert.deepEqual(f.calls,['hide']);
  f.element.dispatchEvent(new Event('hidden.bs.modal'));await pending;
  assert.deepEqual(f.calls,['hide','next']);
});

function bookingReview({cash=false,ok=true}={}){
  const calls=[],booking={_id:'record',paymentMethod:cash?'cash_after_service':'cod'};
  const context={_pdAll:[],_bookingDetailBooking:booking,_bookingPaymentReviews:new Set(),APPOINTMENTS_API:'/api/admin/appointments',
    confirm:message=>{calls.push({confirm:message});return true;},document:{getElementById:()=>null},
    fetch:async(_url,request)=>{calls.push({body:JSON.parse(request.body)});return{ok,json:async()=>ok?{success:true,destination:'assignment_queue'}:{error:'Proof rejected'}};},
    appointmentResponseJson:async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);return data;},
    showNotification:notice=>calls.push({notice}),closeBookingDetailFor:async(id,work)=>{calls.push({close:id});return work();},
    showBookingWorkflowTab:tab=>calls.push({tab}),AU:{Pending:{load:()=>calls.push({reload:true})}}};
  const start=bookings.indexOf('  AU.Pending.verifyPayment=async function'),end=bookings.indexOf('  AU.Pending.openReject=function',start);
  vm.runInNewContext(bookings.slice(start,end),context);
  return{calls,run:()=>context.AU.Pending.verifyPayment('record',null,booking)};
}
for(const cash of [false,true])test(`review from Overview uses the loaded ${cash?'cash':'deposit'} booking and opens Assignment Queue`,async()=>{
  const f=bookingReview({cash});await f.run();
  assert.match(f.calls.find(call=>call.confirm).confirm,cash?/No payment will be recorded/:/Verify payment/);
  assert.ok(f.calls.some(call=>call.close==='record'));
  assert.ok(f.calls.some(call=>call.tab==='queue'));
  if(cash)assert.match(f.calls.find(call=>call.body).body.notes,/no upfront payment/);
});
test('a failed booking review keeps its evidence open and never navigates to assignment',async()=>{
  const f=bookingReview({ok:false});await f.run();
  assert.equal(f.calls.some(call=>call.close||call.tab),false);
  assert.equal(f.calls.find(call=>call.notice).notice.type,'error');
});

function orderReview({pickup=false,ok=true}={}){
  const calls=[],window={};let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const context={window,paymentReviews:new Set(),Swal:{fire:async options=>{calls.push({dialog:options});return{isConfirmed:true,value:'Verified receipt'};}},
    fetch:async()=>{calls.push({write:true});await gate;return{ok,json:async()=>ok?{success:true,order:{fulfillmentType:pickup?'customer_pickup':'delivery_installation',paymentStatus:'partial',status:'preparing_unit'}}:{error:'Receipt missing'}};},
    RACSDetailActions:{afterClose:async(_element,work)=>{calls.push({close:true});return work();}},
    viewedOrderId:'record',modalEl:{},modal:{},currentFulfillmentScope:'delivery',
    setFulfillmentScope:scope=>calls.push({scope}),showOrderWorkflowTab:tab=>calls.push({tab}),isAdminWorkspace:true};
  const start=orders.indexOf('  window._aoVerifyPayment ='),end=orders.indexOf('\n  };',start)+5;
  vm.runInNewContext(orders.slice(start,end),context);
  return{calls,release,run:()=>window._aoVerifyPayment('record')};
}
for(const pickup of [false,true])test(`verified ${pickup?'pickup':'delivery'} order opens its correct next workflow`,async()=>{
  const f=orderReview({pickup});f.release();await f.run();
  assert.ok(f.calls.some(call=>call.tab===(pickup?'pickup':'assign')));
  assert.equal(f.calls.find(call=>call.dialog).dialog.title,'Verify Submitted Payment?');
  assert.match(f.calls.find(call=>call.dialog).dialog.html,/deposit stays a partial payment/);
});
test('rapid repeated order verification creates one request',async()=>{
  const f=orderReview(),first=f.run();await Promise.resolve();await f.run();
  assert.equal(f.calls.filter(call=>call.write).length,1);
  f.release();await first;
});
test('failed order verification keeps details open and permits a retry',async()=>{
  const f=orderReview({ok:false});f.release();await f.run();
  assert.equal(f.calls.some(call=>call.close||call.tab),false);
  await f.run();assert.equal(f.calls.filter(call=>call.write).length,2);
});
