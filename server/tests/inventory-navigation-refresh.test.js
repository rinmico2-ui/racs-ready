'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInventoryMutation, install } = require('../public/js/inventory-navigation-refresh');
const origin = 'https://racs.example';

test('refresh observes inventory writes, supports Request objects, and excludes unrelated or external requests', () => {
  for (const url of ['/api/admin/hvac/1', '/api/admin/tools/2/adjust-stock', '/api/pos/aircon-checkout', '/api/admin/equipment-returns/3/resolve', '/api/admin/daily-kit/resolve-item', '/api/projects/4/materials']) {
    assert.equal(isInventoryMutation(url, { method: 'POST' }, origin), true);
    assert.equal(isInventoryMutation(new Request(origin + url, { method: 'PATCH' }), undefined, origin), true);
    assert.equal(isInventoryMutation(url, undefined, origin), false);
    assert.equal(isInventoryMutation('https://elsewhere.example' + url, { method: 'POST' }, origin), false);
  }
  assert.equal(isInventoryMutation('/api/notifications/read-all', { method: 'PUT' }, origin), false);
  assert.equal(isInventoryMutation('/api/admin/tools-not-really/1', { method: 'DELETE' }, origin), false);
  assert.equal(isInventoryMutation(new Request(origin + '/api/admin/tools/1', { method: 'PATCH' }), { method: 'GET' }, origin), false);
});

test('one successful write refreshes once without consuming or replacing its response', async () => {
  const events = [], calls = [];
  let response = new Response('{"saved":true}', { status: 200 });
  const win = { location: { origin }, Event, dispatchEvent(event) { events.push(event.type); },
    fetch: async (...args) => { calls.push(args); return response; } };
  install(win);
  install(win);
  const options = { method: 'PATCH', headers: { 'X-Test': 'value' }, body: '{}' };
  assert.equal(await win.fetch('/api/admin/tools/1', options), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(calls[0][1], options);
  assert.deepEqual(events, ['inventory:changed']);
  response = new Response('', { status: 409 });
  await win.fetch('/api/admin/tools/1', options);
  await win.fetch('/api/admin/tools/1');
  assert.equal(events.length, 1);
});

test('network errors retain their original rejection and do not refresh', async () => {
  const error = new Error('offline');
  const win = { location: { origin }, Event, dispatchEvent() { assert.fail('No refresh on error'); }, fetch: async () => { throw error; } };
  install(win);
  await assert.rejects(win.fetch('/api/pos/checkout', { method: 'POST' }), value => value === error);
});
