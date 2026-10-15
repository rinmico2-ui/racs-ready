'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { retryDelay } = require('../public/js/address-autocomplete');
const script = fs.readFileSync(path.join(__dirname, '../public/js/services-multi.js'), 'utf8');
const names = ['closeAddressSuggestions', 'cancelServiceAddressSuggestions', 'guideToManualAddressPin',
  'showServiceAddressRecovery', 'scheduleLiveAddressSuggestions', 'fetchLiveAddressSuggestions',
  'setupAddressAutocomplete', 'fetchAddressSuggestions'];
const source = names.map(name => {
  const declaration = script.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(declaration, name + ' exists'); return declaration;
}).join('\n');
const tick = () => new Promise(setImmediate);

function fixture() {
  function node() {
    const classes = new Set(), events = {}, attributes = {};
    return { value:'', children:[], style:{}, hidden:false, disabled:false, textContent:'', innerHTML:'',
      classList:{ add:c => classes.add(c), remove:c => classes.delete(c), contains:c => classes.has(c) },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { attributes[key] = value; }, getAttribute:key => attributes[key],
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
      emit(type, event = {}) { for (const fn of events[type] || []) fn({ target:this, preventDefault() {}, ...event }); },
      querySelector:() => null, contains(target) { return this === target || this.children.includes(target); }, focus() {} };
  }
  const nodes = Object.fromEntries(['locationInput', 'locationSuggest', 'serviceAddressSearchBtn', 'locationStatus'].map(id => [id, node()]));
  nodes.locationSuggest.classList.add('d-none');
  const timers = new Map(), calls = [], displayed = []; let clock = Date.now(), timerId = 0;
  const ctx = {
    document:{ getElementById:id => nodes[id], createElement:node, addEventListener() {} },
    BookingState:{ customerLocation:null }, AbortController, Date:class extends Date { static now() { return clock; } },
    addressAutocompleteDebounceTimer:null, addressSuggestionRequestToken:0, addressSuggestionAbortController:null,
    addressAutocompleteEnabled:true, addressAutocompleteStatusLoaded:true, addressAutocompleteRetryAt:0,
    clearTimeout:id => timers.delete(id), setTimeout:fn => { timers.set(++timerId, fn); return timerId; },
    fetch:(url, options) => new Promise(resolve => calls.push({ url, options, resolve })),
    displaySuggestions:results => displayed.push(results), resetServiceLocationForTypedAddress() {}, bookingDebug() {}, showError() {},
  };
  ctx.window = { setTimeout:ctx.setTimeout, AddressAutocomplete:{ retryDelay } };
  vm.createContext(ctx); vm.runInContext(source, ctx); ctx.setupAddressAutocomplete(nodes.locationInput);
  function type(value) { nodes.locationInput.value = value; nodes.locationInput.emit('input'); }
  function flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  function respond(index, data, status = 200) { calls[index].resolve({ ok:status === 200, status, json:async () => data }); }
  return { ctx, nodes, calls, displayed, type, flush, respond, advance:ms => { clock += ms; } };
}

test('the services form offers Search and map actions after an outage and stops live lookups during cooldown', async () => {
  const f = fixture(); f.type('Puncan'); f.flush();
  f.respond(0, { retryAfter:30000 }, 503); await tick();
  const panel = f.nodes.locationSuggest;
  assert.equal(panel.classList.contains('d-none'), false);
  assert.deepEqual(panel.children.slice(1).map(node => node.textContent), ['Search this address', 'Keep this address and place a pin']);
  assert.equal(f.nodes.locationInput.value, 'Puncan'); assert.equal(f.nodes.locationStatus.hidden, false);
  f.type('Puncan Carranglan'); f.flush(); assert.equal(f.calls.length, 1);
  panel.children[1].emit('click'); assert.match(f.calls[1].url, /\/search\?q=Puncan%20Carranglan/);
  assert.equal(f.nodes.serviceAddressSearchBtn.disabled, true);
  f.respond(1, [{ display_name:'Puncan, Carranglan, Nueva Ecija, Philippines', lat:15.9, lon:121.0 }]); await tick();
  assert.equal(f.displayed.length, 1); assert.equal(f.nodes.serviceAddressSearchBtn.disabled, false);
});

test('the services map recovery preserves the edited address instead of requiring a search result', async () => {
  const f = fixture(); f.type('Puncan'); f.flush(); f.respond(0, {}, 502); await tick();
  f.type('House 7, Puncan, Carranglan'); f.nodes.locationSuggest.children[2].emit('click');
  assert.equal(f.ctx.BookingState.pendingManualAddress, 'House 7, Puncan, Carranglan');
  assert.equal(f.nodes.locationInput.value, 'House 7, Puncan, Carranglan');
  assert.equal(f.nodes.locationSuggest.classList.contains('d-none'), true);
  assert.equal(f.calls.length, 1, 'the map action does not automatically geocode typed text');
});

test('an outdated live failure cannot reopen the services recovery panel or impose cooldown on the latest query', async () => {
  const f = fixture(); f.type('Puncan'); f.flush(); f.type('Carranglan'); f.flush();
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.respond(1, { suggestions:[{ display_name:'Carranglan' }] }); await tick();
  f.respond(0, {}, 503); await tick();
  assert.equal(f.ctx.addressAutocompleteRetryAt, 0); assert.equal(f.displayed.length, 1);
  assert.equal(f.nodes.locationSuggest.classList.contains('d-none'), true);
});

test('the services form resumes live suggestions after cooldown without automatically submitting Search', async () => {
  const f = fixture(); f.type('Puncan'); f.flush(); f.respond(0, {}, 503); await tick();
  f.advance(31000); f.type('Carranglan'); f.flush();
  assert.equal(f.calls.length, 2); assert.match(f.calls[1].url, /\/autocomplete\?/);
  f.respond(1, { suggestions:[{ display_name:'Carranglan' }] }); await tick();
  assert.equal(f.ctx.addressAutocompleteRetryAt, 0);
});

test('a non-JSON explicit services search restores the Search button and keeps map recovery available', async () => {
  const f = fixture(); f.nodes.locationInput.value = 'Puncan'; f.ctx.fetchAddressSuggestions('Puncan');
  f.calls[0].resolve({ ok:true, status:200, json:async () => { throw new SyntaxError('Bad Gateway'); } }); await tick();
  assert.equal(f.nodes.serviceAddressSearchBtn.disabled, false);
  assert.equal(f.nodes.locationSuggest.children[2].textContent, 'Keep this address and place a pin');
  assert.doesNotMatch(f.nodes.locationStatus.textContent, /Bad Gateway|Unexpected token/);
});
