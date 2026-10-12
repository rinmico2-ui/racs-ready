'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const settle = () => new Promise(resolve => setImmediate(resolve));
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
function harness() {
  const nodes = {}, requests = [], events = {};
  const node = id => nodes[id] ||= { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false, dataset: {}, handlers: {},
    addEventListener(type, callback) { this.handlers[type] = callback; }, querySelectorAll() { return []; }, insertAdjacentHTML(_position, html) { this.innerHTML += html; } };
  node('serviceFilter').value = 'all';
  const window = { confirm: () => true, addEventListener: (name, callback) => { events[name] = callback; } };
  const source = read('../public/js/service-kit-rules-admin.js').replace(/\n  load\(\);\n\}\)\(\);\s*$/, '\n  window.rulesTest = { state, load, select, render };\n})();');
  vm.runInNewContext(source, { window, document: { getElementById: node }, fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })), console, Date, Map, Set });
  const fire = (id, type, dataset = {}) => node(id).handlers[type]({ preventDefault() {}, target: { value: node(id).value, dataset, closest: () => ({ dataset }) } });
  const respond = (index, body, ok = true) => requests[index].resolve({ ok, json: async () => body });
  const rule = { mode: 'defaults', revision: 0, items: [], inspectionItems: [], repairItems: [], updatedAt: null };
  const services = [{ id: 'core', name: 'Aircon Installation', serviceModel: 'CoreService', active: true, rule: { ...rule } },
    { id: 'repair', name: 'Overheating', serviceModel: 'RepairService', active: true, rule: { ...rule } }];
  services[0].defaults = { items: [{ toolId: 'tool', name: 'Field <Kit>', category: 'equipment', quantity: 1, unit: 'pcs', available: 2 },
    { toolId: null, name: 'Ladder', category: 'equipment', quantity: 1, unit: 'pcs', available: 0, catalogMissing: true }], inspectionItems: [], repairItems: [] };
  services[1].defaults = { items: [], inspectionItems: [{ name: 'Inspection tool', category: 'equipment', quantity: 1, available: 3 }],
    repairItems: [{ name: 'Repair tool', category: 'equipment', quantity: 2, available: 1 }] };
  const catalog = [{ id: 'tool', name: 'Field <Kit>', category: 'equipment', unit: 'pcs', available: 2, code: 'KIT-1' },
    { id: 'supply', name: 'Tape', category: 'consumable', unit: 'roll', available: 0, code: '' }];
  async function boot() { const pending = window.rulesTest.load(); respond(0, { success: true, services, catalog }); await pending; }
  return { nodes, requests, window, events, api: window.rulesTest, fire, respond, boot };
}
test('the page and catalog safely render service names and exact catalog choices', async () => {
  const h = harness(); await h.boot();
  assert.equal(h.nodes.serviceName.textContent, 'Aircon Installation');
  assert.match(h.nodes.catalogResults.innerHTML, /Field &lt;Kit&gt;/); assert.match(h.nodes.catalogResults.innerHTML, /0 available/);
  assert.match(h.nodes.serviceList.innerHTML, /CoreService:core/); assert.match(h.nodes.serviceList.innerHTML, /RepairService:repair/);
});
test('defaults show automatically with quantities and shortages without making the rule dirty', async () => {
  const h = harness(); await h.boot();
  assert.match(h.nodes.defaultItems.innerHTML, /Field &lt;Kit&gt;/); assert.match(h.nodes.defaultItems.innerHTML, /1 pcs/);
  assert.match(h.nodes.defaultItems.innerHTML, /Missing from inventory/); assert.match(h.nodes.defaultCount.textContent, /2 items/);
  assert.equal(h.nodes.customEditor.hidden, true); assert.equal(h.api.state.dirty, false); assert.equal(h.requests.length, 1);
});
test('repair phase tabs show the default list even when no custom rule exists', async () => {
  const h = harness(); await h.boot(); h.api.select(h.api.state.services[1]);
  assert.equal(h.nodes.phaseTabs.hidden, false); assert.match(h.nodes.defaultItems.innerHTML, /Inspection tool/);
  h.fire('phaseTabs', 'click', { phase: 'repairItems' }); assert.match(h.nodes.defaultItems.innerHTML, /Repair tool/);
  assert.match(h.nodes.defaultItems.innerHTML, /kr-default-shortage/); assert.equal(h.api.state.dirty, false);
});
test('custom rule edits keep the default preview separate from the editable list', async () => {
  const h = harness(); await h.boot(); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change');
  h.fire('catalogResults', 'click', { add: 'supply' });
  assert.match(h.nodes.defaultItems.innerHTML, /Field &lt;Kit&gt;/); assert.equal(h.api.state.draft.items.length, 1);
  assert.equal(h.api.state.draft.items[0].toolId, 'supply'); assert.match(h.nodes.defaultHelp.textContent, /own kit list below/);
});
test('repair tabs keep separate lists and save both phases in one request', async () => {
  const h = harness(); await h.boot(); h.api.select(h.api.state.services[1]);
  h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change'); h.fire('catalogResults', 'click', { add: 'tool' });
  h.fire('phaseTabs', 'click', { phase: 'repairItems' }); h.fire('catalogResults', 'click', { add: 'supply' });
  const pending = h.fire('kitRuleForm', 'submit');
  const payload = JSON.parse(h.requests[1].options.body);
  assert.equal(payload.inspectionItems[0].toolId, 'tool'); assert.equal(payload.repairItems[0].toolId, 'supply');
  assert.equal(payload.inspectionItems[0].quantityBasis, 'per_visit'); assert.equal(payload.repairItems[0].quantityBasis, 'per_unit');
  assert.match(h.requests[1].url, /RepairService\/repair$/);
  h.respond(1, { success: true, rule: { ...payload, revision: 1, updatedAt: new Date().toISOString() } }); await pending;
  assert.equal(h.api.state.dirty, false); assert.equal(h.nodes.kitMessage.textContent, 'Kit rule saved.');
});
test('save validates both repair phases, including a phase not currently displayed', async () => {
  const h = harness(); await h.boot(); h.api.select(h.api.state.services[1]); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change');
  h.fire('catalogResults', 'click', { add: 'tool' }); h.fire('phaseTabs', 'click', { phase: 'repairItems' }); h.fire('catalogResults', 'click', { add: 'supply' });
  h.api.state.draft.inspectionItems[0].quantity = 1.5;
  await h.fire('kitRuleForm', 'submit'); assert.equal(h.requests.length, 1); assert.equal(h.api.state.phase, 'inspectionItems'); assert.match(h.nodes.kitMessage.textContent, /valid quantities/);
});
test('empty repair phases need individual confirmation; no request is sent prematurely', async () => {
  const h = harness(); await h.boot(); h.api.select(h.api.state.services[1]); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change');
  h.nodes.emptyConfirm.checked = true; h.fire('emptyConfirm', 'change');
  await h.fire('kitRuleForm', 'submit'); assert.equal(h.requests.length, 1); assert.equal(h.api.state.phase, 'repairItems'); assert.equal(h.nodes.emptyConfirm.checked, false);
});
test('stale update error preserves the draft and enables retry or reload', async () => {
  const h = harness(); await h.boot(); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change'); h.fire('catalogResults', 'click', { add: 'tool' });
  const pending = h.fire('kitRuleForm', 'submit'); h.respond(1, { error: 'Another staff member changed this rule. Reload the rules before saving again.' }, false); await pending;
  assert.equal(h.api.state.draft.items.length, 1); assert.equal(h.api.state.dirty, true); assert.equal(h.nodes.saveRule.disabled, false); assert.match(h.nodes.kitMessage.textContent, /Reload/);
});
test('unsaved changes prevent accidental switching and browser exit', async () => {
  const h = harness(); await h.boot(); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change');
  h.window.confirm = () => false; h.api.select(h.api.state.services[1]); assert.equal(h.api.state.selected.id, 'core');
  let prevented = false; h.events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});
