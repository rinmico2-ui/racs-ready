'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {resolutionPaymentNeedsReview,orderResolutionCase}=require('../utils/resolutionCenter');
const page=fs.readFileSync(path.join(__dirname,'../views/pages/admin/Appointments/AttentionQueue.ejs'),'utf8').replace(/\r\n/g,'\n');
const names=['findResolutionCase','renderBookingActions','renderOrderActions','resolutionProposalText','resetResolutionPaymentReview','openResolutionPaymentReview','confirmResolutionPaymentReview'];
const implementation=names.map(name=>{
  const start=page.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);return page.slice(start,page.indexOf('\n  }',start)+4);
}).join('\n');
function setup(source='booking',reply={success:true,pendingPayment:{id:'payment',amount:500,reference:'REF-123'}},hook) {
  const elements=new Map(),requests=[],details=[],notices=[];
  const element=id=>{
    if(!elements.has(id)) {
      const classes=new Set();
      elements.set(id,{textContent:'',hidden:true,disabled:true,checked:false,classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},addEventListener(){},querySelector:()=>null});
    }
    return elements.get(id);
  };
  const item={sourceType:source,id:'record',issueType:'past_date',allowedActions:['view','reschedule','verify_payment']};
  const modal={_isTransitioning:false,hide(){details.push('close');context.resetResolutionPaymentReview();}};
  const context=vm.createContext({document:{getElementById:element,querySelector:()=>element('title')},allResolutionCases:[item],
    RESOLUTION_API_BASE:'/api/admin',escapeHtml:String,contactActions:()=>'',
    bootstrap:{Modal:{getOrCreateInstance:()=>modal}},loadQueue:async()=>details.push('reload'),showToast:(...args)=>notices.push(args),
    fetch:async(url,options={})=>{requests.push({url,...options});if(hook)return hook(url,options);return {ok:true,json:async()=>options.method?{success:true}:reply};},
  });
  vm.runInContext('let resolutionDetailRequestId=0;let resolutionPaymentSelection=null;let resolutionPaymentBusy=false;\n'+implementation+`
    async function viewDetail(id){resetResolutionPaymentReview();resolutionDetailRequestId++;return {id};}
    async function viewOrderDetail(id){return viewDetail(id);}
    function interruptReview(){resolutionDetailRequestId++;resetResolutionPaymentReview();}
  `,context);
  return {context,element,requests,details,notices,item};
}

test('pending payments have a direct review button on booking and order cards',()=>{
  for(const source of ['booking','order']) {
    const {context,item}=setup(source);
    const render=value=>source==='order'?context.renderOrderActions(value):context.renderBookingActions(value,'BOOK');
    assert.match(render(item),/>Review payment</);
    assert.match(render(item),new RegExp(`openResolutionPaymentReview\\('${source}','record'\\)`));
    assert.doesNotMatch(render({...item,allowedActions:['view','reschedule']}),/>Review payment</);
    if(source==='booking')assert.match(render({...item,issueType:'no_show'}),/>Review payment</);
  }
});

test('a cancelled booking cannot render a reschedule action even with an old issue or action list',()=>{
  const {context,item}=setup();
  for(const issueType of ['cancelled','customer_reschedule','past_date']) {
    const html=context.renderBookingActions({...item,status:'cancelled',issueType,canReassign:true,allowedActions:['view','close','reschedule','reassign','verify_payment']},'BOOK');
    assert.match(html,/>View booking</);assert.match(html,/>Close case</);
    assert.doesNotMatch(html,/openReschedule|openResolveMenu|reassignCase|Review payment/);
  }
});

test('proposal messages require a real date and format it when only the stored date is available',()=>{
  const {context}=setup();
  for(const proposedReschedule of [{status:'pending'},{status:'pending',date:''},{status:'pending',date:'invalid'}])
    assert.equal(context.resolutionProposalText({status:'pending',proposedReschedule}),'');
  const proposal={status:'pending',date:'2030-01-05T00:00:00+08:00',time:'13:00'};
  assert.match(context.resolutionProposalText({status:'pending',proposedReschedule:proposal}),/Suggested schedule: Jan 5, 2030 at 13:00/);
  assert.equal(context.resolutionProposalText({status:'cancelled',proposedReschedule:proposal}),'');
});

