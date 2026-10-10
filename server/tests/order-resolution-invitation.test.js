'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const routes = require('../routes/orderRoutes');
const { activeOrderRescheduleInvitation, assertCustomerOrderReschedule } = require('../utils/orderRescheduleInvitation');
const id = '507f191e810c19729de860ea', userId = '507f191e810c19729de860eb';
const user = { _id:userId, role:'customer', name:'Jamie' };
function fixture(extra = {}) {
  return new Order({ _id:id, userId, orderReference:'ORD-INVITED', status:'preparing_unit', fulfillmentType:'customer_pickup',
    items:[{ inventoryId:id, brand:'Midea', modelLine:'Split', quantity:1 }], pickupDate:new Date('2020-01-01'),
    delivery:{ address:'Customer location', preferredDate:new Date('2020-01-01') },
    rescheduleInvitation:{ status:'allowed', sentBy:userId, sentAt:new Date(), expiresAt:new Date(Date.now()+86400000) }, ...extra });
}
function mocks(t, order) {
  t.mock.method(Order,'findById',async()=>order);
  t.mock.method(require('../models/OperationLock'),'findOneAndUpdate',(_,update)=>({ lean:async()=>({ owner:update.$set.owner }) }));
  t.mock.method(require('../models/OperationLock'),'deleteOne',async()=>({}));
  t.mock.method(require('../utils/audit'),'logEvent',async()=>{});
  t.mock.method(require('../utils/notify'),'createNotification',async()=>({ _id:'notification' }));
}
async function invoke(route, method, { body={}, query={}, actor=user }={}) {
  const res = { code:200, status(code) { this.code=code;return this; }, set() {}, json(body) { this.body=body;return this; } };
  const handler = routes.stack.find(layer=>layer.route?.path===route&&layer.route.methods[method]).route.stack.at(-1).handle;
  await handler({ params:{id}, body, query, user:actor, protocol:'http', get:()=> 'localhost:5000', app:{get:()=>null} }, res);
  return res;
}

test('only the owning customer can use an active invitation on work that has not started', () => {
  const order=fixture();
  assert.equal(activeOrderRescheduleInvitation(order),true);
  assert.equal(assertCustomerOrderReschedule(order,user),order);
  assert.throws(()=>assertCustomerOrderReschedule(order,{...user,_id:id}),error=>error.status===403);
  assert.throws(()=>assertCustomerOrderReschedule(order,{...user,role:'technician'}),error=>error.status===403);
  for(const extra of [{status:'installing'},{status:'completed'},{status:'cancelled'},{rescheduleInvitation:{status:'submitted',expiresAt:new Date('2099-01-01')}},{rescheduleInvitation:{status:'allowed',expiresAt:new Date('2020-01-01')}}]) {
    assert.throws(()=>assertCustomerOrderReschedule(fixture(extra),user),error=>error.status===410);
  }
});

test('sending an invitation retains the order schedule and sends the owner a working, account-protected link', async t => {
  const order=fixture({rescheduleInvitation:undefined});mocks(t,order);
  let update,notification,email;
  t.mock.method(Order,'findOneAndUpdate',async(filter,patch)=>{assert.equal(filter.status,'preparing_unit');update=patch;order.rescheduleInvitation=patch.$set.rescheduleInvitation;return order;});
  t.mock.method(require('../models/User'),'findById',()=>({select:()=>({lean:async()=>({email:'jamie@example.test'})})}));
  t.mock.method(require('../utils/notify'),'createNotification',async value=>{notification=value;return {};});
  t.mock.method(require('../utils/mailer'),'sendMail',async value=>{email=value;});
  const res=await invoke('/:id/reschedule-invitation','post',{actor:{...user,role:'admin'}});
  assert.equal(res.code,200);assert.equal(res.body.emailSent,true);
  assert.equal(order.status,'preparing_unit');assert.equal(order.pickupDate.toISOString(),'2020-01-01T00:00:00.000Z');
  assert.equal(update.$set.rescheduleInvitation.status,'allowed');
  assert.ok(new Date(update.$set.rescheduleInvitation.expiresAt)>new Date(Date.now()+6*86400000));
  assert.equal(notification.link,`/my-orders/${id}/reschedule`);assert.equal(String(notification.userId),userId);
  assert.match(email.text,new RegExp(`/my-orders/${id}/reschedule`));assert.equal(email.to,'jamie@example.test');
});

