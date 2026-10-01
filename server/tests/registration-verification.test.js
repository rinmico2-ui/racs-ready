const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const User = require("../models/User");
const SiteSetting = require("../models/SiteSetting");
const mailer = require("../utils/mailer");
const audit = require("../utils/audit");
const authController = require("../controllers/authController");
const authRoutes = require("../routes/authRoutes");
const { invalidateSystemConfiguration } = require("../utils/systemConfiguration");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    cookies: {},
    clearedCookies: [],
    cookie(name, value, options) {
      this.cookies[name] = { value, options };
      return this;
    },
    clearCookie(name) {
      this.clearedCookies.push(name);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function registrationRequest(overrides = {}) {
  return {
    body: {
      email: "new.customer@example.com",
      password: "Password1!",
      firstName: "New",
      lastName: "Customer",
      phone: "09171234567",
      addressProvince: "Pampanga",
      addressCity: "Angeles",
      addressBarangay: "Balibago",
      addressPostal: "2009",
      mathCaptcha: "4",
      mathAnswer: "4",
      ...overrides,
    },
    headers: {},
    connection: { remoteAddress: "127.0.0.77" },
    ip: "127.0.0.77",
  };
}

test("registration verification routes are exposed", () => {
  for (const path of ["/verify-register-otp", "/resend-register-otp"]) {
    const layer = authRoutes.stack.find(
      (candidate) =>
        candidate.route &&
        candidate.route.path === path &&
        candidate.route.methods.post,
    );
    assert.ok(layer, `expected POST ${path}`);
  }
});

test("registration creates a pending account and sends an OTP without storing it in plaintext", async (t) => {
  invalidateSystemConfiguration();
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "registration-verification-test-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  let savedUser;
  let sentMessage;
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => null }));
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User.prototype, "save", async function savePendingUser() {
    savedUser = this;
    return this;
  });
  t.mock.method(mailer, "sendMail", async (message) => {
    sentMessage = message;
    return { messageId: "registration-test-message" };
  });
  t.mock.method(audit, "logEvent", async () => undefined);

  const req = registrationRequest();
  const res = responseRecorder();
  let forwardedError;
  await authController.register(req, res, (error) => {
    forwardedError = error;
  });

  assert.equal(forwardedError, undefined);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.requiresVerification, true);
  assert.equal(savedUser.emailVerified, false);
  assert.equal(savedUser.emailVerificationOtpHash.length, 64);
  assert.ok(savedUser.emailVerificationExpires > new Date());
  assert.equal(sentMessage.to, "new.customer@example.com");
  assert.equal(sentMessage.source, "registration_otp");

  const otpMatch = String(sentMessage.text).match(/\b(\d{6})\b/);
  assert.ok(otpMatch, "expected the email to contain a six-digit OTP");
  assert.notEqual(savedUser.emailVerificationOtpHash, otpMatch[1]);
  assert.equal(res.cookies.registration_flow.options.httpOnly, true);
  assert.equal(res.cookies.auth_token, undefined);
  assert.notEqual(savedUser.registrationFlowHash, res.cookies.registration_flow.value);
});

test("registration policy can disable public account creation", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  t.mock.method(SiteSetting, "findOne", () => ({
    lean: async () => ({
      value: { application: { allowCustomerRegistrations: false, requireEmailVerification: true } },
    }),
  }));

  const res = responseRecorder();
  await authController.register(registrationRequest(), res, (error) => { throw error; });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.registrationDisabled, true);
});

test("public signup cannot replace a pending invited account", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => null }));
  const invited = new User({
    email: "invited.customer@example.com",
    passwordHash: "existing-hash",
    firstName: "Invited",
    lastName: "Customer",
    phone: "09171234567",
    emailVerified: false,
    accountOrigin: "walk_in_order",
    accountStatus: "invited",
  });
  t.mock.method(User, "findOne", () => ({ select: async () => invited }));
  const res = responseRecorder();
  await authController.register(registrationRequest({ email: invited.email }), res, (error) => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(invited.passwordHash, "existing-hash");
  assert.equal(res.cookies.registration_flow, undefined);
});

