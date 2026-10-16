"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const view = fs.readFileSync(path.join(__dirname, "../views/partials/technician-order-daily-kit.ejs"), "utf8");
const source = view.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\}\)\(\);\s*$/, "window.kitTest={state,saveCheck,render,load,updateChecklist,chooseExtra,changeExtra,searchExtras};})();");
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
class WorkDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-10-12T00:00:00Z"])); }
}

function harness() {
  const nodes = {};
  function node(id) {
    return nodes[id] ||= { style: {}, classList: { contains: () => false }, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {}, textContent: "", innerHTML: "",
      querySelector: () => null, querySelectorAll: () => [], scrollTop: 215 };
  }
  const rows = {};
  for (const id of ["a", "b", "c"]) {
    const input = { dataset: { odkCheckItem: id }, checked: false, disabled: false };
    const help = node(`help-${id}`), badge = node(`badge-${id}`);
    rows[id] = { input, help, badge, querySelector: selector => selector === "[data-odk-check-item]" ? input
      : selector === "[data-odk-check-help]" ? help : selector === "[data-odk-item-status]" ? badge : null };
  }
  const body = node("odkBody");
  let rebuilds = 0, html = "";
  Object.defineProperty(body, "innerHTML", { get: () => html, set: value => { html = value; rebuilds++; } });
  body.querySelector = selector => rows[/data-odk-item-row="(.*?)"/.exec(selector)?.[1]] || null;
  const fill = node("progress-fill");
  node("odkCheckTrack").querySelector = () => fill;
  const requests = [];
  const window = { addEventListener() {} };
  vm.runInNewContext(source, {
    window, document: { getElementById: node, addEventListener() {}, querySelector: () => null },
    Date: WorkDate, Intl, encodeURIComponent, Map, setTimeout, clearTimeout,
    Swal: { fire: async () => ({ isConfirmed: true, value: "Extra is no longer needed" }) },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  const api = window.kitTest;
  let savedKit = { _id: "kit-1", status: "draft", hasDelta: false, items: ["a", "b", "c"].map(id => ({
    _id: id, name: `Tool ${id}`, category: "equipment", quantity: 1, checkoutStatus: "pending", preparedChecked: false,
  })), deltaItems: [] };
  api.state.date = api.state.payloadDate = "2026-10-12";
  api.state.payload = { kit: clone(savedKit), jobDetails: [{ serviceName: "Aircon Installation", status: "accepted" }] };
  function toggle(id, checked) { rows[id].input.checked = checked; api.saveCheck(rows[id].input); }
  function respond(index, { error, kit } = {}) {
    const req = requests[index];
    if (!error && req.options?.body && !kit) {
      const command = JSON.parse(req.options.body);
      const item = savedKit.items.find(item => item._id === command.itemId);
      item.preparedChecked = command.checked;
      item.preparedCheckedAt = command.checked ? "2026-10-12T00:01:00Z" : null;
    }
    const payload = error ? { error } : { success: true, kit: clone(kit || savedKit) };
    req.resolve({ ok: !error, json: async () => payload });
  }
  return { api, nodes, rows, requests, toggle, respond, rebuilds: () => rebuilds, savedKit, fill, node, html: () => html };
}

test("rapid checks update immediately without locking other tools or refetching the kit", async () => {
  const h = harness();
  h.toggle("a", true); h.toggle("b", true); h.toggle("c", true);
  assert.equal(h.requests.length, 1, "saves must run one at a time");
  for (const row of Object.values(h.rows)) { assert.equal(row.input.checked, true); assert.equal(row.input.disabled, false); }
  assert.match(h.nodes.odkSaveStatus.textContent, /Saving 3 items/);
  assert.equal(h.nodes.odkConfirm.disabled, true);
  assert.equal(h.nodes.odkCheckedCount.textContent, "3 of 3 checked");
  h.respond(0); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.rows.a.help.textContent, "Checked and saved");
  assert.equal(h.rows.b.input.checked, true, "an older response cannot clear a queued check");
  assert.equal(h.nodes.odkConfirm.disabled, true);
  h.respond(1); await settle(); h.respond(2); await settle();
  assert.equal(h.nodes.odkConfirm.disabled, false);
  assert.equal(h.api.state.pendingChecks.size, 0);
  assert.equal(h.api.state.savingItem, false);
  assert.equal(h.rebuilds(), 0, "ordinary saves must preserve the checklist DOM, focus and scroll");
  assert.equal(h.nodes.odkBody.scrollTop, 215);
  assert.ok(h.requests.every(req => req.url === "/api/technician/daily-kit/check-item" && req.options.method === "POST"));
  assert.ok(h.api.state.payload.kit.items.every(item => item.preparedChecked));
});

test("changing a checkbox during its save persists the last choice and coalesces queued toggles", async () => {
  const h = harness();
  h.toggle("a", true); h.toggle("a", false); h.toggle("b", true); h.toggle("b", false); h.toggle("b", true);
  h.respond(0); await settle();
  assert.equal(h.rows.a.input.checked, false);
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { date: "2026-10-12", itemId: "a", checked: false });
  h.respond(1); await settle();
  assert.deepEqual(JSON.parse(h.requests[2].options.body), { date: "2026-10-12", itemId: "b", checked: true });
  h.respond(2); await settle();
  assert.equal(h.requests.length, 3);
  assert.equal(h.savedKit.items[0].preparedChecked, false);
  assert.equal(h.savedKit.items[1].preparedChecked, true);
  assert.equal(h.api.state.pendingChecks.size, 0);
});