test('a save in progress blocks editing and service switching until it returns', async () => {
  const h = harness(); await h.boot(); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change'); h.fire('catalogResults', 'click', { add: 'tool' });
  const pending = h.fire('kitRuleForm', 'submit'); h.api.select(h.api.state.services[1]); h.fire('catalogResults', 'click', { add: 'supply' });
  assert.equal(h.api.state.selected.id, 'core'); assert.equal(h.api.state.draft.items.length, 1); assert.equal(h.nodes.saveRule.disabled, true);
  h.respond(1, { success: true, rule: { ...h.api.state.draft, revision: 1 } }); await pending; assert.equal(h.api.state.dirty, false);
});
test('search filters core and repair services without changing their rules', async () => {
  const h = harness(); await h.boot(); h.nodes.serviceFilter.value = 'RepairService'; h.fire('serviceFilter', 'change');
  assert.match(h.nodes.serviceList.innerHTML, /Overheating/); assert.doesNotMatch(h.nodes.serviceList.innerHTML, /Aircon Installation/);
});
test('customer repair categories are included in the repair filter and have two editable visit lists', async () => {
  const h = harness(); await h.boot();
  const category = { ...h.api.state.services[1], id: 'category', serviceModel: 'ServiceCategory', name: 'Air Conditioner' };
  h.api.state.services.push(category); h.api.select(category);
  assert.equal(h.nodes.phaseTabs.hidden, false); assert.match(h.nodes.serviceKind.textContent, /Customer repair category/);
  h.nodes.serviceFilter.value = 'RepairService'; h.fire('serviceFilter', 'change'); assert.match(h.nodes.serviceList.innerHTML, /ServiceCategory:category/);
});
test('a non-JSON login or server response offers useful feedback and allows retry', async () => {
  const h = harness(); const pending = h.api.load(); h.requests[0].resolve({ ok: false, json: async () => { throw Error('HTML'); } }); await pending;
  assert.match(h.nodes.kitMessage.textContent, /sign in again/); assert.equal(h.nodes.reloadRules.disabled, false);
});
test('removing an item only edits the selected service draft and never calls inventory checkout', async () => {
  const h = harness(); await h.boot(); h.nodes.ruleMode.value = 'custom'; h.fire('ruleMode', 'change'); h.fire('catalogResults', 'click', { add: 'tool' });
  h.fire('kitItems', 'click', { remove: '0' }); assert.equal(h.api.state.draft.items.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.api.state.draft.emptyAllowed.items, false);
});
test('kit page renders, and admin routes and service pages expose the protected rule editor', () => {
  const file = path.join(__dirname, '../views/pages/admin/Services/KitRules.ejs'); const html = ejs.render(read('../views/pages/admin/Services/KitRules.ejs'), {}, { filename: file });
  assert.match(html, /Service Kit Rules/); assert.match(html, /service-kit-rules-admin.js/); assert.match(html, /aria-live/);
  const api = read('../routes/adminApi.js'); assert.match(api, /router\.patch\('\/service-kit-rules\/:serviceModel\/:serviceId', requirePermission\('services.manage'\)/);
  assert.match(read('../routes/pages.js'), /kit-rules', pageAuth.requireRole\('admin'\)/);
  for (const view of ['../views/pages/admin/Services/CoreServices.ejs', '../views/pages/admin/Services/RepairServices.ejs', '../views/pages/admin/Inventory/TechnicianTools.ejs', '../views/partials/admin-sidebar.ejs']) assert.match(read(view), /\/admin\/services\/kit-rules/);
});