test("registration policy can activate new customers without an email OTP", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "registration-verification-test-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  let savedUser;
  let emailSent = false;
  t.mock.method(SiteSetting, "findOne", () => ({
    lean: async () => ({
      value: { application: { allowCustomerRegistrations: true, requireEmailVerification: false } },
    }),
  }));
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  t.mock.method(User.prototype, "save", async function saveActiveUser() {
    savedUser = this;
    return this;
  });
  t.mock.method(mailer, "sendMail", async () => {
    emailSent = true;
    return { messageId: "unexpected" };
  });
  t.mock.method(audit, "logEvent", async () => undefined);

  const res = responseRecorder();
  let forwardedError;
  await authController.register(registrationRequest({ email: "active.customer@example.com" }), res, (error) => {
    forwardedError = error;
  });
  assert.equal(forwardedError, undefined);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.requiresVerification, false);
  assert.equal(res.body.signedIn, true);
  assert.equal(res.body.redirect, "/");
  assert.equal(res.cookies.auth_token.options.httpOnly, true);
  assert.equal(savedUser.emailVerified, true);
  assert.ok(savedUser.emailVerifiedAt instanceof Date);
  assert.equal(emailSent, false);
});

test("a valid persistent registration OTP verifies the account and clears secrets", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const secret = "registration-verification-test-secret";
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const email = "pending.customer@example.com";
  const otp = "654321";
  const pendingUser = new User({
    email,
    passwordHash: "not-used-by-this-test",
    firstName: "Pending",
    lastName: "Customer",
    phone: "09171234567",
    emailVerified: false,
    emailVerificationOtpHash: crypto
      .createHmac("sha256", secret)
      .update(`${email}:${otp}`)
      .digest("hex"),
    emailVerificationExpires: new Date(Date.now() + 60_000),
    emailVerificationLastSentAt: new Date(),
    emailVerificationAttempts: 0,
  });
  pendingUser.save = async () => pendingUser;

  t.mock.method(User, "findOne", () => ({
    select: async () => pendingUser,
  }));
  t.mock.method(audit, "logEvent", async () => undefined);

  const req = registrationRequest({ email, otp });
  const res = responseRecorder();
  let forwardedError;
  await authController.verifyRegisterOTP(req, res, (error) => {
    forwardedError = error;
  });

  assert.equal(forwardedError, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.redirect, "/login?verified=1");
  assert.equal(res.body.signedIn, false);
  assert.equal(pendingUser.emailVerified, true);
  assert.ok(pendingUser.emailVerifiedAt instanceof Date);
  assert.equal(pendingUser.emailVerificationOtpHash, undefined);
  assert.equal(pendingUser.emailVerificationExpires, undefined);
});

test("verifying a registration code in the signup browser signs in without a second OTP", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const secret = "registration-verification-test-secret";
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const email = "same.browser@example.com";
  const otp = "654321";
  const flowToken = crypto.randomBytes(32).toString("hex");
  const pendingUser = new User({
    email,
    passwordHash: "not-used-by-this-test",
    firstName: "Same",
    lastName: "Browser",
    phone: "09171234567",
    emailVerified: false,
    emailVerificationOtpHash: crypto.createHmac("sha256", secret)
      .update(`${email}:${otp}`).digest("hex"),
    emailVerificationExpires: new Date(Date.now() + 60_000),
    registrationFlowHash: crypto.createHash("sha256").update(flowToken).digest("hex"),
  });
  pendingUser.save = async () => pendingUser;
  t.mock.method(User, "findOne", () => ({ select: async () => pendingUser }));
  t.mock.method(audit, "logEvent", async () => undefined);

  const req = registrationRequest({ email, otp });
  req.cookies = { registration_flow: flowToken };
  const res = responseRecorder();
  await authController.verifyRegisterOTP(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.signedIn, true);
  assert.equal(res.body.redirect, "/");
  assert.equal(res.cookies.auth_token.options.httpOnly, true);
  assert.ok(res.clearedCookies.includes("registration_flow"));
  assert.equal(pendingUser.emailVerified, true);
  assert.equal(pendingUser.registrationFlowHash, undefined);
  assert.ok(pendingUser.currentSessionId);
});

