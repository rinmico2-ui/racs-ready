'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AttentionQueue.ejs'), 'utf8').replace(/\r\n/g, '\n');
const functions = ['renderOrderActions', 'findResolutionCase', 'openOrderResolutionForCase', 'hideOrderResolutionMenu', 'contactOrderResolutionCustomer', 'handleOrderResolveAction'];
const implementation = functions.map(name => {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}).join('\n');

function setup(overrides = {}, hooks = {}) {
  const item = { id:'order-1', sourceType:'order', issueType:'dispatch_overdue', reference:'ORD-1', customer:'Jamie Santos', phone:'09170000000', email:'jamie@example.test', fulfillmentType:'delivery_installation', allowedActions:['view', 'reschedule', 'send_link', 'cancel'], ...overrides };
  const elements = new Map(), trace = [], notices = [];
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      const listeners = new Map();
      elements.set(id, { textContent:'', innerHTML:'', classList:{ contains:key=>classes.has(key), add:key=>classes.add(key), remove:key=>classes.delete(key), toggle(key,on) { on ? classes.add(key) : classes.delete(key); } },
        addEventListener(name, fn) { listeners.set(name, fn); }, emit(name) { const fn=listeners.get(name);listeners.delete(name);fn?.(); } });
    }
    return elements.get(id);
  };
  const modal = { _isTransitioning:false, show() { trace.push('show review');element('orderResolveMenuModal').classList.add('show'); }, hide() { trace.push('hide review');element('orderResolveMenuModal').classList.remove('show');element('orderResolveMenuModal').emit('hidden.bs.modal'); } };
  const context = vm.createContext({ document:{getElementById:element}, bootstrap:{Modal:{getInstance:()=>modal,getOrCreateInstance:()=>modal}}, allResolutionCases:[item],
    escapeHtml:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    contactPhoneHref:value=>/^\+?[\d\s-]{7,20}$/.test(String(value||'')) ? 'tel:'+value : '', contactEmailHref:value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||'')) ? 'mailto:'+value : '',
    showToast:(...args)=>notices.push(args),
    reschedulePickupOrder:async value=>{ trace.push(['pickup',value.id]);await hooks.schedule?.(); },
    rescheduleDeliveryOrder:async value=>{ trace.push(['delivery',value.id]);await hooks.schedule?.(); },
    verifyOrderPayment:async id=>trace.push(['payment',id]),
    sendOrderRescheduleLink:async value=>trace.push(['send link',value.id]),
    cancelResolutionOrder:async value=>trace.push(['cancel',value.id]),
    openCustomerCall:async (...args)=>{trace.push(['call',...args]);await hooks.contact?.();},
    openCustomerEmail:async (...args)=>{trace.push(['email',...args]);await hooks.contact?.();},
  });
  vm.runInContext('let orderResolutionSelection=null;let orderResolutionActionPending=false;\n'+implementation,context);
  return { item, context, element, modal, trace, notices };
}

test('Resolve opens customer contact review without opening the schedule or changing the order', () => {
  const {context,element,trace}=setup();
  context.openOrderResolutionForCase('order-1');
  assert.deepEqual(trace,['show review']);
  assert.equal(element('orderResolveType').textContent,'Delivery + installation');
  assert.equal(element('orderResolveContactDetails').textContent,'09170000000 · jamie@example.test');
  assert.match(element('orderResolveContactActions').innerHTML,/contactOrderResolutionCustomer\('call'\)/);
  assert.match(element('orderResolveContactActions').innerHTML,/contactOrderResolutionCustomer\('email'\)/);
  assert.match(context.renderOrderActions(context.allResolutionCases[0]),/>Resolve case</);
  assert.doesNotMatch(context.renderOrderActions(context.allResolutionCases[0]),/Set future schedule|verifyOrderPayment/);
  for (const id of ['orderResolveCustomerSchedule', 'orderResolveSchedule', 'orderResolveCancel']) assert.equal(element(id).classList.contains('d-none'), false);
});

test('customer choice sends a link and cancellation uses its own order action after closing review', async () => {
  for (const [action, kind] of [['send_link','send link'],['cancel','cancel']]) {
    const {context,trace}=setup();
    context.openOrderResolutionForCase('order-1');
    await context.handleOrderResolveAction(action);
    assert.deepEqual(trace,['show review','hide review',[kind,'order-1']]);
  }
});

