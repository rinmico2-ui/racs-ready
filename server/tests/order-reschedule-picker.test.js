"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const { OrderReschedulePicker, normalizeAvailableDates, dateFromKey } = require("../public/js/order-reschedule-picker");

function fakeDom() {
  const elements = new Map();
  const make = () => ({ children: [], dataset: {}, attributes: {}, hidden: false, disabled: false,
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); return child; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, listener) { this.events ||= {}; this.events[type] = listener; },
  });
  const root = make();
  root.querySelector = selector => {
    if (!elements.has(selector)) elements.set(selector, make());
    return elements.get(selector);
  };
  root.contains = () => true;
  const previousDocument = global.document;
  global.document = { createElement: make };
  return { root, get: selector => root.querySelector(selector), restore: () => { global.document = previousDocument; } };
}

test("reschedule picker normalizes dates and rejects invalid/empty time slots", () => {
  assert.equal(dateFromKey("2026-02-30"), null);
  assert.equal(dateFromKey("<script>"), null);
  const rows = normalizeAvailableDates([
    { date: "2026-10-01", available: true, timeSlots: [{ time: "09:00", label: "9:00 AM" }] },
    { date: "2026-10-02", available: true, timeSlots: [] },
    { date: "2026-10-03", available: false, timeSlots: [{ time: "10:00" }] },
    { date: "2026-02-30", available: true, timeSlots: [{ time: "09:00" }] },
  ]);
  assert.equal(rows.size, 3);
  assert.equal(rows.get("2026-10-01").available, true);
  assert.equal(rows.get("2026-10-02").available, false);
  assert.equal(rows.get("2026-10-03").available, false);
});

test("calendar date then time selection updates checkout-style hidden values and keeps closed dates disabled", t => {
  const dom = fakeDom();
  t.after(dom.restore);
  const date = { value: "" }, time = { value: "" };
  let changes = 0;
  const picker = new OrderReschedulePicker(dom.root, date, time, () => { changes++; });
  const rows = [
    { date: "2026-10-01", available: true, timeSlots: [{ time: "09:00" }, { time: "10:00", label: "10:00 AM" }] },
    { date: "2026-10-02", available: false, timeSlots: [] },
    { date: "2026-11-03", available: true, timeSlots: [{ time: "store_hours", label: "During store hours" }] },
  ];
  assert.equal(picker.setDates(rows), true);
  assert.equal(dom.get('[data-month-label]').textContent, "October 2026");
  const dayButtons = dom.get('[data-date-grid]').children.filter(node => node.dataset.rescheduleDate);
  assert.equal(dayButtons.find(button => button.dataset.rescheduleDate === "2026-10-01").disabled, false);
  assert.equal(dayButtons.find(button => button.dataset.rescheduleDate === "2026-10-02").disabled, true);
  picker.selectDate("2026-10-02");
  assert.equal(date.value, "");
  picker.selectDate("2026-10-01");
  assert.equal(date.value, "2026-10-01");
  assert.equal(time.value, "");
  assert.equal(dom.get('[data-time-section]').hidden, false);
  assert.deepEqual(dom.get('[data-time-grid]').children.map(button => button.textContent), ["9:00 AM", "10:00 AM"]);
  picker.selectTime("11:00");
  assert.equal(time.value, "");
  picker.selectTime("09:00");
  assert.equal(time.value, "09:00");
  picker.changeMonth(1);
  assert.equal(dom.get('[data-month-label]').textContent, "November 2026");
  picker.selectDate("2026-11-03");
  assert.equal(time.value, "");
  picker.selectTime("store_hours");
  assert.equal(time.value, "store_hours");
  picker.changeMonth(1);
  assert.equal(dom.get('[data-month-label]').textContent, "November 2026");
  picker.reset();
  assert.equal(date.value, "");
  assert.equal(time.value, "");
  assert.equal(dom.get('[data-time-section]').hidden, true);
  assert.ok(changes >= 6);
});

