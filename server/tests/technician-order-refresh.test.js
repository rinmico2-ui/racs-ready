'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../views/pages/technician/technicianorders.ejs'), 'utf8');
const start = source.indexOf('  window.doStatus = async function(id, status)'), end = source.indexOf('  async function collectOrderPayment', start);
assert.ok(start >= 0 && end > start);

function fixture({ok = true, balanceAmount = 1000, paymentMethod = 'cod', fulfillmentType = 'delivery_installation', collection = true, proof = true} = {}) {
  const events = [], order = {_id:'order-1',fulfillmentType,paymentMethod,balanceAmount};
  const window = {TechnicianWorkUpdates:{beginMutation() {events.push('begin');return needed=>events.push(needed === false ? 'finish without refresh' : 'refresh');}}};
  const context = {window,_orders:[],_allOrders:[order],SCFG:{completed:{label:'Completed'}},
    captureOrderCompletion:async current=>{assert.equal(current,order);events.push('completion proof');return proof ? {completionProofUrl:'fixture-proof'} : null;},
    collectOrderPayment:async id=>{assert.equal(id,order._id);events.push('collect payment');if(collection instanceof Error) throw collection;return collection;},
    fetch:async()=>{events.push('status request');return {ok,json:async()=>ok ? {success:true} : {error:'Completion rejected'}};},
    Swal:{fire:async options=>{events.push(typeof options === 'string' ? options : options.title);return {isConfirmed:true};}}};
  vm.runInNewContext(source.slice(start,end),context);
  return {window,events};
}

test('a job that moved out of the selected tab retains its payment balance and refreshes before the success dialog', async () => {
  const f = fixture(); await f.window.doStatus('order-1','completed');
  assert.deepEqual(f.events,['collect payment','completion proof','begin','status request','refresh','Work Completed']);
});

test('a rejected order status preserves the error and finishes without a success refresh', async () => {
  const f = fixture({ok:false}); await f.window.doStatus('order-1','completed');
  assert.deepEqual(f.events,['collect payment','completion proof','begin','status request','Error','finish without refresh']);
});

test('completion checks the current payment balance even when the cached order says zero', async () => {
  const f = fixture({balanceAmount:0}); await f.window.doStatus('order-1','completed');
  assert.equal(f.events[0],'collect payment');
  assert.ok(f.events.indexOf('collect payment') < f.events.indexOf('status request'));
});

test('delivery and installation collect their balance before asking for completion proof', async () => {
  for(const fulfillmentType of ['delivery_only','delivery_installation']) {
    for(const paymentMethod of ['cod','cash','cash_onsite','gcash_downpayment']) {
      const f=fixture({fulfillmentType,paymentMethod});await f.window.doStatus('order-1','completed');
      assert.deepEqual(f.events.slice(0,3),['collect payment','completion proof','begin']);
    }
  }
});

test('cancelled or failed collection never opens completion proof or submits completion', async () => {
  const cancelled=fixture({collection:false});await cancelled.window.doStatus('order-1','completed');
  assert.deepEqual(cancelled.events,['collect payment']);
  const failed=fixture({collection:new Error('Payment not saved')});await failed.window.doStatus('order-1','completed');
  assert.deepEqual(failed.events,['collect payment','Error']);
});

test('cancelling proof after payment leaves the order unfinished', async () => {
  const f=fixture({proof:false});await f.window.doStatus('order-1','completed');
  assert.deepEqual(f.events,['collect payment','completion proof']);
});

test('fully prepaid orders go directly to completion proof', async () => {
  const f=fixture({paymentMethod:'gcash_full',balanceAmount:0});await f.window.doStatus('order-1','completed');
  assert.deepEqual(f.events,['completion proof','begin','status request','refresh','Work Completed']);
});

test('the success message and automatic map wait until the saved order has refreshed without socket events', async () => {
  let release;
  const completed = new Promise(resolve => { release=resolve; }), events=[];
  const order={_id:'order-1',status:'technician_accepted',fulfillmentType:'delivery_only'};
  const context={_allOrders:[order],_selectedId:'order-1',SCFG:{out_for_delivery:{label:'En Route'}},
    orderNeedsScheduleRecovery:()=>false,
    fetch:async()=>({ok:true,json:async()=>({success:true})}),
    Swal:{fire:async options=>{events.push(options.title);return {isConfirmed:true};}},
    window:{TechnicianWorkUpdates:{beginMutation(){return ()=>completed.then(()=>{order.status='out_for_delivery';events.push('details refreshed');return true;});}},
      viewOrderRoute(){events.push('map opened');}}};
  vm.runInNewContext(source.slice(start,end),context);
  const action=context.window.doStatus('order-1','out_for_delivery');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['Go En Route?']);
  release();await action;
  assert.deepEqual(events,['Go En Route?','details refreshed','Status Updated','map opened']);
});

function listFixture() {
  let revision=0, response={orders:[]}, ok=true;
  const panels=[], elements=new Map(), window={TechnicianWorkUpdates:{get revision(){return revision;}}};
  const context={window,orderFetchRequest:0,_page:1,_status:'technician_accepted',_search:'',_selectedId:'order-1',_orders:[],_allOrders:[],
    document:{getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:''});return elements.get(id);}},
    fetch:async()=>{const snapshot=response;return {ok,json:async()=>snapshot};},
    setOrderListMode(){},isTodayOrder:()=>true,updateKPIs(){},renderCurrentOrderView(){},esc:String,
    openDetailPanel(order){panels.push(order.status);},closeDetailPanel(){panels.push('closed');}};
  const begin=source.indexOf('  window.fetchOrders = function'),finish=source.indexOf('  function renderCards',begin);
  vm.runInNewContext(source.slice(begin,finish),context);
  return {context,window,panels,setResponse(value){response=value;},setRevision(value){revision=value;},fail(){ok=false;}};
}

test('an order moving out of the selected status tab still refreshes its open details from all assigned orders', async () => {
  const f=listFixture();f.setResponse({orders:[{_id:'order-1',status:'out_for_delivery',fulfillmentType:'delivery_only'}]});
  await f.window.fetchOrders({quiet:true});
  assert.equal(f.context._orders.length,0);assert.deepEqual(f.panels,['out_for_delivery']);
});

test('a list response started before a new status write cannot restore stale order details', async () => {
  const f=listFixture();let release;
  f.setResponse(new Promise(resolve=>{release=resolve;}));
  const older=f.window.fetchOrders({quiet:true});f.setRevision(1);
  release({orders:[{_id:'order-1',status:'technician_accepted',fulfillmentType:'delivery_only'}]});
  await older;assert.deepEqual(f.panels,[]);
  f.setResponse({orders:[{_id:'order-1',status:'arrived',fulfillmentType:'delivery_only'}]});
  await f.window.fetchOrders({quiet:true});assert.deepEqual(f.panels,['arrived']);
});

test('a failed order refresh reports failure without closing the selected detail panel', async () => {
  const f=listFixture();f.fail();f.setResponse({error:'Temporarily unavailable'});
  assert.equal(await f.window.fetchOrders({quiet:true}),false);assert.deepEqual(f.panels,[]);
});
