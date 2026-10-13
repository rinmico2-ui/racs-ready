'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

class Element {
  constructor(document) {
    this.document = document;
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.isConnected = true;
    this.classList = {
      contains: token => this.className.split(/\s+/).includes(token),
      add: (...tokens) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...tokens])].join(' '); },
      remove: (...tokens) => { this.className = this.className.split(/\s+/).filter(token => !tokens.includes(token)).join(' '); },
      toggle: (token, force) => {
        const add = force === undefined ? !this.classList.contains(token) : force;
        this.classList[add ? 'add' : 'remove'](token);
        return add;
      },
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  focus() { this.document.activeElement = this; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  closest(selector) { return selector === '.d-none' && this.classList.contains('d-none') ? this : this.parent?.closest(selector); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    if (selector === 'button') return descendants.filter(child => child.tagName === 'button');
    if (selector.startsWith('button:not')) return descendants.filter(child => (child.tagName === 'button' || child.tagName === 'input' || child.tabIndex === 0) && !child.disabled);
    return descendants.filter(child => child.classList.contains('notif-checkbox') || child.classList.contains('notif-modal-item'));
  }
  async dispatch(name, extra = {}) {
    const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    await Promise.all((this.events[name] || []).map(handler => handler(event)));
    return event;
  }
}

function browser(count = 123) {
  const document = { readyState: 'complete', events: {}, hidden: false };
  const ids = ['notifModal', 'notifModalList', 'notifModalStatus', 'notifDropdownStatus', 'notifSearch', 'selectAllNotif', 'modalMarkSelectedRead', 'modalDeleteSelected', 'notifPagination', 'notifPrevPage', 'notifNextPage', 'notifPageNumbers', 'markAllReadBtn', 'deleteAllBtn', 'modalMarkAllRead', 'modalDeleteAll', 'viewAllNotifBtn', 'closeNotifModal'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(document)]));
  const modal = elements.notifModal;
  modal.className = 'd-none';
  for (const id of ids.slice(1)) {
    if (id === 'viewAllNotifBtn' || id === 'markAllReadBtn' || id === 'deleteAllBtn') continue;
    elements[id].tagName = /Search|selectAll/.test(id) ? 'input' : /Btn|modalMark|modalDelete|Page|close/.test(id) ? 'button' : 'div';
    modal.appendChild(elements[id]);
  }
  document.getElementById = id => elements[id];
  document.createElement = tag => { const el = new Element(document); el.tagName = tag; return el; };
  document.addEventListener = (name, handler) => { (document.events[name] ||= []).push(handler); };
  document.body = new Element(document);
  document.body.style.overflow = 'auto';
  document.activeElement = elements.viewAllNotifBtn;
  let records = Array.from({ length: count }, (_, index) => ({
    _id: 'n' + index, title: index === 0 ? '<img src=x onerror=alert(1)>' : 'Job ' + index,
    message: index === 110 ? 'special equipment notice' : 'Please check',
    read: false, type: 'assignment_new', createdAt: '2026-10-12T00:00:00Z',
    link: index === 0 ? 'javascript:alert(1)' : '/technician/assignments',
  }));
  const requests = [];
  let failGet = false;
  let failWrite = false;
  let holdWrite = false;
  let releaseWrite;
  let refreshes = 0;
  let confirmations = true;
  const window = {
    location: { href: 'http://localhost:5000/technician/assignments', origin: 'http://localhost:5000' },
    confirm: () => confirmations,
    _technicianRefreshNotifications: async () => { refreshes++; },
    _technicianCloseNotificationPanel: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/technician-notification-inbox.js'), 'utf8'), {
    document, window, URL, AbortController,
    async fetch(url, options) {
      requests.push({ url, ...options });
      if (options.method) {
        if (holdWrite) await new Promise(resolve => { releaseWrite = resolve; });
        return { ok: !failWrite };
      }
      const p = Number(new URL(url, window.location.href).searchParams.get('page'));
      return { ok: !failGet, async json() { return { notifications: records.slice((p - 1) * 100, p * 100), pages: Math.ceil(records.length / 100) }; } };
    },
  });
  return {
    elements, document, window, requests,
    settle: () => new Promise(resolve => setImmediate(resolve)),
    failGet: value => { failGet = value; },
    failWrite: value => { failWrite = value; },
    holdWrite: value => { holdWrite = value; },
    releaseWrite: () => releaseWrite(),
    confirmations: value => { confirmations = value; },
    refreshes: () => refreshes,
    records: value => { records = value; },
  };
}

