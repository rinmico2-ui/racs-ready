'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createController } = require('../public/js/relocation-booking-locations');
function harness(fetch = async () => ({ ok: true, json: async () => [] }), contains) {
  const tasks = new Map(); let nextTimer = 0;
  class Node {
    constructor(id) {
      this.id = id; this.ownerDocument = null; this.style = {}; this.innerHTML = 'Search'; this.value = ''; this.disabled = false; this.children = []; this.listeners = {}; this.attributes = {};
      const classes = new Set(); this.classList = { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    emit(name, properties = {}) {
      let stopped = false;
      const event = { target: this, preventDefault() {}, ...properties, stopPropagation() { stopped = true; } };
      const pending = (this.listeners[name] || []).map(listener => listener(event));
      if (name === 'click' && !stopped) pending.push(document.emit('click', event));
      return Promise.all(pending);
    }
    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return this.children; }
    contains(node) { return this === node || this.children.includes(node); }
    focus() { document.activeElement = this; document.emit('focusin', { target: this }); }
    scrollIntoView() {}
    get firstElementChild() { return this.children[0]; }
  }
  const fields = new Map(), listeners = {};
  const document = { activeElement: null,
    getElementById(id) { if (!fields.has(id)) { const node = new Node(id); node.ownerDocument = document; fields.set(id, node); } return fields.get(id); },
    createElement() { const node = new Node(''); node.ownerDocument = document; return node; },
    createTextNode(text) { return { textContent: text }; },
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    emit(name, event) { return Promise.all((listeners[name] || []).map(listener => listener(event))); } };
  let item = { relocation: { scope: 'different_address', from: {}, to: {} } }, origin = null;
  const pins = [], targets = [], requests = [];
  const controller = createController({ document, fetch: (url, options) => { requests.push(url); return fetch(url, options); },
    contains, window: { document, fetch: (url, options) => { requests.push(url); return fetch(url, options); }, AbortController, setTimeout: fn => { tasks.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => tasks.delete(id), ...(contains ? { NuevaEcijaCoverage: { contains } } : {}) },
    getItem: () => item, getOrigin: () => origin, setPin: (lat, lng) => pins.push({ lat, lng }),
    setTarget: target => targets.push(target), changed() {}, clearPin() { pins.push('cleared'); }, isLocationStep: () => true });
  const field = id => document.getElementById(id);
  const type = value => { field('relocationDestinationAddress').value = value; field('relocationDestinationAddress').emit('input'); };
  return { controller, pins, targets, requests, field, type, flush() { for (const [id, fn] of tasks) { tasks.delete(id); fn(); } }, document, replaceOriginInput() { fields.delete('locationInput'); return field('locationInput'); }, item: () => item, setItem(value) { item = value; }, setOrigin(value) { origin = value; } };
}
test('choosing the current location switches to the destination without replacing the origin pin', () => {
  const h = harness(); h.controller.sync(); assert.equal(h.field('relocationDestinationAddress').disabled, true);
  assert.equal(h.controller.target(), 'from');
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync();
  assert.equal(h.controller.target(), 'to'); assert.equal(h.field('relocationDestinationAddress').disabled, false);
  assert.equal(h.item().relocation.from.lat, 15.3); assert.equal(h.field('relocationDestinationAddress').id, 'relocationDestinationAddress');
  h.field('relocationMapStepFrom').emit('click'); assert.equal(h.controller.target(), 'from');
  h.field('relocationMapStepTo').emit('click'); assert.equal(h.controller.target(), 'to'); assert.equal(h.pins.length, 0);
});
test('address suggestions set only the orange pin and invalidate an old destination when edited', async () => {
  const h = harness(async () => ({ ok: true, json: async () => [{ display_name: 'New address, Santa Rosa', lat: '15.4', lon: '121.2' }] }));
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync(); h.type('Santa Rosa'); await h.controller.search();
  assert.equal(h.field('relocationDestinationSuggest').children.filter(node => node.attributes?.role === 'option').length, 1);
  await h.field('relocationDestinationSuggest').children[0].emit('click');
  assert.deepEqual(h.pins.at(-1), { lat: 15.4, lng: 121.2 }); assert.equal(h.item().relocation.from.lat, 15.3);
  assert.equal(h.item().relocation.to.address, 'New address, Santa Rosa');
  h.type('Another street'); assert.equal(h.item().relocation.to.lat, null); assert.equal(h.pins.at(-1), 'cleared');
  h.type(''); // cancel the debounce without making a real network request
});
test('a destination map click works without typing and keeps its exact coordinates after reverse geocoding', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ display_name: 'New pinned street, Manila' }) }));
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync();
  const pending = h.controller.pin(15.4, 121.2);
  assert.deepEqual(h.pins[0], { lat: 15.4, lng: 121.2 }); assert.equal(h.item().relocation.from.lng, 121.1);
  await pending; assert.equal(h.item().relocation.to.address, 'New pinned street, Manila');
  assert.equal(h.item().relocation.to.lat, 15.4); assert.equal(h.item().relocation.to.lng, 121.2);
});
test('manual destination text remains saved when the customer places an exact pin', async () => {
  const h = harness(); h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync();
  h.type('Block 1 Lot 2, New Street'); await h.controller.pin(15.4, 121.2);
  assert.equal(h.item().relocation.to.address, 'Block 1 Lot 2, New Street'); assert.equal(h.requests.length, 0);
});
test('a late suggestion response cannot overwrite newer text or a different relocation', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync(); h.type('Old search');
  const pending = h.controller.search(); h.type('New search');
  release({ ok: true, json: async () => [{ display_name: 'Old address', lat: 15.4, lon: 121.2 }] }); await pending;
  assert.equal(h.field('relocationDestinationAddress').getAttribute('aria-expanded'), 'false'); assert.equal(h.item().relocation.to.address, 'New search');
  const second = h.controller.search(); const old = h.item(); h.setItem({ relocation: { scope: 'different_address', from: {}, to: {} } }); h.controller.sync();
  release({ ok: true, json: async () => [{ display_name: 'New search address', lat: 15.4, lon: 121.2 }] }); await second;
  assert.equal(h.field('relocationDestinationAddress').getAttribute('aria-expanded'), 'false'); assert.equal(h.item().relocation.to.address, undefined); assert.equal(old.relocation.to.lat, null);
});
test('changing the origin retains an existing separate destination, while nearby moves share the property pin', () => {
  const h = harness(); h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 });
  h.item().relocation.to = { address: 'New street', lat: 15.4, lng: 121.2 }; h.controller.sync();
  h.setOrigin({ address: 'Updated current street', lat: 15.31, lng: 121.11 }); h.controller.sync();
  assert.equal(h.item().relocation.from.lat, 15.31); assert.equal(h.item().relocation.to.lat, 15.4);
  h.setItem({ relocation: { scope: 'same_property', from: { details: 'Room A' }, to: { details: 'Room B' } } }); h.controller.sync();
  assert.equal(h.item().relocation.to.lat, 15.31); assert.equal(h.item().relocation.to.address, 'Updated current street'); assert.equal(h.item().relocation.to.details, 'Room B');
});
test('a failed search or address lookup does not erase a valid destination pin', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync(); await h.controller.pin(15.4, 121.2);
  assert.equal(h.item().relocation.to.lat, 15.4); assert.match(h.field('relocationDestinationStatus').textContent, /pin is saved/);
});

