"use strict";

const test = require("node:test");
const { install: installMathChallenge, signedRequest } = require("./helpers/mathChallenge");
installMathChallenge(test);
const assert = require("node:assert/strict");
const User = require("../models/User");
const authController = require("../controllers/authController");
const mailer = require("../utils/mailer");
const rateLimiter = require("../middleware/loginRateLimiter");
const secureAuth = require("../controllers/secureAuthController");
const LoginHistory = require("../models/LoginHistory");
const FailedLoginAttempt = require("../models/FailedLoginAttempt");
const audit = require("../utils/audit");
const challenge = require("../utils/loginOtpChallenge");

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(part => matches(record, part));
    if (key === "$nor") return !expected.some(part => matches(record, part));
    const actual = record[key];
    if (expected === null) return actual == null;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => ({
        $lt: actual < value, $lte: actual <= value, $gt: actual > value, $gte: actual >= value,
      })[operator]);
    }
    return actual === expected;
  });
}

function fixture(t) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-login-otp-secret";
  t.after(() => previous === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = previous);
  const user = {
    _id: "otp-user", email: "admin@example.com", passwordHash: "verified-password-hash", role: "admin",
    active: true, blocked: false, emailVerified: true,
    async comparePassword() { return false; },
    async save() { return this; },
  };
  const query = result => ({ select: async () => result, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) });
  function update(filter, change, after) {
    if (!matches(user, filter)) return after ? null : { modifiedCount: 0 };
    Object.assign(user, change.$set || {});
    for (const [field, amount] of Object.entries(change.$inc || {})) user[field] = (user[field] || 0) + amount;
    for (const field of Object.keys(change.$unset || {})) delete user[field];
    return after ? { ...user } : { modifiedCount: 1 };
  }
  t.mock.method(User, "updateOne", async (filter, change) => update(filter, change));
  t.mock.method(User, "findOne", filter => query(matches(user, filter) ? { ...user } : null));
  t.mock.method(User, "findOneAndUpdate", (filter, change) => query(update(filter, change, true)));
  const req = { body: { email: user.email, csrfToken: "csrf-value" }, cookies: { "XSRF-TOKEN": "csrf-value" }, headers: {} };
  const res = {
    cookies: [], cleared: [], statusCode: 200,
    cookie(name, value, options) { this.cookies.push({ name, value, options }); },
    clearCookie(name) { this.cleared.push(name); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const sent = [];
  const send = async (email, otp, type, options) => { sent.push({ email, otp, type, options }); return { queued: true, messageId: "test-outbox-id" }; };
  const begin = async () => {
    const result = await challenge.begin(user, true, req, res, send);
    req.cookies[challenge.COOKIE_NAME] = res.cookies.at(-1).value;
    return result;
  };
  return { user, req, res, send, sent, begin };
}

test("password login stores only hashes and binds a queued OTP to an HttpOnly browser cookie", async t => {
  const f = fixture(t);
  const result = await f.begin();
  const browser = f.res.cookies[0];
  assert.equal(browser.options.httpOnly, true);
  assert.equal(browser.options.sameSite, "Strict");
  assert.equal(browser.options.path, "/api/auth");
  assert.notEqual(browser.value, f.user.loginOtpChallengeHash);
  assert.match(f.user.loginOtpHash, /^[a-f0-9]{64}$/);
  assert.equal(f.sent[0].options.loginOtp.hash, f.user.loginOtpHash);
  assert.equal(f.sent[0].options.validUntil, result.expiresAt);
  assert.equal(result.deliveryStatus, "queued");
  assert.doesNotMatch(result.message, /was sent|delivered/);
  assert.equal(JSON.stringify(result).includes(f.sent[0].otp), false);
});

test("an email address and even a correct OTP cannot verify or resend without the password browser", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = f.sent[0].otp;
  delete f.req.cookies[challenge.COOKIE_NAME];
  await assert.rejects(challenge.consume(f.req), error => error.restartLogin && error.statusCode === 400);
  await assert.rejects(challenge.resend(f.req, f.send), error => error.restartLogin && error.statusCode === 400);
  assert.equal(f.user.loginOtpAttempts, 0);
  assert.equal(f.sent.length, 1);
});

