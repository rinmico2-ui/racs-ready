'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createController } = require('../public/js/relocation-booking-locations');
function harness(fetch = async () => ({ ok: true, json: async () => [] })) {
  class Node {
    constructor(id) {
      this.id = id; this.value = ''; this.disabled = false; this.children = []; this.listeners = {}; this.attributes = {};
      const classes = new Set(); this.classList = { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    emit(name, properties = {}) { for (const listener of this.listeners[name] || []) listener({ target: this, preventDefault() {}, ...properties }); }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return this.children; }
    contains(node) { return this === node || this.children.includes(node); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    get firstElementChild() { return this.children[0]; }
  }
  const fields = new Map();
  const document = { activeElement: null, getElementById(id) { if (!fields.has(id)) fields.set(id, new Node(id)); return fields.get(id); }, createElement() { return new Node(''); }, addEventListener() {} };
  let item = { relocation: { scope: 'custom_quote', from: {}, to: {} } }, origin = null;
  const pins = [], targets = [], requests = [];
  const controller = createController({ document, fetch: (url, options) => { requests.push(url); return fetch(url, options); },
    getItem: () => item, getOrigin: () => origin, setPin: (lat, lng) => pins.push({ lat, lng }),
    setTarget: target => targets.push(target), changed() {}, clearPin() { pins.push('cleared'); }, isLocationStep: () => true });
  const field = id => document.getElementById(id);
  const type = value => { field('relocationDestinationAddress').value = value; field('relocationDestinationAddress').emit('input'); };
  return { controller, pins, targets, requests, field, type, item: () => item, setItem(value) { item = value; }, setOrigin(value) { origin = value; } };
}
test('choosing the current location switches to the destination without replacing the origin pin', () => {
  const h = harness(); h.controller.sync(); assert.equal(h.field('relocationDestinationAddress').disabled, true);
  assert.equal(h.controller.target(), 'from');
  h.field('locationInput').focus(); h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync();
  assert.equal(h.controller.target(), 'to'); assert.equal(h.field('relocationDestinationAddress').disabled, false);
  assert.equal(h.item().relocation.from.lat, 15.3); assert.equal(h.field('relocationDestinationAddress').id, 'relocationDestinationAddress');
  h.field('relocationMapStepFrom').emit('click'); assert.equal(h.controller.target(), 'from');
  h.field('relocationMapStepTo').emit('click'); assert.equal(h.controller.target(), 'to'); assert.equal(h.pins.length, 0);
});
test('address suggestions set only the orange pin and invalidate an old destination when edited', async () => {
  const h = harness(async () => ({ ok: true, json: async () => [{ display_name: 'New address, Santa Rosa', lat: '15.4', lon: '121.2' }] }));
  h.setOrigin({ address: 'Current street', lat: 15.3, lng: 121.1 }); h.controller.sync(); h.type('Santa Rosa'); await h.controller.search();
  assert.equal(h.field('relocationDestinationSuggest').children.length, 1);
  h.field('relocationDestinationSuggest').children[0].emit('click');
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
  assert.equal(h.field('relocationDestinationSuggest').children.length, 0); assert.equal(h.item().relocation.to.address, 'New search');
  const second = h.controller.search(); const old = h.item(); h.setItem({ relocation: { scope: 'custom_quote', from: {}, to: {} } }); h.controller.sync();
  release({ ok: true, json: async () => [{ display_name: 'New search address', lat: 15.4, lon: 121.2 }] }); await second;
  assert.equal(h.field('relocationDestinationSuggest').children.length, 0); assert.equal(h.item().relocation.to.address, undefined); assert.equal(old.relocation.to.lat, null);
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
