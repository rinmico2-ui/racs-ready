'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectOrders } = require('../public/js/customer-orders');
const Order = require('../models/Order');
const SiteSetting = require('../models/SiteSetting');
const schedule = require('../routes/scheduleRoutes');
const routes = require('../routes/orderRoutes');

const orderId = '507f191e810c19729de860ea', userId = '507f191e810c19729de860eb';
function fixture(extra = {}) {
  const order = { _id:orderId, userId, status:'preparing_unit', fulfillmentType:'delivery_installation',
    items:[{ quantity:2 },{ quantity:1 }], routeDurationMin:45, bookingId:'507f191e810c19729de860ec',
    delivery:{ preferredDate:new Date('2030-01-01T00:00:00Z') }, timeSlot:'09:00', ...extra };
  order.toObject = () => ({ ...order });
  return order;
}
function response() {
  return { statusCode:200, headers:{}, status(code) { this.statusCode = code; return this; },
    set(key,value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } };
}
async function invoke(path, method, req = {}) {
  const route = routes.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  const res = response();
  await route.stack.at(-1).handle({ params:{ id:orderId }, query:{}, user:{ _id:userId, role:'customer' },
    body:{ requestedDate:'2030-01-02', requestedTime:'09:00', reason:'Please change my schedule' }, ...req },res);
  return res;
}

test('search and status filters paginate the whole matching order list in selected date order', () => {
  const cards = Array.from({ length:20 }, (_,i) => ({ dataset:{ orderGroup:i % 2 ? 'active' : 'completed', orderSearch:'ord-' + i + ' carrier', orderCreated:String(i) } }));
  const first = selectOrders(cards,'active','carrier','newest',1);
  assert.equal(first.matching.length,10); assert.equal(first.pages,2); assert.equal(first.visible.length,8);
  assert.equal(first.visible[0],cards[19]);
  const second = selectOrders(cards,'active','carrier','newest',2);
  assert.deepEqual(second.visible,[cards[3],cards[1]]);
  const changed = selectOrders(cards,'completed','ord-0','oldest',8);
  assert.equal(changed.page,1); assert.deepEqual(changed.visible,[cards[0]]);
  assert.equal(selectOrders(cards,'all','<img>','newest',1).matching.length,0);
});

test('availability uses owned-order capacity and ignores client exclusion and quantity overrides', async t => {
  const order = fixture(); let input, exclusions;
  t.mock.method(Order,'findById',async () => order);
  t.mock.method(schedule,'getAvailableDatesForQuery',async (query,exclude) => { input = query; exclusions = exclude; return { statusCode:200,payload:{ availableDates:[] } }; });
  const res = await invoke('/:id/reschedule-availability','get',{ query:{ quantity:'99', excludeOrderId:'someone-else' } });
  assert.equal(res.statusCode,200); assert.equal(res.headers['Cache-Control'],'no-store, private');
  assert.deepEqual(input,{ duration:'60', mode:'manual', quantity:'3', travelTime:'45' });
  assert.deepEqual(exclusions,{ excludeOrderId:orderId, excludeBookingId:order.bookingId });
});

test('availability rejects other owners, completed orders, and malformed dates before scheduling', async t => {
  let order = fixture(), calls = 0;
  t.mock.method(Order,'findById',async () => order);
  t.mock.method(schedule,'getTimeSlotsForQuery',async () => { calls++; });
  assert.equal((await invoke('/:id/reschedule-availability','get',{ user:{ _id:'other' } })).statusCode,403);
  order = fixture({ status:'completed' });
  assert.equal((await invoke('/:id/reschedule-availability','get')).statusCode,409);
  order = fixture();
  assert.equal((await invoke('/:id/reschedule-availability','get',{ query:{ date:'2030-02-30' } })).statusCode,400);
  assert.equal(calls,0);
});