test("a challenge belonging to another browser cannot consume the active OTP", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.cookies[challenge.COOKIE_NAME] = "a".repeat(64);
  f.req.body.otp = f.sent[0].otp;
  await assert.rejects(challenge.consume(f.req), /expired|attempt limit/);
  assert.equal(f.user.loginOtpAttempts, 0);
});

test("OTP verification and resend enforce CSRF before accessing pending state", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = f.sent[0].otp;
  f.req.body.csrfToken = "forged";
  await assert.rejects(challenge.consume(f.req), error => error.statusCode === 403);
  await assert.rejects(challenge.resend(f.req, f.send), error => error.statusCode === 403);
  assert.equal(f.user.loginOtpAttempts, 0);
});

test("concurrent correct password submissions enqueue only one verification email", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    challenge.begin(f.user, false, f.req, f.res, f.send),
    challenge.begin(f.user, false, f.req, f.res, f.send),
  ]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(results.find(row => row.status === "rejected").reason.statusCode, 429);
  assert.equal(f.sent.length, 1);
});

test("repeating password login in the same browser preserves the pending code within cooldown", async t => {
  const f = fixture(t);
  await f.begin();
  const oldHash = f.user.loginOtpHash;
  const result = await f.begin();
  assert.equal(result.deliveryStatus, "pending");
  assert.equal(f.sent.length, 1);
  assert.equal(f.user.loginOtpHash, oldHash);
});

test("concurrent resends replace a code once, preserving deadline and failed attempts", async t => {
  const f = fixture(t);
  await f.begin();
  f.user.loginOtpAttempts = 2;
  f.user.loginOtpLastSentAt = new Date(Date.now() - 61000);
  const expires = f.user.loginOtpExpires.getTime();
  const oldCode = f.sent[0].otp;
  const result = await Promise.allSettled([challenge.resend(f.req, f.send), challenge.resend(f.req, f.send)]);
  assert.equal(result.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.user.loginOtpExpires.getTime(), expires);
  assert.equal(f.user.loginOtpAttempts, 2);
  f.req.body.otp = oldCode;
  await assert.rejects(challenge.consume(f.req), /incorrect/);
  f.req.body.otp = f.sent[1].otp;
  const verified = await challenge.consume(f.req);
  assert.equal(verified.user._id, f.user._id);
  assert.equal(verified.rememberMe, true);
});

test("parallel wrong guesses share five attempts and password login cannot reset a locked challenge", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = "000000";
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => challenge.consume(f.req)));
  assert.ok(attempts.every(row => row.status === "rejected"));
  assert.equal(f.user.loginOtpAttempts, 5);
  f.user.loginOtpLastSentAt = new Date(Date.now() - 61000);
  await assert.rejects(challenge.begin(f.user, false, f.req, f.res, f.send), error => error.statusCode === 429);
  await assert.rejects(challenge.resend(f.req, f.send), /expired/);
  assert.equal(f.sent.length, 1);
});

test("a valid OTP is consumed once even with parallel verification submissions", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = f.sent[0].otp;
  const results = await Promise.allSettled([challenge.consume(f.req), challenge.consume(f.req)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(f.user.loginOtpHash, undefined);
  assert.equal(f.user.loginOtpChallengeHash, undefined);
  await assert.rejects(challenge.consume(f.req), /expired/);
});

test("password changes and disabled accounts invalidate pending OTPs", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = f.sent[0].otp;
  f.user.passwordHash = "a-new-password-hash";
  await assert.rejects(challenge.consume(f.req), /expired/);
  f.user.passwordHash = "verified-password-hash";
  f.user.blocked = true;
  await assert.rejects(challenge.consume(f.req), /expired/);
  await assert.rejects(challenge.resend(f.req, f.send), /expired/);
});

test("email transport failure invalidates the code and never establishes an OTP browser cookie", async t => {
  const f = fixture(t);
  await assert.rejects(challenge.begin(f.user, false, f.req, f.res, async () => { throw new Error("secret provider error"); }), error => error.statusCode === 503 && !error.message.includes("secret"));
  assert.equal(f.user.loginOtpHash, undefined);
  assert.equal(f.res.cookies.length, 0);
});