test('a cancelled order cannot get an invitation and failed notification delivery is reported honestly', async t => {
  let order=fixture({status:'cancelled'});mocks(t,order);
  const closed=await invoke('/:id/reschedule-invitation','post',{actor:{...user,role:'admin'}});
  assert.equal(closed.code,409);
  order=fixture();t.mock.method(Order,'findById',async()=>order);
  t.mock.method(Order,'findOneAndUpdate',async()=>order);
  t.mock.method(require('../utils/notify'),'createNotification',async()=>null);
  t.mock.method(require('../models/User'),'findById',()=>({select:()=>({lean:async()=>({})})}));
  const failed=await invoke('/:id/reschedule-invitation','post',{actor:{...user,role:'admin'}});
  assert.equal(failed.code,503);assert.match(failed.body.error,/could not be notified/);
});

test('customer availability and save endpoints reject another owner and expired invitations before capacity reads', async t => {
  const order=fixture();mocks(t,order);let reads=0;
  t.mock.method(require('../utils/orderResolutionScheduling'),'loadOrderScheduling',async()=>{reads++;throw new Error('Should not read capacity');});
  const other=await invoke('/:id/customer-resolution-availability','get',{actor:{...user,_id:id}});
  assert.equal(other.code,403);
  order.rescheduleInvitation.expiresAt=new Date('2020-01-01');
  for(const [path,method] of [['/:id/customer-resolution-availability','get'],['/:id/customer-project-window-availability','post'],['/:id/customer-resolution-reschedule','post']]) {
    const res=await invoke(path,method,{body:{scheduledDate:'2035-01-02'}});assert.equal(res.code,410);
  }
  assert.equal(reads,0);
});

test('an invited pickup uses store hours, saves once and consumes the link with a conditional save', async t => {
  const order=fixture();mocks(t,order);let saves=0;const notifications=[];
  t.mock.method(require('../utils/notify'),'createNotification',async value=>{notifications.push(value);return {};});
  t.mock.method(require('../models/SiteSetting'),'find',()=>({lean:async()=>[]}));
  t.mock.method(order,'save',async()=>{saves++;});
  const metadata=await invoke('/:id/customer-resolution-availability','get');
  assert.equal(metadata.body.fulfillmentType,'customer_pickup');assert.ok(metadata.body.storeHours.length);
  const saved=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02'}});
  assert.equal(saved.code,200,JSON.stringify(saved.body));assert.equal(saves,1);
  assert.equal(order.rescheduleInvitation.status,'submitted');assert.equal(order.timeSlot,null);
  assert.equal(order.$where['rescheduleInvitation.status'],'allowed');assert.equal(String(order.$where.userId),userId);
  assert.equal(order.$where.status,'preparing_unit');
  assert.ok(notifications.some(value=>value.role==='customer'&&String(value.userId)===userId));
  assert.ok(notifications.some(value=>value.role==='admin'&&value.link==='/admin/appointments/orders'));
  const repeated=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-03'}});
  assert.equal(repeated.code,410);assert.equal(saves,1);
});

test('the final save rejects an order changed after the invitation check', async t => {
  const order=fixture();mocks(t,order);
  t.mock.method(require('../models/SiteSetting'),'find',()=>({lean:async()=>[]}));
  t.mock.method(order,'save',async()=>{throw new mongoose.Error.DocumentNotFoundError(order.$where);});
  const res=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02'}});
  assert.equal(res.code,409);assert.equal(res.body.code,'ORDER_CHANGED');
  assert.equal(order.$where['rescheduleInvitation.status'],'allowed');
  assert.ok(order.$where['rescheduleInvitation.expiresAt'].$gt instanceof Date);
});

test('calendar display and final capacity checks use the same stored installation hours', async t => {
  const bookingId='507f191e810c19729de860ec';
  const order=fixture({fulfillmentType:'delivery_installation',bookingId,items:[{inventoryId:id,quantity:2}]});mocks(t,order);
  t.mock.method(require('../models/BookingService'),'findById',async()=>({_id:bookingId,serviceDurationMinutes:240}));
  t.mock.method(require('../utils/enterpriseSchedulingEngine'),'getProjectThresholdHours',async()=>8);
  const queries=[];
  t.mock.method(require('../routes/scheduleRoutes'),'getTimeSlotsForQuery',async(query,exclusions)=>{
    queries.push({query,exclusions});return {statusCode:200,payload:{timeSlots:[{startTime:'09:00',available:false}]}};
  });
  const calendar=await invoke('/:id/customer-resolution-availability','get',{query:{date:'2035-01-02',duration:'1',quantity:'1'}});
  assert.equal(calendar.body.scheduling.totalEstimatedMinutes,240);
  const save=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02',timeSlot:'09:00',quantity:1,duration:1}});
  assert.equal(save.code,409);assert.equal(order.rescheduleInvitation.status,'allowed');
  assert.equal(queries.length,2);
  for(const {query,exclusions} of queries) {
    assert.equal(query.duration,'240');assert.equal(query.quantity,'1');
    assert.equal(String(exclusions.excludeOrderId),id);assert.equal(String(exclusions.excludeBookingId),bookingId);
  }
});

