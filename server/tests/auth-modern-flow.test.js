"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("signup is a progressive three-step accessible flow", () => {
  const page = read("views/pages/auth.ejs");
  const client = read("public/js/register.js");
  const styles = read("public/css/auth/auth.css");

  assert.equal((page.match(/data-register-step="[123]"/g) || []).length, 3);
  assert.equal((page.match(/data-register-progress="[123]"/g) || []).length, 3);
  assert.match(page, /data-register-next="2"/);
  assert.match(page, /data-register-next="3"/);
  assert.match(page, /data-register-back="1"/);
  assert.match(page, /data-register-back="2"/);
  assert.match(client, /function setRegisterStep\(step, focusHeading\)/);
  assert.match(client, /function validateRegisterStep\(step\)/);
  assert.match(client, /Choose your barangay/);
  assert.match(client, /focusRegisterField\(firstInvalid\)/);
  assert.match(styles, /\.auth-register-progress-item\.active/);
  assert.match(styles, /\.auth-step-next/);
});

test("login remains a compact secure single-step form", () => {
  const page = read("views/pages/auth.ejs");
  const login = page.slice(page.indexOf('<section id="authSignIn"'), page.indexOf('<section id="authSignUp"'));

  assert.match(login, /class="auth-form-context"/);
  assert.match(login, /Customer portal/);
  assert.match(login, /Secure sign in/);
  assert.doesNotMatch(login, /data-register-step/);
});

test("auth layout cache-busts the modern flow styles", () => {
  const layout = read("views/layouts/auth.ejs");
  assert.match(layout, /auth\.css\?v=20260928-modern-auth-flow/);
});
