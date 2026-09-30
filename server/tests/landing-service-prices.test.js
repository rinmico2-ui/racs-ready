"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { buildLandingServicePrices } = require("../utils/landingServicePricing");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const categories = [{ slug: "appliance", active: true, unitTypes: [
  { value: "Refrigerator", label: "Refrigerator", inspectionFee: 750 },
  { value: "Washing Machine", label: "Washing Machine", inspectionFee: 0 },
  { value: "Microwave Oven", label: "Microwave" },
  { value: "Water Dispenser", label: "Water Dispenser" },
] }];

test("core price breakdown uses current type/HP tiers rather than stale legacy prices", () => {
  const prices = buildLandingServicePrices([{
    name: "Aircon Installation", isAirconService: true, basePrice: 10,
    hpPricing: [{ hp: 1, price: 20 }],
    airconTypes: [
      { name: "Split Type", hpPricing: [{ hp: 1, price: 2500 }, { hp: 1.5, price: 3000 }] },
      { name: "Window Type", hpPricing: [{ hp: 1, price: 1800 }] },
    ],
  }], [], 500)["Aircon Installation"];
  assert.equal(prices.min, 1800);
  assert.equal(prices.max, 3000);
  assert.deepEqual(prices.rows, [
    { label: "Split Type · 1 HP", amount: 2500 }, { label: "Split Type · 1.5 HP", amount: 3000 },
    { label: "Window Type · 1 HP", amount: 1800 },
  ]);
});

test("legacy HP tiers, base prices, ranges, and alternate refrigerant names are supported", () => {
  const prices = buildLandingServicePrices([
    { name: "Aircon Cleaning", isAirconService: true, hpPricing: [{ hp: 1, price: 800 }, { hp: 2, price: 1200 }] },
    { name: "Aircon Recharging", slug: "freon-recharging", basePrice: 900 },
    { name: "Aircon Relocation", priceRange: { min: 2000, max: 4000 } },
  ], [], 500);
  assert.equal(prices["Aircon Cleaning"].min, 800);
  assert.equal(prices["Freon Recharging"].min, 900);
  assert.equal(prices["Aircon Relocation"].max, 4000);
});

test("repair prices reuse the booking inspection policy, including explicit zero overrides", () => {
  const prices = buildLandingServicePrices([], categories, 650);
  assert.equal(prices["Refrigerator Repair"].min, 750);
  assert.equal(prices["Washing Machine"].min, 0);
  assert.equal(prices["Microwave Oven"].min, 650);
  assert.equal(prices["Water Dispenser"].min, 650);
  for (const name of ["Refrigerator Repair", "Washing Machine", "Microwave Oven", "Water Dispenser"]) {
    assert.equal(prices[name].kind, "inspection");
  }
});

test("inactive, missing, invalid and unrelated catalog prices are never guessed", () => {
  const prices = buildLandingServicePrices([
    { name: "Aircon Installation", active: false, basePrice: 2500 },
    { name: "Aircon Cleaning", basePrice: null, priceRange: { min: "", max: 1200 } },
    { name: "Freon Recharging", isAirconService: true, hpPricing: [{ hp: 1, price: -1 }, { hp: 0, price: 100 }] },
    { name: "Unrelated Service", basePrice: 100 },
  ], [{ ...categories[0], active: false }], 500);
  assert.equal(Object.keys(prices).length, 8);
  assert.ok(Object.values(prices).every(price => !price.available && !price.rows.length));
  assert.equal(buildLandingServicePrices([{ name: "Aircon Installation", basePrice: 0 }], [], 500)["Aircon Installation"].min, 0);
});

