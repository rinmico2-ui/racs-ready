'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const page = fs.readFileSync(path.join(__dirname, '../views/pages/admin/Appointments/AttentionQueue.ejs'), 'utf8').replace(/\r\n/g, '\n');
const implementation = ['focusRequestedResolutionCase', 'openFocusedResolutionCase', 'clearResolutionFocus'].map(name => {
  const start = page.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name); return page.slice(start, page.indexOf('\n  }', start) + 4);
}).join('\n');

function setup(source = 'booking', overrides = {}) {
  const trace = [], timers = new Map(), cards = [];
  let ready, nextTimer = 0;
  const pageReady = new Promise(resolve => { ready = resolve; });
  const target = { sourceType: source, id: 'selected-id', issueType: 'past_date', reference: 'SAME-REFERENCE',
    allowedActions: ['view', 'reschedule'], ...overrides };
  const items = [{ ...target, id: 'other-id' }, { ...target, sourceType: source === 'booking' ? 'order' : 'booking' }, target];
  for (const item of items) cards.push({ dataset: { source: item.sourceType, recordId: item.id }, isConnected: true,
    classList: { add(name) { this[name] = true; } }, setAttribute(key, value) { this[key] = value; }, scrollIntoView() {} });
  const context = vm.createContext({ allResolutionCases: items, requestedFocusHandled: false, requestedFocus: `${source}:selected-id`,
    currentFocus: `${source}:selected-id`, resolvedFocus: `${source}:selected-id`, requestedOpenAction: 'resolve', resolutionFocusTimer: null,
    resolutionPageReady: pageReady,
    document: { querySelectorAll: () => cards, querySelector: () => context.activeModal ? {} : null,
      getElementById: () => ({ classList: { add() {} } }) },
    window: { requestAnimationFrame: fn => fn(), setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: key => timers.delete(key) },
    findResolutionCase: (type, id) => context.allResolutionCases.find(item => item.sourceType === type && item.id === id),
    ...Object.fromEntries(['openCustomerCancellationCase', 'openResolutionPaymentReview', 'openVisitRecoveryCase', 'openOrderResolutionForCase', 'viewOrderDetail', 'viewDetail', 'openResolveMenuForCase', 'openReschedule']
      .map(name => [name, (...args) => { trace.push({ name, args }); }])) });
  vm.runInContext(implementation, context);
  return { context, target, trace, cards, ready, async flush() { await Promise.resolve(); for (const fn of timers.values()) fn(); timers.clear(); await Promise.resolve(); } };
}

test('Resolve waits for page dependencies and opens the selected booking or order rather than the first row or matching reference', async () => {
  for (const source of ['booking', 'order']) {
    const f = setup(source); f.context.focusRequestedResolutionCase(); await f.flush();
    assert.equal(f.trace.length, 0);
    assert.equal(f.cards[0]['aria-current'], undefined); assert.equal(f.cards[2]['aria-current'], 'true');
    f.ready(); await f.flush();
    assert.equal(f.trace.length, 1);
    assert.equal(f.trace[0].name, source === 'booking' ? 'openResolveMenuForCase' : 'openOrderResolutionForCase');
    assert.equal(f.trace[0].args[0], 'selected-id');
    f.context.focusRequestedResolutionCase(); await f.flush(); assert.equal(f.trace.length, 1);
  }
});

test('the selected record opens payment review before recovery, including changed state loaded while navigation was waiting', async () => {
  for (const source of ['booking', 'order']) {
    const f = setup(source, { recoveryAvailable: true, allowedActions: ['view', 'recover', 'reschedule'] });
    f.context.focusRequestedResolutionCase();
    f.target.paymentReview = { required: true, kind: 'cash' };
    f.ready(); await f.flush();
    assert.deepEqual(f.trace[0], { name: 'openResolutionPaymentReview', args: [source, 'selected-id'] });
  }
});

test('customer cancellation opens its own request first, including when a submitted payment needs verification', async () => {
  const f = setup('booking', { allowedActions: ['view', 'review_cancellation'], paymentReview: { required: true }, issueType: 'customer_cancellation' });
  f.context.focusRequestedResolutionCase(); f.ready(); await f.flush();
  assert.deepEqual(f.trace[0], { name: 'openCustomerCancellationCase', args: ['selected-id'] });
});

test('a linked booking follows its owning order and preserves that exact order identity', async () => {
  const f = setup('order'); f.context.requestedFocus = f.context.currentFocus = 'booking:installation-id';
  f.context.focusRequestedResolutionCase(); f.ready(); await f.flush();
  assert.equal(f.trace[0].name, 'openOrderResolutionForCase'); assert.equal(f.trace[0].args[0], 'selected-id');
});

test('clearing focus, changing the selected record, or opening a dialog cancels a queued automatic handoff', async () => {
  for (const change of [f => f.context.clearResolutionFocus(), f => { f.context.resolvedFocus = 'order:another-id'; }, f => { f.context.activeModal = true; }]) {
    const f = setup(); f.context.focusRequestedResolutionCase(); change(f); f.ready(); await f.flush();
    assert.equal(f.trace.length, 0);
  }
});

test('missing cases do not open another record, and closed or view-only cases open their own details', async () => {
  const missing = setup(); missing.context.currentFocus = missing.context.resolvedFocus = 'booking:missing-id';
  missing.context.focusRequestedResolutionCase(); missing.ready(); await missing.flush(); assert.equal(missing.trace.length, 0);
  for (const source of ['booking', 'order']) {
    const f = setup(source, { status: 'cancelled', allowedActions: ['view', 'close'] });
    f.context.focusRequestedResolutionCase(); f.ready(); await f.flush();
    assert.equal(f.trace[0].name, source === 'booking' ? 'viewDetail' : 'viewOrderDetail');
    assert.equal(f.trace[0].args[0], 'selected-id');
  }
});
