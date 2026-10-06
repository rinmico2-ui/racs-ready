"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { rateLimit } = require("../utils/boundedRateLimit");
const { emailOrIpKey } = require("../utils/rateLimitIdentity");
const {
  shouldSkipAuthAttemptLimit,
  shouldSkipRegistrationAttemptLimit,
  shouldSkipRegistrationBurstLimit,
} = require("../utils/authRateLimitPolicy");

test("many distinct customers on one IP can start signup and login", async t => {
  const app = express();
  app.use(express.json());
  const registrationBurst = rateLimit({ windowMs: 900000, limit: 300, skip: shouldSkipRegistrationBurstLimit });
  const registrationAccount = rateLimit({ windowMs: 900000, limit: 10, keyGenerator: emailOrIpKey, skipSuccessfulRequests: true, skip: shouldSkipRegistrationAttemptLimit });
  const authBurst = rateLimit({ windowMs: 900000, limit: 300, skipSuccessfulRequests: true, skip: shouldSkipAuthAttemptLimit });
  const authAccount = rateLimit({ windowMs: 900000, limit: 10, keyGenerator: emailOrIpKey, skipSuccessfulRequests: true, skip: shouldSkipAuthAttemptLimit });
  app.use("/api/auth", registrationBurst, registrationAccount, authBurst, authAccount);
  app.post("/api/auth/register", (_req, res) => res.status(202).json({ requiresVerification: true }));
  app.post("/api/auth/secure/login", (_req, res) => res.json({ signedIn: true }));

  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, expected] of [["register", 202], ["secure/login", 200]]) {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `customer-${i}@example.test` }),
    })));
    assert.ok(responses.every(response => response.status === expected), `${path}: ${responses.map(response => response.status)}`);
    await Promise.all(responses.map(response => response.arrayBuffer()));
  }
});

test("progressive login state is bounded and preserves existing customers' counters", () => {
  const previous = process.env.LOGIN_PROGRESSIVE_MAX_KEYS;
  process.env.LOGIN_PROGRESSIVE_MAX_KEYS = "2";
  const modulePath = require.resolve("../middleware/loginRateLimiter");
  delete require.cache[modulePath];
  const limiter = require(modulePath);
  try {
    limiter.recordFailed("email", "first@example.test");
    limiter.recordFailed("email", "second@example.test");
    assert.equal(limiter.isBlocked("email", "third@example.test").blocked, true);
    assert.equal(limiter.isBlocked("email", "first@example.test").blocked, false);
    limiter.reset("email", "first@example.test");
    assert.equal(limiter.isBlocked("email", "third@example.test").blocked, false);
    limiter.recordFailed("email", "THIRD@example.test");
    assert.equal(limiter.isBlocked("email", "third@example.test").attemptsRemaining, 4);
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) delete process.env.LOGIN_PROGRESSIVE_MAX_KEYS;
    else process.env.LOGIN_PROGRESSIVE_MAX_KEYS = previous;
  }
});

test("forgot-password failure state rejects new identities when full", async t => {
  const previous = process.env.FORGOT_MAX_KEYS;
  process.env.FORGOT_MAX_KEYS = "2";
  const modulePath = require.resolve("../controllers/authController");
  delete require.cache[modulePath];
  const authController = require(modulePath);
  const User = require("../models/User");
  const audit = require("../utils/audit");
  let lookups = 0;
  t.mock.method(User, "findOne", async () => { lookups += 1; return null; });
  t.mock.method(audit, "logEvent", async () => {});
  try {
    async function request(email) {
      const req = { body: { email, mathCaptcha: "3", mathAnswer: "3" }, headers: {}, ip: "127.0.0.1" };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await authController.forgotPassword(req, res, error => { throw error; });
      return res;
    }
    assert.equal((await request("first@example.test")).statusCode, 200);
    assert.equal((await request("second@example.test")).statusCode, 200);
    assert.equal((await request("third@example.test")).statusCode, 429);
    assert.equal(lookups, 2);
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) delete process.env.FORGOT_MAX_KEYS;
    else process.env.FORGOT_MAX_KEYS = previous;
  }
});
