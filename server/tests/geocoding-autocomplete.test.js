"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const axios = require("axios");

test("optional live suggestions are private, Philippines-only, and leave manual search available", async t => {
  const routePath = require.resolve("../routes/geocodingRoutes");
  const previousKey = process.env.GEOAPIFY_API_KEY;
  const originalGet = axios.get;
  delete process.env.GEOAPIFY_API_KEY;
  delete require.cache[routePath];

  const app = express();
  app.use("/api/geocoding", require(routePath));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    axios.get = originalGet;
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
    delete require.cache[routePath];
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}/api/geocoding`;
  const offStatus = await (await fetch(`${base}/autocomplete/status`)).json();
  assert.equal(offStatus.enabled, false);
  assert.equal((await fetch(`${base}/autocomplete?q=Quezon%20City`)).status, 503);

  process.env.GEOAPIFY_API_KEY = "test-private-key";
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url, params: options.params });
    return { data: { results: [
      { formatted: "Quezon City, Metro Manila, Philippines", country_code: "ph", lat: 14.67, lon: 121.04 },
      { formatted: "Foreign city", country_code: "us", lat: 40.7, lon: -74 }
    ] } };
  };

  const onStatus = await (await fetch(`${base}/autocomplete/status`)).json();
  assert.equal(onStatus.enabled, true);
  const response = await fetch(`${base}/autocomplete?q=Quezon%20City`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, "https://api.geoapify.com/v1/geocode/autocomplete");
  assert.equal(requests[0].params.filter, "countrycode:ph");
  assert.equal(requests[0].params.apiKey, "test-private-key");
  assert.deepEqual(body.suggestions.map(item => item.display_name), ["Quezon City, Metro Manila, Philippines"]);
  assert.equal(JSON.stringify(body).includes("test-private-key"), false);
});
