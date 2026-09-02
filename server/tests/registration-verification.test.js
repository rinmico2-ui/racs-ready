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

  const otpMatch = String(sentMessage.text).match(/\b(\d{6})\b/);
  assert.ok(otpMatch, "expected the email to contain a six-digit OTP");
  assert.notEqual(savedUser.emailVerificationOtpHash, otpMatch[1]);
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

test("registration policy can activate new customers without an email OTP", async (t) => {
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
  assert.equal(pendingUser.emailVerified, true);
  assert.ok(pendingUser.emailVerifiedAt instanceof Date);
  assert.equal(pendingUser.emailVerificationOtpHash, undefined);
  assert.equal(pendingUser.emailVerificationExpires, undefined);
});