test("a failed save rolls back only its check, continues other saves and allows a retry", async () => {
  const h = harness();
  h.toggle("a", true); h.toggle("b", true);
  h.respond(0, { error: "This kit item changed." }); await settle();
  assert.equal(h.rows.a.input.checked, false);
  assert.equal(h.rows.b.input.checked, true);
  assert.equal(h.nodes.odkChecklistError.style.display, "block");
  assert.match(h.nodes.odkChecklistError.textContent, /Could not save this check/);
  h.respond(1); await settle();
  h.toggle("a", true);
  assert.equal(h.nodes.odkChecklistError.style.display, "none");
  h.respond(2); await settle();
  assert.equal(h.rows.a.help.textContent, "Checked and saved");
  assert.equal(h.api.state.pendingChecks.size, 0);
  assert.equal(h.rebuilds(), 0);
});

test("a failed outdated toggle does not discard a newer choice", async () => {
  const h = harness();
  h.toggle("a", true); h.toggle("a", false);
  h.respond(0, { error: "Temporary failure" }); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.rows.a.input.checked, false);
  h.respond(1); await settle();
  assert.equal(h.api.state.pendingChecks.size, 0);
  assert.equal(h.savedKit.items[0].preparedChecked, false);
});

test("a response from another date cannot replace the visible kit or enable its checks", async () => {
  const h = harness();
  h.toggle("a", true);
  h.api.state.date = h.api.state.payloadDate = "2026-10-13";
  const other = { kit: { _id: "kit-2", status: "draft", items: [{ ...h.savedKit.items[0], preparedChecked: false }] }, jobDetails: [] };
  h.api.state.payload = other;
  h.respond(0); await settle();
  assert.equal(h.api.state.payload, other);
  assert.equal(other.kit.items[0].preparedChecked, false);
  assert.equal(h.rows.a.input.disabled, true);
  assert.equal(h.nodes.odkConfirm.disabled, true);
  assert.equal(h.rebuilds(), 0);
});

test("an earlier save acknowledgement preserves a newer same-date kit refresh", async () => {
  const h = harness();
  h.toggle("a", true);
  h.api.state.requestId++;
  const newer = clone(h.api.state.payload);
  newer.kit.items[0].preparedChecked = false;
  newer.kit.items[1].name = "Updated tool";
  newer.jobDetails.push({ serviceName: "New installation", status: "accepted" });
  h.api.state.payload = newer;
  h.respond(0); await settle();
  assert.equal(h.api.state.payload, newer);
  assert.equal(newer.kit.items[0].preparedChecked, true);
  assert.equal(newer.kit.items[1].name, "Updated tool");
  assert.equal(newer.jobDetails.length, 2);
  assert.equal(h.rebuilds(), 0);
});

