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
