const test = require("node:test");
const assert = require("node:assert/strict");
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
