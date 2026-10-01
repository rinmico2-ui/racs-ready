"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const axios = require("axios");

test("geocoding deduplicates matching lookups and serializes provider traffic", async (t) => {
  const routePath = require.resolve("../routes/geocodingRoutes");
  const originalGet = axios.get;
  const calls = [];

  axios.get = async (url, options) => {
    calls.push({ url, at: Date.now(), params: options.params });
    return {
      data: {
        display_name: `Point ${options.params.lat},${options.params.lon}`,
        lat: options.params.lat,
        lon: options.params.lon
      }
    };
  };
  delete require.cache[routePath];

  const app = express();
  app.use("/api/geocoding", require(routePath));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  t.after(() => {
    axios.get = originalGet;
    delete require.cache[routePath];
    server.close();
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/geocoding/reverse`;
  const responses = await Promise.all([
    fetch(`${base}?lat=15.900371&lon=121.007559`),
    fetch(`${base}?lat=15.900372&lon=121.007558`),
    fetch(`${base}?lat=15.899647&lon=120.997204`)
  ]);

  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.equal(calls.length, 2, "coordinates in the same rounded area share one lookup");
  assert.ok(
    calls[1].at - calls[0].at >= 1000,
    `provider calls were only ${calls[1].at - calls[0].at}ms apart`
  );
});

test("complete Philippine addresses fall back to a nearby mapped area without claiming an exact house pin", async (t) => {
  const routePath = require.resolve("../routes/geocodingRoutes");
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (_url, options) => {
    calls.push(options.params);
    return { data: calls.length === 1 ? [] : [{
      display_name: "Mabini Street, Barangay Poblacion, Cabanatuan City, Nueva Ecija, Philippines",
      lat: "15.4863", lon: "120.9671", address: { country_code: "ph" }
    }] };
  };
  delete require.cache[routePath];
  const app = express();
  app.use("/api/geocoding", require(routePath));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    axios.get = originalGet;
    delete require.cache[routePath];
    server.close();
  });

  const query = "123 Mabini Street, Zone 4, Barangay Poblacion, Cabanatuan City, Nueva Ecija";
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/geocoding/search?q=${encodeURIComponent(query)}`);
  const results = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.countrycodes === "ph"));
  assert.match(calls[1].q, /^Mabini Street/);
  assert.equal(results[0].match_level, "area");
  assert.equal(results[0].address.country_code, "ph");
});

test("search results and map reverse lookups reject locations outside the Philippines", async (t) => {
  const routePath = require.resolve("../routes/geocodingRoutes");
  const originalGet = axios.get;
  axios.get = async (url) => ({ data: url.endsWith("/search") ? [
    { display_name: "Makati, Philippines", lat: "14.55", lon: "121.03", address: { country_code: "ph" } },
    { display_name: "Foreign place", lat: "4", lon: "120", address: { country_code: "my" } }
  ] : { display_name: "Foreign place", address: { country_code: "my" } } });
  delete require.cache[routePath];
  const app = express();
  app.use("/api/geocoding", require(routePath));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    axios.get = originalGet;
    delete require.cache[routePath];
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}/api/geocoding`;
  const search = await fetch(`${base}/search?q=Makati%20City`);
  const matches = await search.json();
  assert.equal(search.status, 200);
  assert.deepEqual(matches.map(place => place.address.country_code), ["ph"]);
  const reverse = await fetch(`${base}/reverse?lat=5.9&lon=116.1`);
  assert.equal(reverse.status, 422);
});

test("a full geocoding queue returns backpressure without calling the provider", async t => {
  const routePath = require.resolve("../routes/geocodingRoutes");
  const originalGet = axios.get;
  const originalLimit = process.env.GEOCODING_MAX_PENDING_REQUESTS;
  process.env.GEOCODING_MAX_PENDING_REQUESTS = "2";
  let releaseProvider;
  let markStarted;
  let markSecond;
  let calls = 0;
  let incoming = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const secondArrived = new Promise(resolve => { markSecond = resolve; });
  const providerHold = new Promise(resolve => { releaseProvider = resolve; });
  axios.get = async (_url, options) => {
    calls += 1;
    markStarted();
    await providerHold;
    return { data: { display_name: "Philippines", lat: options.params.lat, lon: options.params.lon, address: { country_code: "ph" } } };
  };
  delete require.cache[routePath];
  const app = express();
  app.use("/api/geocoding", (_req, _res, next) => { if (++incoming === 2) markSecond(); next(); });
  app.use("/api/geocoding", require(routePath));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    releaseProvider();
    axios.get = originalGet;
    if (originalLimit === undefined) delete process.env.GEOCODING_MAX_PENDING_REQUESTS;
    else process.env.GEOCODING_MAX_PENDING_REQUESTS = originalLimit;
    delete require.cache[routePath];
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/geocoding/reverse`;
  const first = fetch(`${base}?lat=15.1&lon=121.1`);
  await started;
  const second = fetch(`${base}?lat=15.2&lon=121.2`);
  await secondArrived;
  const excess = await fetch(`${base}?lat=15.3&lon=121.3`);
  assert.equal(excess.status, 503);
  assert.equal(excess.headers.get("retry-after"), "3");
  assert.equal(calls, 1, "rejected traffic must not call the provider or enter its queue");
  releaseProvider();
  const completed = await Promise.all([first, second]);
  assert.deepEqual(completed.map(response => response.status), [200, 200]);
  assert.equal(calls, 2);
});
