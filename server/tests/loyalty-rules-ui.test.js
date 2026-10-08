'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const ejs = require('ejs');
const source = fs.readFileSync(path.join(__dirname, '../public/js/loyalty-rules.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const rule = { id: 'repeat-services', name: 'Repeat service', enabled: true, metric: 'bookings', threshold: 5, discountPercent: 10, appliesTo: 'services', qualifyingServiceIds: [], eligibleServiceIds: [], eligibleProductIds: [] };
const initial = () => ({ policy: { enabled: false, revision: 'version-1', updatedAt: '2026-10-09T01:00:00Z', rules: [{ ...rule }] }, services: [], products: [] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

async function fixture(replies = []) {
  const nodes = new Map(), requests = [];
  const element = () => ({ handlers: {}, dataset: {}, attributes: {}, hidden: false, disabled: false, textContent: '', children: [],
    addEventListener(name, callback) { this.handlers[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    fire(name = 'click') { return this.handlers[name]?.({ preventDefault() {} }); },
    append(child) { this.children.push(child); child.parent = this; }, replaceChildren() { this.children = []; },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
  });
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  get('loyaltyRulesForm').checkValidity = () => true;
  get('loyaltyRulesForm').reportValidity = () => { get('loyaltyRulesForm').reportedInvalid = true; };
  const createCard = () => {
    const card = element(), controls = {};
    Object.defineProperty(card, 'innerHTML', { set(html) {
      for (const name of ['name', 'threshold', 'discountPercent']) controls[name] = { value: html.match(new RegExp('name="' + name + '"[^>]*value="([^"]*)"'))[1] };
      controls.enabled = { checked: /name="enabled" checked/.test(html) };
      for (const [name, items] of [['metric', { bookings: 'Service bookings', orders: 'Product orders', combined: 'Bookings + orders' }], ['appliesTo', { services: 'Core-service bookings', orders: 'Aircon orders', both: 'Both' }]]) {
        let selected = Object.keys(items)[0];
        controls[name] = { get value() { return selected; }, set value(value) { selected = value; }, get selectedOptions() { return [{ value: selected, textContent: items[selected] }]; } };
      }
      for (const name of ['qualifyingServiceIds', 'eligibleServiceIds', 'eligibleProductIds']) controls[name] = { selectedOptions: [] };
      controls['.lr-preview'] = element(); controls['.lr-remove'] = element();
    } });
    card.querySelector = selector => controls[selector.match(/^\[name=([^\]]+)\]$/)?.[1] || selector];
    return card;
  };
  let saved = initial();
  vm.runInNewContext(source, {
    document: { querySelector: () => true, getElementById: get, createElement: createCard }, crypto,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (replies.length) { const next = replies.shift(); return typeof next === 'function' ? next(options) : next; }
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        saved = { ...saved, policy: { ...body, revision: 'version-' + requests.length, updatedAt: '2026-10-09T02:00:00Z' } };
      }
      return response(saved);
    },
  });
  await tick();
  return { get, requests, card: () => get('loyaltyRuleCards').children[0] };
}

test('saving edited loyalty rules shows confirmation beside Save and advances the revision for repeated saves', async () => {
  const f = await fixture();
  f.card().querySelector('[name=threshold]').value = '6';
  f.get('loyaltyEnabled').checked = true;
  await f.get('loyaltyRulesForm').fire('submit');
  const sent = JSON.parse(f.requests[1].options.body);
  assert.equal(sent.expectedRevision, 'version-1'); assert.equal(sent.rules[0].threshold, 6); assert.equal(sent.enabled, true);
  assert.match(f.get('loyaltySaveFeedback').textContent, /Saved successfully.*enabled/);
  assert.match(f.get('loyaltyProgramStatus').textContent, /enabled · 1 active rule/);
  assert.equal(f.get('saveLoyaltyRules').textContent, 'Saved'); assert.equal(f.get('loyaltyRulesFields').disabled, false);
  assert.equal(f.get('loyaltyRulesForm').attributes['aria-busy'], 'false');
  f.card().querySelector('[name=discountPercent]').value = '7.25'; f.get('loyaltyRulesForm').fire('input');
  assert.match(f.get('loyaltySaveFeedback').textContent, /Unsaved changes/);
  await f.get('loyaltyRulesForm').fire('submit');
  assert.equal(JSON.parse(f.requests[2].options.body).expectedRevision, 'version-2');
  assert.equal(JSON.parse(f.requests[2].options.body).rules[0].discountPercent, 7.25);
});

test('saving a disabled program clearly explains that rules were saved but automatic discounts are disabled', async () => {
  const f = await fixture(); await f.get('loyaltyRulesForm').fire('submit');
  assert.match(f.get('loyaltySaveFeedback').textContent, /Saved successfully.*disabled/);
  assert.match(f.get('loyaltyProgramStatus').textContent, /discounts disabled/);
});

test('invalid fields and inactive-only enabled programs give actionable feedback without sending a save', async () => {
  const f = await fixture(); f.get('loyaltyRulesForm').checkValidity = () => false;
  await f.get('loyaltyRulesForm').fire('submit');
  assert.equal(f.requests.length, 1); assert.equal(f.get('loyaltyRulesForm').reportedInvalid, true);
  assert.equal(f.get('loyaltySaveFeedback').attributes.role, 'alert');
  f.get('loyaltyRulesForm').checkValidity = () => true; f.get('loyaltyEnabled').checked = true;
  f.card().querySelector('[name=enabled]').checked = false;
  await f.get('loyaltyRulesForm').fire('submit');
  assert.equal(f.requests.length, 1); assert.match(f.get('loyaltySaveFeedback').textContent, /Activate at least one/);
  assert.equal(f.get('saveLoyaltyRules').disabled, false);
  f.card().querySelector('[name=name]').value = '   ';
  await f.get('loyaltyRulesForm').fire('submit');
  assert.match(f.get('loyaltySaveFeedback').textContent, /Enter a name/); assert.equal(f.get('saveLoyaltyRules').disabled, false);
});

test('pending saves lock editing and prevent duplicate submissions', async () => {
  let finish;
  const f = await fixture([response(initial()), () => new Promise(resolve => { finish = resolve; })]);
  const save = f.get('loyaltyRulesForm').fire('submit');
  assert.equal(f.get('loyaltyRulesFields').disabled, true); assert.equal(f.get('saveLoyaltyRules').textContent, 'Saving…');
  await f.get('loyaltyRulesForm').fire('submit'); assert.equal(f.requests.length, 2);
  finish(response({ policy: { ...initial().policy, revision: 'saved-version', updatedAt: '2026-10-09' } })); await save;
  assert.equal(f.get('saveLoyaltyRules').disabled, false); assert.equal(f.get('loyaltyRulesFields').disabled, false);
});

test('save rejection and revision conflicts preserve the draft and expose an explicit reload action', async () => {
  const f = await fixture([response(initial()), response({ error: 'Invalid discount percentage.' }, 400), response({ error: 'Another admin changed the rules.' }, 409)]);
  f.card().querySelector('[name=threshold]').value = '8'; await f.get('loyaltyRulesForm').fire('submit');
  assert.match(f.get('loyaltySaveFeedback').textContent, /Invalid discount/); assert.equal(f.card().querySelector('[name=threshold]').value, '8');
  await f.get('loyaltyRulesForm').fire('submit');
  assert.equal(f.get('reloadLoyaltyRules').hidden, false); assert.match(f.get('reloadLoyaltyRules').textContent, /replace draft/);
  assert.equal(f.card().querySelector('[name=threshold]').value, '8');
  assert.equal(JSON.parse(f.requests[2].options.body).expectedRevision, 'version-1');
});

test('load failures disable the editor and Retry restores it with session errors explained', async () => {
  const f = await fixture([response({ error: 'Unauthorized' }, 401), response(initial())]);
  assert.equal(f.get('loyaltyRulesFields').disabled, true); assert.equal(f.get('saveLoyaltyRules').disabled, true);
  assert.match(f.get('loyaltySaveFeedback').textContent, /Sign in again/); assert.equal(f.get('reloadLoyaltyRules').hidden, false);
  await f.get('reloadLoyaltyRules').fire();
  assert.equal(f.get('loyaltyRulesFields').disabled, false); assert.equal(f.get('saveLoyaltyRules').disabled, false);
});

test('non-JSON server failures are shown beside Save and leave the editor usable', async () => {
  const f = await fixture([response(initial()), { ok: false, status: 500, json: async () => { throw new SyntaxError('HTML response'); } }]);
  await f.get('loyaltyRulesForm').fire('submit');
  assert.match(f.get('loyaltySaveFeedback').textContent, /Please try again/); assert.equal(f.get('saveLoyaltyRules').disabled, false);
});

test('privileges page renders visible save feedback and validation is handled by the page script', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/pages/admin/Customers/Privilege.ejs'), {});
  assert.match(html, /id="loyaltyRulesForm" novalidate/); assert.match(html, /id="loyaltySaveFeedback" role="status"/);
  assert.match(html, /id="loyaltyRulesFields"[^>]*disabled/); assert.match(html, /20261009-save-feedback/);
});
