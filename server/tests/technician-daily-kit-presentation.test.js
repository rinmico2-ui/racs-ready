"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

const assignmentsView = read("../views/pages/technician/assignments.ejs");
const ordersView = read("../views/pages/technician/technicianorders.ejs");
const dailyKitPartial = read("../views/partials/technician-order-daily-kit.ejs");
const technicianApi = read("../routes/technicianApi.js");

test("booking assignments and installation orders render the same Daily Preparation component", () => {
  const sharedInclude = /include\('\.\.\/\.\.\/partials\/technician-order-daily-kit'\)/;
  assert.match(assignmentsView, sharedInclude);
  assert.match(ordersView, sharedInclude);
});

test("shared Daily Preparation determines empty state from covered jobs, not physical items", () => {
  assert.match(dailyKitPartial, /if\(!jobs\.length\)return .*label:'No jobs'/);
  assert.match(dailyKitPartial, /if\(!\(kit\.items\|\|\[\]\)\.length\)return .*label:'Ready to confirm'/);
  assert.match(dailyKitPartial, /odkConfirm'\)\.disabled=unavailable\.length>0\|\|!jobs\.length/);
});

test("shared Daily Preparation exposes compatible actions to both technician workflows", () => {
  assert.match(dailyKitPartial, /window\.openOrderDailyKit=window\.openTechnicianDailyKit/);
  assert.match(dailyKitPartial, /window\.openDailyKitModal=window\.openTechnicianDailyKit/);
  assert.match(dailyKitPartial, /window\.refreshOrderDailyKit=window\.refreshTechnicianDailyKit/);
});

test("shared Daily Preparation shows reviewed AI repair-part suggestions without issuing them", () => {
  assert.match(dailyKitPartial, /Reviewed AI contingency suggestions/);
  assert.match(dailyKitPartial, /not issued or deducted until the technician confirms the actual repair scope/);
  assert.match(dailyKitPartial, /payload\.aiContingencySuggestions/);
});

test("Daily Preparation opens above the detail panel and any active modal", () => {
  assert.match(dailyKitPartial, /document\.body\.appendChild\(el\('odkModal'\)\)/);
  assert.match(dailyKitPartial, /\.modal\.show:not\(#odkModal\)/);
  assert.match(dailyKitPartial, /hidden\.bs\.modal',show/);
  assert.match(assignmentsView, /openDailyKitModal\('\$\{a\.bookingDate/);
});

test("technicians can preview kits for upcoming accepted bookings, orders, and project work", () => {
  assert.match(technicianApi, /router\.get\("\/daily-kit\/upcoming"/);
  assert.match(technicianApi, /status: \{ \$in: ACTIVE_ASSIGNMENT_STATUSES \}/);
  assert.match(technicianApi, /status: \{ \$in: ACTIVE_INSTALLATION_ORDER_STATUSES \}/);
  assert.match(technicianApi, /planningOnly: \{ \$ne: true \}/);
  assert.match(dailyKitPartial, /\/api\/technician\/daily-kit\/upcoming/);
  assert.match(dailyKitPartial, /data-odk-date/);
  assert.match(dailyKitPartial, /var canConfirm=isTodayDate\(state\.date\)/);
  assert.match(dailyKitPartial, /Preview only\. Equipment and materials are not issued yet/);
});

test("shared Daily Kit inline script parses", () => {
  const script = dailyKitPartial.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("both technician views and the shared kit render as valid EJS templates", () => {
  for (const view of [assignmentsView, ordersView, dailyKitPartial]) {
    assert.doesNotThrow(() => ejs.compile(view));
  }
});

test("opening the kit waits for a details modal to close and mounts the kit above the page pane", () => {
  const script = dailyKitPartial.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const nodes = Object.fromEntries(["odkModal", "odkBarDate", "odkModalDateInput", "odkModalDate", "odkUpcomingDates", "odkBody", "odkConfirm"].map(id => [id, { style: {}, parentElement: {}, classList: { contains: () => false } }]));
  let afterHidden;
  const active = { addEventListener: (_event, callback) => { afterHidden = callback; } };
  const events = [];
  const body = { appendChild: node => { node.parentElement = body; events.push("mounted"); } };
  const document = {
    body,
    getElementById: id => nodes[id],
    querySelector: () => active,
    addEventListener: () => {},
  };
  const bootstrap = { Modal: { getOrCreateInstance: node => ({
    show: () => events.push(node === nodes.odkModal ? "kit shown" : "other shown"),
    hide: () => events.push("details hidden"),
  }) } };
  const window = {};
  vm.runInNewContext(script, { document, window, bootstrap, fetch: () => new Promise(() => {}), Date, encodeURIComponent });
  window.openTechnicianDailyKit("2026-10-01");
  assert.deepEqual(events, ["mounted", "details hidden"]);
  afterHidden();
  assert.deepEqual(events, ["mounted", "details hidden", "kit shown"]);
  assert.equal(nodes.odkBarDate.value, "2026-10-01");
});
