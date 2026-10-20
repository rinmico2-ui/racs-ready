'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const page = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AttentionQueue.ejs'), 'utf8').replace(/\r\n/g, '\n');
const helper = fs.readFileSync(path.join(__dirname, '../public/js/resolution-action-loading.js'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const nodes = new Map(), events = {};
  function node(tag = 'div') {
    const attrs = new Map();
    return { tag, innerHTML: '', textContent: '', disabled: false, inert: false, hidden: false,
      setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key) ?? null, removeAttribute: key => attrs.delete(key),
      matches: selector => tag === selector, closest: selector => selector === 'button' && tag === 'button' ? this : null,
      querySelector(selector) { return this.children ||= {}, this.children[selector] ||= node(); },
    };
  }
  const root = node(), modal = node(), cancel = node('button');
  nodes.set('resolutionWorkspace', root);
  const document = { activeElement: null, getElementById: id => nodes.get(id), querySelectorAll: () => [modal],
    createElement: node, body: { appendChild: element => nodes.set(element.id, element) }, addEventListener: (type, callback) => { events[type] = callback; } };
  const window = { Swal: { getCancelButton: () => cancel }, addEventListener: (type, callback) => { events[type] = callback; } };
  vm.runInNewContext(helper, { document, window, Map, Set, queueMicrotask });
  const button = () => { const btn = node('button'); btn.innerHTML = '<i>Save</i>'; btn.closest = selector => selector === 'button' ? btn : null; return btn; };
  return { api: window.ResolutionActionLoading, root, modal, cancel, events, nodes, button, document };
}
test('rapid repeated submissions execute only once and show a spinner until completion', async () => {
  const h = harness(), wait = deferred(), button = h.button(); let calls = 0;
  const save = h.api.wrap(async () => { calls++; await wait.promise; return 'saved'; }, { group: 'write', label: 'Saving...' });
  const first = save(button), second = save(button);
  assert.equal(calls, 1); assert.equal(await second, undefined); assert.equal(button.disabled, true); assert.match(button.innerHTML, /spinner-border/);
  assert.equal(h.root.inert, true); assert.equal(h.modal.inert, true); assert.equal(h.nodes.get('resolutionActionStatus').hidden, false);
  wait.resolve(); assert.equal(await first, 'saved'); assert.equal(button.disabled, false); assert.equal(button.innerHTML, '<i>Save</i>');
  assert.equal(h.root.inert, false); assert.equal(h.modal.inert, false); assert.equal(h.nodes.get('resolutionActionStatus').hidden, true);
});
test('another action cannot submit while a payment or cancellation write is pending', async () => {
  const h = harness(), wait = deferred(); let cancellations = 0;
  const payment = h.api.wrap(() => wait.promise, { group: 'write', label: 'Verifying...' });
  const cancel = h.api.wrap(() => { cancellations++; }, { group: 'write', label: 'Cancelling...' });
  const pending = payment(); await cancel(); assert.equal(cancellations, 0); wait.resolve(); await pending; await cancel(); assert.equal(cancellations, 1);
});
test('request failure clears the lock, restores the action, and permits a retry', async () => {
  const h = harness(), button = h.button(); let calls = 0;
  const action = h.api.wrap(async () => { calls++; if (calls === 1) throw Error('Network error'); return true; }, { group: 'write', label: 'Sending...' });
  await assert.rejects(action(button), /Network error/); assert.equal(h.api.isWriting(), false); assert.equal(h.root.inert, false); assert.equal(button.disabled, false);
  assert.equal(await action(button), true); assert.equal(calls, 2);
});
test('eligibility recalculated after a failed schedule save stays disabled when its selected slot was cleared', async () => {
  const h = harness(), button = h.button();
  const action = h.api.wrap(() => {}, { group: 'write', label: 'Saving...', after: () => { button.disabled = true; } });
  await action(button); assert.equal(button.disabled, true); assert.equal(button.innerHTML, '<i>Save</i>');
});
test('a handler that changes its label and eligibility keeps those changes after cleanup', async () => {
  const h = harness(), button = h.button();
  const action = h.api.wrap(() => { button.innerHTML = 'Already reviewed'; button.disabled = true; }, { group: 'write', label: 'Verifying...' });
  await action(button); assert.equal(button.innerHTML, 'Already reviewed'); assert.equal(button.disabled, true);
});
test('nested detail loads do not unlock the page while the payment summary is still loading', async () => {
  const h = harness(), wait = deferred(), button = h.button();
  const detail = h.api.wrap(async () => {}, { group: 'detail', label: 'Loading booking...' });
  const review = h.api.wrap(async () => { await detail(button); await wait.promise; }, { group: 'payment-review', label: 'Loading payment...' });
  const pending = review(button); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.inert, true); assert.equal(button.disabled, true); assert.match(button.innerHTML, /Loading payment/);
  wait.resolve(); await pending; assert.equal(h.root.inert, false); assert.equal(button.innerHTML, '<i>Save</i>');
});
test('queue refresh can run within a successful write without releasing its lock early', async () => {
  const h = harness(), wait = deferred(); let refreshed = 0;
  const refresh = h.api.wrap(async () => { refreshed++; await wait.promise; }, { group: 'queue', label: 'Refreshing...', inert: false, progress: false, allowWrite: true });
  const save = h.api.wrap(async () => { await refresh(); }, { group: 'write', label: 'Saving...' });
  const pending = save(); assert.equal(refreshed, 1); assert.equal(h.api.isWriting(), true);
  wait.resolve(); await pending; assert.equal(h.api.isWriting(), false);
});
test('overlapping queue reads keep their loading button disabled until the last one finishes', async () => {
  const h = harness(), first = deferred(), second = deferred(), button = h.button(); let calls = 0;
  const refresh = h.api.wrap(() => (++calls === 1 ? first.promise : second.promise), { group: 'queue', label: 'Refreshing...', progress: false, inert: false, allowWrite: true });
  const a = refresh(button), b = refresh(button); first.resolve(); await a; assert.equal(button.disabled, true);
  second.resolve(); await b; assert.equal(button.disabled, false); assert.equal(button.innerHTML, '<i>Save</i>');
});
test('preserved button contents keep live badge nodes and updated counts after queue loading', async () => {
  const h = harness(), wait = deferred(), button = h.button();
  button.innerHTML = '<i>Bookings</i><span id="rcBookingCount">0</span>';
  button.setAttribute('data-resolution-loading', 'previous');
  const refresh = h.api.wrap(async () => { await wait.promise; button.innerHTML = '<i>Bookings</i><span id="rcBookingCount">5</span>'; },
    { group:'queue', label:'Refreshing...', inert:false, progress:false, preserveButtonContent:true });
  const pending = refresh(button);
  assert.match(button.innerHTML, /rcBookingCount/);
  assert.equal(button.getAttribute('data-resolution-loading'), 'preserve');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  wait.resolve(); await pending;
  assert.match(button.innerHTML, />5<\/span>/);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('data-resolution-loading'), 'previous');
  assert.equal(button.getAttribute('aria-busy'), null);
});
test('preserved tabs stay locked through overlapping requests and recover from a failed request', async () => {
  const h = harness(), first = deferred(), second = deferred(), button = h.button(); let calls = 0;
  const refresh = h.api.wrap(() => (++calls === 1 ? first.promise : second.promise),
    { group:'queue', label:'Refreshing...', progress:false, inert:false, preserveButtonContent:true });
  const a = refresh(button), b = refresh(button);
  first.resolve(); await a;
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('data-resolution-loading'), 'preserve');
  const failure = assert.rejects(b, /Network unavailable/);
  second.reject(new Error('Network unavailable')); await failure;
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, '<i>Save</i>');
  assert.equal(button.getAttribute('data-resolution-loading'), null);
});
test('actual queue refresh from All, Bookings or Orders retains its count and renders the returned cases', async t => {
  const start = page.indexOf('  async function loadQueue()');
  const implementation = page.slice(start, page.indexOf('\n  function renderNoShowCard', start));
  const binding = page.match(/^  loadQueue = actionLoading\.wrap\(loadQueue,.*$/m)[0];
  for (const [source, badgeId, count] of [['', 'rcAllCount', 9], ['booking', 'rcBookingCount', 5], ['order', 'rcOrderCount', 4]]) {
    await t.test(source || 'all', async () => {
      const h = harness(), pendingResponse = deferred(), button = h.button(), badge = h.document.createElement();
      let html = `<span id="${badgeId}">0</span>`;
      // Model what innerHTML replacement does in the browser: removes the
      // descendant from getElementById until the old markup is recreated.
      Object.defineProperty(button, 'innerHTML', { get: () => html, set(value) {
        html = value;
        if (value.includes(`id="${badgeId}"`)) { badge.textContent = '0'; h.nodes.set(badgeId, badge); }
        else h.nodes.delete(badgeId);
      } });
      for (const id of ['resolutionResultsMeta','resolutionTotal','resolutionPastDue','resolutionPriority','resolutionBookings',
        'resolutionOrders','rcAllCount','rcBookingCount','rcOrderCount','attentionList']) h.nodes.set(id, h.document.createElement());
      h.nodes.set(badgeId, badge);
      const rendered = [], errors = [], events = [];
      const cases = [{ id:'booking-1', sourceType:'booking' }];
      const context = vm.createContext({ document:h.document, window:{ dispatchEvent:e=>events.push(e) },
        CustomEvent:class { constructor(type, options) { this.type=type; this.detail=options.detail; } }, URLSearchParams,
        queueRequest:0, currentPage:1, currentFocus:'', currentSource:source, currentBookingType:'',
        currentFilter:'', currentSeverity:'', currentSearch:'', allResolutionCases:[], RESOLUTION_API_BASE:'/api/admin',
        fetch:()=>pendingResponse.promise, actionLoading:h.api, console:{ error:e=>errors.push(e) },
        renderQueue:rows=>rendered.push(rows), renderResolutionPagination() {}, focusRequestedResolutionCase() {}, syncResolutionUrl() {},
        escapeHtml:value=>String(value),
      });
      vm.runInContext(implementation + '\n' + binding, context);
      const loading = context.loadQueue(button);
      assert.equal(h.document.getElementById(badgeId), badge);
      pendingResponse.resolve({ ok:true, json:async()=>({ cases, summary:{ total:9, pastDue:2, bySource:{booking:5,order:4}, bySeverity:{critical:1,high:2} }, pagination:{page:1,pages:1,total:1,perPage:25} }) });
      await loading;
      assert.equal(errors.length, 0);
      assert.equal(rendered.length, 1);
      assert.equal(rendered[0], cases);
      assert.equal(h.document.getElementById(badgeId), badge);
      assert.equal(Number(badge.textContent), count);
      assert.match(h.nodes.get('resolutionResultsMeta').textContent, /Showing 1.*1 of 1/);
      assert.equal(button.disabled, false);
      assert.equal(button.getAttribute('data-resolution-loading'), null);
      assert.equal(events[0].type, 'resolution:counts');
    });
  }
});
test('order dialog submission locks cancel and rejects a second request, then permits retry', () => {
  const h = harness(); const done = h.api.beginNetwork('Saving order...'); assert.equal(h.cancel.disabled, true);
  assert.equal(h.api.beginNetwork('Duplicate'), null); assert.equal(h.api.isWriting(), true);
  done(); done(); assert.equal(h.api.isWriting(), false); assert.equal(h.cancel.disabled, false);
  const retry = h.api.beginNetwork('Retrying...'); assert.ok(retry); retry();
});
test('an order popup does not start its payment or schedule request during another pending write', async () => {
  const h = harness(), wait = deferred(); const save = h.api.wrap(() => wait.promise, { group: 'write', label: 'Saving...' });
  const pending = save(); assert.equal(h.api.beginNetwork('Order write'), null); wait.resolve(); await pending;
  const done = h.api.beginNetwork('Order write'); assert.ok(done); done();
});
test('order opening feedback stops when the form is ready but the dialog guard stays active', async () => {
  const h = harness(), wait = deferred(); let calls = 0;
  const open = h.api.wrap(() => { calls++; return wait.promise; }, { group: 'order-dialog', label: 'Loading available dates...' });
  const pending = open(); assert.equal(h.nodes.get('resolutionActionStatus').hidden, false);
  h.api.dialogReady(); assert.equal(h.nodes.get('resolutionActionStatus').hidden, true); assert.equal(h.root.inert, true);
  await open(); assert.equal(calls, 1); wait.resolve(); await pending; assert.equal(h.root.inert, false);
});
test('pending writes block escape, accidental modal clicks and navigation; cleanup restores them', async () => {
  const h = harness(), wait = deferred(); const save = h.api.wrap(() => wait.promise, { group: 'write', label: 'Saving...' }); const pending = save();
  for (const type of ['keydown', 'click', 'beforeunload']) {
    let prevented = false; const event = { key: 'Escape', target: { closest: () => h.modal }, preventDefault() { prevented = true; }, stopImmediatePropagation() {} };
    h.events[type](event); assert.equal(prevented, true, type);
  }
  wait.resolve(); await pending;
  let prevented = false; h.events.keydown({ key: 'Escape', preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});
test('initially disabled buttons and an existing inert region remain restricted after cleanup', async () => {
  const h = harness(), button = h.button(); button.disabled = true; h.root.inert = true; h.root.setAttribute('aria-busy', 'true');
  await h.api.wrap(() => {}, { group: 'write', label: 'Saving...' })(button);
  assert.equal(button.disabled, true); assert.equal(h.root.inert, true); assert.equal(h.root.getAttribute('aria-busy'), 'true');
});
test('the actual close-case action cannot post twice and waits for its queue refresh', async () => {
  const h = harness(), response = deferred(), refresh = deferred(), requests = [], notices = [];
  const start = page.indexOf('  async function closeCase('), end = page.indexOf('\n  }', start) + 4;
  const context = { prompt: () => 'Reviewed', confirm: () => true, RESOLUTION_WORKSPACE_ROLE: 'admin', RESOLUTION_API_BASE: '/api/admin',
    fetch: (...args) => { requests.push(args); return response.promise; }, loadQueue: () => refresh.promise,
    findResolutionCase: () => ({ paymentReview:{required:false} }), window: {}, alert: message => notices.push(message) };
  vm.runInNewContext(page.slice(start, end), context);
  const close = h.api.wrap(context.closeCase, { group: 'write', label: 'Closing case...' });
  const pending = close('booking', 'past_date'); await close('booking', 'past_date'); assert.equal(requests.length, 1);
  response.resolve({ ok: true, json: async () => ({ success: true }) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.isWriting(), true); refresh.resolve(); await pending; assert.equal(h.api.isWriting(), false); assert.equal(notices.length, 0);
});
test('the booking schedule-link action works without a browser-global event and refreshes after sending', async () => {
  let requests = 0, refreshes = 0;
  const start = page.indexOf('  async function sendCustomerRescheduleLink('), end = page.indexOf('\n  }', start) + 4;
  const context = { fetch: async () => { requests++; return { ok: true, json: async () => ({ success: true }) }; }, showToast() {}, loadQueue: async () => { refreshes++; } };
  vm.runInNewContext(page.slice(start, end), context); await context.sendCustomerRescheduleLink('booking', 'RACS-1');
  assert.equal(requests, 1); assert.equal(refreshes, 1);
});
test('Resolution Center wires all writes through the guard and its rendered scripts parse', () => {
  for (const name of ['confirmNoShow', 'closeCase', 'reassignCase', 'approveReschedule', 'rejectReschedule', 'sendCustomerRescheduleLink', 'sendOrderRescheduleLink', 'submitCancellation', 'confirmPendingPaymentVerification', 'confirmResolutionPaymentReview', 'rschSubmitProposal']) {
    assert.match(page, new RegExp(`${name} = actionLoading\\.wrap\\(${name}, \\{ group:'write'`));
  }
  assert.equal((page.match(/beginNetwork\('/g) || []).length, 3);
  assert.doesNotMatch(page, /const btn = event\.target/);
  const html = ejs.render(page, {}, { filename: path.join(__dirname, '../views/pages/admin/Appointments/AttentionQueue.ejs') });
  assert.match(html, /resolution-action-loading.js/); assert.match(html, /id="resolutionWorkspace"/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (script[1].trim()) new vm.Script(script[1]);
});
