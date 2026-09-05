const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validationResult } = require("express-validator");

const authRoutes = require("../routes/authRoutes");
const secureAuthRoutes = require("../routes/secureAuth");

async function validateLogin(router, body) {
  const layer = router.stack.find(
    (candidate) =>
      candidate.route &&
      candidate.route.path === "/login" &&
      candidate.route.methods.post,
  );

  assert.ok(layer, "expected the POST /login route to exist");

  const req = { body: { ...body } };
  const validationMiddleware = layer.route.stack.slice(0, -1);

  for (const middleware of validationMiddleware) {
    await new Promise((resolve, reject) => {
      middleware.handle(req, {}, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return validationResult(req);
}

const validCaptcha = {
  mathCaptcha: "4",
  mathAnswer: "4",
  csrfToken: "test-csrf-token",
};

for (const [name, router] of [
  ["legacy", authRoutes],
  ["secure", secureAuthRoutes],
]) {
  test(`${name} login accepts existing password formats`, async () => {
    for (const password of [
      "ChangeMe123!",
      "password",
      "old123",
      "Correct-Horse_Battery Staple!",
    ]) {
      const result = await validateLogin(router, {
        email: "staff+dispatch@accounts.example.com",
        password,
        ...validCaptcha,
      });

      assert.equal(
        result.isEmpty(),
        true,
        `${password} was rejected: ${JSON.stringify(result.array())}`,
      );
    }
  });

  test(`${name} login still rejects unsafe credential input`, async () => {
    const emptyPassword = await validateLogin(router, {
      email: "user@example.com",
      password: "",
      ...validCaptcha,
    });
    assert.equal(emptyPassword.isEmpty(), false);

    const oversizedPassword = await validateLogin(router, {
      email: "user@example.com",
      password: "a".repeat(129),
      ...validCaptcha,
    });
    assert.equal(oversizedPassword.isEmpty(), false);

    const invalidEmail = await validateLogin(router, {
      email: "not-an-email",
      password: "password",
      ...validCaptcha,
    });
    assert.equal(invalidEmail.isEmpty(), false);
  });
}

test("login does not apply the new-password minimum length policy", () => {
  const publicJs = path.join(__dirname, "..", "public", "js");
  const loginClient = fs.readFileSync(path.join(publicJs, "login.js"), "utf8");
  const registerClient = fs.readFileSync(path.join(publicJs, "register.js"), "utf8");
  const resetClient = fs.readFileSync(path.join(publicJs, "reset.js"), "utf8");

  assert.doesNotMatch(loginClient, /password\.length\s*<\s*8|Password must be at least 8/i);
  assert.match(registerClient, /password\.length\s*<\s*8/);
  assert.match(resetClient, /password\.length\s*<\s*8/);
});