const tick = () => new Promise(setImmediate);
const currentPoint = { address: 'Current street, Cabanatuan', lat: 15.49, lng: 120.96 };
const destinationPoint = { display_name: 'New street, Palayan, Nueva Ecija', lat: 15.54, lon: 121.08, source: 'photon' };

test('typing a destination uses shared autocomplete and applying its suggestion only moves the destination', async () => {
  const h = harness(async url => ({ ok: true, json: async () => ({ suggestions: [destinationPoint] }) }));
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Palayan'); h.flush(); await tick();
  assert.match(h.requests[0], /\/autocomplete\?q=Palayan/);
  assert.equal(h.field('relocationDestinationAddress').getAttribute('aria-expanded'), 'true');
  await h.field('relocationDestinationSuggest').children[0].emit('click');
  assert.equal(h.item().relocation.to.lat, 15.54); assert.equal(h.item().relocation.from.lat, currentPoint.lat);
  assert.equal(h.controller.target(), 'to');
});

test('local name-only destination suggestions resolve their point after selection', async () => {
  const locality = require('../utils/nuevaEcijaAddresses').suggestions('Puncan')[0];
  const point = { display_name: locality.display_name, lat: 15.906146, lon: 120.9918457 };
  const h = harness(async url => ({ ok: true, json: async () => url.includes('/autocomplete?') ? { suggestions: [locality] } : [point] }));
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Puncan'); h.flush(); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.item().relocation.to.lat, null);
  await h.field('relocationDestinationSuggest').children[0].emit('click');
  assert.equal(h.requests.length, 2); assert.match(h.requests[1], /\/search\?q=Puncan/);
  assert.equal(h.item().relocation.to.lat, point.lat); assert.equal(h.item().relocation.to.lng, point.lon);
  assert.equal(h.item().relocation.from.lat, currentPoint.lat);
});

