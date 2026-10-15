'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const axios = require('axios');

async function fixture(t) {
  const route = require.resolve('../routes/geocodingRoutes');
  const suggestions = require.resolve('../utils/addressSuggestions');
  const previousKey = process.env.GEOAPIFY_API_KEY;
  const originalGet = axios.get, originalNow = Date.now, originalWarn = console.warn;
  const warnings = [];
  delete process.env.GEOAPIFY_API_KEY;
  delete require.cache[route]; delete require.cache[suggestions];
  console.warn = message => warnings.push(message);
  const app = express(); app.use('/api/geocoding', require(route));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => {
    axios.get = originalGet; Date.now = originalNow; console.warn = originalWarn;
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
    delete require.cache[route]; delete require.cache[suggestions];
    server.closeAllConnections(); server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}/api/geocoding`, warnings };
}
const photon = label => ({ data: { features: [{ geometry: { type: 'Point', coordinates: [121.0075, 15.9003] }, properties: { name: label, city: 'Carranglan', state: 'Nueva Ecija', countrycode: 'PH' } }] } });

test('a Photon timeout pauses live lookups while explicit Puncan Search still works', async t => {
  const f = await fixture(t), calls = [];
  axios.get = async (url, options) => {
    calls.push({ url, params: options.params });
    if (url.endsWith('/api/')) throw Object.assign(new Error('provider timeout'), { code: 'ECONNABORTED' });
    return { data: [{ display_name: 'Puncan, Carranglan, Nueva Ecija, Philippines', lat: '15.9003', lon: '121.0075', address: { country_code: 'ph' } }] };
  };
  const failed = await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue');
  const body = await failed.json();
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('retry-after'), '30');
  assert.equal(body.code, 'ADDRESS_SUGGESTIONS_UNAVAILABLE');
  assert.equal(body.manualSearchAvailable, true); assert.match(body.error, /Press Search/);
  assert.equal((await fetch(f.base + '/autocomplete?q=Unknown%20Street')).status, 503);
  assert.equal(calls.length, 1, 'the outage must not send a provider request for every keystroke');
  const health = await (await fetch(f.base + '/autocomplete/status')).json();
  assert.equal(health.enabled, true); assert.equal(health.liveEnabled, false); assert.ok(health.retryAfter > 0);
  assert.equal(calls.length, 1, 'status must use local health instead of making a provider request');
  const local = await fetch(f.base + '/autocomplete?q=Puncan');
  assert.equal(local.status, 200); const item = (await local.json()).suggestions[0];
  assert.equal(item.source, 'psgc'); assert.equal(item.lat, null); assert.match(item.display_name, /Puncan, Carranglan/);
  assert.equal(calls.length, 1, 'local suggestions must work during provider cooldown without network calls');
  const search = await fetch(f.base + '/search?q=Puncan');
  assert.equal(search.status, 200);
  assert.match((await search.json())[0].display_name, /Puncan, Carranglan/);
  assert.equal(calls.length, 2); assert.equal(calls[1].params.countrycodes, 'ph');
});

test('a failed keyed provider is skipped during cooldown while healthy Photon supplies suggestions', async t => {
  const f = await fixture(t), calls = [];
  process.env.GEOAPIFY_API_KEY = 'private-key-do-not-display';
  axios.get = async (url) => {
    calls.push(url);
    if (url.includes('geoapify')) throw Object.assign(new Error('private-key-do-not-display'), { response: { status: 401 } });
    return photon('Puncan');
  };
  for (const query of ['Unmapped%20Avenue', 'Unknown%20Street']) {
    const response = await fetch(f.base + '/autocomplete?q=' + query);
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.suggestions[0].source, 'photon');
    assert.doesNotMatch(JSON.stringify(body), /private-key/);
  }
  assert.equal(calls.filter(url => url.includes('geoapify')).length, 1);
  assert.equal((await (await fetch(f.base + '/autocomplete/status')).json()).enabled, true);
  assert.doesNotMatch(f.warnings.join('\n'), /private-key|Puncan|Carranglan/);
});

test('cooldown expires and an uncached failed address can recover without restarting the server', async t => {
  const f = await fixture(t); let calls = 0;
  axios.get = async () => { calls++; throw Object.assign(new Error('upstream failure'), { response: { status: 502 } }); };
  assert.equal((await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue')).status, 503);
  const now = Date.now(); Date.now = () => now + 31000;
  assert.equal((await (await fetch(f.base + '/autocomplete/status')).json()).enabled, true);
  axios.get = async () => { calls++; return photon('Puncan'); };
  const recovered = await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue');
  assert.equal(recovered.status, 200); assert.equal((await recovered.json()).suggestions.length, 1);
  await fetch(f.base + '/autocomplete?q=unmapped%20avenue');
  assert.equal(calls, 2, 'a failure is not cached as an empty success, and a real success is cached');
});

test('HTML success responses are treated as unavailable while valid empty provider results remain cacheable', async t => {
  const f = await fixture(t); let calls = 0;
  axios.get = async () => { calls++; return { data: 'Bad Gateway' }; };
  const malformed = await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue');
  assert.equal(malformed.status, 503); assert.doesNotMatch(JSON.stringify(await malformed.json()), /Bad Gateway/);
  const now = Date.now(); Date.now = () => now + 31000;
  axios.get = async () => { calls++; return { data: { features: [] } }; };
  const empty = await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue');
  assert.equal(empty.status, 200); assert.deepEqual((await empty.json()).suggestions, []);
  await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue'); assert.equal(calls, 2);
});

test('cached successful suggestions remain usable during an outage for other queries', async t => {
  const f = await fixture(t); let calls = 0;
  axios.get = async () => { calls++; return photon('Puncan'); };
  assert.equal((await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue')).status, 200);
  axios.get = async () => { calls++; throw new Error('network offline'); };
  assert.equal((await fetch(f.base + '/autocomplete?q=Unknown%20Street')).status, 503);
  const cached = await fetch(f.base + '/autocomplete?q=unmapped%20avenue');
  assert.equal(cached.status, 200); assert.equal((await cached.json()).suggestions.length, 1);
  assert.equal(calls, 2);
});

test('provider Retry-After is honored without sleeping inside a request', async t => {
  const f = await fixture(t); let calls = 0;
  axios.get = async () => { calls++; throw Object.assign(new Error('throttled'), { response: { status: 429, headers: { 'retry-after': '75' } } }); };
  const throttled = await fetch(f.base + '/autocomplete?q=Unmapped%20Avenue');
  assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '75');
  assert.equal((await throttled.json()).retryAfter, 75000);
  assert.equal((await fetch(f.base + '/autocomplete?q=Unknown%20Street')).status, 503);
  assert.equal(calls, 1);
});
