"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { buildMailerStatus, resolveMailProvider } = require("../utils/mailer");

const emailPage = path.join(__dirname, "../views/pages/admin/Settings/Email.ejs");

test("mailer selects SMTP locally and Brevo for Render or production", () => {
  assert.equal(resolveMailProvider({ NODE_ENV: "development" }).provider, "smtp");
  assert.equal(resolveMailProvider({ RENDER: "true" }).provider, "brevo");
  assert.equal(resolveMailProvider({ NODE_ENV: "production" }).provider, "brevo");
});

test("mailer status reports readiness without exposing credentials", () => {
  const status = buildMailerStatus({
    NODE_ENV: "production",
    FROM_EMAIL: "no-reply@example.com",
    FROM_NAME: "CALIDRO RACS",
    BREVO_API_KEY: "brevo-secret-value",
    SMTP_PASS: "smtp-secret-value",
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.provider, "brevo");
  assert.equal(status.configured, true);
  assert.equal(status.brevo.apiKeyConfigured, true);
  assert.doesNotMatch(serialized, /brevo-secret-value|smtp-secret-value/);
});

test("mailer status identifies missing variables for the active provider", () => {
  const status = buildMailerStatus({ NODE_ENV: "development" });

  assert.equal(status.provider, "smtp");
  assert.equal(status.configured, false);
  assert.deepEqual(status.issues, [
    "FROM_EMAIL is missing",
    "SMTP_HOST is missing",
    "SMTP_USER is missing",
    "SMTP_PASS is missing",
  ]);
});

test("email operations page renders with valid browser JavaScript and unique ids", async () => {
  const html = await ejs.renderFile(emailPage, {
    locals: { user: { email: "admin@example.com" } },
    user: { email: "admin@example.com" },
  });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /admin@example\.com/);
  assert.doesNotMatch(html, /password123/);
});

test("email operations page uses authenticated admin endpoints", () => {
  const source = fs.readFileSync(emailPage, "utf8");

  assert.match(source, /\/api\/admin\/settings\/email-status/);
  assert.match(source, /\/api\/admin\/settings\/email-verify/);
  assert.match(source, /\/api\/admin\/settings\/email-test/);
  assert.match(source, /\/api\/admin\/settings\/email-logs/);
});