test('switching to the current address cancels a pending destination lookup even after the origin input is replaced', async () => {
  let respond;
  const h = harness(() => new Promise(resolve => { respond = resolve; }));
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Palayan'); h.flush();
  const replacement = h.replaceOriginInput(); replacement.focus();
  assert.equal(h.controller.target(), 'from');
  respond({ ok: true, json: async () => ({ suggestions: [destinationPoint] }) }); await tick();
  assert.equal(h.pins.filter(pin => typeof pin === 'object').length, 0);
  assert.equal(h.field('relocationDestinationAddress').getAttribute('aria-expanded'), 'false');
  h.field('relocationDestinationAddress').focus(); assert.equal(h.controller.target(), 'to');
});

test('origin pin edits retain the explicitly selected target and leave the destination unchanged', async () => {
  const h = harness(); h.setOrigin(currentPoint); h.controller.sync(); h.type('New address'); await h.controller.pin(15.54, 121.08);
  h.field('relocationMapStepFrom').emit('click');
  h.setOrigin({ ...currentPoint, lat: 15.5 }); h.controller.sync();
  assert.equal(h.controller.target(), 'from'); assert.equal(h.item().relocation.from.lat, 15.5); assert.equal(h.item().relocation.to.lat, 15.54);
  h.field('relocationMapStepTo').emit('click'); await h.controller.pin(15.55, 121.09);
  assert.equal(h.controller.target(), 'to'); assert.equal(h.item().relocation.from.lat, 15.5);
});

test('repeated destination map placements retain the destination target and exact last coordinates', async () => {
  const h = harness(); h.setOrigin(currentPoint); h.controller.sync(); h.type('Manual new address');
  await h.controller.pin(15.54, 121.08); await h.controller.pin(15.55, 121.09);
  assert.equal(h.controller.target(), 'to'); assert.deepEqual(h.pins.at(-1), { lat: 15.55, lng: 121.09 });
  assert.equal(h.item().relocation.from.lat, currentPoint.lat);
});

test('dragging a previously resolved destination updates its address rather than retaining an old search label', async () => {
  const h = harness(async url => ({ ok: true, json: async () => url.includes('/reverse?') ? { display_name: 'Dragged destination address' } : [destinationPoint] }));
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Palayan'); await h.controller.search();
  await h.field('relocationDestinationSuggest').children[0].emit('click');
  await h.controller.pin(15.55, 121.09);
  assert.match(h.requests.at(-1), /\/reverse\?lat=15.55/); assert.equal(h.item().relocation.to.address, 'Dragged destination address');
});

test('locality failures and non-JSON gateway responses keep manual destination pinning available', async () => {
  const locality = require('../utils/nuevaEcijaAddresses').suggestions('Puncan')[0];
  const h = harness(async url => url.includes('/autocomplete?') ? { ok: true, json: async () => ({ suggestions: [locality] }) }
    : { ok: false, status: 502, json: async () => { throw SyntaxError('Bad Gateway'); } });
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Puncan'); h.flush(); await tick();
  await h.field('relocationDestinationSuggest').children[0].emit('click');
  assert.equal(h.field('relocationDestinationSearch').disabled, false);
  assert.equal(h.item().relocation.to.lat, null); assert.doesNotMatch(h.field('relocationDestinationStatus').textContent, /Bad Gateway|SyntaxError/);
  await h.controller.pin(15.54, 121.08); assert.equal(h.item().relocation.to.lat, 15.54);
  assert.equal(h.item().relocation.to.address, locality.display_name);
});

test('autocomplete and manual destination pins both enforce Nueva Ecija coverage', async () => {
  const contains = require('../public/js/nueva-ecija-coverage').contains;
  const h = harness(async () => ({ ok: true, json: async () => ({ suggestions: [{ ...destinationPoint, lat: 14.6, lon: 121 }] }) }), contains);
  h.setOrigin(currentPoint); h.controller.sync(); h.type('Outside'); h.flush(); await tick();
  assert.equal(h.field('relocationDestinationSuggest').children.filter(node => node.attributes?.role === 'option').length, 0);
  await h.controller.pin(14.6, 121); assert.equal(h.item().relocation.to.lat, null);
});
