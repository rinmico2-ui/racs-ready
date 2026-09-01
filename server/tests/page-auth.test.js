const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

process.env.JWT_SECRET = process.env.JWT_SECRET || "page-auth-test-secret";

const pageAuth = require("../middleware/pageAuth");
const originalFindById = User.findById;

function mockUserLookup(user) {
  User.findById = () => ({
    select: async () => user,
  });
}

function request(token) {
  return {
    headers: { cookie: `auth_token=${encodeURIComponent(token)}` },
    originalUrl: "/admin/services/core",
    session: {},
  };
}

function response() {
  return {
    locals: {},
    headers: {},
    cookies: [],
    redirectUrl: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };
}

function admin(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    role: "admin",
    active: true,
    blocked: false,
    currentSessionId: "session-1",
    ...overrides,
  };
}

function tokenFor(user, options = {}) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      sessionId: options.sessionId || user.currentSessionId,
      rememberMe: Boolean(options.rememberMe),
    },
    process.env.JWT_SECRET,
    { expiresIn: options.expiresIn || "20m" },
  );
}

test.afterEach(() => {
  User.findById = originalFindById;
});

test("admin page auth accepts a matching bound session", async () => {
  const user = admin();
  mockUserLookup(user);
  const req = request(tokenFor(user));
  const res = response();
  let nextCalled = false;

  await pageAuth.requireRole("admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user, user);
  assert.equal(res.redirectUrl, null);
});

test("admin page auth renews a token close to expiry", async () => {
  const user = admin();
  mockUserLookup(user);
  const req = request(tokenFor(user, { expiresIn: "5m" }));
  const res = response();

  await pageAuth.requireRole("admin")(req, res, () => {});

  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].name, "auth_token");
  assert.equal(res.cookies[0].options.httpOnly, true);
  assert.equal(res.cookies[0].options.path, "/");
  const renewed = jwt.verify(res.cookies[0].value, process.env.JWT_SECRET, {
    algorithms: ["HS256"],
  });
  assert.equal(renewed.sessionId, user.currentSessionId);
});

test("admin page auth rejects a revoked bound session", async () => {
  const user = admin();
  mockUserLookup(user);
  const req = request(tokenFor(user, { sessionId: "revoked-session" }));
  const res = response();
  let nextCalled = false;

  await pageAuth.requireRole("admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(
    res.redirectUrl,
    "/login?returnTo=%2Fadmin%2Fservices%2Fcore",
  );
});