test('pickup and installation choose their own picker after the review dialog closes', async () => {
  for (const [fulfillmentType,kind] of [['customer_pickup','pickup'],['delivery_installation','delivery'],['delivery_only','delivery']]) {
    const {context,element,trace}=setup({fulfillmentType});
    context.openOrderResolutionForCase('order-1');
    await context.handleOrderResolveAction('reschedule');
    assert.deepEqual(trace,['show review','hide review',[kind,'order-1']]);
    if(kind==='pickup') assert.match(element('orderResolveScheduleHint').textContent,/Technician scheduling is not needed/);
  }
});

test('payment-only cases show payment review and cannot open a schedule', async () => {
  const {context,element,trace,notices}=setup({allowedActions:['view','verify_payment']});
  context.openOrderResolutionForCase('order-1');
  assert.equal(element('orderResolveSchedule').classList.contains('d-none'),true);
  assert.equal(element('orderResolvePayment').classList.contains('d-none'),false);
  await context.handleOrderResolveAction('reschedule');
  assert.equal(notices.length,1);
  await context.handleOrderResolveAction('verify_payment');
  assert.deepEqual(trace,['show review','hide review',['payment','order-1']]);
});

test('a secondary issue keeps its own permitted actions throughout review', async () => {
  const {context,element,trace}=setup({allowedActions:['view','verify_payment'],issueType:'payment_review_overdue',issues:[{issueType:'payment_review_overdue',allowedActions:['view','verify_payment']},{issueType:'dispatch_overdue',allowedActions:['view','reschedule']}]});
  context.openOrderResolutionForCase('order-1','dispatch_overdue');
  assert.equal(element('orderResolveSchedule').classList.contains('d-none'),false);
  assert.equal(element('orderResolvePayment').classList.contains('d-none'),true);
  await context.handleOrderResolveAction('reschedule');
  assert.deepEqual(trace.at(-1),['delivery','order-1']);
});

test('call and email close review before contact and return to the same case without scheduling', async () => {
  for(const method of ['call','email']) {
    const {context,trace}=setup();
    context.openOrderResolutionForCase('order-1');
    await context.contactOrderResolutionCustomer(method);
    assert.deepEqual(trace,['show review','hide review',[method,method==='call'?'09170000000':'jamie@example.test','Jamie Santos','ORD-1'],'show review']);
  }
});

test('repeated clicks cannot open another picker while the selected action is pending', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {context,trace}=setup({}, {schedule:()=>gate});
  context.openOrderResolutionForCase('order-1');
  const first=context.handleOrderResolveAction('reschedule');
  await context.handleOrderResolveAction('reschedule');
  await new Promise(resolve=>setImmediate(resolve));
  context.openOrderResolutionForCase('order-1');
  assert.deepEqual(trace,['show review','hide review',['delivery','order-1']]);
  release();await first;
});

test('a failed contact action returns to review and allows staff to try again', async () => {
  const {context,element,notices}=setup({}, {contact:async()=>{throw new Error('Contact app unavailable');}});
  context.openOrderResolutionForCase('order-1');
  await context.contactOrderResolutionCustomer('call');
  assert.equal(notices[0][1],'Contact app unavailable');
  assert.equal(element('orderResolveMenuModal').classList.contains('show'),true);
  assert.equal(vm.runInContext('orderResolutionActionPending',context),false);
});

test('closed or stale cases cannot continue and missing contacts do not create broken links', async () => {
  const {context,element,modal,trace,notices}=setup({phone:'',email:'javascript:unsafe',customer:'<img src=x onerror=unsafe()>',reference:'<b>ORD-1</b>'});
  context.openOrderResolutionForCase('order-1');
  assert.equal(element('orderResolveContactActions').innerHTML,'');
  assert.match(element('orderResolveContactDetails').textContent,/No phone number or email saved/);
  assert.equal(element('orderResolveCustomer').textContent,'<img src=x onerror=unsafe()>');
  assert.equal(element('orderResolveReference').textContent,'<b>ORD-1</b>');
  modal.hide();await context.handleOrderResolveAction('reschedule');
  assert.equal(trace.length,2);
  context.openOrderResolutionForCase('order-1');
  context.allResolutionCases.length=0;
  await context.handleOrderResolveAction('reschedule');
  assert.equal(notices.length,1);
  assert.equal(trace.length,3);
});