test('reschedule persists only the request atomically and keeps the confirmed schedule unchanged', async t => {
  const order = fixture(); let filter, update, options, exclusions;
  t.mock.method(Order,'findById',async () => order);
  t.mock.method(schedule,'getTimeSlotsForQuery',async (query,exclude) => { exclusions = exclude; return { statusCode:200, payload:{ timeSlots:[{ startTime:'09:00', available:true }] } }; });
  t.mock.method(Order,'findOneAndUpdate',async (f,u,o) => { filter = f; update = u; options = o; return order; });
  const res = await invoke('/:id/reschedule-request','post');
  assert.equal(res.statusCode,200); assert.equal(res.body.order.rescheduleRequest.status,'pending');
  assert.equal(order.delivery.preferredDate.toISOString(),'2030-01-01T00:00:00.000Z'); assert.equal(order.timeSlot,'09:00');
  assert.equal(filter.userId,userId); assert.ok(filter.status.$in.includes('preparing_unit')); assert.equal(filter.$or.length,2);
  assert.deepEqual(Object.keys(update.$set),['rescheduleRequest']); assert.equal(update.$set.rescheduleRequest.requestedDate,'2030-01-02');
  assert.equal(options.runValidators,true); assert.equal(options.returnDocument,'after');
  assert.equal(exclusions.excludeOrderId,orderId);
});

test('a lost slot, an existing pending request, and a concurrent status change cannot overwrite the order', async t => {
  let order = fixture(), writes = 0, available = false;
  t.mock.method(Order,'findById',async () => order);
  t.mock.method(schedule,'getTimeSlotsForQuery',async () => ({ statusCode:200,payload:{ timeSlots:[{ startTime:'09:00', available }] } }));
  t.mock.method(Order,'findOneAndUpdate',async () => { writes++; return null; });
  const lost = await invoke('/:id/reschedule-request','post');
  assert.equal(lost.statusCode,409); assert.equal(lost.body.refreshSlots,true); assert.equal(writes,0);
  order = fixture({ rescheduleRequest:{ requested:true, status:'pending' } });
  const pending = await invoke('/:id/reschedule-request','post');
  assert.equal(pending.statusCode,409); assert.equal(pending.body.code,'ORDER_RESCHEDULE_PENDING'); assert.equal(writes,0);
  order = fixture(); available = true;
  assert.equal((await invoke('/:id/reschedule-request','post')).statusCode,409); assert.equal(writes,1);
});

test('reschedule input errors and unauthorized requests make no writes', async t => {
  t.mock.method(Order,'findById',async () => fixture());
  t.mock.method(Order,'findOneAndUpdate',async () => { throw new Error('must not write'); });
  assert.equal((await invoke('/:id/reschedule-request','post',{ params:{ id:'invalid' } })).statusCode,400);
  assert.equal((await invoke('/:id/reschedule-request','post',{ user:{ _id:'other' } })).statusCode,403);
  assert.equal((await invoke('/:id/reschedule-request','post',{ body:{ requestedDate:'2030-01-02', requestedTime:'09:00', reason:{} } })).statusCode,400);
  assert.equal((await invoke('/:id/reschedule-request','post',{ body:{ requestedDate:'2030-02-30', requestedTime:'09:00', reason:'Changed plans' } })).statusCode,400);
});

test('pickup requests follow store hours and store a date-only request without a delivery time', async t => {
  let open = true, writes = 0;
  t.mock.method(Order,'findById',async () => fixture({ fulfillmentType:'customer_pickup', pickupDate:new Date('2030-01-01') }));
  t.mock.method(SiteSetting,'find',() => ({ lean:async () => [{ key:'storeOpenHours', value:Array.from({ length:7 },(_,dayOfWeek) => ({ dayOfWeek,open,startMinutes:480,endMinutes:1080 })) }] }));
  t.mock.method(Order,'findOneAndUpdate',async (_filter,update) => { writes++; assert.equal(update.$set.rescheduleRequest.requestedTime,''); return fixture({ fulfillmentType:'customer_pickup',rescheduleRequest:update.$set.rescheduleRequest }); });
  assert.equal((await invoke('/:id/reschedule-request','post',{ body:{ requestedDate:'2030-01-02',requestedTime:'store_hours',reason:'New pickup day' } })).statusCode,200);
  open = false;
  const closed = await invoke('/:id/reschedule-request','post',{ body:{ requestedDate:'2030-01-02',reason:'New pickup day' } });
  assert.equal(closed.statusCode,409); assert.equal(closed.body.code,'ORDER_PICKUP_STORE_CLOSED'); assert.equal(writes,1);
});