test("untrusted availability labels enter the picker as text, never as HTML", t => {
  const dom = fakeDom();
  t.after(dom.restore);
  const picker = new OrderReschedulePicker(dom.root, { value: "" }, { value: "" });
  const staticMarkup = dom.root.innerHTML;
  picker.setDates([{ date: "2026-10-01", available: true, timeSlots: [{ time: "09:00", label: "<img src=x onerror=alert(1)>" }] }]);
  picker.selectDate("2026-10-01");
  assert.equal(dom.get('[data-time-grid]').children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(dom.root.innerHTML, staticMarkup);
});

test("capacity dates load their own time slots and ignore an older response", async t => {
  const dom = fakeDom();
  t.after(dom.restore);
  const date = { value: "" }, time = { value: "" };
  const pending = new Map();
  const picker = new OrderReschedulePicker(dom.root, date, time, () => {}, key => new Promise(resolve => pending.set(key, resolve)));
  assert.equal(picker.setDates([
    { date: "2026-10-01", availableSlots: 3 },
    { date: "2026-10-02", availableSlots: 1 },
    { date: "2026-10-03", availableSlots: 0 },
  ]), true);
  const dayButtons = dom.get('[data-date-grid]').children.filter(node => node.dataset.rescheduleDate);
  assert.equal(dayButtons.find(button => button.dataset.rescheduleDate === "2026-10-01").disabled, false);
  assert.equal(dayButtons.find(button => button.dataset.rescheduleDate === "2026-10-03").disabled, true);
  const first = picker.selectDate("2026-10-01");
  const second = picker.selectDate("2026-10-02");
  pending.get("2026-10-02")([{ startTime: "10:00", available: true }]);
  await second;
  picker.selectTime("10:00");
  assert.equal(time.value, "10:00");
  pending.get("2026-10-01")([{ startTime: "09:00", available: true }]);
  await first;
  assert.equal(date.value, "2026-10-02");
  assert.equal(time.value, "10:00");
  assert.deepEqual(dom.get('[data-time-grid]').children.map(button => button.textContent), ["10:00 AM"]);
});

test("customer order history uses checkout capacity dates and date-specific slots", async () => {
  const template = path.join(__dirname, "../views/pages/my-orders.ejs");
  const source = fs.readFileSync(template, "utf8");
  const html = await ejs.renderFile(template, { orders: [] });
  assert.match(html, /id="orderRescheduleModal"/);
  assert.match(html, /id="rescheduleCalendar"/);
  assert.match(html, /id="rescheduleDate"/);
  assert.match(html, /id="rescheduleTime"/);
  assert.doesNotMatch(html, /<select id="rescheduleDate"|<select id="rescheduleTime"/);
  assert.match(html, /order-reschedule-picker\.js\?v=/);
  assert.match(html, /\/api\/schedule\/available-dates\?/);
  assert.match(html, /\/api\/schedule\/time-slots\?/);
  assert.doesNotMatch(html, /\/api\/schedule\/technician\//);
  assert.match(html, /\/api\/public\/company\/store-open-hours/);
  assert.match(source, /data-quantity=/);
  assert.match(source, /data-travel-time=/);
  assert.match(html, /requestedDate: requestedDate, requestedTime: requestedTime/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test("reschedule request and approval verify live capacity before changing the order", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/orderRoutes.js"), "utf8");
  const request = source.slice(source.indexOf('router.post("/:id/reschedule-request"'), source.indexOf('router.post("/:id/reschedule-approve"'));
  const approve = source.slice(source.indexOf('router.post("/:id/reschedule-approve"'), source.indexOf('router.post("/:id/admin-reschedule"'));
  assert.match(source, /async function checkOrderRescheduleSlot[\s\S]*getTimeSlotsForQuery/);
  assert.match(request, /checkOrderRescheduleSlot\(/);
  assert.match(approve, /checkOrderRescheduleSlot\(/);
  assert.match(request, /ORDER_SLOT_UNAVAILABLE/);
});

test("reschedule slot validation uses checkout quantity and travel rules", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/orderRoutes.js"), "utf8");
  const helper = source.slice(source.indexOf("async function checkOrderRescheduleSlot"), source.indexOf('router.post("/:id/reschedule-request"'));
  let query;
  const check = vm.runInNewContext(helper + "\ncheckOrderRescheduleSlot", {
    require: () => ({ getTimeSlotsForQuery: async input => {
      query = input;
      return { statusCode: 200, payload: { timeSlots: [
        { startTime: "09:00", available: true },
        { startTime: "10:00", available: false },
      ] } };
    } }),
  });
  const order = { fulfillmentType: "delivery_installation", items: [{ quantity: 2 }, { quantity: 1 }], routeDurationMin: 45 };
  assert.equal((await check(order, "2026-10-01", "09:00")).available, true);
  assert.deepEqual(JSON.parse(JSON.stringify(query)), { date: "2026-10-01", duration: "60", quantity: "3", travelTime: "45" });
  assert.equal((await check(order, "2026-10-01", "10:00")).available, false);
  order.fulfillmentType = "delivery_only";
  await check(order, "2026-10-01", "09:00");
  assert.equal(query.quantity, "1");
});
