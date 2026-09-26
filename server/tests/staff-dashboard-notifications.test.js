const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const read = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

class Element {
  constructor() {
    this.children = []; this.textContent = ''; this.style = {}; this.events = {}; this.attributes = {};
    this.classList = { toggle() {} };
  }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  click() { return this.events.click?.({ preventDefault() {} }); }
}

function browser() {
  const ids = ['notificationsBody', 'dashboardNotificationCount', 'dashboardNotificationRefresh', 'dashboardNotificationViewAll', 'notifBadge', 'viewAllNotifBtn'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const events = {};
  let data = { unreadCount: 30, notifications: Array.from({ length: 15 }, (_, i) => ({
    _id: 'notice-' + i, title: '<img src=x onerror=alert(1)>', message: 'Check booking ' + i,
    read: false, link: '/admin/appointments', createdAt: '2026-09-26T04:00:00Z',
  })) };
  let failed = false, reads = 0, openedAll = false, countReloads = 0;
  const window = {
    location: { origin: 'http://localhost:5000', href: 'http://localhost:5000/secretary' },
    _notifRoleSafeLink: link => link.replace('/admin/appointments', '/secretary/appointments'),
    _notifLoadUnreadCount: () => countReloads++,
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  elements.viewAllNotifBtn.events.click = () => { openedAll = true; };
  const document = {
    hidden: false,
    getElementById: id => elements[id],
    createElement: () => new Element(),
    addEventListener() {},
  };
  vm.runInNewContext(read('../public/js/dashboard-notifications.js'), {
    window, document, URL, AbortController, setTimeout, clearTimeout, setInterval() {},
    async fetch(url, options) {
      if (options.method === 'PUT') { reads++; return { ok: true }; }
      assert.equal(url, '/api/notifications?limit=15');
      return { ok: !failed, async json() { return data; } };
    },
  });
  return {
    elements, events, window,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    fail: () => { failed = true; },
    data: value => { data = value; failed = false; },
    reads: () => reads,
    openedAll: () => openedAll,
    countReloads: () => countReloads,
  };
}

test('secretary dashboard loads the bell inbox and renders safe, role-scoped recent notifications', async () => {
  const feed = browser();
  await feed.settle();
  const el = feed.elements;
  assert.equal(el.dashboardNotificationCount.textContent, '30 unread');
  assert.equal(el.notifBadge.textContent, '30');
  assert.equal(el.notificationsBody.children.length, 6);
  const first = el.notificationsBody.children[1];
  assert.equal(first.href, '/secretary/appointments');
  assert.equal(first.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(el.notificationsBody.attributes['aria-busy'], 'false');
  await first.click();
  assert.equal(feed.reads(), 1);
  assert.equal(feed.countReloads(), 1);
  assert.equal(el.dashboardNotificationCount.textContent, '29 unread');
  assert.equal(feed.window.location.href, '/secretary/appointments');
  el.dashboardNotificationViewAll.click();
  assert.equal(feed.openedAll(), true);
});

test('navbar updates and new notifications keep the dashboard in sync', async () => {
  const feed = browser(); await feed.settle();
  feed.events['notifications:loaded']({ detail: { unreadCount: 0, notifications: [] } });
  assert.equal(feed.elements.dashboardNotificationCount.textContent, '0 unread');
  assert.equal(feed.elements.notificationsBody.children[0].textContent, 'You have no notifications yet.');
  await feed.events['notification:new']();
  assert.equal(feed.elements.dashboardNotificationCount.textContent, '30 unread');
});

test('refresh failure preserves existing notifications and offers retry guidance', async () => {
  const feed = browser(); await feed.settle(); feed.fail();
  await feed.elements.dashboardNotificationRefresh.click();
  assert.equal(feed.elements.notificationsBody.children.length, 6);
  assert.match(feed.elements.dashboardNotificationCount.textContent, /Could not refresh/);
  assert.equal(feed.elements.dashboardNotificationRefresh.disabled, false);
  feed.data({ unreadCount: 0, notifications: [] });
  await feed.elements.dashboardNotificationRefresh.click();
  assert.equal(feed.elements.dashboardNotificationCount.textContent, '0 unread');
});

test('analytics cannot overwrite the notification card with its unrelated alert list', () => {
  const analytics = read('../public/js/admin-dashboard.js');
  const page = read('../views/pages/admin/admin-dashboard.ejs');
  assert.doesNotMatch(analytics, /notificationsBody|_dashData\.notifications|d\.notifications/);
  assert.match(page, /dashboard-notifications\.js/);
  assert.doesNotMatch(page, /data-card-type="notifications"/);
  assert.doesNotThrow(() => ejs.compile(page));
  assert.doesNotThrow(() => new vm.Script(analytics));
});

test('shared navbar supports existing secretary links as well as legacy admin destinations', () => {
  const source = read('../views/partials/admin-navbar.ejs');
  const start = source.indexOf('function roleSafeNotificationLink(link)');
  const end = source.indexOf('window._notifRoleSafeLink = roleSafeNotificationLink;', start);
  const window = { USER_ROLE: 'secretary' };
  vm.runInNewContext(source.slice(start, end) + 'window.map = roleSafeNotificationLink;', { window });
  assert.equal(window.map('/secretary/appointments?tab=pending'), '/secretary/appointments?tab=pending');
  assert.equal(window.map('/admin/appointments/pending'), '/secretary/appointments?tab=pending');
  assert.equal(window.map('/admin/payments/remittance'), '');
  assert.match(source, /notifications:loaded/);
  assert.match(source, /notifications:count/);
  ejs.compile(source);
});
