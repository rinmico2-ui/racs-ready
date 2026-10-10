"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const axios = require("axios");

test("live suggestions work without a key, stay Philippines-only, and keep configured keys private", async t => {
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
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url, params: options.params });
    return { data:{ features:[
      { geometry:{ type:'Point',coordinates:[120.9671,15.4863] },properties:{ name:'Cabanatuan',state:'Nueva Ecija',country:'Philippines',countrycode:'PH' } },
      { geometry:{ type:'Point',coordinates:[120,4] },properties:{ name:'Foreign place',countrycode:'MY' } },
    ] } };
  };
  const offStatus = await (await fetch(`${base}/autocomplete/status`)).json();
  assert.equal(offStatus.enabled, true);
  assert.equal(offStatus.provider,'photon');
  const noKeyResponse = await fetch(`${base}/autocomplete?q=Cabanatuan`);
  const noKeyBody = await noKeyResponse.json();
  assert.equal(noKeyResponse.status,200);
  assert.equal(requests[0].url,'https://photon.komoot.io/api/');
  assert.equal(requests[0].params.countrycode,'PH');
  assert.equal(requests[0].params.bbox,'116,4.5,127,21.5');
  assert.deepEqual(noKeyBody.suggestions.map(item => item.display_name),['Cabanatuan, Nueva Ecija, Philippines']);
  await fetch(`${base}/autocomplete?q=cabanatuan`);
  assert.equal(requests.length,1,'case-insensitive results use the same bounded cache');
  assert.equal((await fetch(`${base}/autocomplete?q=ab`)).status,400);

  process.env.GEOAPIFY_API_KEY = "test-private-key";
  requests.length = 0;
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
  axios.get = async (url) => {
    if (url.includes('geoapify')) throw { response:{ status:429 } };
    return { data:{ features:[{ geometry:{ type:'Point',coordinates:[120.95,15.3] },properties:{ name:'Gapan',countrycode:'PH' } }] } };
  };
  const fallback = await fetch(`${base}/autocomplete?q=Gapan`);
  assert.equal(fallback.status,200);
  assert.equal((await fallback.json()).suggestions[0].source,'photon');
});