for (const fails of [false, true]) {
  test(`public pricing endpoint performs compact parallel reads and ${fails ? "fails safely" : "returns only prices"}`, async () => {
    const source = read("routes/serviceRoutes.js");
    const start = source.indexOf('router.get("/landing-prices"');
    const end = source.indexOf("\n});", start) + 4;
    let handler;
    let reads = 0;
    const model = (rows, core) => ({ find(filter) {
      assert.equal(filter.active, true); reads++;
      return {
        select(fields) { assert.doesNotMatch(fields, /images|internal|parts|customer|bookingCount/); if (core) assert.match(fields, /hpPricing/); return this; },
        limit(value) { assert.equal(value, 100); return this; },
        maxTimeMS(value) { assert.equal(value, 3000); return this; },
        async lean() { if (fails && core) throw new Error("private database error"); return rows; },
      };
    } });
    vm.runInNewContext(source.slice(start, end), {
      router: { get(_url, callback) { handler = callback; } },
      CoreService: model([{ name: "Aircon Installation", basePrice: 2500, internalNotes: "private" }], true),
      require: name => { assert.equal(name, "../models/ServiceCategory"); return model(categories, false); },
      getDefaultRepairInspectionFee: async () => { reads++; return 650; },
      buildLandingServicePrices,
    });
    const res = { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; },
      status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    await handler({}, res);
    assert.equal(reads, 3);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.statusCode, fails ? 503 : 200);
    assert.doesNotMatch(JSON.stringify(res.body), /private|internalNotes|customerId/);
    if (!fails) assert.equal(res.body.prices["Refrigerator Repair"].min, 750);
  });
}

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.className = ""; this.text = ""; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(" "); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.text = ""; this.children = []; children.forEach(child => this.appendChild(child)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  matches(selector) { return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : Object.hasOwn(this.attributes, selector.slice(1, -1)); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function browser(fetcher) {
  const events = {};
  const document = { createElement: tag => new Element(tag), addEventListener(name, callback) { events[name] = callback; } };
  const modal = new Element(); modal.className = "landing-service-detail";
  const panel = new Element(); panel.setAttribute("data-price-service", "Aircon Installation"); panel.dataset.priceService = "Aircon Installation";
  const content = new Element(); content.setAttribute("data-service-price-content", "");
  panel.appendChild(content); modal.appendChild(panel);
  vm.runInNewContext(read("public/js/landing-service-prices.js"), {
    document, fetch: fetcher, Intl, AbortController, WeakMap, setTimeout, clearTimeout,
  });
  return { events, modal, panel, content };
}

test("modal prices load on demand and repeated opens share a short-lived cache", async () => {
  let calls = 0;
  const ui = browser(async (url, options) => {
    calls++; assert.equal(url, "/api/services/landing-prices"); assert.equal(options.credentials, "same-origin");
    return { ok: true, json: async () => ({ prices: buildLandingServicePrices([{ name: "Aircon Installation", basePrice: 2500 }], categories, 500) }) };
  });
  assert.equal(calls, 0);
  ui.events["show.bs.modal"]({ target: ui.modal });
  ui.events["show.bs.modal"]({ target: ui.modal });
  await flush();
  assert.equal(calls, 1);
  assert.match(ui.content.textContent, /Service price: ₱2,500\.00 per unit/);
  assert.match(ui.content.textContent, /Travel fees/);
  assert.equal(ui.panel.attributes["aria-busy"], "false");
  ui.events["show.bs.modal"]({ target: ui.modal }); await flush();
  assert.equal(calls, 1);
});

test("inspection fees and zero amounts are shown without implying a final repair price", async () => {
  const ui = browser(async () => ({ ok: true, json: async () => ({ prices: buildLandingServicePrices([], categories, 500) }) }));
  ui.panel.dataset.priceService = "Washing Machine";
  ui.events["show.bs.modal"]({ target: ui.modal }); await flush();
  assert.match(ui.content.textContent, /Inspection fee: ₱0\.00 per appliance/);
  assert.match(ui.content.textContent, /not the final repair or replacement parts/);
});

test("failed price requests show a usable retry and missing prices never show a made-up amount", async () => {
  let calls = 0;
  const ui = browser(async () => { calls++; return calls === 1 ? { ok: false } : { ok: true, json: async () => ({ prices: {} }) }; });
  ui.events["show.bs.modal"]({ target: ui.modal }); await flush();
  assert.match(ui.content.textContent, /Prices could not be loaded/);
  const retry = ui.content.querySelector("[data-service-price-retry]");
  assert.equal(retry.type, "button");
  ui.events.click({ target: retry }); await flush();
  assert.equal(calls, 2);
  assert.match(ui.content.textContent, /No current price is published/);
  assert.doesNotMatch(ui.content.textContent, /₱/);
});

test("HP price tables render labels as text, not injected HTML", async () => {
  const label = '<img src=x onerror="alert(1)">';
  const ui = browser(async () => ({ ok: true, json: async () => ({ prices: {
    "Aircon Installation": { available: true, kind: "service", min: 800, max: 1200, rows: [{ label, amount: 800 }, { label: "2 HP", amount: 1200 }] },
  } }) }));
  ui.events["show.bs.modal"]({ target: ui.modal }); await flush();
  const table = ui.content.children.find(child => child.tagName === "table");
  assert.ok(table);
  assert.equal(table.children[1].children[0].children[0].textContent, label);
  assert.equal(table.children[1].children[0].children[0].children.length, 0);
  assert.match(ui.content.textContent, /₱800\.00 – ₱1,200\.00/);
});
