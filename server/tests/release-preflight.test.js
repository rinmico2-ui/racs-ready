"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), { spawnSync } = require("node:child_process"), crypto = require("node:crypto");
const { checkProductionRelease } = require("../../deploy/dokploy/release-preflight.cjs");
const valid = () => ({ NODE_ENV: "production", JWT_SECRET: crypto.randomBytes(32).toString("hex"), EMAIL_OUTBOX_SECRET: crypto.randomBytes(32).toString("hex"), ATTENDANCE_QR_SECRET: crypto.randomBytes(32).toString("hex"), MONGODB_URI: "mongodb://fixture-user:fixture-password@mongo:27017/fixture", MONGODB_ALLOW_PLAINTEXT_INTERNAL: "true" });
test("portable release preflight accepts the intended private Docker configuration without a database connection", () => {
  const result = checkProductionRelease(valid()); assert.equal(result.ready, true); assert.equal(result.scope, "production startup configuration only");
});
test("portable release preflight blocks missing/reused secrets and non-production runtime", () => {
  for (const patch of [{ JWT_SECRET: "short" }, { EMAIL_OUTBOX_SECRET: "" }, { NODE_ENV: "development" }]) assert.equal(checkProductionRelease({ ...valid(), ...patch }).ready, false);
  const env = valid(); env.ATTENDANCE_QR_SECRET = env.JWT_SECRET;
  assert.equal(checkProductionRelease(env).ready, false); assert.equal(checkProductionRelease(valid(), "18.20.0").ready, false);
});
test("portable release preflight blocks public plaintext and unauthenticated MongoDB", () => {
  for (const uri of ["mongodb://fixture-user:fixture-password@203.0.113.1:27017/fixture", "mongodb://mongo:27017/fixture"]) {
    const result = checkProductionRelease({ ...valid(), MONGODB_URI: uri }); assert.equal(result.ready, false);
  }
  assert.equal(checkProductionRelease({ ...valid(), MONGODB_URI: "mongodb+srv://fixture-user:fixture-password@cluster.example.test/fixture" }).ready, true);
});
test("portable release preflight uses the same previous-outbox-key expiry rules as startup", () => {
  const env = { ...valid(), EMAIL_OUTBOX_PREVIOUS_SECRET: "fixture-previous-secret" };
  assert.equal(checkProductionRelease(env).ready, false);
  assert.equal(checkProductionRelease({ ...env, EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL: new Date(Date.now() + 86400000).toISOString() }).ready, true);
});
test("CLI output never reveals secret values or the connection string", () => {
  const env = valid(), result = spawnSync(process.execPath, [path.resolve(__dirname, "../../deploy/dokploy/release-preflight.cjs")], { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0); const output = result.stdout + result.stderr;
  for (const key of ["JWT_SECRET", "EMAIL_OUTBOX_SECRET", "ATTENDANCE_QR_SECRET", "MONGODB_URI"]) assert.equal(output.includes(env[key]), false);
  assert.equal(JSON.parse(result.stdout).ready, true);
});
