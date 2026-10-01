"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { createBoundedWindow } = require("../utils/boundedWindow");
const { createHttpAdmission } = require("../middleware/httpAdmission");
const { createWorkLimiter } = require("../utils/workLimiter");
const { createSocketTrafficProtection } = require("../utils/socketTrafficProtection");
const { rateLimit, BoundedRateLimitStore } = require("../utils/boundedRateLimit");
const { normalizedIpKey } = require("../utils/rateLimitIdentity");

async function listen(t, app) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("counter memory stays bounded and full stores cannot reset another identity's budget", () => {
  let now = 0;
  const window = createBoundedWindow({ limit: 2, windowMs: 2000, maxKeys: 2, now: () => now });
  assert.equal(window.consume("a").allowed, true);
  assert.equal(window.consume("a").allowed, true);
  assert.equal(window.consume("a").allowed, false);
  window.consume("b");
  assert.equal(window.consume("c").allowed, false);
  assert.equal(window.size, 2);
  assert.equal(window.consume("a").allowed, false);
  now = 2001;
  assert.equal(window.consume("c").allowed, true);
  assert.equal(window.consume("a").allowed, true);
  assert.equal(window.size, 2);
});

test("account limit stores fail closed when full, preserve counters and recover after expiry", async t => {
  let now = Date.now();
  const store = new BoundedRateLimitStore({ maxKeys: 2, now: () => now });
  t.after(() => store.shutdown());
  const app = express();
  app.use(rateLimit({ windowMs: 1000, limit: 1, store, keyGenerator: req => req.headers['x-account'], skipSuccessfulRequests: true }));
  app.get('/', (req, res) => res.status(req.headers['x-account'] === 'b' ? 401 : 200).end());
  const { base } = await listen(t, app);
  const request = account => fetch(base, { headers: { 'x-account': account } });
  assert.equal((await request('a')).status, 200);
  assert.equal((await request('b')).status, 401);
  assert.equal((await request('c')).status, 429);
  assert.equal(store.entries.size, 2);
  assert.equal((await request('a')).status, 200, 'successful existing accounts keep their usual allowance');
  assert.equal((await request('b')).status, 429, 'new identities cannot reset an existing failed-attempt counter');
  now += 1001;
  assert.equal((await request('c')).status, 200);
  assert.ok(store.entries.size <= 2);
});

test("invalid forwarding values share the connection IP rather than creating arbitrary keys", () => {
  const socket = { remoteAddress: '203.0.113.8' };
  assert.equal(normalizedIpKey({ ip: 'attacker-one', socket }), 'ip:203.0.113.8');
  assert.equal(normalizedIpKey({ ip: 'x'.repeat(16000), socket }), 'ip:203.0.113.8');
  assert.equal(normalizedIpKey({ ip: '203.0.113.9', socket }), 'ip:203.0.113.9');
});

test("excess HTTP requests and oversized auth bodies are rejected before parsing or database work", async t => {
  const app = express();
  const guard = createHttpAdmission({ rateLimit: 2 });
  let reads = 0;
  app.use(guard);
  app.use(express.json());
  app.use((_req, res) => { reads += 1; res.json({ ok: true }); });
  const { base } = await listen(t, app);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '"' + "x".repeat(65536) + '"' })).status, 413);
  assert.equal(reads, 0);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "invalid json" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(reads, 1);
});

test("direct requests cannot evade a budget with forged forwarding headers", async t => {
  const app = express();
  app.set("trust proxy", false);
  app.use(createHttpAdmission({ rateLimit: 1 }));
  app.get("/", (_req, res) => res.json({ ok: true }));
  const { base } = await listen(t, app);
  assert.equal((await fetch(base, { headers: { "X-Forwarded-For": "203.0.113.1" } })).status, 200);
  assert.equal((await fetch(base, { headers: { "X-Forwarded-For": "203.0.113.2" } })).status, 429);
});

test("IPv6 addresses in one subnet share the same HTTP budget", () => {
  const guard = createHttpAdmission({ rateLimit: 1 });
  function response() {
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = () => res;
    return res;
  }
  const first = response();
  guard({ ip: "2001:db8:1:1::1", headers: {}, path: "/" }, first, () => {});
  first.emit("finish");
  const second = response();
  guard({ ip: "2001:db8:1:2::2", headers: {}, path: "/" }, second, () => assert.fail("must be limited"));
  assert.equal(second.statusCode, 429);
});

test("a local 100-request burst stays within the active-work ceiling and the service recovers", async t => {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  const guard = createHttpAdmission({ maxActive: 8, maxPerIp: 8 });
  app.use(guard);
  let peak = 0;
  app.get("/work", (_req, res) => {
    peak = Math.max(peak, guard.snapshot().active);
    setTimeout(() => res.json({ ok: true }), 50);
  });
  const { base } = await listen(t, app);
  const responses = await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/work`)));
  const counts = responses.reduce((result, response) => { result[response.status] = (result[response.status] || 0) + 1; return result; }, {});
  await Promise.all(responses.map(response => response.text()));
  assert.ok(counts[200] > 0 && counts[503] > 0);
  assert.ok(peak <= 8);
  assert.equal(guard.snapshot().active, 0);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/work`)).status, 200);
  console.log(`Local admission burst: ${JSON.stringify(counts)}; peak work=${peak}`);
});