test('payment eligibility excludes verified payments, closed work and cash due at pickup',()=>{
  assert.equal(resolutionPaymentNeedsReview({status:'pending'}),true);
  assert.equal(resolutionPaymentNeedsReview({status:'pending_project_scheduling',paymentStatus:'pending'}),true);
  for(const paymentStatus of ['paid','verified','partial','remitted','payment_collected','refunded','failed'])
    assert.equal(resolutionPaymentNeedsReview({status:'pending',paymentStatus}),false);
  for(const status of ['cancelled','completed','closed'])assert.equal(resolutionPaymentNeedsReview({status,paymentStatus:'pending'}),false);
  assert.equal(resolutionPaymentNeedsReview({status:'ready_for_pickup',paymentStatus:'pending',paymentMethod:'cash_onsite'},'order'),false);
  assert.equal(resolutionPaymentNeedsReview({status:'awaiting_assignment'}),false);
  const order={_id:'record',status:'pending_payment',paymentStatus:'pending',paymentMethod:'cash_onsite',fulfillmentType:'customer_pickup',pickupDate:'2020-01-01'};
  assert.ok(!orderResolutionCase(order).allowedActions.includes('verify_payment'));
});

test('review loads the real submitted amount as text and makes no payment changes before confirmation',async()=>{
  const {context,element,requests}=setup('order',{success:true,pendingPayment:{amount:500,reference:'<img src=x onerror=alert(1)>'}});
  await context.openResolutionPaymentReview('order','record');
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/orders/record/payment-review');assert.equal(requests[0].method,undefined);
  assert.match(element('detailPaymentSummary').textContent,/500.00/);
  assert.match(element('detailPaymentSummary').textContent,/<img/);
  assert.equal(element('detailPaymentChecked').disabled,false);assert.equal(element('detailPaymentVerify').disabled,true);
  await context.confirmResolutionPaymentReview();assert.equal(requests.length,1);
});

test('confirmation uses the booking payment-only endpoint or order payment endpoint and refreshes the queue',async()=>{
  for(const source of ['booking','order']) {
    const {context,element,requests,details}=setup(source);
    await context.openResolutionPaymentReview(source,'record');element('detailPaymentChecked').checked=true;
    await context.confirmResolutionPaymentReview();
    assert.equal(requests.length,2);
    assert.equal(requests[1].method,source==='order'?'PATCH':'POST');
    assert.equal(requests[1].url,source==='order'?'/api/orders/record/payment':'/api/admin/resolution-center/record/verify-pending-payment');
    assert.deepEqual(details,['close','reload']);
    await context.confirmResolutionPaymentReview();assert.equal(requests.length,2);
  }
});

test('missing submissions and loading errors cannot enable verification',async()=>{
  for(const reply of [{success:true,pendingPayment:null},{success:false,error:'Access denied'},{success:true,pendingPayment:{amount:0}}]) {
    const {context,element,requests}=setup('booking',reply);
    await context.openResolutionPaymentReview('booking','record');
    element('detailPaymentChecked').checked=true;await context.confirmResolutionPaymentReview();
    assert.equal(element('detailPaymentChecked').disabled,true);assert.equal(requests.length,1);
  }
});

test('failed verification retains the confirmation and prevents duplicate saves',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {context,element,requests,details}=setup('booking',null,async(_url,options)=>{
    if(!options.method)return {ok:true,json:async()=>({success:true,pendingPayment:{amount:500}})};
    await gate;return {ok:false,json:async()=>({error:'This payment changed. Please review again.'})};
  });
  await context.openResolutionPaymentReview('booking','record');element('detailPaymentChecked').checked=true;
  const saving=context.confirmResolutionPaymentReview();await context.confirmResolutionPaymentReview();
  assert.equal(requests.length,2);assert.equal(element('detailPaymentVerify').disabled,true);
  release();await saving;
  assert.equal(element('detailPaymentError').hidden,false);assert.match(element('detailPaymentError').textContent,/changed/);
  assert.equal(element('detailPaymentChecked').checked,true);assert.equal(element('detailPaymentVerify').disabled,false);assert.deepEqual(details,[]);
});

test('closing details ignores an older pending-payment response',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {context,element}=setup('order',null,async()=>{await gate;return {ok:true,json:async()=>({success:true,pendingPayment:{amount:500}})};});
  const opening=context.openResolutionPaymentReview('order','record');await new Promise(resolve=>setImmediate(resolve));
  context.interruptReview();release();await opening;
  assert.equal(element('detailPaymentChecked').disabled,true);assert.equal(element('detailPaymentReview').classList.contains('d-none'),true);
});

