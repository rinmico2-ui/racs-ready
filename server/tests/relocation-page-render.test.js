"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const user = { _id: "507f1f77bcf86cd799439011", name: "Test technician", role: "technician" };
const bookingId = "507f1f77bcf86cd799439012";
const technician = { _id: "507f1f77bcf86cd799439013", user: user._id, name: "Test technician", availabilityStatus: "Available" };
const views = path.join(__dirname, "../views");

function routeHarness(record, failure) {
  const source = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  const start = source.indexOf("router.get('/technician/relocation-work-order/:bookingId'");
  const end = source.indexOf('\nrouter.get(', start + 1);
  assert.ok(start >= 0 && end > start, "Locate the real relocation page route");
  const result = { queries: [], errors: [] };
  vm.runInNewContext(source.slice(start, end), {
    router: { get(route, guard, handler) { result.route = route; result.guard = guard; result.handler = handler; } },
    pageAuth: { requireRole(role) { result.role = role; return "technician-auth-guard"; } },
    require(name) {
      assert.equal(name, "../models/Technician");
      return { findOne(filter) {
        result.queries.push(filter);
        return { async lean() { if (failure) throw failure; return record; } };
      } };
    },
  });
  result.run = () => result.handler({ user, params: { bookingId } }, {
    render(view, locals) { result.view = view; result.locals = locals; },
  }, error => result.errors.push(error));
  return result;
}

async function renderFullPage(locals) {
  const base = { user, currentPath: `/technician/relocation-work-order/${bookingId}`, ...locals };
  const body = await ejs.renderFile(path.join(views, "pages/technician/relocation-work-order.ejs"), base);
  const html = await ejs.renderFile(path.join(views, "layouts/technician.ejs"), { ...base, body });
  for (const [, attributes, script] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(attributes) && script.trim()) new vm.Script(script);
  }
  return html;
}

test("the relocation page route keeps technician authentication and loads the signed-in technician", async () => {
  const route = routeHarness(technician);
  await route.run();
  assert.equal(route.role, "technician");
  assert.equal(route.guard, "technician-auth-guard");
  assert.equal(route.queries.length, 1);
  assert.equal(String(route.queries[0].user), user._id);
  assert.equal(route.view, "pages/technician/relocation-work-order");
  assert.equal(route.locals.technician, technician);
  assert.equal(route.locals.bookingId, bookingId);
  assert.equal(route.locals.layout, "layouts/technician");
});

test("the actual relocation route renders the full layout, checklist shell and technician socket room", async () => {
  const route = routeHarness(technician);
  await route.run();
  const html = await renderFullPage(route.locals);
  assert.match(html, /<h1>Aircon relocation<\/h1>/);
  assert.ok(html.includes(`data-booking-id="${bookingId}"`));
  assert.ok(html.includes(`window.socket.emit('tech:join', '${technician._id}')`));
  assert.match(html, /relocation-work-order\.js/);
  assert.match(html, /Assignments/);
});

test("a missing technician record still renders the page so the API can show its account error", async () => {
  const route = routeHarness(null);
  await route.run();
  assert.ok(route.locals.technician && Object.keys(route.locals.technician).length === 0);
  const html = await renderFullPage(route.locals);
  assert.match(html, /id="relocationWorkOrder"/);
  assert.doesNotMatch(html, /window\.socket\.emit\('tech:join'/);
});

test("technician lookup failures go through the page error handler without rendering a misleading page", async () => {
  const failure = new Error("Test database lookup failure");
  const route = routeHarness(null, failure);
  await route.run();
  assert.equal(route.errors.length, 1);
  assert.equal(route.errors[0], failure);
  assert.equal(route.locals, undefined);
});

test("the shared technician layout can render when a page omits technician locals", async () => {
  const html = await renderFullPage({ title: "Relocation work order", bookingId });
  assert.match(html, /<h1>Aircon relocation<\/h1>/);
  assert.doesNotMatch(html, /window\.socket\.emit\('tech:join'/);
});

test("the shared technician layout also handles an explicitly null technician", async () => {
  const html = await renderFullPage({ title: "Relocation work order", bookingId, technician: null });
  assert.match(html, /id="relocationWorkOrder"/);
  assert.doesNotMatch(html, /window\.socket\.emit\('tech:join'/);
});
