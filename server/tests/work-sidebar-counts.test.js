'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const workIds = ['appointmentsBadge', 'ordersBadge', 'repairSchedBadge', 'expensesBadge', 'projectsBadge', 'attentionBadge', 'escalatedBadge', 'warrantyBadge', 'maintenanceBadge'];

async function fixture(pathname = '/admin/appointments') {
  const html = await ejs.renderFile(path.join(__dirname, '../views/partials/admin-sidebar.ejs'), { currentPath: pathname });
  const elements = new Map();
  for (const match of html.matchAll(/<span[^>]*id="([^"]+)"[^>]*>/g)) elements.set(match[1], {
    textContent: '', dataset: {}, style: { display: 'none' }, title: '', removeAttribute(name) { delete this[name]; },
  });
  const summary = { counts: { pendingBookings: 20, activeJobs: 30, assignmentQueue: 1, pendingExpenses: 2,
    escalatedBookings: 0, pendingLeaveRequests: 55, auditToday: 99 }, orders: { actionable: 13 },
    projects: { pendingScheduling: 8 }, repairScheduling: { pendingScheduling: 0 },
    maintenance: { actionable: 0 }, returns: { overdue: 900 } };
  const replies = {
    '/api/admin/navigation-summary': summary,
    '/api/admin/warranties/stats': { activeWarranty: 1, warrantyClaims: 0 },
    '/api/admin/resolution-center?page=1&perPage=1': { summary: { bySource: { booking: 100, order: 4 } } },
  };
  const events = {}, timers = [], requests = [];
  let refresh;
  const context = {
    document: { hidden: false, getElementById: id => elements.get(id),
      querySelectorAll: selector => selector.includes('appointment-mgmt-collapse') ? workIds.map(id => elements.get(id)) : [elements.get('auditTodayBadge')],
      addEventListener: (name, fn) => { events[name] = fn; } },
    window: { location: { pathname }, addEventListener: (name, fn) => { events[name] = fn; },
      setInterval(fn) { refresh = fn; }, setTimeout(fn) { timers.push(fn); return timers.length; } },
    console: { warn() {} }, fetch: async url => {
      requests.push(url);
      const reply = replies[url];
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'Unexpected count endpoint: ' + url);
      return { ok: true, json: async () => reply };
    },
  };
  vm.runInNewContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n'), context);
  events.DOMContentLoaded();
  await tick();
  return { elements, events, replies, requests, html, refresh: () => refresh(), async extended() { await timers.shift()?.(); },
    total: () => Number(elements.get('pendingReviewCount').textContent) || 0,
    childTotal: () => workIds.reduce((sum, id) => sum + (Number(elements.get(id).textContent) || 0), 0) };
}

test('Work sums its children, including deferred warranty and Resolution Center counts', async () => {
  const f = await fixture();
  assert.equal(f.total(), 74);
  assert.equal(f.total(), f.childTotal());
  await f.extended();
  assert.equal(f.elements.get('appointmentsBadge').textContent, '51');
  assert.equal(f.elements.get('attentionBadge').textContent, '104');
  assert.equal(f.total(), 179);
  assert.equal(f.total(), f.childTotal());
  assert.match(f.elements.get('pendingReviewCount').title, /queues may overlap/);
  // Audit, leave, and inventory counts are outside the Work group.
  assert.equal(f.elements.get('systemGroupBadge').textContent, '99');
  assert.equal(f.elements.get('equipmentReturnsBadge').textContent, '900');
  f.events['resolution:counts']({ detail: { bySource: { booking: 2, order: 3 } } });
  assert.equal(f.total(), 80);
  assert.equal(f.total(), f.childTotal());
});

test('Resolution Center reuses its page summary and still updates the Work total', async () => {
  const f = await fixture('/admin/operations/resolution-center');
  await f.extended();
  assert.ok(!f.requests.some(url => url.includes('/resolution-center?')));
  assert.equal(f.total(), 75);
  f.events['resolution:counts']({ detail: { bySource: { booking: 100, order: 4 } } });
  assert.equal(f.total(), 179);
});

test('unavailable and recovered sources preserve a matching shown total and flag stale values', async () => {
  const f = await fixture();
  await f.extended();
  f.replies['/api/admin/navigation-summary'] = { counts: { pendingBookings: 20, activeJobs: 30, assignmentQueue: 1, pendingExpenses: 2, escalatedBookings: 0 },
    failedSources: ['orders'], staleSources: [] };
  await f.refresh();
  assert.equal(f.elements.get('ordersBadge').style.display, 'none');
  assert.equal(f.total(), 166);
  assert.equal(f.total(), f.childTotal());
  assert.match(f.elements.get('pendingReviewCount').title, /some counts temporarily unavailable/);
  f.replies['/api/admin/warranties/stats'] = new Error('Unavailable');
  await f.extended();
  assert.equal(f.elements.get('warrantyBadge').textContent, '1');
  assert.equal(f.elements.get('warrantyBadge').dataset.countStale, 'true');
  assert.equal(f.total(), f.childTotal());
  f.replies['/api/admin/navigation-summary'] = { counts: { pendingBookings: 20, activeJobs: 30, assignmentQueue: 1, pendingExpenses: 2, escalatedBookings: 0 }, orders: { actionable: 13 } };
  f.replies['/api/admin/warranties/stats'] = { activeWarranty: 1, warrantyClaims: 0 };
  await f.refresh(); await f.extended();
  assert.equal(f.total(), 179);
  assert.equal(f.elements.get('ordersBadge').dataset.countUnavailable, undefined);
  assert.equal(f.elements.get('warrantyBadge').dataset.countUnavailable, undefined);
  assert.doesNotMatch(f.elements.get('pendingReviewCount').title, /unavailable/);
});

test('zero badges are hidden and a network failure does not replace known counts with false zeros', async () => {
  const f = await fixture();
  await f.extended();
  f.replies['/api/admin/navigation-summary'] = new Error('Network unavailable');
  await f.refresh();
  assert.equal(f.total(), 179);
  assert.match(f.elements.get('pendingReviewCount').title, /Last known/);
  f.replies['/api/admin/navigation-summary'] = { counts: { pendingBookings: 0, activeJobs: 0, assignmentQueue: 0, pendingExpenses: 0, escalatedBookings: 0, auditToday: 0 },
    orders: { actionable: 0 }, projects: { pendingScheduling: 0 }, repairScheduling: { pendingScheduling: 0 }, maintenance: { actionable: 0 } };
  f.replies['/api/admin/warranties/stats'] = { activeWarranty: 0, warrantyClaims: 0 };
  f.replies['/api/admin/resolution-center?page=1&perPage=1'] = { summary: { bySource: { booking: 0, order: 0 } } };
  await f.refresh(); await f.extended();
  assert.equal(f.total(), 0);
  assert.equal(f.elements.get('pendingReviewCount').style.display, 'none');
  assert.equal(f.total(), f.childTotal());
});
