const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validationResult } = require("express-validator");

const authRoutes = require("../routes/authRoutes");
const authController = require("../controllers/authController");
const {
  REGISTRATION_PASSWORD_MESSAGE,
  getRegistrationPasswordState,
  isValidRegistrationPassword,
} = require("../utils/registrationPasswordPolicy");

function registrationBody(password) {
  return {
    email: "new.customer@example.com",
    password,
    firstName: "New",
    lastName: "Customer",
    phone: "09171234567",
    addressProvince: "Pampanga",
    addressCity: "Angeles",
    addressBarangay: "Balibago",
    addressPostal: "2009",
    mathCaptcha: "4",
    mathAnswer: "4",
  };
}

async function runRegistrationValidators(password) {
  const layer = authRoutes.stack.find((candidate) =>
    candidate.route && candidate.route.path === "/register" && candidate.route.methods.post);
  assert.ok(layer, "expected POST /register");
  const req = { body: registrationBody(password) };
  for (const middleware of layer.route.stack.slice(0, -1)) {
    await new Promise((resolve, reject) => {
      middleware.handle(req, {}, (error) => error ? reject(error) : resolve());
    });
  }
  return { req, errors: validationResult(req) };
}

test("registration password policy matches the three rules shown to customers", () => {
  for (const password of ["Password1", "Password!", "MOREUppercase1", "Password!!"] ) {
    assert.equal(isValidRegistrationPassword(password), true, password);
  }
  for (const password of ["Short1", "password1", "Password", "P".repeat(31) + "1"]) {
    assert.equal(isValidRegistrationPassword(password), false, password);
  }
  assert.deepEqual(getRegistrationPasswordState("Password1"), {
    length: true,
    uppercase: true,
    numberOrSymbol: true,
    valid: true,
  });
});

test("registration route and controller return the same password policy", async () => {
  const valid = await runRegistrationValidators("MoreUPPERCASE1!");
  assert.equal(valid.errors.isEmpty(), true, JSON.stringify(valid.errors.array()));

  const invalid = await runRegistrationValidators("alllowercase");
  assert.equal(invalid.errors.isEmpty(), false);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await authController.register(invalid.req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, REGISTRATION_PASSWORD_MESSAGE);
});

test("sign-up keeps passwords untouched and reports matching separately from strength", () => {
  const client = fs.readFileSync(path.join(__dirname, "../public/js/register.js"), "utf8");
  const view = fs.readFileSync(path.join(__dirname, "../views/pages/auth.ejs"), "utf8");
  const layout = fs.readFileSync(path.join(__dirname, "../views/layouts/auth.ejs"), "utf8");

  assert.doesNotMatch(client, /sanitizePwd|this\.value\s*=\s*sanitize/);
  assert.match(client, /var passwordsMatch = conf\.length > 0 && pwd === conf/);
  assert.match(client, /Passwords match\. Complete the requirements above\./);
  assert.match(client, /Keep typing to match your password\./);
  assert.match(client, /getPasswordState\(password\)\.valid/);
  assert.match(view, /id="register-password"[^>]*minlength="8"[^>]*maxlength="30"/);
  assert.match(view, /id="passwordMatchHint" aria-live="polite"/);
  assert.match(layout, /auth\.css\?v=20260928-modern-auth-flow/);
});