test('admin and technician render the same shared notification dialog and stylesheet', async () => {
  const root = path.join(__dirname, '../views/partials');
  const admin = await ejs.renderFile(path.join(root, 'admin-navbar.ejs'), { user: { role: 'admin', _id: 'staff' } });
  const tech = await ejs.renderFile(path.join(root, 'technician-navbar.ejs'), {});
  const dialog = await ejs.renderFile(path.join(root, 'notification-modal.ejs'), {});
  for (const html of [admin, tech]) {
    assert.ok(html.includes(dialog.trim()));
    assert.match(html, /notification-inbox\.css/);
    assert.equal((html.match(/id="notifModal"/g) || []).length, 1);
    for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});

test('View All loads the full inbox beyond 100 records, searches older notices, and paginates', async () => {
  const feed = browser();
  const el = feed.elements;
  assert.equal(feed.requests.length, 0);
  await el.viewAllNotifBtn.dispatch('click'); await feed.settle();
  assert.equal(el.notifModal.classList.contains('d-none'), false);
  assert.equal(feed.document.body.style.overflow, 'hidden');
  assert.equal(feed.requests.length, 2);
  assert.equal(el.notifModalList.children.length, 10);
  assert.equal(el.notifModalList.children[0].children.at(-1).children[0].textContent, '<img src=x onerror=alert(1)>');
  await el.notifNextPage.dispatch('click');
  assert.equal(el.notifModalList.children[0].children.at(-1).children[0].textContent, 'Job 10');
  el.notifSearch.value = 'special equipment';
  await el.notifSearch.dispatch('input');
  assert.equal(el.notifModalList.children.length, 1);
  assert.equal(el.notifModalList.children[0].children.at(-1).children[0].textContent, 'Job 110');
  assert.equal(el.notifPagination.classList.contains('d-none'), true);
});

test('select-all only selects the visible page; mutations block repeats and refresh counts after success', async () => {
  const feed = browser(); const el = feed.elements;
  await el.viewAllNotifBtn.dispatch('click'); await feed.settle();
  el.selectAllNotif.checked = true;
  await el.selectAllNotif.dispatch('change');
  assert.equal(el.modalMarkSelectedRead.disabled, false);
  feed.holdWrite(true);
  const pending = el.modalMarkSelectedRead.dispatch('click');
  assert.equal(el.modalMarkSelectedRead.disabled, true);
  assert.equal(el.notifModal.attributes['aria-busy'], 'true');
  await el.modalMarkSelectedRead.dispatch('click');
  const writes = feed.requests.filter(request => request.method);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(writes[0].body).ids, Array.from({ length: 10 }, (_, i) => 'n' + i));
  feed.releaseWrite(); await pending;
  assert.equal(feed.refreshes(), 1);
  assert.equal(el.notifModalList.children[0].classList.contains('unread'), false);
  assert.equal(el.modalMarkSelectedRead.disabled, true);
  assert.equal(el.notifModal.attributes['aria-busy'], 'false');
});

test('failed writes preserve unread records and selection, show an error, and allow retry', async () => {
  const feed = browser(3); const el = feed.elements;
  await el.viewAllNotifBtn.dispatch('click'); await feed.settle();
  el.selectAllNotif.checked = true; await el.selectAllNotif.dispatch('change');
  feed.failWrite(true);
  await el.modalMarkSelectedRead.dispatch('click');
  assert.equal(el.notifModalList.children[0].classList.contains('unread'), true);
  assert.equal(el.modalMarkSelectedRead.disabled, false);
  assert.match(el.notifModalStatus.textContent, /Could not update/);
  assert.equal(feed.refreshes(), 0);
  feed.failWrite(false);
  await el.modalMarkSelectedRead.dispatch('click');
  assert.equal(el.notifModalList.children[0].classList.contains('unread'), false);
  assert.equal(feed.refreshes(), 1);
});

test('deletion requires confirmation and only removes selected notices after successful save', async () => {
  const feed = browser(12); const el = feed.elements;
  await el.viewAllNotifBtn.dispatch('click'); await feed.settle();
  el.selectAllNotif.checked = true; await el.selectAllNotif.dispatch('change');
  feed.confirmations(false); await el.modalDeleteSelected.dispatch('click');
  assert.equal(feed.requests.filter(request => request.method).length, 0);
  feed.confirmations(true); feed.failWrite(true);
  await el.modalDeleteSelected.dispatch('click'); await feed.settle();
  assert.equal(el.notifModalList.children.length, 10);
  feed.failWrite(false); await el.modalDeleteSelected.dispatch('click'); await feed.settle();
  const writes = feed.requests.filter(request => request.method);
  assert.equal(writes.at(-1).url, '/api/notifications/bulk-delete');
  assert.equal(writes.at(-1).method, 'DELETE');
  assert.equal(JSON.parse(writes.at(-1).body).ids.length, 10);
  assert.equal(el.notifModalList.children.length, 2);
  assert.equal(el.notifModalList.children[0].children.at(-1).children[0].textContent, 'Job 10');
  assert.equal(feed.refreshes(), 1);
});

test('load failures offer retry; Escape restores focus and scroll; unsafe links stay within technician pages', async () => {
  const feed = browser(2); const el = feed.elements;
  feed.failGet(true);
  await el.viewAllNotifBtn.dispatch('click'); await feed.settle();
  assert.match(el.notifModalStatus.textContent, /Could not load/);
  feed.failGet(false);
  await el.notifModalStatus.children[0].dispatch('click'); await feed.settle();
  assert.equal(el.notifModalList.children.length, 2);
  await el.notifModalList.children[0].dispatch('click');
  assert.equal(feed.window.location.href, '/technician#dashboardNotifications');
  const event = { key: 'Escape', preventDefault() {} };
  feed.document.events.keydown.forEach(handler => handler(event));
  assert.equal(el.notifModal.classList.contains('d-none'), true);
  assert.equal(feed.document.body.style.overflow, 'auto');
  assert.equal(feed.document.activeElement, el.viewAllNotifBtn);
});
