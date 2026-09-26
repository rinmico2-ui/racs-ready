"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const Notification = require("../models/Notification");
const router = require("../routes/technicianApi");

test("technician notification count covers the full inbox, not just the latest 30", async () => {
  const originalFind = Notification.find;
  const originalCount = Notification.countDocuments;
  const filters = [];
  Notification.find = (filter) => {
    filters.push(filter);
    return {
      sort(value) { assert.deepEqual(value, { createdAt: -1 }); return this; },
      limit(value) { assert.equal(value, 30); return this; },
      async lean() {
        return Array.from({ length: 30 }, (_, i) => ({
          _id: String(i), title: "Assigned job", message: "Please check", read: i === 0,
          type: "assignment_new", createdAt: new Date(),
        }));
      },
    };
  };
  Notification.countDocuments = async (filter) => { filters.push(filter); return 47; };
  try {
    const handler = router.stack.find(layer => layer.route?.path === "/notifications").route.stack[0].handle;
    let response;
    await handler({ user: { _id: "my-user" } }, { json(value) { response = value; } }, error => { throw error; });
    const inbox = { $or: [{ userId: "my-user" }, { userId: null, role: "technician" }] };
    assert.deepEqual(filters[0], inbox);
    assert.deepEqual(filters[1], { ...inbox, read: { $ne: true } });
    assert.equal(response.unread, 47);
    assert.equal(response.notifications.length, 30);
    assert.equal(response.notifications[0].read, true);
    assert.equal(response.notifications[1].read, false);
  } finally {
    Notification.find = originalFind;
    Notification.countDocuments = originalCount;
  }
});

class Element {
  constructor() {
    this.children = [];
    this.textContent = "";
    this.attributes = {};
    this.events = {};
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => this.classes.add(value)),
      remove: (...values) => values.forEach(value => this.classes.delete(value)),
    };
  }
  appendChild(child) { this.children.push(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  contains() { return false; }
}

function browserFeed() {
  const navbar = fs.readFileSync(path.join(__dirname, "../views/partials/technician-navbar.ejs"), "utf8");
  ejs.compile(navbar);
  const script = navbar.split("/* ---- Notifications ---- */")[1].split("</script>")[0];
  const ids = ["notifBadge", "notifCount", "notifList", "notifDropdownBtn", "notifDropdown",
    "dashboardNotificationList", "dashboardNotificationBody", "dashboardNotificationStatus",
    "dashboardNotificationMore", "dashboardNotificationRefresh"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const listeners = {};
  const socketEvents = {};
  let data = { unread: 30, notifications: Array.from({ length: 30 }, (_, i) => ({
    title: i === 0 ? '<img src=x onerror=alert(1)>' : "Job " + i,
    message: "Please check the booking", read: false, time: new Date().toISOString(),
    link: i === 0 ? "javascript:alert(1)" : "/technician/assignments",
  })) };
  let fail = false;
  let requests = 0;
  const document = {
    readyState: "loading", hidden: false,
    getElementById: id => elements[id] || null,
    createElement: () => new Element(),
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
  };
  const window = { location: { href: "http://localhost:5000/technician", origin: "http://localhost:5000" } };
  vm.runInNewContext(script, {
    document, window, URL, setInterval() {},
    async fetch(url) {
      requests++;
      assert.equal(url, "/api/technician/notifications");
      return { ok: !fail, async json() { return data; } };
    },
  });
  return {
    elements, socketEvents,
    async start() {
      // Socket is created later in the layout, not during navbar execution.
      window.socket = { on(name, callback) { socketEvents[name] = callback; } };
      listeners.DOMContentLoaded.forEach(callback => callback());
      await new Promise(resolve => setImmediate(resolve));
    },
    async refresh(nextData, failure = false) {
      if (nextData) data = nextData;
      fail = failure;
      listeners.click.forEach(callback => callback({ target: { closest: selector => selector === "#dashboardNotificationRefresh" } }));
      await new Promise(resolve => setImmediate(resolve));
    },
    more() {
      listeners.click.forEach(callback => callback({ target: { closest: selector => selector === "#dashboardNotificationMore" } }));
    },
    requests: () => requests,
  };
}

test("bell and dashboard use one response, with safe content and working show more", async () => {
  const feed = browserFeed();
  assert.equal(feed.requests(), 0);
  await feed.start();
  const el = feed.elements;
  assert.equal(feed.requests(), 1);
  assert.equal(el.notifBadge.textContent, "30");
  assert.equal(el.notifCount.textContent, 30);
  assert.equal(el.notifList.children.length, 30);
  assert.equal(el.dashboardNotificationList.children.length, 5);
  assert.match(el.dashboardNotificationStatus.textContent, /^30 unread/);
  assert.equal(el.dashboardNotificationMore.hidden, false);
  assert.equal(el.dashboardNotificationBody.attributes["aria-busy"], "false");
  const first = el.dashboardNotificationList.children[0];
  assert.equal(first.href, "/technician#dashboardNotifications");
  assert.equal(first.children[1].children[0].textContent, '<img src=x onerror=alert(1)>');
  feed.more();
  assert.equal(el.dashboardNotificationList.children.length, 30);
  assert.equal(el.dashboardNotificationMore.attributes["aria-expanded"], "true");
  feed.more();
  assert.equal(el.dashboardNotificationList.children.length, 5);
  assert.equal(typeof feed.socketEvents["notification:new"], "function");
  await feed.socketEvents["notification:new"]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(feed.requests(), 2);
});

test("a failed request shows retry guidance instead of claiming the inbox is empty", async () => {
  const feed = browserFeed();
  await feed.start();
  await feed.refresh(null, true);
  assert.match(feed.elements.dashboardNotificationStatus.textContent, /Could not load.*Refresh/);
  assert.equal(feed.elements.dashboardNotificationList.children.length, 5);
  assert.equal(feed.elements.notifBadge.textContent, "30");
  assert.equal(feed.elements.dashboardNotificationRefresh.disabled, false);
  await feed.refresh({ unread: 0, notifications: [] });
  assert.equal(feed.elements.dashboardNotificationStatus.textContent, "0 unread");
  assert.equal(feed.elements.dashboardNotificationList.children[0].textContent, "You have no notifications yet.");
  assert.equal(feed.elements.notifBadge.classes.has("d-none"), true);
  assert.equal(feed.elements.dashboardNotificationMore.hidden, true);
});

test("dashboard notification markup starts loading and both templates compile", () => {
  const source = fs.readFileSync(path.join(__dirname, "../views/pages/technician/techniciandashboard.ejs"), "utf8");
  ejs.compile(source);
  assert.match(source, /id="dashboardNotificationList"/);
  assert.doesNotMatch(source, /You have no new notifications\./);
  for (const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});