test("a changed requirement refreshes the checklist once while preserving scroll", async () => {
  const h = harness();
  h.toggle("a", true);
  const changed = clone(h.savedKit);
  changed.items[0].preparedChecked = true;
  changed.items[1].checkoutStatus = "unavailable";
  h.respond(0, { kit: changed }); await settle();
  assert.equal(h.rebuilds(), 1);
  assert.equal(h.nodes.odkBody.scrollTop, 215);
  assert.equal(h.rows.b.input.disabled, true);
  assert.equal(h.nodes.odkConfirm.disabled, true);
});

test("checking is blocked while the selected date is still loading or checkout is running", () => {
  const h = harness();
  h.api.state.payloadDate = "2026-10-11";
  h.toggle("a", true);
  assert.equal(h.requests.length, 0);
  h.api.state.payloadDate = "2026-10-12";
  h.api.state.confirming = true;
  h.toggle("b", true);
  assert.equal(h.requests.length, 0);
});

test("an invalid save response is treated as a failure instead of reporting a saved check", async () => {
  const h = harness();
  h.toggle("a", true);
  h.respond(0, { kit: { _id: "different-kit", items: [] } }); await settle();
  assert.equal(h.rows.a.input.checked, false);
  assert.match(h.nodes.odkChecklistError.textContent, /Unable to confirm/);
  assert.equal(h.api.state.pendingChecks.size, 0);
});

test("a slow overlapping kit read cannot clear a check acknowledged after that read started", async () => {
  const h = harness();
  h.toggle("a", true);
  const oldKit = clone(h.savedKit);
  const refresh = h.api.load("2026-10-12", false);
  assert.equal(h.requests.length, 2);
  h.respond(0); await settle();
  h.requests[1].resolve({ ok: true, json: async () => ({ kit: oldKit, jobDetails: [{ status: "accepted" }] }) });
  await refresh;
  assert.equal(h.api.state.payload.kit.items[0].preparedChecked, true);
});

test("a changed quantity in an overlapping read still clears an old packed check", async () => {
  const h = harness();
  h.toggle("a", true);
  const changedKit = clone(h.savedKit);
  changedKit.items[0].quantity = 2;
  const refresh = h.api.load("2026-10-12", false);
  h.respond(0); await settle();
  h.requests[1].resolve({ ok: true, json: async () => ({ kit: changedKit, jobDetails: [{ status: "accepted" }] }) });
  await refresh;
  assert.equal(h.api.state.payload.kit.items[0].quantity, 2);
  assert.equal(h.api.state.payload.kit.items[0].preparedChecked, false);
});

test("draft kits expose catalog extras and guarded removal while issued kits expose returns", () => {
  const h = harness();
  const item = h.api.state.payload.kit.items[0];
  item.manualQuantity = 2; item.requiredQuantity = 1;
  h.api.render(h.api.state.payload);
  assert.match(h.html(), /odkExtraSearch/);
  assert.match(h.html(), /Total quantity to pack/);
  assert.match(h.html(), /Job that needs this item/);
  assert.match(h.html(), /data-odk-remove-extra="a"/);
  assert.match(h.html(), /Not needed/);
  h.api.state.payload.kit.status = "confirmed";
  item.checkoutStatus = "checked_out";
  h.api.render(h.api.state.payload);
  assert.doesNotMatch(h.html(), /id="odkExtraSearch"/);
  assert.doesNotMatch(h.html(), /data-odk-remove-extra/);
  assert.match(h.html(), /return reusable equipment from My Tools/);
});

test("adding an extra sends its catalog identity and selected job without a second GET", async () => {
  const h = harness();
  h.api.state.extraResults = [{ _id: "catalog-1", name: "Ladder", category: "equipment", available: 3, unit: "pcs" }];
  h.api.chooseExtra({ dataset: { odkSelectExtra: "catalog-1" } });
  h.node("odkExtraQty").value = "2";
  h.node("odkExtraJob").value = "booking:job-1";
  h.node("odkExtraNote").value = "Higher ceiling needs a ladder";
  const add = h.api.changeExtra(h.node("odkAddExtra"), false);
  assert.equal(h.api.state.mutatingItem, true);
  assert.equal(h.nodes.odkConfirm.disabled, true);
  assert.ok(Object.values(h.rows).every(row => row.input.disabled));
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { date: "2026-10-12", inventoryItemId: "catalog-1", quantity: 2,
    jobType: "booking", jobId: "job-1", note: "Higher ceiling needs a ladder" });
  const updated = clone(h.savedKit); updated.items[0].manualQuantity = 2;
  h.respond(0, { kit: updated }); await add;
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.method, "POST");
  assert.equal(h.api.state.payload.kit.items[0].manualQuantity, 2);
  assert.equal(h.api.state.mutatingItem, false);
  assert.equal(h.nodes.odkBody.scrollTop, 215);
});

