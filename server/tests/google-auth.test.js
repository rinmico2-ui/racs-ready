const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "google-auth-test-secret";

const googleAuth = require("../controllers/googleAuthController");
const authRoutes = require("../routes/authRoutes");

test("Google auth exposes start and callback routes", () => {
  const routeMethods = authRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);

  assert.ok(routeMethods.includes("get /google"));
  assert.ok(routeMethods.includes("get /google/callback"));
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

test("Google login stays out of the registration panel", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "..", "views", "pages", "auth.ejs"),
    "utf8",
  );
  const loginPanel = view.slice(view.indexOf('id="authSignIn"'), view.indexOf('id="authSignUp"'));
  const registrationPanel = view.slice(view.indexOf('id="authSignUp"'));

  assert.match(loginPanel, /Sign in with Google/);
  assert.doesNotMatch(registrationPanel, /Sign in with Google/);
  assert.ok(
    loginPanel.indexOf("Sign in with Google") < loginPanel.indexOf('id="auth-login-form"'),
    "Google sign-in should appear before the email/password form",
  );
});

test("Google callback is explicitly existing-account only", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "..", "controllers", "googleAuthController.js"),
    "utf8",
  );

  assert.match(controller, /User\.findOne\(\{ email \}\)/);
  assert.doesNotMatch(controller, /User\.(create|findOneAndUpdate)\(/);
  assert.match(controller, /sameSite: "lax"/);
});