test('an invited delivery cannot consume its link when the requested slot is no longer available', async t => {
  const order=fixture({fulfillmentType:'delivery_only'});mocks(t,order);let saves=0;
  t.mock.method(order,'save',async()=>{saves++;});
  t.mock.method(require('./../routes/scheduleRoutes'),'getTimeSlotsForQuery',async()=>({statusCode:200,payload:{timeSlots:[{startTime:'09:00',available:false}]}}));
  const res=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02',timeSlot:'09:00'}});
  assert.equal(res.code,409);assert.equal(res.body.refreshSlots,true);assert.equal(saves,0);
  assert.equal(order.rescheduleInvitation.status,'allowed');
});

test('invited installation availability derives project units from stored work, and missing end dates do not consume the link', async t => {
  const order=fixture({fulfillmentType:'delivery_installation',items:[{inventoryId:id,quantity:8}]});mocks(t,order);
  t.mock.method(require('../utils/enterpriseSchedulingEngine'),'getProjectThresholdHours',async()=>8);
  const metadata=await invoke('/:id/customer-resolution-availability','get',{query:{isProject:false,quantity:1}});
  assert.equal(metadata.code,200);assert.equal(metadata.body.scheduling.isProject,true);assert.equal(metadata.body.scheduling.totalUnits,8);
  const missing=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02',quantity:1,isProject:false}});
  assert.equal(missing.code,400);assert.match(missing.body.error,/finish-by/);assert.equal(order.rescheduleInvitation.status,'allowed');
});

test('an invited project saves both dates and consumes its link in the planning transaction', async t => {
  const order=fixture({fulfillmentType:'delivery_installation',status:'technician_accepted',items:[{inventoryId:id,quantity:8}]});mocks(t,order);
  const engine=require('../utils/enterpriseSchedulingEngine'), Project=require('../models/Project');
  t.mock.method(engine,'getProjectThresholdHours',async()=>8);
  t.mock.method(engine,'getProjectWindowAvailability',async()=>({sufficient:true}));
  t.mock.method(Project,'findOne',()=>({lean:async()=>null}));
  const session={withTransaction:async commit=>commit(),endSession:async()=>{}};
  t.mock.method(mongoose,'startSession',async()=>session);
  let booking,project,saves=0;
  t.mock.method(require('../models/BookingService').prototype,'save',async function(options){booking=this;await this.validate();assert.equal(options.session,session);});
  t.mock.method(require('../models/Assignment'),'updateMany',async()=>({}));
  t.mock.method(Project,'create',async docs=>{project=docs[0];return [];});
  t.mock.method(order,'save',async options=>{saves++;await order.validate();assert.equal(options.session,session);});
  const saved=await invoke('/:id/customer-resolution-reschedule','post',{body:{scheduledDate:'2035-01-02',endDate:'2035-01-06',quantity:1,duration:1}});
  assert.equal(saved.code,200,JSON.stringify(saved.body));assert.equal(saves,1);
  assert.equal(order.rescheduleInvitation.status,'submitted');assert.equal(order.$where.status,'technician_accepted');
  assert.equal(order.status,'preparing_unit');assert.equal(order.timeSlot,null);
  assert.equal(order.rescheduleRequest.requestedEndDate,'2035-01-06');
  assert.equal(String(order.bookingId),String(booking._id));
  assert.equal(booking.serviceDurationMinutes,480);assert.equal(project.totalUnits,8);
  assert.equal(project.preferredCompletionDeadline.toISOString(),'2035-01-05T16:00:00.000Z');
});

test('the order list provides one schedule action while a staff invitation is active', () => {
  const ejs=require('ejs'), fs=require('node:fs');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../views/pages/my-orders.ejs'),'utf8');
  const render=extra=>ejs.render(source,{orders:[fixture(extra).toObject()]});
  const active=render();
  assert.match(active,new RegExp(`href="/my-orders/${id}/reschedule"`));
  assert.doesNotMatch(active,/<button[^>]+class="[^"]*ord-reschedule-btn/);
  for(const extra of [{rescheduleInvitation:undefined},{rescheduleInvitation:{status:'allowed',expiresAt:new Date('2020-01-01')}}]) {
    const ordinary=render(extra);assert.doesNotMatch(ordinary,/Our team invited/);
    assert.match(ordinary,/<button[^>]+class="[^"]*ord-reschedule-btn/);
  }
  assert.doesNotMatch(render({status:'cancelled'}),/Our team invited/);
});
