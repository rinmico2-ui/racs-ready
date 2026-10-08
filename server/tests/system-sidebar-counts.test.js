'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const sidebar = path.join(__dirname, '../views/partials/admin-sidebar.ejs');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const html = await ejs.renderFile(sidebar, { currentPath: '/admin/settings/system', user: { role: 'admin' } });
  const elements = new Map();
  for (const match of html.matchAll(/<span[^>]*id="([^"]+)"[^>]*>/g)) elements.set(match[1], {
    dataset: {}, style: { display: 'none' }, textContent: '', title: '', removeAttribute(name) { delete this[name]; },
  });
  const children = [elements.get('auditTodayBadge')];
  const handlers = {};
  let summary = { counts: { pendingBookings: 99, assignmentQueue: 3, activeJobs: 2, auditToday: 7 } }, fail = false, refresh;
  const context = {
    document: { hidden: false, getElementById: id => elements.get(id),
      querySelectorAll: selector => {
        if (selector === '#appointment-mgmt-collapse a.nav-link .nav-badge') return ['appointmentsBadge', 'ordersBadge', 'repairSchedBadge', 'expensesBadge', 'projectsBadge', 'attentionBadge', 'escalatedBadge', 'warrantyBadge', 'maintenanceBadge'].map(id => elements.get(id));
        assert.equal(selector, '#settings-collapse a.nav-link .nav-badge'); return children;
      },
      addEventListener: (name, handler) => { handlers[name] = handler; } },
    window: { location: { pathname: '/admin/settings/system' }, addEventListener() {},
      setInterval(fn) { refresh = fn; }, setTimeout() { return 1; } },
    console: { warn() {} },
    fetch: async url => { assert.equal(url, '/api/admin/navigation-summary'); if (fail) throw new Error('Network unavailable'); return { ok: true, json: async () => summary }; },
  };
  vm.runInNewContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n'), context);
  handlers.DOMContentLoaded();
  await tick();
  return { html, elements, children, async update(data, networkFailure = false) { summary = data; fail = networkFailure; await refresh(); }, handlers };
}

test('Audit Trail owns the audit count and System sums only its child badges', async () => {
  const f = await fixture();
  assert.match(f.html, /href="\/admin\/audit-trail"[^]*?id="auditTodayBadge"/);
  assert.match(f.html, /<button[^]*?System<\/span><span[^>]*id="systemGroupBadge"/);
  assert.equal((f.html.match(/id="auditTodayBadge"/g) || []).length, 1);
  assert.equal(f.elements.get('auditTodayBadge').textContent, '7');
  assert.equal(f.elements.get('systemGroupBadge').textContent, '7');
  assert.equal(f.elements.get('systemGroupBadge').style.display, 'inline-flex');
  assert.match(f.elements.get('auditTodayBadge').title, /Audit events today \(Philippine time\)/);
  // A second child count is included once; operational badges outside System
  // and the number of configuration pages never affect the parent total.
  f.children.push({ dataset: { count: '4' } });
  await f.update({ counts: { auditToday: 3, pendingBookings: 500 } });
  assert.equal(f.elements.get('systemGroupBadge').textContent, '7');
  f.children.pop();
  await f.update({ counts: { auditToday: 0 } });
  assert.equal(f.elements.get('auditTodayBadge').style.display, 'none');
  assert.equal(f.elements.get('systemGroupBadge').style.display, 'none');
});

test('failed and recovered counts keep System aligned with its child and restore useful labels', async () => {
  const f = await fixture();
  await f.update({ counts: { auditToday: 7 }, failedSources: ['auditToday'], staleSources: ['auditToday'] });
  assert.equal(f.elements.get('systemGroupBadge').textContent, '7');
  assert.match(f.elements.get('systemGroupBadge').title, /Last known/);
  await f.update({ counts: {}, failedSources: ['auditToday'], staleSources: [] });
  assert.equal(f.elements.get('auditTodayBadge').style.display, 'none');
  assert.equal(f.elements.get('systemGroupBadge').style.display, 'none');
  assert.match(f.elements.get('systemGroupBadge').title, /unavailable/);
  await f.update({ counts: { auditToday: 2 } });
  assert.equal(f.elements.get('systemGroupBadge').textContent, '2');
  assert.match(f.elements.get('auditTodayBadge').title, /Philippine time/);
  assert.equal(f.elements.get('auditTodayBadge').dataset.countUnavailable, undefined);
  await f.update(null, true);
  assert.equal(f.elements.get('systemGroupBadge').textContent, '2');
  assert.match(f.elements.get('auditTodayBadge').title, /Last known audit count/);
});

test('all Configuration and Governance routes open the System group', async () => {
  for (const route of ['settings/system', 'settings/fare', 'settings/scheduling', 'settings/aftercare', 'settings/email', 'settings/company-location', 'roles', 'archive', 'audit-trail']) {
    const html = await ejs.renderFile(sidebar, { currentPath: '/admin/' + route });
    assert.match(html, /class="collapse show" id="settings-collapse"/);
    assert.match(html, /id="systemGroupBadge"/);
  }
});

test('audit activity uses the Philippine day and never reuses yesterday’s count after midnight', async t => {
  const Booking = require('../models/BookingService');
  t.mock.method(Booking, 'aggregate', async () => []);
  for (const model of ['Expense', 'LeaveRequest', 'Order', 'Project', 'EquipmentAssignment']) t.mock.method(require('../models/' + model), 'countDocuments', async () => 0);
  t.mock.method(require('../utils/maintenanceSummary'), 'maintenanceSummary', async () => ({ actionable: 0 }));
  let fail = false;
  t.mock.method(require('../models/ActivityLog'), 'countDocuments', async filter => {
    if (fail) throw new Error('Audit temporarily unavailable');
    const dates = ['2026-10-08T15:59:59.999Z', '2026-10-08T16:00:00Z', '2026-10-08T16:10:00Z', '2026-10-08T17:00:00Z'].map(value => new Date(value));
    return dates.filter(value => value >= filter.createdAt.$gte && value <= filter.createdAt.$lte).length;
  });
  const { buildAdminNavigationSummary } = require('../utils/adminNavigationSummary');
  const beforeMidnight = await buildAdminNavigationSummary(new Date('2026-10-08T15:59:59.999Z'));
  assert.equal(beforeMidnight.counts.auditToday, 1);
  fail = true;
  const nextDay = await buildAdminNavigationSummary(new Date('2026-10-08T16:30:00Z'));
  assert.equal(nextDay.counts.auditToday, undefined);
  assert.ok(nextDay.failedSources.includes('auditToday'));
  assert.ok(!nextDay.staleSources.includes('auditToday'));
  fail = false;
  const recovered = await buildAdminNavigationSummary(new Date('2026-10-08T16:30:00Z'));
  assert.equal(recovered.counts.auditToday, 2);
});