test("global capacity covers different clients and large-body slots release only once", () => {
  const guard = createHttpAdmission({ maxActive: 3, maxPerIp: 2, maxLargeBodies: 1 });
  function response() {
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = () => res;
    return res;
  }
  const largeReq = ip => ({ ip, path: "/api/bookings", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
  const first = response();
  guard(largeReq("203.0.113.1"), first, () => {});
  const rejectedLarge = response();
  guard(largeReq("203.0.113.2"), rejectedLarge, () => assert.fail("large body must be refused"));
  assert.equal(rejectedLarge.statusCode, 503);
  const second = response();
  const third = response();
  guard({ ip: "203.0.113.2", headers: {}, path: "/" }, second, () => {});
  guard({ ip: "203.0.113.3", headers: {}, path: "/" }, third, () => {});
  const fourth = response();
  guard({ ip: "203.0.113.4", headers: {}, path: "/" }, fourth, () => assert.fail("global capacity must apply"));
  assert.equal(fourth.statusCode, 503);
  first.emit("close");
  first.emit("finish");
  assert.equal(guard.snapshot().active, 2);
  assert.equal(guard.snapshot().largeBodies, 0);
  second.emit("finish");
  third.emit("finish");
  assert.equal(guard.snapshot().active, 0);
});

test("expensive tasks remain bounded until their work finishes, including failures", async () => {
  const work = createWorkLimiter({ limit: 2, perKeyLimit: 1 });
  let finish;
  const first = work.run("a", () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(work.run("a", () => assert.fail("must not start")), { code: "WORK_CAPACITY_EXCEEDED" });
  await assert.rejects(work.run("b", async () => { throw new Error("provider failure"); }), /provider failure/);
  assert.equal(work.active, 1);
  finish();
  await first;
  assert.equal(work.active, 0);
  assert.equal(await work.run("a", async () => "recovered"), "recovered");
});

test("Socket.IO rejects anonymous, forged and cross-origin transports and caps live connections", async t => {
  const app = express();
  const { server, base } = await listen(t, app);
  const secret = "socket-traffic-test-secret-only";
  const guard = createSocketTrafficProtection({ secret, allowedOrigins: [base], maxConnections: 2, maxPerUser: 1 });
  const io = new Server(server, { maxHttpBufferSize: 16384, allowRequest: (req, callback) => guard.allowRequest(req, callback, io.engine.clientsCount) });
  io.engine.on("connection", connection => guard.trackConnection(connection));
  t.after(() => io.close());
  const url = `${base}/socket.io/?EIO=4&transport=polling`;
  const token = jwt.sign({ id: "aaaaaaaaaaaaaaaaaaaaaaaa" }, secret, { expiresIn: "1m" });
  const headers = { cookie: `auth_token=${token}`, origin: base };
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, cookie: "auth_token=forged" } })).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(url, { headers })).status, 403, "one account cannot open unlimited transports");
  const secondToken = jwt.sign({ id: "bbbbbbbbbbbbbbbbbbbbbbbb" }, secret, { expiresIn: "1m" });
  assert.equal((await fetch(url, { headers: { cookie: `auth_token=${secondToken}`, origin: base } })).status, 200);
  assert.equal(io.engine.clientsCount, 2);
  const thirdToken = jwt.sign({ id: "cccccccccccccccccccccccc" }, secret, { expiresIn: "1m" });
  assert.equal((await fetch(url, { headers: { cookie: `auth_token=${thirdToken}`, origin: base } })).status, 403);
  for (const connection of Object.values(io.engine.clients)) connection.close(true);
  assert.equal(guard.snapshot().connectedUsers, 0);
});

test("socket event limits span tabs and concurrent GPS writes cannot build a queue", async () => {
  const guard = createSocketTrafficProtection({ secret: "test" });
  function socket() {
    return { user: { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" }, use(fn) { this.middleware = fn; }, disconnect() { this.disconnected = true; } };
  }
  const first = socket();
  const second = socket();
  guard.protectPackets(first);
  guard.protectPackets(second);
  let accepted = 0;
  for (let index = 0; index < 20; index += 1) (index % 2 ? first : second).middleware(["gps:update", { lat: 15, lng: 121 }], () => accepted++);
  assert.equal(accepted, 10);
  let finish;
  let writes = 0;
  const handler = guard.wrapGpsHandler(first, () => { writes += 1; return new Promise(resolve => { finish = resolve; }); });
  const pending = handler({});
  await handler({});
  assert.equal(writes, 1);
  finish();
  await pending;
  for (let index = 0; index < 41; index += 1) second.middleware(["tech:join", "id"], () => {});
  assert.equal(second.disconnected, true);
});

test("production wiring admits requests before sessions, body parsers and payment webhooks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const guard = source.indexOf("app.use(httpAdmission)");
  assert.ok(guard > source.indexOf('app.get("/ready"'));
  assert.ok(guard < source.indexOf('express.raw({ type: "application/json"'));
  assert.ok(guard < source.indexOf('express.json({ limit: "64kb"'));
  assert.ok(guard < source.indexOf("session({"));
  assert.ok(guard < source.indexOf("app.use(attachCurrentUser)"));
});
