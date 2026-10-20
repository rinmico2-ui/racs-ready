'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('customer directory waits for footer Bootstrap before initializing or fetching records', async () => {
  const elements = new Map(), listeners = new Map();
  const document = { readyState: 'loading', addEventListener(event, callback) { listeners.set(event, callback); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', addEventListener() {} });
      return elements.get(id);
    } };
  let modalInitializations = 0, requests = 0;
  const context = vm.createContext({ window: {}, document, AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: async () => { ++requests; return { ok: true, json: async () => ({ customers: [], total: 0, limit: 10, stats: {} }) }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/customer-directory.js'), 'utf8'), context);
  assert.doesNotThrow(() => context.window.CustomerDirectory.init({ apiBase: '/api/admin/customers' }));
  assert.equal(requests, 0); assert.equal(typeof listeners.get('DOMContentLoaded'), 'function');
  context.bootstrap = { Modal: { getOrCreateInstance: () => { ++modalInitializations; return { show() {}, hide() {} }; } } };
  document.readyState = 'interactive';
  assert.doesNotThrow(() => listeners.get('DOMContentLoaded')());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(modalInitializations, 1); assert.equal(requests, 1);
  assert.equal(elements.get('custTotal').textContent, '0');
  assert.match(elements.get('customerTableBody').innerHTML, /No customers match/);
});
