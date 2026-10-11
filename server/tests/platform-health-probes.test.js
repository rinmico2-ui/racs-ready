"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");

// Exercise the actual middleware order without loading the application's
// database connection, account seeding, mail workers or background schedulers.
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = source.indexOf("// Lightweight platform probes.");
const end = source.indexOf("// Public assets and platform probes", start);
assert.ok(start >= 0 && end > start);
const middleware = source.slice(start, end);

async function fixture(t, { readyState = 1, shuttingDown = false, appUrl = "https://racs.example.com" } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  const connection = { readyState };
  vm.runInNewContext(middleware, {
    app, mongoose: { connection }, shuttingDown, URL,
    process: { env: { NODE_ENV: "production", APP_URL: appUrl } },
  });
  app.get("/profile", (_req, res) => res.json({ protectedPage: true }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (route, options = {}) => fetch(base + route, { redirect: "manual", ...options });
}

test("container HTTP probes return JSON directly while customer pages retain HTTPS protection", async t => {
  const request = await fixture(t);
  for (const route of ["/health", "/ready"]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).database, "connected");
  }
  const head = await request("/ready", { method: "HEAD" });
  assert.equal(head.status, 200);
  const privateResponse = await request("/profile?tab=account");
  assert.equal(privateResponse.status, 308);
  assert.equal(privateResponse.headers.get("location"), "https://racs.example.com/profile?tab=account");
  const secured = await request("/profile", { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(secured.status, 200);
});

for (const state of [{ readyState: 0 }, { readyState: 2 }, { readyState: 1, shuttingDown: true }]) {
  test(`readiness reports 503 during database state ${state.readyState} or shutdown ${Boolean(state.shuttingDown)}`, async t => {
    const request = await fixture(t, state);
    const ready = await request("/ready");
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).status, "not_ready");
    const health = await request("/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
  });
}

test("probes remain available without a configured public URL and do not bypass HTTPS for other paths", async t => {
  const request = await fixture(t, { appUrl: "" });
  assert.equal((await request("/ready")).status, 200);
  const privateResponse = await request("/profile");
  assert.equal(privateResponse.status, 400);
  assert.equal((await privateResponse.json()).error, "HTTPS is required");
  assert.equal((await request("/health/private")).status, 400);
});
