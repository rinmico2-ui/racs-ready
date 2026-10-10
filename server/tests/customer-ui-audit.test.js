'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');
function source(name, file = 'services-multi.js') {
  const text = read(file), start = text.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const next = text.slice(start + 1).search(/\n(?:async )?function /);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}
function element() {
  const events = {}, attrs = {}, classes = new Set();
  return { value:'', disabled:false, hidden:false, type:'password', textContent:'', style:{}, dataset:{},
    classList:{ add:c => classes.add(c), remove:c => classes.delete(c), contains:c => classes.has(c) },
    addEventListener(type, fn) { events[type] = fn; },
    emit(type) { return events[type]?.({ preventDefault() {} }); },
    setAttribute(key, value) { attrs[key] = value; }, removeAttribute(key) { delete attrs[key]; },
    getAttribute:key => attrs[key], focus() { this.focused = true; },
  };
}
test('custom brand resolves from its input even after navigating away from the brand step', () => {
  const select = { value:'__other__' }, custom = { value:'  Acme Air  ' };
  const context = vm.createContext({ BookingState:{ selectedBrand:'__other__' }, document:{ getElementById:id => id === 'brandInput' ? select : custom } });
  vm.runInContext(source('configuredServiceBrand'), context);
  assert.equal(context.configuredServiceBrand(), 'Acme Air');
  custom.value = '   '; assert.equal(context.configuredServiceBrand(), '');
  select.value = '__unknown__'; assert.equal(context.configuredServiceBrand(), "I don't know");
});
test('HP choices retain cents, sort fractional sizes, and omit malformed and duplicate prices', () => {
  const context = vm.createContext({}); vm.runInContext(source('pricedHpOptions'), context);
  const result = context.pricedHpOptions([{ hp:1.5,price:'950.75' },{ hp:.75,price:0 },{ hp:1.5,price:1 },{ hp:2,price:'' },{ hp:3,price:null },{ hp:-1,price:100 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ hp:.75,price:0 },{ hp:1.5,price:950.75 }]);
});
test('the footer is the only brand continuation action for catalog and typed brands', () => {
  const button = element(); button.style.setProperty = () => {};
  const select = element(), custom = element();
  const state = { currentService:{ isAirconService:true,airconTypes:[{ type:'split' }] },configurationStep:1,selectedBrand:'',selectedHps:[] };
  let advanced = 0, submitted = 0;
  const context = vm.createContext({ BookingState:state,
    document:{ getElementById:id => id === 'confirmQuantitySelection' ? button : id === 'brandInput' ? select : custom },
    usesAirconTypeWizard:() => true,isAirconRelocationService:() => false,
    confirmQuantitySelection:() => submitted++,advanceFromBrandSelection:() => { advanced++; state.configurationStep = 2; },
  });
  vm.runInContext(source('configuredServiceBrand') + source('syncConfigurationPrimaryAction') + source('handleServiceConfigurationPrimaryAction'),context);
  context.syncConfigurationPrimaryAction(); assert.equal(button.disabled,true); assert.match(button.innerHTML,/Next: Aircon Type/);
  select.value = '__other__'; custom.value = '  Custom Brand  '; state.selectedBrand = custom.value;
  context.syncConfigurationPrimaryAction(); assert.equal(button.disabled,false);
  context.handleServiceConfigurationPrimaryAction(); assert.equal(advanced,1); assert.equal(submitted,0); assert.equal(state.selectedBrand,'Custom Brand');
  state.configurationStep = 1; select.value = state.selectedBrand = 'Carrier';
  context.syncConfigurationPrimaryAction(); context.handleServiceConfigurationPrimaryAction(); assert.equal(advanced,2); assert.equal(submitted,0);
  const page = fs.readFileSync(path.join(__dirname,'../views/pages/services.ejs'),'utf8');
  assert.doesNotMatch(page,/cfgBrandContinue|Continue with this brand/);
});
test('returning to Brand or Type keeps the footer on navigation until the HP step', () => {
  const button = element(); button.style.setProperty = () => {};
  const state = { currentService:{ isAirconService:true,airconTypes:[{ type:'split' }] },configurationStep:1,selectedBrand:'Carrier',selectedAirconType:{ type:'split' },selectedHps:[{ hp:1,quantity:2 }] };
  let submitted = 0;
  const context = vm.createContext({ BookingState:state,document:{ getElementById:() => button },
    usesAirconTypeWizard:() => true,isAirconRelocationService:() => false,confirmQuantitySelection:() => submitted++,
    activeAirconConfigurationContainer:() => ({}),renderHpOptionsForType:() => { state.configurationStep = 3; },updateCombinedPrice:() => context.syncConfigurationPrimaryAction(),
  });
  vm.runInContext(source('syncConfigurationPrimaryAction') + source('handleServiceConfigurationPrimaryAction'),context);
  context.syncConfigurationPrimaryAction(); assert.match(button.innerHTML,/Next: Aircon Type/);
  state.configurationStep = 2; context.syncConfigurationPrimaryAction(); assert.match(button.innerHTML,/Next: HP/);
  context.handleServiceConfigurationPrimaryAction(); assert.equal(submitted,0); assert.match(button.innerHTML,/Add to Booking/);
  context.handleServiceConfigurationPrimaryAction(); assert.equal(submitted,1);
});
test('editing a booking at the 40-unit limit credits the original units', () => {
  const state = { selectedServices:[{ id:'edit',quantity:10 },{ id:'other',quantity:30 }], editingServiceId:'edit' };
  const context = vm.createContext({ BookingState:state, MAX_BOOKING_UNITS:40, selectedUnitTotal:() => 40 });
  vm.runInContext(source('remainingBookingUnits'), context);
  assert.equal(context.remainingBookingUnits(), 10);
  state.editingServiceId = null; assert.equal(context.remainingBookingUnits(), 0);
});
function passwordFixture(fetch) {
  const nodes = new Map(); const get = id => { if (!nodes.has(id)) nodes.set(id,element()); return nodes.get(id); };
  const redirects = [], timers = [];
  get('customerPasswordForm').reset = () => ['customerCurrentPassword','customerNewPassword','customerConfirmPassword'].forEach(id => { get(id).value = ''; });
  vm.runInNewContext(read('customer-profile-password.js'), { document:{ getElementById:get }, fetch, window:{ setTimeout:fn => timers.push(fn), location:{ assign:url => redirects.push(url) } } });
  function fill() { get('customerCurrentPassword').value = 'OldPass1!'; get('customerNewPassword').value = get('customerConfirmPassword').value = 'NewPass2!'; }
  return { get, fill, submit:() => get('customerPasswordForm').emit('submit'), redirects, timers };
}
test('password form blocks invalid confirmation before posting', async () => {
  let calls = 0; const f = passwordFixture(() => { calls++; }); f.fill(); f.get('customerConfirmPassword').value = 'Mismatch1!';
  await f.submit(); assert.equal(calls,0); assert.match(f.get('customerPasswordAlert').textContent,/do not match/);
});
test('password form blocks duplicate submissions, retains inputs on failure, and signs out on success', async () => {
  let complete, calls = 0;
  const f = passwordFixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); }); f.fill();
  const first = f.submit(); await f.submit(); assert.equal(calls,1); assert.equal(f.get('customerCurrentPassword').readOnly,true);
  complete({ ok:false,status:400,json:async () => ({ error:'Current password is incorrect.' }) }); await first;
  assert.equal(f.get('customerNewPassword').value,'NewPass2!'); assert.equal(f.get('customerChangePassword').disabled,false);
  assert.match(f.get('customerPasswordAlert').textContent,/incorrect/);
  const second = f.submit(); complete({ ok:true,status:200,json:async () => ({ requiresLogin:true }) }); await second;
  assert.equal(f.get('customerCurrentPassword').value,''); assert.equal(f.get('customerChangePassword').disabled,true);
  f.timers[0](); assert.deepEqual(f.redirects,['/login']);
});
test('sidebar, navbar, and mobile cart badges clear together and announce the full quantity', () => {
  const nodes = { cart:element(), bookings:element(), orders:element(), aftercare:element() }, navbar = element(), mobile = element();
  const text = read('navbar-auth.js'); const start = text.indexOf('    function setBadge('), end = text.indexOf('    var badgeGeneration',start);
  const context = vm.createContext({ sidebar:{ querySelector:selector => nodes[selector.match(/"(.+)"/)[1]] }, navbarCartBadge:navbar, triggerCartBadge:mobile, BADGE_LABELS:{ cart:n => n + ' items in cart' } });
  vm.runInContext(text.slice(start,end),context);
  context.setBadge('cart',126);
  assert.equal(nodes.cart.textContent,'99+'); assert.equal(navbar.textContent,'99+'); assert.equal(mobile.textContent,'99+');
  assert.equal(nodes.cart.getAttribute('aria-label'),'126 items in cart'); assert.equal(mobile.getAttribute('aria-label'),'126 items in cart');
  context.setBadge('cart',0); assert.equal(nodes.cart.hidden,true); assert.equal(mobile.hidden,true); assert.equal(navbar.style.display,'none');
});
test('an older badge response cannot overwrite counts after a newer refresh', async () => {
  const text = read('navbar-auth.js'), start = text.indexOf('    var badgeGeneration'), end = text.indexOf('    function isMenuOpen', start);
  const requests = [], writes = [];
  const context = vm.createContext({ fetch:() => new Promise(resolve => requests.push(resolve)), setBadge:(key,value) => writes.push([key,value]) });
  vm.runInContext(text.slice(start,end),context); context.loadBadges(); context.loadBadges();
  requests[1]({ ok:true,json:async () => ({ cart:0,bookings:1,orders:2,aftercare:3 }) }); await new Promise(setImmediate);
  requests[0]({ ok:true,json:async () => ({ cart:99,bookings:99,orders:99,aftercare:99 }) }); await new Promise(setImmediate);
  assert.deepEqual(writes,[['cart',0],['bookings',1],['orders',2],['aftercare',3]]);
});