function query(value){return {select(){return this;},sort(){return this;},lean:async()=>value};}
test('the order payment read matches the order ledger and excludes cash pickup and reviewed payments',async t=>{
  const Order=require('../models/Order'),Payment=require('../models/Payment'),routes=require('../routes/orderRoutes');
  const id='507f191e810c19729de860ea',paymentId='507f191e810c19729de860eb';
  let order={status:'pending_payment',paymentStatus:'pending',paymentMethod:'gcash_full',paymentId},filter,reads=0;
  t.mock.method(Order,'findById',()=>query(order));
  t.mock.method(Payment,'findOne',value=>{filter=value;reads++;return query({_id:paymentId,amount:8500,reference:'REF'});});
  const handler=routes.stack.find(layer=>layer.route?.path==='/:id/payment-review').route.stack.at(-1).handle;
  const invoke=async()=>{const res={code:200,status(code){this.code=code;return this;},set(){},json(value){this.body=value;return this;}};await handler({params:{id}},res);return res;};
  const pending=await invoke();assert.equal(pending.body.pendingPayment.amount,8500);
  assert.deepEqual(filter,{_id:paymentId,orderId:id,status:'pending'});
  order={...order,paymentMethod:'cash_onsite'};assert.equal((await invoke()).body.pendingPayment,null);
  order={...order,paymentMethod:'gcash_full',paymentStatus:'partial'};assert.equal((await invoke()).body.pendingPayment,null);
  assert.equal(reads,1);
});

test('booking review reads the latest pending amount rather than a paid amount or configured fee',async()=>{
  const file=path.join(__dirname,'../routes/adminApi.js'),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),actualRequire=createRequire(file);
  const begin=source.indexOf('router.get("/resolution-center/:id/payment-summary"');
  const start=source.indexOf('async (req, res, next) => {',begin),end=source.indexOf('\n});',start);
  const payments=[{_id:'paid',status:'paid',amount:9000},{_id:'pending',status:'pending',amount:500,reference:'REF'}];
  const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',{
    mongoose:require('mongoose'),require:name=>name==='../models/BookingService'?{findById:()=>query({paymentStatus:'pending',totalPrice:20000})}:name==='../models/Payment'?{find:()=>query(payments)}:actualRequire(name),
  });
  const res={status(){return this;},json(body){this.body=body;return this;}};
  await handler({params:{id:'507f191e810c19729de860ea'}},res,error=>{throw error;});
  assert.equal(res.body.pendingPayment.amount,500);assert.equal(res.body.pendingPayment.reference,'REF');assert.equal(res.body.amountPaid,9000);
});

test('reviewing an overdue booking payment keeps its schedule and workflow stage open for resolution',async()=>{
  const file=path.join(__dirname,'../routes/adminApi.js'),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),actualRequire=createRequire(file);
  const begin=source.indexOf('router.post("/resolution-center/:id/verify-pending-payment"');
  const start=source.indexOf('async (req, res, next) => {',begin),end=source.indexOf('\n});',start);
  for(const paymentMethod of ['cod','gcash']){
    const id='507f191e810c19729de860ea';let bookingSaves=0,paymentSaves=0;
    const booking={_id:id,status:'pending',bookingDate:'2020-01-01',paymentStatus:'pending',paymentMethod,totalPrice:5000,save:async()=>{bookingSaves++;}};
    const payment={_id:'payment',status:'pending',amount:500,proofUrl:'/receipt.jpg',events:[],save:async()=>{paymentSaves++;}};
    const handler=vm.runInNewContext('('+source.slice(start,end+2)+')',{
      mongoose:require('mongoose'),audit:{logEvent:async()=>{}},
      require:name=>name==='../models/BookingService'?{findById:async()=>booking}:name==='../models/Payment'?{findOne:()=>({sort:async()=>payment}),find:()=>query([payment])}:actualRequire(name),
    });
    const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({params:{id},user:{_id:id,role:'admin'}},res,error=>{throw error;});
    assert.equal(res.body.success,true);assert.equal(booking.status,'pending');assert.equal(booking.bookingDate,'2020-01-01');
    assert.equal(booking.paymentStatus,paymentMethod==='cod'?'partial':'paid');assert.equal(booking.amountPaid,500);
    assert.equal(paymentSaves,1);assert.equal(bookingSaves,1);
  }
});