test("removing an extra requires a reason and sends the row ID instead of its name", async () => {
  const h = harness();
  h.api.state.payload.kit.items[0].manualQuantity = 2;
  h.api.state.payload.kit.items[0].requiredQuantity = 1;
  const remove = h.api.changeExtra({ dataset: { odkRemoveExtra: "a" }, innerHTML: "Remove extra" }, true);
  await settle();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { date: "2026-10-12", itemId: "a", note: "Extra is no longer needed" });
  assert.equal(h.requests[0].options.method, "DELETE");
  h.respond(0, { kit: h.savedKit }); await remove;
  assert.equal(h.requests.length, 1);
  assert.equal(h.api.state.mutatingItem, false);
  assert.equal(h.nodes.odkBody.scrollTop, 215);
});

test("a failed extra change keeps the current kit and allows retry without a reload", async () => {
  const h = harness();
  h.api.state.extraItem = { _id: "catalog-1", category: "equipment" };
  h.node("odkExtraQty").value = "2"; h.node("odkExtraJob").value = "booking:job-1";
  h.node("odkExtraNote").value = "Extra tools for the job";
  const original = h.api.state.payload.kit;
  const add = h.api.changeExtra(h.node("odkAddExtra"), false);
  h.respond(0, { error: "This kit is already confirmed." }); await add;
  assert.equal(h.api.state.payload.kit, original);
  assert.equal(h.api.state.extraItem._id, "catalog-1");
  assert.equal(h.api.state.mutatingItem, false);
  assert.equal(h.node("odkAddExtra").disabled, false);
  assert.match(h.nodes.odkChecklistError.textContent, /already confirmed/);
  assert.equal(h.rebuilds(), 0);
});

test("extra changes cannot race queued physical checks", async () => {
  const h = harness();
  h.toggle("a", true);
  await h.api.changeExtra({ dataset: { odkRemoveExtra: "a" }, innerHTML: "Remove" }, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.api.state.mutatingItem, false);
  h.respond(0); await settle();
});

test('support-only Daily Preparation displays shared packing status without editable controls or confirmation', () => {
  const h = harness();
  const payload = { kit: { status: 'draft', items: [] }, jobDetails: [], sharedKits: [{ readOnly: true, primaryName: '<Primary>', status: 'draft', jobs: [{ reference: 'JOB-1', serviceName: 'Aircon Cleaning' }],
    items: [{ name: 'Pump <safe>', quantity: 1, unit: 'pc', preparedChecked: true, checkoutStatus: 'pending' }], deltaItems: [] }] };
  h.api.state.payload = payload; h.api.render(payload);
  assert.match(h.html(), /Shared team kits/); assert.match(h.html(), /Packed/);
  assert.match(h.html(), /&lt;Primary&gt;/); assert.match(h.html(), /Pump &lt;safe&gt;/);
  assert.doesNotMatch(h.html(), /data-odk-check-item|data-odk-action|odkAddExtra|type="checkbox"/);
  assert.equal(h.nodes.odkConfirm.style.display, 'none'); assert.equal(h.nodes.odkConfirm.disabled, true);
  assert.match(h.nodes.odkFooterHint.textContent, /View only/); assert.equal(h.requests.length, 0);
});

test('a technician can prepare their own primary jobs while viewing a different primary shared kit', () => {
  const h = harness();
  h.api.state.payload.sharedKits = [{ primaryName: 'Other primary', status: 'confirmed', jobs: [], items: [{ name: 'Shared ladder', quantity: 1, checkoutStatus: 'checked_out' }] }];
  h.api.render(h.api.state.payload);
  assert.match(h.html(), /Shared ladder/); assert.match(h.html(), /data-odk-check-item="a"/);
  assert.doesNotMatch(h.html(), /data-odk-check-item="Shared ladder"/);
  assert.equal(h.nodes.odkConfirm.style.display, '');
});
