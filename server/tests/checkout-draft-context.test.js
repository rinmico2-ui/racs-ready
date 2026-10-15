'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { availability } = require('../public/js/product-availability');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const cart = read('views/partials/cart-wizard.ejs'), direct = read('views/partials/aircons.ejs');
function functions(source, names, indent) {
  return names.map(name => {
    const declaration = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n${' '.repeat(indent)}\\}`))?.[0];
    assert.ok(declaration, name + ' exists'); return declaration;
  }).join('\n');
}
function storage(draft) {
  let value = JSON.stringify(draft);
  return { getItem:() => value, setItem:(_key, next) => { value = next; }, removeItem:key => { if (key === 'draft') value = null; }, value:() => value };
}
const item = (id, quantity = 1) => ({ _id:'line-' + id, inventoryId:{ _id:id, sellingPrice:20000 }, quantity });

test('cart drafts are compared to the current checkbox selection rather than the last opened modal', () => {
  const items = [item('a')], localStorage = storage({ savedAt:Date.now(), cartSignature:'line-a:a:1' });
  const ctx = { CART_ITEMS:items, window:{ getSelectedCartForCheckout:() => ({ items:[item('b')] }) }, localStorage,
    _cartCheckoutSessionActive:true, CART_CHECKOUT_CUSTOMER_ID:'customer', CART_CHECKOUT_DRAFT_KEY:'draft', CART_CHECKOUT_DRAFT_MAX_AGE_MS:1800000 };
  vm.runInNewContext(functions(cart, ['cartCheckoutSignature', 'readCartCheckoutDraft'], 4), ctx);
  assert.equal(ctx.readCartCheckoutDraft(), null); assert.equal(localStorage.value(), null);
});

test('a pending save cannot put the previous aircon back into storage after the cart changes', () => {
  const localStorage = storage({ savedAt:Date.now() });
  const ctx = { CART_ITEMS:[item('a')], window:{ getSelectedCartForCheckout:() => ({ items:[item('a', 10)] }) }, localStorage,
    _cartCheckoutSessionActive:true, _checkoutSubmitting:false, _restoringCartDraft:false, selectedFulfillment:'delivery_installation',
    _cartDraftSaveTimer:null, CART_CHECKOUT_DRAFT_KEY:'draft', clearTimeout() {} };
  vm.runInNewContext(functions(cart, ['cartCheckoutSignature', 'saveCartCheckoutDraft', 'clearCartCheckoutDraft'], 4), ctx);
  assert.equal(ctx.saveCartCheckoutDraft(), false); assert.equal(localStorage.value(), null);
});

test('an unchanged cart restores its draft independent of row order', () => {
  const localStorage = storage({ savedAt:Date.now(), cartSignature:'line-a:a:1|line-b:b:3', currentStep:2 });
  const ctx = { CART_ITEMS:[item('a'), item('b', 3)], window:{ getSelectedCartForCheckout:() => ({ items:[item('b', 3), item('a')] }) }, localStorage,
    _cartCheckoutSessionActive:true, CART_CHECKOUT_CUSTOMER_ID:'customer', CART_CHECKOUT_DRAFT_KEY:'draft', CART_CHECKOUT_DRAFT_MAX_AGE_MS:1800000 };
  vm.runInNewContext(functions(cart, ['cartCheckoutSignature', 'readCartCheckoutDraft'], 4), ctx);
  assert.equal(ctx.readCartCheckoutDraft().currentStep, 2);
});

test('a cancelled cart restore cannot select fulfillment in a newer checkout', async () => {
  const ctx = { _cartCheckoutGeneration:2, CART_ITEMS:[item('b')], window:{ selectFulfillment() { throw new Error('stale restore'); } } };
  vm.runInNewContext(functions(cart, ['cartCheckoutSignature', 'restoreCartCheckoutDraft'], 4), ctx);
  await ctx.restoreCartCheckoutDraft({ selectedFulfillment:'delivery_installation', cartSignature:'line-a:a:1' }, 1);
});

test('a cart restore that waits for pricing cannot advance or release a newer restore', async () => {
  let release; const pricing = new Promise(resolve => { release = resolve; });
  const ctx = { _cartCheckoutGeneration:1, _restoringCartDraft:false, CART_ITEMS:[item('a')], window:{ selectFulfillment() {} },
    clearTimeout() {}, _autoAdvanceTimer:null, setCheckoutFieldValue() {}, document:{ getElementById:() => null }, Event,
    orderProjectCheckout:null, checkoutCalendar:null, fpDatePickup:null, _checkoutRequestId:'request-a', createCheckoutRequestId:() => 'new',
    refreshOrderReward:() => pricing, renderPaymentOptions() { throw new Error('stale payment options'); }, enterWizardStep() { throw new Error('stale advance'); } };
  vm.runInNewContext(functions(cart, ['cartCheckoutSignature', 'restoreCartCheckoutDraft'], 4), ctx);
  const restoring = ctx.restoreCartCheckoutDraft({ selectedFulfillment:'customer_pickup', cartSignature:'line-a:a:1', currentStep:3 }, 1);
  ctx._cartCheckoutGeneration = 2; ctx._restoringCartDraft = true; release(); await restoring;
  assert.equal(ctx._restoringCartDraft, true);
});

function directFixture(quantity = 1) {
  const localStorage = storage({ savedAt:Date.now(), groupIdx:0, variantIdx:0, variantId:'a', selectedQuantity:quantity });
  const ctx = { GROUPS:[{ variants:[{ _id:'b', quantity:10, active:true, status:'in_stock' }] }, { variants:[{ _id:'a', quantity:5, active:true, status:'in_stock' }] }],
    _directCheckoutSessionActive:true, DIRECT_CHECKOUT_CUSTOMER_ID:'customer', DIRECT_CHECKOUT_DRAFT_KEY:'draft', DIRECT_CHECKOUT_DRAFT_MAX_AGE_MS:1800000,
    ProductAvailability:{ availability }, localStorage };
  vm.runInNewContext(functions(direct, ['readDirectCheckoutDraft'], 6), ctx); return { ctx, localStorage };
}
test('direct checkout locates a saved variant by ID after catalogue groups are reordered', () => {
  const f = directFixture(); const draft = f.ctx.readDirectCheckoutDraft();
  assert.equal(draft.groupIdx, 1); assert.equal(draft.variantIdx, 0); assert.equal(draft.variantId, 'a');
});
test('direct checkout rejects saved quantities that no longer fit available stock', () => {
  const f = directFixture(6); assert.equal(f.ctx.readDirectCheckoutDraft(), null); assert.equal(f.localStorage.value(), null);
});
test('direct checkout cannot restore a previous product into the currently opened group', async () => {
  const ctx = { _directCheckoutGeneration:2, selectedGroupIdx:1, GROUPS:[{ variants:[{ _id:'a' }] }, { variants:[{ _id:'b' }] }],
    window:{ selectVariant() { throw new Error('restored the wrong HP'); } } };
  vm.runInNewContext(functions(direct, ['directCheckoutVariantId', 'restoreDirectCheckoutDraft'], 6), ctx);
  await ctx.restoreDirectCheckoutDraft({ groupIdx:0, variantIdx:0, variantId:'a' }, 2);
  await ctx.restoreDirectCheckoutDraft({ groupIdx:1, variantIdx:0, variantId:'b' }, 1);
});
test('changing HP or quantity clears dates and payment while preserving the fare for the same address', () => {
  const values = new Map();
  const ctx = { directLoyaltyQuote:{ subtotal:20000 }, _checkoutRequestId:'old-request', _routeRequestId:1,
    _routeDistanceKm:23, _routeDurationMin:40, _transportFee:920,
    checkoutCalendar:null, fpDatePickup:null, document:{ getElementById:() => null },
    setDirectCheckoutFieldValue:(id, value) => values.set(id, value) };
  vm.runInNewContext(functions(direct, ['resetDirectCheckoutFields'], 6), ctx);
  ctx.resetDirectCheckoutFields(false);
  assert.equal(values.get('wizardDate'), ''); assert.equal(values.get('wizardPaymentMethod'), '');
  assert.equal(values.has('wizardAddress'), false); assert.equal(ctx._transportFee, 920);
  assert.equal(ctx._routeDistanceKm, 23); assert.equal(ctx.directLoyaltyQuote, null); assert.equal(ctx._checkoutRequestId, '');
});
test('opening a fresh model clears the old location, fare and map marker', () => {
  let removed = false; const values = new Map();
  const ctx = { _routeRequestId:1, _transportFee:920, checkoutCalendar:null, fpDatePickup:null, USER_PHONE:'09171234567',
    document:{ getElementById:() => null }, window:{}, leafletMap:{ remove() { removed = true; } }, leafletMarker:{},
    setDirectCheckoutFieldValue:(id, value) => values.set(id, value) };
  vm.runInNewContext(functions(direct, ['resetDirectCheckoutFields'], 6), ctx);
  ctx.resetDirectCheckoutFields();
  assert.equal(values.get('wizardAddress'), ''); assert.equal(values.get('wizardLat'), '');
  assert.equal(ctx._transportFee, 0); assert.equal(ctx.leafletMarker, null); assert.equal(removed, true);
});
test('clearing an installation window cancels its old capacity verdict and removes both dates', () => {
  const ctx = { window:{}, clearTimeout() {} }; vm.runInNewContext(read('public/js/large-order-checkout.js'), ctx);
  let aborted = false;
  const panel = Object.assign(Object.create(ctx.window.LargeOrderCheckout.prototype), {
    start:{ value:'2035-01-02', min:'2035-01-01' }, end:{ value:'2035-01-12', min:'2035-01-02' },
    status:{}, retry:{}, version:1, verdict:{ sufficient:true }, controller:{ abort() { aborted = true; } }
  });
  panel.reset(); assert.equal(aborted, true); assert.equal(panel.version, 2); assert.equal(panel.verdict, null);
  assert.equal(panel.start.value, ''); assert.equal(panel.end.value, ''); assert.equal(panel.retry.hidden, true);
});
test('a cleared checkout calendar ignores a time-slot response from the previous order', async () => {
  let release; const response = new Promise(resolve => { release = resolve; });
  const ctx = { window:{}, URLSearchParams, console, fetch:() => response };
  vm.runInNewContext(read('public/js/checkout-calendar.js') + '\nglobalThis.Calendar = CheckoutCalendar;', ctx);
  const calendar = Object.assign(Object.create(ctx.Calendar.prototype), {
    state:{ selectedDate:new Date('2035-01-02'), selectedTimeSlot:{ startTime:'09:00' }, duration:60, quantity:1, travelTime:30 },
    dom:{ timeSection:{ style:{} }, nextAction:{} }, render() {}, _renderTimeSlots() { throw new Error('stale time slots rendered'); }
  });
  const loading = calendar.loadTimeSlots(new Date('2035-01-02')); calendar.clear();
  release({ ok:true, json:async () => ({ timeSlots:[{ startTime:'09:00', available:true }] }) }); await loading;
  assert.equal(calendar.state.selectedDate, null); assert.equal(calendar.state.selectedTimeSlot, null);
});

test('a delayed slot validation cannot restore a date that a changed order already cleared', async () => {
  let release; const response = new Promise(resolve => { release = resolve; });
  const ctx = { window:{}, URLSearchParams, console, fetch:() => response };
  vm.runInNewContext(read('public/js/checkout-calendar.js') + '\nglobalThis.Calendar = CheckoutCalendar;', ctx);
  const calendar = Object.assign(Object.create(ctx.Calendar.prototype), {
    state:{ duration:60, quantity:1, travelTime:30 }, dom:{ timeSection:{ style:{} }, nextAction:{} }, render() {}
  });
  const validating = calendar.validateSelectedSlot('2035-01-02', '09:00'); calendar.clear();
  release({ ok:true, json:async () => ({ timeSlots:[{ startTime:'09:00', available:true }] }) });
  assert.equal(await validating, false); assert.equal(calendar.state.selectedDate, null);
});

test('calendar availability from the old quantity cannot overwrite the new order workload', async () => {
  const pending = []; let renders = 0;
  const ctx = { window:{}, URLSearchParams, console, fetch:url => new Promise(resolve => pending.push({ url, resolve })) };
  vm.runInNewContext(read('public/js/checkout-calendar.js') + '\nglobalThis.Calendar = CheckoutCalendar;', ctx);
  const calendar = Object.assign(Object.create(ctx.Calendar.prototype), {
    state:{ duration:60, quantity:1, travelTime:30 }, dom:{ grid:{ style:{} } }, render() { renders++; }
  });
  const first = calendar.fetchData(); calendar.state.quantity = 3; const second = calendar.fetchData();
  function finish(index, label) {
    for (const request of pending.slice(index, index + 3)) request.resolve({ ok:true,
      json:async () => request.url.includes('available-dates') ? { availableDates:[label] }
        : request.url.includes('booking-policy') ? { largeProjectThresholdHours:8 } : { holidays:[], nonWorkingDays:[] } });
  }
  finish(3, 'new quantity'); await second; finish(0, 'old quantity'); await first;
  assert.equal(calendar.scheduleData.availableDates[0], 'new quantity'); assert.equal(renders, 1);
});
