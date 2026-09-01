const test = require("node:test");
const assert = require("node:assert/strict");

const TrustedDevice = require("../models/TrustedDevice");
const trustedDevices = require("../utils/trustedDevices");
const User = require("../models/User");
const authController = require("../controllers/authController");
const rateLimiter = require("../middleware/loginRateLimiter");
const mailer = require("../utils/mailer");
const audit = require("../utils/audit");

function request(overrides = {}) {
  return {
    cookies: {},
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/140.0 Windows NT 10.0",
      ...overrides.headers,
    },
    ip: "203.0.113.25",
    connection: { remoteAddress: "203.0.113.25" },
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    cleared: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cleared.push({ name, options });
    },
  };
}

function loginRequest() {
  return request({
    body: {
      email: "technician@example.com",
      password: "ValidPassword1!",
      mathCaptcha: "8",
      mathAnswer: "8",
      csrfToken: "csrf-test",
      rememberMe: false,
    },
    headers: {
      cookie: "XSRF-TOKEN=csrf-test",
      "user-agent": "Mozilla/5.0 Chrome/140.0 Windows NT 10.0",
    },
  });
}

function mockSuccessfulPasswordLogin(t) {
  const user = {
    _id: "technician-user-id",
    role: "technician",
    email: "technician@example.com",
    active: true,
    blocked: false,
    emailVerified: true,
    async comparePassword() { return true; },
    async save() { return this; },
  };
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(rateLimiter, "isBlocked", () => ({ blocked: false }));
  t.mock.method(rateLimiter, "reset", () => {});
  t.mock.method(audit, "logEvent", async () => ({}));
  return user;
}

test("trusted-device schema keeps the token hash private and expires records", () => {
  assert.equal(TrustedDevice.schema.path("tokenHash").options.select, false);
  const ttlIndex = TrustedDevice.schema
    .indexes()
    .find(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0);
  assert.ok(ttlIndex, "expected an expiresAt TTL index");
});

test("issuing and validating a technician device stores only a hash and rotates its cookie", async (t) => {
  let created;
  let rotatedUpdate;
  const record = {
    _id: "trusted-device-id",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    passwordChangedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  t.mock.method(TrustedDevice, "create", async (payload) => {
    created = payload;
    Object.assign(record, payload);
    return record;
  });
  t.mock.method(TrustedDevice, "find", () => ({
    sort() { return this; },
    skip() { return this; },
    select() { return this; },
    async lean() { return []; },
  }));
  t.mock.method(TrustedDevice, "findOne", () => ({
    select: async () => record,
  }));
  t.mock.method(TrustedDevice, "updateOne", async (query, update) => {
    rotatedUpdate = { query, update };
    return { modifiedCount: 1 };
  });

  const user = {
    _id: "technician-user-id",
    role: "technician",
    lastPasswordChange: new Date("2026-01-01T00:00:00.000Z"),
  };
  const firstResponse = responseRecorder();
  await trustedDevices.issue(request(), firstResponse, user);

  assert.equal(firstResponse.cookies.length, 1);
  const firstCookie = firstResponse.cookies[0];
  assert.equal(firstCookie.name, trustedDevices.COOKIE_NAME);
  assert.equal(firstCookie.options.httpOnly, true);
  assert.equal(firstCookie.options.sameSite, "Strict");
  assert.notEqual(created.tokenHash, firstCookie.value);
  assert.equal(
    created.tokenHash,
    trustedDevices._private.hashToken(firstCookie.value),
  );

  const secondResponse = responseRecorder();
  const valid = await trustedDevices.validateAndRotate(
    request({ cookies: { [trustedDevices.COOKIE_NAME]: firstCookie.value } }),
    secondResponse,
    user,
  );

  assert.equal(valid, true);
  assert.equal(secondResponse.cookies.length, 1);
  assert.notEqual(secondResponse.cookies[0].value, firstCookie.value);
  assert.equal(rotatedUpdate.query.tokenHash, created.tokenHash);
  assert.equal(
    rotatedUpdate.update.$set.tokenHash,
    trustedDevices._private.hashToken(secondResponse.cookies[0].value),
  );
});

test("a password change invalidates an existing trusted device", async (t) => {
  let saved = false;
  const record = {
    _id: "trusted-device-id",
    expiresAt: new Date(Date.now() + 60_000),
    passwordChangedAt: new Date("2026-01-01T00:00:00.000Z"),
    async save() {
      saved = true;
      return this;
    },
  };
  t.mock.method(TrustedDevice, "findOne", () => ({
    select: async () => record,
  }));

  const res = responseRecorder();
  const valid = await trustedDevices.validateAndRotate(
    request({ cookies: { [trustedDevices.COOKIE_NAME]: "old-device-token" } }),
    res,
    {
      _id: "technician-user-id",
      role: "technician",
      lastPasswordChange: new Date("2026-02-01T00:00:00.000Z"),
    },
  );

  assert.equal(valid, false);
  assert.equal(saved, true);
  assert.ok(record.revokedAt instanceof Date);
  assert.equal(res.cleared[0].name, trustedDevices.COOKIE_NAME);
});

test("a trusted cookie copied to a materially different device is rejected", async (t) => {
  const originalAgent = "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0";
  const copiedAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Version/19.0 Mobile Safari/604.1";
  let saved = false;
  const record = {
    _id: "trusted-device-id",
    label: trustedDevices._private.deviceLabel(originalAgent),
    expiresAt: new Date(Date.now() + 60_000),
    async save() {
      saved = true;
      return this;
    },
  };
  assert.notEqual(record.label, trustedDevices._private.deviceLabel(copiedAgent));
  t.mock.method(TrustedDevice, "findOne", () => ({
    select: async () => record,
  }));

  const res = responseRecorder();
  const valid = await trustedDevices.validateAndRotate(
    request({
      cookies: { [trustedDevices.COOKIE_NAME]: "copied-device-token" },
      headers: { "user-agent": copiedAgent },
    }),
    res,
    { _id: "technician-user-id", role: "technician" },
  );

  assert.equal(valid, false);
  assert.equal(saved, true);
  assert.ok(record.revokedAt instanceof Date);
  assert.equal(res.cleared[0].name, trustedDevices.COOKIE_NAME);
});

test("the production login endpoint skips OTP for a trusted technician device", async (t) => {
  mockSuccessfulPasswordLogin(t);
  t.mock.method(trustedDevices, "validateAndRotate", async () => true);
  t.mock.method(mailer, "sendMail", async () => {
    throw new Error("OTP email must not be sent for a trusted device");
  });

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "trusted-device-test-secret-that-is-long-enough";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const res = responseRecorder();
  await authController.login(loginRequest(), res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.redirect, "/technician");
  assert.equal(res.body.trustedDevice, true);
  assert.equal(res.body.requiresOTP, undefined);
  assert.ok(res.cookies.some((cookie) => cookie.name === "auth_token"));
});

test("the production login endpoint requires OTP for an untrusted technician device", async (t) => {
  mockSuccessfulPasswordLogin(t);
  t.mock.method(trustedDevices, "validateAndRotate", async () => false);
  let emailSent = false;
  t.mock.method(mailer, "sendMail", async () => {
    emailSent = true;
    return { messageId: "login-otp-test" };
  });

  const res = responseRecorder();
  await authController.login(loginRequest(), res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.requiresOTP, true);
  assert.equal(res.body.canTrustDevice, true);
  assert.equal(emailSent, true);
  assert.equal(res.cookies.some((cookie) => cookie.name === "auth_token"), false);
});