test("a new registration cannot be verified from a different browser using only its OTP", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const secret = "registration-verification-test-secret";
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const email = "other.browser@example.com";
  const otp = "654321";
  const pendingUser = new User({
    email,
    passwordHash: "not-used-by-this-test",
    firstName: "Other",
    lastName: "Browser",
    phone: "09171234567",
    emailVerified: false,
    emailVerificationOtpHash: crypto.createHmac("sha256", secret)
      .update(`${email}:${otp}`).digest("hex"),
    emailVerificationExpires: new Date(Date.now() + 60_000),
    registrationFlowHash: crypto.createHash("sha256").update("a".repeat(64)).digest("hex"),
  });
  t.mock.method(User, "findOne", () => ({ select: async () => pendingUser }));
  const res = responseRecorder();
  await authController.verifyRegisterOTP(registrationRequest({ email, otp }), res, (error) => { throw error; });

  assert.equal(res.statusCode, 403);
  assert.equal(pendingUser.emailVerified, false);
  assert.equal(res.cookies.auth_token, undefined);
});

test("a correct OTP cannot bypass the stored attempt limit", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const secret = "registration-verification-test-secret";
  process.env.JWT_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const email = "locked.signup@example.com";
  const otp = "654321";
  const user = new User({
    email,
    passwordHash: "not-used-by-this-test",
    firstName: "Locked",
    lastName: "Signup",
    phone: "09171234567",
    emailVerified: false,
    emailVerificationAttempts: 5,
    emailVerificationOtpHash: crypto.createHmac("sha256", secret)
      .update(`${email}:${otp}`).digest("hex"),
    emailVerificationExpires: new Date(Date.now() + 60_000),
  });
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  const res = responseRecorder();
  await authController.verifyRegisterOTP(registrationRequest({ email, otp }), res, (error) => { throw error; });

  assert.equal(res.statusCode, 429);
  assert.equal(user.emailVerified, false);
  assert.equal(res.cookies.auth_token, undefined);
});

test("resending a new signup code requires its browser and refreshes that browser's cookie", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "registration-verification-test-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const flowToken = crypto.randomBytes(32).toString("hex");
  const user = new User({
    email: "resend.browser@example.com",
    passwordHash: "not-used-by-this-test",
    firstName: "Resend",
    lastName: "Browser",
    phone: "09171234567",
    emailVerified: false,
    emailVerificationLastSentAt: new Date(Date.now() - 120_000),
    registrationFlowHash: crypto.createHash("sha256").update(flowToken).digest("hex"),
  });
  user.save = async () => user;
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  let messagesSent = 0;
  t.mock.method(mailer, "sendMail", async () => {
    messagesSent += 1;
    return { messageId: "resend-test-message" };
  });

  const wrongBrowser = responseRecorder();
  await authController.resendRegisterOTP(registrationRequest({ email: user.email }), wrongBrowser, (error) => { throw error; });
  assert.equal(wrongBrowser.statusCode, 403);
  assert.equal(messagesSent, 0);

  const req = registrationRequest({ email: user.email });
  req.cookies = { registration_flow: flowToken };
  const rightBrowser = responseRecorder();
  await authController.resendRegisterOTP(req, rightBrowser, (error) => { throw error; });
  assert.equal(rightBrowser.statusCode, 200);
  assert.equal(messagesSent, 1);
  assert.equal(rightBrowser.cookies.registration_flow.value, flowToken);
  assert.equal(rightBrowser.cookies.registration_flow.options.httpOnly, true);
});
