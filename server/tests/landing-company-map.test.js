"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");
const view = path.join(__dirname, "../views/pages/landing.ejs");
const routes = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");

function locationReader(values, fail = false) {
  let reads = 0;
  const start = routes.indexOf("async function getCompanyLocation()");
  const end = routes.indexOf("async function getBusinessHours()", start);
  const getLocation = vm.runInNewContext(`${routes.slice(start, end)}\ngetCompanyLocation;`, {
    SiteSetting: { findOne({ key }) {
      reads++;
      return { async lean() {
        if (fail) throw new Error("Unavailable");
        return Object.hasOwn(values, key) ? { value: values[key] } : null;
      } };
    } },
  });
  return { getLocation, reads: () => reads };
}
async function render(location) {
  return ejs.renderFile(view, {
    companyLocation: location, companyName: "Test Company", companyAddress: "STALE CACHED ADDRESS",
    displayRating: 0, displayCount: 0, publicStats: {},
  });
}
function attribute(tag, name) {
  const value = tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  assert.ok(value, `missing ${name}`);
  return value.replaceAll("&amp;", "&");
}

test("embedded map and Open Map use the same saved coordinates and address", async () => {
  const values = { companyLocationLat: "15.523456", companyLocationLng: "120.987654", companyLocationAddress: "Saved office address" };
  const reader = locationReader(values);
  const location = await reader.getLocation();
  assert.equal(location.configured, true);
  assert.equal(reader.reads(), 3);
  const html = await render(location);
  const link = html.match(/<a id="landingOpenMap"[^>]*>/)?.[0];
  const iframe = html.match(/<iframe\s+id="landingCompanyMap"[^>]*>/)?.[0];
  assert.ok(link && iframe);
  const mapUrl = new URL(attribute(link, "href"));
  const embedUrl = new URL(attribute(iframe, "src"));
  assert.equal(mapUrl.hostname, "www.google.com");
  assert.equal(mapUrl.searchParams.get("query"), "15.523456,120.987654");
  assert.equal(embedUrl.searchParams.get("q"), mapUrl.searchParams.get("query"));
  assert.match(link, /target="_blank" rel="noopener noreferrer"/);
  assert.match(iframe, /title="Company location map"/);
  assert.match(html, /Saved office address/);
  assert.doesNotMatch(html, /STALE CACHED ADDRESS|15\.123456|120\.123456/);
});

test("updated company settings appear on the next home render without a cached address mismatch", async () => {
  const values = { companyLocationLat: 15, companyLocationLng: 121, companyLocationAddress: "Old office" };
  const reader = locationReader(values);
  await reader.getLocation();
  Object.assign(values, { companyLocationLat: 16, companyLocationLng: 122, companyLocationAddress: "New office" });
  const html = await render(await reader.getLocation());
  assert.equal(reader.reads(), 6);
  assert.match(html, /query=16%2C122/);
  assert.match(html, /New office/);
  assert.doesNotMatch(html, /Old office|STALE CACHED ADDRESS/);
});

test("zero coordinates are valid and never replaced by truthy default coordinates", async () => {
  const reader = locationReader({ companyLocationLat: 0, companyLocationLng: "0", companyLocationAddress: "Zero-coordinate office" });
  const html = await render(await reader.getLocation());
  assert.match(html, /query=0%2C0/);
  assert.match(html, /q=0%2C0/);
});

test("missing, invalid and failed settings reads do not advertise fallback centers as the business", async () => {
  for (const [values, fail] of [
    [{}, false],
    [{ companyLocationLat: 15, companyLocationLng: "" }, false],
    [{ companyLocationLat: "15abc", companyLocationLng: 121 }, false],
    [{ companyLocationLat: true, companyLocationLng: 121 }, false],
    [{ companyLocationLat: 91, companyLocationLng: 121 }, false],
    [{ companyLocationLat: 15, companyLocationLng: 181 }, false],
    [{ companyLocationLat: 15, companyLocationLng: 121 }, true],
  ]) {
    const location = await locationReader(values, fail).getLocation();
    assert.equal(location.configured, false);
    const html = await render(location);
    assert.match(html, /Company location is not available yet/);
    assert.doesNotMatch(html, /id="landingOpenMap"|id="landingCompanyMap"|Quezon City|STALE CACHED ADDRESS/);
  }
});

test("home rendering independently rejects malformed locations and escapes company address text", async () => {
  for (const location of [undefined, { lat: "", lng: "" }, { lat: 500, lng: 120 }, { lat: 15, lng: 120, configured: false }]) {
    assert.doesNotMatch(await render(location), /id="landingOpenMap"|id="landingCompanyMap"/);
  }
  const html = await render({ lat: 15, lng: 121, configured: true, address: '<img src=x onerror="alert(1)">' });
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /<img src=x/);
  const landingHandler = routes.slice(routes.indexOf('router.get("/",'), routes.indexOf("// Services page"));
  assert.match(landingHandler, /getCompanyLocation\(\)/);
  assert.match(landingHandler, /companyLocation,/);
});