test("incorrect password sends no OTP", async t => {
  const f = fixture(t);
  f.req.body.password = "wrong-password";
  f.req.body.mathCaptcha = "8";
  f.req.body.mathAnswer = "8";
  f.req.headers.cookie = "XSRF-TOKEN=csrf-value";
  f.req.ip = "192.0.2.18";
  t.mock.method(rateLimiter, "isBlocked", () => ({ blocked: false }));
  t.mock.method(rateLimiter, "recordFailed", () => ({}));
  let sent = 0;
  t.mock.method(mailer, "sendMail", async () => { sent += 1; });
  signedRequest(f.req, "login");
  await authController.login(f.req, f.res, error => { throw error; });
  assert.equal(f.res.statusCode, 400);
  assert.equal(sent, 0);
  assert.equal(f.res.cookies.length, 0);
});

test("malformed verification payloads never bypass server-side validation", async t => {
  const f = fixture(t);
  f.req.body.email = { $ne: null };
  f.req.body.otp = "123456";
  await authController.verifyLoginOTP(f.req, f.res, error => { throw error; });
  assert.equal(f.res.statusCode, 400);
  await authController.resendLoginOTP(f.req, f.res, error => { throw error; });
  assert.equal(f.res.statusCode, 400);
});

test("staff secure login returns queued status and a browser challenge without signing in early", async t => {
  const f = fixture(t);
  f.user.comparePassword = async () => true;
  f.req.body.password = "verified-password";
  f.req.body.mathCaptcha = "8";
  f.req.body.mathAnswer = "8";
  f.req.headers = { cookie: "XSRF-TOKEN=csrf-value", accept: "application/json", "user-agent": "Test browser" };
  f.req.ip = "192.0.2.18";
  t.mock.method(rateLimiter, "isBlocked", () => ({ blocked: false }));
  t.mock.method(rateLimiter, "reset", () => {});
  t.mock.method(FailedLoginAttempt, "deleteMany", async () => ({}));
  t.mock.method(LoginHistory, "find", () => ({ sort() { return this; }, limit: async () => [] }));
  t.mock.method(mailer, "sendMail", async () => ({ queued: true, messageId: "outbox-test" }));
  signedRequest(f.req, "login");
  await secureAuth.login(f.req, f.res, error => { throw error; });
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.res.body.requiresOTP, true);
  assert.equal(f.res.body.deliveryStatus, "queued");
  assert.ok(f.res.cookies.some(cookie => cookie.name === challenge.COOKIE_NAME));
  assert.equal(f.res.cookies.some(cookie => cookie.name === "auth_token"), false);
});

test("successful OTP verification establishes the intended staff login and clears its challenge", async t => {
  const f = fixture(t);
  await f.begin();
  f.req.body.otp = f.sent[0].otp;
  f.req.headers.accept = "application/json";
  t.mock.method(audit, "logEvent", async () => ({}));
  await authController.verifyLoginOTP(f.req, f.res, error => { throw error; });
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.res.body.redirect, "/admin");
  assert.equal(f.res.body.user.role, "admin");
  const loginCookie = f.res.cookies.find(cookie => cookie.name === "auth_token");
  assert.equal(loginCookie.options.httpOnly, true);
  assert.equal(loginCookie.options.maxAge, 30 * 24 * 60 * 60 * 1000);
  assert.ok(f.res.cleared.includes(challenge.COOKIE_NAME));
  assert.equal(f.user.loginOtpHash, undefined);
});

test("login OTP secrets remain hidden in schema queries and JSON", () => {
  const privateFields = Object.keys(challenge._private.CLEAR_FIELDS);
  const user = new User({ email: "admin@example.com", passwordHash: "password-hash", ...Object.fromEntries(privateFields.map(field => [field, field.includes("Expires") || field.includes("At") ? new Date() : field.includes("Attempts") ? 2 : field.includes("RememberMe") ? true : "private-value"])) });
  for (const field of privateFields) {
    assert.equal(User.schema.path(field).options.select, false);
    assert.equal(user.toJSON()[field], undefined);
  }
});
