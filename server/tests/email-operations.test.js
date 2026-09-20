"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const {
  buildMailerStatus,
  resolveMailProvider,
  buildBookingPaymentEmailDetails,
} = require("../utils/mailer");

const emailPage = path.join(__dirname, "../views/pages/admin/Settings/Email.ejs");

test("mailer selects SMTP locally and Brevo for Render, Railway, or production", () => {
  assert.equal(resolveMailProvider({ NODE_ENV: "development" }).provider, "smtp");
  assert.equal(resolveMailProvider({ RENDER: "true" }).provider, "brevo");
  assert.equal(resolveMailProvider({ RAILWAY_PROJECT_ID: "proj" }).provider, "brevo");
  assert.equal(resolveMailProvider({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }).provider, "brevo");
  assert.equal(resolveMailProvider({ RAILWAY_ENVIRONMENT_NAME: "production" }).provider, "brevo");
  assert.equal(resolveMailProvider({ NODE_ENV: "production" }).provider, "brevo");
});

test("MAIL_PROVIDER override pins the provider on any host", () => {
  assert.equal(resolveMailProvider({ MAIL_PROVIDER: "brevo" }).provider, "brevo");
  assert.equal(resolveMailProvider({ MAIL_PROVIDER: "brevo", NODE_ENV: "development" }).provider, "brevo");
  assert.equal(resolveMailProvider({ MAIL_PROVIDER: "SMTP" }).provider, "smtp");
  assert.equal(resolveMailProvider({ MAIL_PROVIDER: "nonsense" }).provider, "smtp");
  assert.equal(resolveMailProvider({ MAIL_PROVIDER: "brevo" }).overridden, true);
  assert.equal(resolveMailProvider({}).overridden, false);
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

test("booking email payment details include the submitted downpayment and remaining balance", () => {
  const details = buildBookingPaymentEmailDetails({
    paymentMethod: "cod",
    estimatedFee: 5000,
    downpaymentPercentage: 10,
    downpaymentAmount: 500,
    balanceAmount: 4500,
    paymentStatus: "pending",
  });

  assert.equal(details.downpaymentAmount, 500);
  assert.equal(details.balanceAmount, 4500);
  assert.match(details.amountRows, /Downpayment submitted \(10%\)/);
  assert.match(details.amountRows, /₱500\.00/);
  assert.match(details.amountRows, /₱4,500\.00/);
  assert.equal(details.verificationLabel, "Pending receipt verification");
});

test("full-payment booking emails do not present a downpayment balance", () => {
  const details = buildBookingPaymentEmailDetails({
    paymentMethod: "gcash",
    estimatedFee: 5000,
    downpaymentAmount: 5000,
    balanceAmount: 0,
    paymentStatus: "pending",
  });

  assert.match(details.amountRows, /Full payment submitted/);
  assert.doesNotMatch(details.amountRows, /Balance due at completion/);
  assert.equal(details.balanceAmount, 0);
});

test("booking emails name the selected payment channel", () => {
  const full = buildBookingPaymentEmailDetails({ paymentMethod: "gcash", paymentChannel: "maya", estimatedFee: 4000 });
  const deposit = buildBookingPaymentEmailDetails({ paymentMethod: "cod", paymentChannel: "bank_transfer", estimatedFee: 4000, downpaymentAmount: 400, balanceAmount: 3600 });
  assert.equal(full.payLabel, "Full payment via Maya");
  assert.equal(deposit.payLabel, "Bank Transfer reservation downpayment; balance at service completion");
});

test("booking emails describe gateway-free card payments as due at the store", () => {
  const full = buildBookingPaymentEmailDetails({ paymentMethod: "gcash", paymentChannel: "card", estimatedFee: 4000 });
  const deposit = buildBookingPaymentEmailDetails({ paymentMethod: "cod", paymentChannel: "card", estimatedFee: 4000, downpaymentAmount: 400, balanceAmount: 3600 });
  assert.equal(full.payLabel, "Full card payment at RACS store");
  assert.equal(full.verificationLabel, "Payment due at RACS store");
  assert.match(full.amountRows, /Full payment due at store/);
  assert.equal(deposit.payLabel, "Card at RACS store reservation downpayment; balance at service completion");
  assert.match(deposit.amountRows, /Downpayment due at store/);
});

test("booking email repairs a legacy zero-balance default for a downpayment plan", () => {
  const details = buildBookingPaymentEmailDetails({
    paymentMethod: "cod",
    estimatedFee: 5000,
    downpaymentAmount: 500,
    balanceAmount: 0,
  });

  assert.equal(details.balanceAmount, 4500);
  assert.match(details.amountRows, /₱4,500\.00/);
});

test("customer booking confirmation passes authoritative payment breakdown into the mailer", () => {
  const routeSource = fs.readFileSync(path.join(__dirname, "../routes/bookingRoutesNew.js"), "utf8");
  const mailerSource = fs.readFileSync(path.join(__dirname, "../utils/mailer.js"), "utf8");

  assert.match(routeSource, /downpaymentPercentage:\s*booking\.downpaymentPercentage/);
  assert.match(routeSource, /downpaymentAmount:\s*booking\.downpaymentAmount/);
  assert.match(routeSource, /balanceAmount:\s*booking\.balanceAmount/);
  assert.match(mailerSource, /\$\{paymentDetails\.amountRows\}/);
  assert.match(mailerSource, /Pending receipt verification/);
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
