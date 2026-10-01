const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");

process.env.JWT_SECRET = process.env.JWT_SECRET || "google-auth-test-secret";

const googleAuth = require("../controllers/googleAuthController");
const authRoutes = require("../routes/authRoutes");
const User = require("../models/User");
const SiteSetting = require("../models/SiteSetting");
const AuthSession = require("../models/AuthSession");
const audit = require("../utils/audit");
const authController = require("../controllers/authController");
const { invalidateSystemConfiguration } = require("../utils/systemConfiguration");

test("Google auth exposes sign-in and customer signup routes", () => {
  const routeMethods = authRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);

  assert.ok(routeMethods.includes("get /google"));
  assert.ok(routeMethods.includes("get /google/callback"));
  assert.ok(routeMethods.includes("get /google/signup"));
  assert.ok(routeMethods.includes("post /google/complete-signup"));
});

test("Google auth only accepts local return paths", () => {
  const { safeReturnTo } = googleAuth._test;

  assert.equal(safeReturnTo("/bookings?tab=active"), "/bookings?tab=active");
  assert.equal(safeReturnTo("%2Forders%2Fcurrent"), "/orders/current");
  assert.equal(safeReturnTo("https://evil.example/path"), "");
  assert.equal(safeReturnTo("//evil.example/path"), "");
  assert.equal(safeReturnTo("%2F%2Fevil.example/path"), "");
});

test("Google auth starts on the callback origin so the state cookie survives", () => {
  const { canonicalStartUrl } = googleAuth._test;
  const config = {
    redirectUri: "https://calidroracs.devs.surf/api/auth/google/callback",
  };
  const req = {
    protocol: "https",
    query: { returnTo: "/orders/current" },
    get(name) {
      return name === "host" ? "racs-ready-whdl.onrender.com" : "";
    },
  };

  assert.equal(
    canonicalStartUrl(req, config),
    "https://calidroracs.devs.surf/api/auth/google?returnTo=%2Forders%2Fcurrent",
  );

  req.get = (name) => (name === "host" ? "calidroracs.devs.surf" : "");
  assert.equal(canonicalStartUrl(req, config), "");
});

test("Google OAuth state cookie is secure for an HTTPS callback", () => {
  const { stateCookieOptions } = googleAuth._test;
  const options = stateCookieOptions({
    redirectUri: "https://calidroracs.devs.surf/api/auth/google/callback",
  });

  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/api/auth/google/callback");
});

test("Google sign-in and signup appear in their respective panels", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "..", "views", "pages", "auth.ejs"),
    "utf8",
  );
  const loginPanel = view.slice(view.indexOf('id="authSignIn"'), view.indexOf('id="authSignUp"'));
  const registrationPanel = view.slice(view.indexOf('id="authSignUp"'));

  assert.match(loginPanel, /Sign in with Google/);
  assert.match(registrationPanel, /Sign up with Google/);
  assert.ok(
    loginPanel.indexOf("Sign in with Google") > loginPanel.indexOf('id="auth-login-form"'),
    "Google sign-in should appear below the email/password form",
  );
});

test("Google signup requires a signed state and complete customer details", () => {
  const { signupState, signupDetails, signupCookieOptions } = googleAuth._test;
  const token = jwt.sign({ purpose: "google_customer_signup", sub: "google-123", email: "new@gmail.com" },
    process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 60 });
  assert.equal(signupState({ cookies: { google_signup_state: token } }).sub, "google-123");
  assert.equal(signupState({ cookies: { google_signup_state: "forged" } }), null);
  assert.equal(signupCookieOptions({ redirectUri: "https://example.com/callback" }).httpOnly, true);
  assert.equal(signupDetails({ firstName: "Ana", lastName: "Cruz", phone: "09171234567",
    addressProvince: "01", addressCity: "0101", addressBarangay: "010101", addressPostal: "2009",
    termsAccepted: true }).phone, "09171234567");
  assert.equal(signupDetails({ firstName: "Ana", lastName: "Cruz", phone: "bad", termsAccepted: true }), null);
});

function signupRequest(email) {
  const token = jwt.sign({ purpose: "google_customer_signup", sub: "google-123", email, returnTo: "/" },
    process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 60 });
  return {
    cookies: { google_signup_state: token },
    body: { firstName: "Ana", lastName: "Cruz", phone: "09171234567",
      addressProvince: "01", addressCity: "0101", addressBarangay: "010101",
      addressPostal: "2009", termsAccepted: true },
    sessionID: "session-test",
    session: { regenerate(done) { done(); }, save(done) { done(); } },
    headers: {},
    ip: "127.0.0.1",
  };
}

function signupResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    clearCookie() { return this; },
  };
}

test("first-time Google signup creates a verified customer without an emailed OTP", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => null }));
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  let saved;
  t.mock.method(User.prototype, "save", async function () { saved = this; return this; });
  t.mock.method(AuthSession, "create", async () => undefined);
  t.mock.method(audit, "logEvent", async () => undefined);
  t.mock.method(authController, "establishJwtLogin", async () => "/");
  const res = signupResponse();
  await googleAuth.completeSignup(signupRequest("new@gmail.com"), res, (error) => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(saved.email, "new@gmail.com");
  assert.equal(saved.googleSubject, "google-123");
  assert.equal(saved.emailVerified, true);
  assert.ok(saved.passwordHash);
  assert.equal(res.body.redirect, "/");
});

test("Google claim of an unverified email signup replaces its old password", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => null }));
  const user = new User({ email: "pending@gmail.com", role: "customer", accountOrigin: "self_registration",
    firstName: "Pending", lastName: "Person", phone: "09171234567", passwordHash: "old-password-hash",
    emailVerified: false, emailVerificationOtpHash: "old-otp" });
  user.isNew = false;
  t.mock.method(User, "findOne", (query) => ({ select: async () => query.email ? user : null }));
  t.mock.method(user, "save", async () => user);
  t.mock.method(AuthSession, "create", async () => undefined);
  t.mock.method(audit, "logEvent", async () => undefined);
  t.mock.method(authController, "establishJwtLogin", async () => "/");
  const res = signupResponse();
  await googleAuth.completeSignup(signupRequest("pending@gmail.com"), res, (error) => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(user.emailVerified, true);
  assert.equal(user.emailVerificationOtpHash, undefined);
  assert.notEqual(user.passwordHash, "old-password-hash");
});

test("Google signup respects disabled customer registration", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => ({
    value: { application: { allowCustomerRegistrations: false } },
  }) }));
  t.mock.method(User, "findOne", () => { throw new Error("No account lookup should run"); });
  const res = signupResponse();
  await googleAuth.completeSignup(signupRequest("new@gmail.com"), res, (error) => { throw error; });
  assert.equal(res.statusCode, 403);
});

test("verified first-time Google identity opens profile completion", async (t) => {
  invalidateSystemConfiguration();
  t.after(invalidateSystemConfiguration);
  const previous = {
    id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  };
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-test";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret-test";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://example.com/api/auth/google/callback";
  t.after(() => {
    for (const [key, value] of Object.entries({
      GOOGLE_OAUTH_CLIENT_ID: previous.id,
      GOOGLE_OAUTH_CLIENT_SECRET: previous.secret,
      GOOGLE_OAUTH_REDIRECT_URI: previous.redirect,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(google.auth, "OAuth2", function () {
    this.getToken = async () => ({ tokens: { id_token: "verified-token" } });
    this.verifyIdToken = async () => ({ getPayload: () => ({
      sub: "google-123", email: "first@gmail.com", email_verified: true,
      nonce: "test-nonce", given_name: "Ana", family_name: "Cruz",
    }) });
  });
  t.mock.method(SiteSetting, "findOne", () => ({ lean: async () => null }));
  t.mock.method(User, "findOne", () => ({ select: async () => null }));
  const stateToken = jwt.sign({ purpose: "google_oauth_login", state: "test-state",
    nonce: "test-nonce", codeVerifier: "test-verifier", returnTo: "/" },
    process.env.SESSION_SECRET || process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 60 });
  const req = {
    cookies: { google_oauth_state: stateToken },
    query: { state: "test-state", code: "auth-code" },
  };
  const res = {
    cookie(name, value) { this.cookies ||= {}; this.cookies[name] = value; return this; },
    clearCookie() { return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; },
  };
  await googleAuth.callback(req, res);
  assert.equal(res.statusCode, 303);
  assert.equal(res.redirectUrl, "/api/auth/google/signup");
  assert.equal(googleAuth._test.signupState({ cookies: res.cookies }).email, "first@gmail.com");
});
