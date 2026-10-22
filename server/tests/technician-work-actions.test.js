'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/js/technician-work-actions.js'), 'utf8');
function fixture() {
  const buttons = [{ disabled: false, isConnected: true }, { disabled: true, isConnected: true }];
  const nodes = new Map(), attributes = new Map(), events = [], listeners = {};
  let observe, release, calls = 0;
  const document = { body: {}, querySelectorAll: () => buttons,
    getElementById: id => id === 'detailPanelActions' ? bar : nodes.get(id),
    createElement: () => ({ setAttribute() {}, remove() { nodes.delete(this.id); } }),
    addEventListener(name, listener) { listeners[name] = listener; } };
  const bar = { setAttribute(key, value) { attributes.set(key, value); }, removeAttribute(key) { attributes.delete(key); }, append(node) { nodes.set(node.id, node); } };
  const window = { async transitionStatus() { calls++; events.push('status started'); await new Promise(resolve => { release = resolve; }); events.push('status saved'); },
    async completeAllCoreWork() { calls++; }, async doStatus() { calls++; } };
  const context = { window, document, MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() { events.push('observer disconnected'); } } };
  vm.runInNewContext(source, context);
  return { window, context, buttons, nodes, attributes, events, get calls() { return calls; },
    release() { release(); }, render(button) { buttons.push(button); observe(); },
    click() { const event = { target: { closest: () => buttons[0] }, preventDefault() { events.push('click prevented'); }, stopImmediatePropagation() { events.push('propagation stopped'); } }; listeners.click(event); } };
}

test('one status save locks all conflicting controls until the action and refresh settle', async () => {
  const f = fixture(), running = f.window.transitionStatus('assignment', 'on_site');
  assert.equal(f.window.TechnicianWorkActions.busy, true); assert.equal(f.buttons[0].disabled, true);
  assert.equal(f.attributes.get('aria-busy'), 'true'); assert.match(f.nodes.get('technicianWorkSaving').textContent, /Updating/);
  assert.equal(await f.window.completeAllCoreWork('booking'), false); assert.equal(f.calls, 1);
  f.click(); assert.ok(f.events.includes('click prevented'));
  f.release(); await running;
  assert.equal(f.window.TechnicianWorkActions.busy, false); assert.equal(f.buttons[0].disabled, false);
  assert.equal(f.buttons[1].disabled, true, 'A control disabled by the workflow stays disabled');
  assert.equal(f.nodes.size, 0); assert.equal(f.attributes.has('aria-busy'), false);
  await f.window.completeAllCoreWork('booking'); assert.equal(f.calls, 2);
});

test('controls rendered by the status refresh are locked too and become available after the save', async () => {
  const f = fixture(), running = f.window.transitionStatus('assignment', 'on_site');
  const next = { disabled: false, isConnected: true }; f.render(next);
  assert.equal(next.disabled, true); f.release(); await running; assert.equal(next.disabled, false);
});

test('a failed or cancelled action releases its controls and allows a deliberate retry', async () => {
  const f = fixture();
  await assert.rejects(f.window.TechnicianWorkActions.run(async () => { throw Error('Save failed'); }), /Save failed/);
  assert.equal(f.window.TechnicianWorkActions.busy, false); assert.equal(f.buttons[0].disabled, false);
  assert.equal(await f.window.TechnicianWorkActions.run(async () => false), false);
  await f.window.doStatus('order', 'arrived'); assert.equal(f.calls, 1);
});

test('loading the action guard twice does not wrap handlers twice or duplicate observers', async () => {
  const f = fixture(), original = f.window.transitionStatus;
  vm.runInNewContext(source, f.context); assert.equal(f.window.transitionStatus, original);
  const running = f.window.transitionStatus('assignment', 'on_site'); f.release(); await running; assert.equal(f.calls, 1);
});
