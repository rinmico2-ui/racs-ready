"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLocationText, relocationLocations } = require("../utils/relocationLocation");
const { point, createController } = require("../public/js/relocation-work-order-map");

const from = { address: "Test current address", lat: 15.3, lng: 120.9 };
const to = { address: "Test destination", lat: 15.4, lng: 121.0 };
const road = { routes: [{ distance: 2100, duration: 280, geometry: { coordinates: [[120.9, 15.3], [120.95, 15.35], [121.0, 15.4]] } }] };

function mapHarness(fetch = async () => ({ ok: true, json: async () => road }), options = {}) {
  const maps = [];
  const requests = [];
  const document = { createElement(tag) { return { tag, children: [], append(...children) { this.children.push(...children); } }; } };
  const L = {
    map(element, settings) {
      const map = { element, settings, markers: [], lines: [], views: [], bounds: [], removed: false,
        setView(...args) { this.views.push(args); }, fitBounds(...args) { this.bounds.push(args); }, remove() { this.removed = true; } };
      maps.push(map);
      return map;
    },
    divIcon: settings => settings,
    marker(position, settings) {
      const marker = { position, settings, addTo(map) { map.markers.push(this); return this; }, bindPopup(popup) { this.popup = popup; return this; } };
      return marker;
    },
    polyline(positions, settings) {
      return { positions, settings, addTo(map) { map.lines.push(this); return this; }, getBounds() { return positions; } };
    },
  };
  const controller = createController({ L: options.noLeaflet ? null : L, document,
    createLayer: () => ({ addTo() { if (options.failTiles) throw new Error("Test map unavailable"); } }),
    fetch: async (url, settings) => { requests.push({ url, settings }); return fetch(url, settings); } });
  const element = { hidden: false };
  const status = { textContent: "" };
  return { controller, maps, requests, element, status, render: item => controller.render(item, element, status) };
}

test("address display repairs a stored broken ñ while retaining already valid Unicode", () => {
  assert.equal(cleanLocationText("Malaca\u00c3\u00b1ang, Santa Rosa"), "Malacañang, Santa Rosa");
  assert.equal(cleanLocationText("España · Niño – 東京"), "España · Niño – 東京");
  assert.equal(cleanLocationText("Unit A\u00c2\u00b7Room B"), "Unit A·Room B");
  assert.equal(cleanLocationText("Unit \u00e2\u00a1"), "Unit \u00e2\u00a1");
});

test("a legacy move retains the actual current pin and leaves its unknown destination unpinned", () => {
  const locations = relocationLocations({}, { ...from, address: "Malaca\u00c3\u00b1ang" });
  assert.equal(locations.from.address, "Malacañang");
  assert.deepEqual(point(locations.from), [15.3, 120.9]);
  assert.equal(locations.to.address, "");
  assert.equal(point(locations.to), null);
});

test("only a declared same-property move reuses the saved property pin for both room positions", () => {
  const locations = relocationLocations({ scope: "same_property", from: { details: "Room A" }, to: { details: "Room B" } }, from);
  assert.deepEqual(point(locations.from), point(locations.to));
  assert.equal(locations.to.address, from.address);
  assert.equal(locations.to.details, "Room B");
  assert.equal(relocationLocations({ scope: "custom_quote", to: { address: to.address } }, from).to.lat, undefined);
});

test("a different address never borrows the current property's coordinates", () => {
  const locations = relocationLocations({ from: { address: "Other origin" }, scope: "same_property", to: { address: to.address } }, from);
  assert.equal(point(locations.from), null);
  assert.equal(point(locations.to), null);
});

test("map pins support the stored GeoJSON order and reject blank, invalid and outside-country values", () => {
  assert.deepEqual(point({ coordinates: { type: "Point", coordinates: [120.9, 15.3] } }), [15.3, 120.9]);
  assert.deepEqual(point({ lat: "15.3", lng: "120.9" }), [15.3, 120.9]);
  for (const place of [{ lat: "", lng: "" }, { lat: null, lng: null }, { lat: 0, lng: 0 }, { lat: 200, lng: 121 }, {}]) assert.equal(point(place), null);
});

test("a missing destination shows only the actual current pin and requests no guessed route", async () => {
  const h = mapHarness();
  await h.render({ from, to: {} });
  assert.equal(h.maps[0].markers.length, 1);
  assert.deepEqual(h.maps[0].markers[0].position, [15.3, 120.9]);
  assert.equal(h.requests.length, 0);
  assert.match(h.status.textContent, /new location needs a saved map pin/);
});

test("two saved pins request and display the actual road geometry, distance and estimated travel time", async () => {
  const h = mapHarness();
  await h.render({ from, to });
  assert.equal(h.maps[0].markers.length, 2);
  assert.equal(h.maps[0].lines.length, 1);
  assert.equal(new URL(h.requests[0].url, "http://localhost").searchParams.get("coords"), "120.9,15.3;121,15.4");
  assert.equal(h.requests[0].settings.credentials, "same-origin");
  assert.deepEqual(h.maps[0].lines[0].positions, [[15.3, 120.9], [15.35, 120.95], [15.4, 121.0]]);
  assert.match(h.status.textContent, /2\.1 km.*5 min/);
  assert.equal(h.maps[0].settings.scrollWheelZoom, false);
});

test("a same-property move uses one shared pin without requesting a driving route", async () => {
  const h = mapHarness();
  await h.render({ from, to: from, sameProperty: true });
  assert.equal(h.maps[0].markers.length, 1);
  assert.match(h.maps[0].markers[0].settings.icon.html, /A\/B/);
  assert.equal(h.requests.length, 0);
  assert.match(h.status.textContent, /Same property/);
});

test("route failures retain both real pins and never draw a straight line as a road route", async () => {
  for (const fetch of [async () => { throw new Error("Test network failure"); }, async () => ({ ok: true, json: async () => ({ routes: [{ geometry: { coordinates: [["bad", 15.3], [121, 15.4]] } }] }) })]) {
    const h = mapHarness(fetch);
    await h.render({ from, to });
    assert.equal(h.maps[0].markers.length, 2);
    assert.equal(h.maps[0].lines.length, 0);
    assert.match(h.status.textContent, /route is unavailable/);
  }
});

test("refresh discards a pending route response belonging to the previous map", async () => {
  let release;
  const h = mapHarness(() => new Promise(resolve => { release = resolve; }));
  const pending = h.render({ from, to });
  h.controller.clear();
  assert.equal(h.maps[0].removed, true);
  release({ ok: true, json: async () => road });
  await pending;
  assert.equal(h.maps[0].lines.length, 0);
});

test("absent pins or unavailable map assets show a useful message instead of throwing", async () => {
  const noPins = mapHarness();
  await noPins.render({ from: {}, to: {} });
  assert.equal(noPins.maps.length, 0);
  assert.equal(noPins.element.hidden, true);
  assert.match(noPins.status.textContent, /No map pins/);
  for (const options of [{ noLeaflet: true }, { failTiles: true }]) {
    const h = mapHarness(undefined, options);
    await h.render({ from, to });
    assert.equal(h.element.hidden, true);
    assert.match(h.status.textContent, /map could not load/);
  }
});

test("saved address text enters popup text nodes rather than executable HTML", async () => {
  const h = mapHarness();
  await h.render({ from: { ...from, address: '<img src=x onerror="alert(1)">' }, to: {} });
  const body = h.maps[0].markers[0].popup.children[1];
  assert.equal(body.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(body.innerHTML, undefined);
});
