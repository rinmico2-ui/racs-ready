'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/technician-work-updates.js'), 'utf8');

function fixture() {
  const timers = new Map(), events = new Map(), listeners = new Map();
  let next = 0, calls = 0, dialog = false, refresh;
  const document = { readyState: 'complete', hidden: false, querySelector: () => dialog ? {} : null,
    addEventListener(name, fn) { listeners.set(name, fn); } };
  const window = { socket: { on(name, fn) { const handlers = events.get(name) || []; handlers.push(fn); events.set(name, handlers); }, off() {} },
    addEventListener(name, fn) { listeners.set(name, fn); }, setInterval() {},
    setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); },
    async _refreshTechnicianWork() { calls++; if (refresh) await refresh(); } };
  const context = { window, document, console };
  vm.runInNewContext(source, context);
  return { window, document, events, context, listeners,
    calls: () => calls, dialog(value) { dialog = value; }, refreshing(fn) { refresh = fn; },
    event(name) { for (const fn of events.get(name) || []) fn(); },
    async tick() { const ready = [...timers.values()]; timers.clear(); for (const fn of ready) await fn(); } };
}

test('status response and its socket events result in one refresh after the mutation completes', async () => {
  const f = fixture(), finish = f.window.TechnicianWorkUpdates.beginMutation();
  f.event('assignment:updated'); await f.tick();
  f.event('booking:updated'); f.event('booking:rescheduled'); await f.tick();
  assert.equal(f.calls(), 0);
  finish(); f.event('assignment:updated'); await f.tick();
  assert.equal(f.calls(), 1); await f.tick(); assert.equal(f.calls(), 1);
});

test('overlapping mutations wait for every request and completion callbacks are idempotent', async () => {
  const f = fixture(), first = f.window.TechnicianWorkUpdates.beginMutation(), second = f.window.TechnicianWorkUpdates.beginMutation();
  first(); first(); await f.tick(); assert.equal(f.calls(), 0);
  second(); second(); await f.tick(); assert.equal(f.calls(), 1);
  f.event('booking:updated'); await f.tick(); assert.equal(f.calls(), 2);
});

test('project phase, team and reconnect events coalesce with a local mobilization update', async () => {
  const f = fixture(), finish = f.window.TechnicianWorkUpdates.beginMutation();
  for (const name of ['project:phase', 'project:team-status', 'project:team_assigned', 'connect']) f.event(name);
  await f.tick(); assert.equal(f.calls(), 0);
  finish(); await f.tick(); assert.equal(f.calls(), 1);
});

test('finishing an update preserves an open action dialog and refreshes when it closes', async () => {
  const f = fixture(), finish = f.window.TechnicianWorkUpdates.beginMutation();
  f.dialog(true); finish(); await f.tick(); assert.equal(f.calls(), 0);
  f.dialog(false); await f.tick(); assert.equal(f.calls(), 1);
});

test('a rejected project action keeps its error visible while retaining unrelated live updates', async () => {
  const f = fixture();
  f.window.TechnicianWorkUpdates.beginMutation()(false);
  await f.tick(); assert.equal(f.calls(), 0);
  const finish = f.window.TechnicianWorkUpdates.beginMutation();
  f.event('project:team-status'); finish(false);
  await f.tick(); assert.equal(f.calls(), 1);
});

test('an external update arriving during the final refresh is retained for a follow-up', async () => {
  const f = fixture(); let release;
  f.refreshing(() => new Promise(resolve => { release = resolve; }));
  const finish = f.window.TechnicianWorkUpdates.beginMutation(); finish();
  const running = f.tick(); await Promise.resolve();
  assert.equal(f.calls(), 1); f.event('booking:updated'); await f.tick(); assert.equal(f.calls(), 1);
  f.refreshing(null); release(); await running;
  await f.tick(); assert.equal(f.calls(), 2);
});

test('loading the update script twice does not install duplicate refresh handlers', async () => {
  const f = fixture(), coordinator = f.window.TechnicianWorkUpdates;
  vm.runInNewContext(source, f.context);
  assert.equal(f.window.TechnicianWorkUpdates, coordinator);
  assert.equal(f.events.get('assignment:updated').length, 1);
  f.event('assignment:updated'); await f.tick(); assert.equal(f.calls(), 1);
});
