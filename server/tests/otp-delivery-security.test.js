"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/User");
const EmailOutbox = require("../models/EmailOutbox");
const outbox = require("../utils/emailOutbox");
const mailer = require("../utils/mailer");
const { lookupDelivery } = require("../utils/brevoDelivery");

function fixture(t, overrides = {}) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "email-outbox-test-secret";
  t.after(() => previous === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = previous);
  const payload = {
    to: "user@example.com", subject: "Login OTP", text: "secret OTP content", source: "login_otp",
    validUntil: new Date(Date.now() + 60000).toISOString(), loginOtp: { userId: "otp-user", hash: "otp-hash" }, ...overrides,
  };
  const job = { _id: "job-id", attempts: 1, ...outbox._private.encryptPayload(payload) };
  t.mock.method(EmailOutbox, "findOneAndUpdate", () => ({ select: async () => job }));
  const updates = [];
  t.mock.method(EmailOutbox, "updateOne", async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; });
  t.mock.method(User, "exists", async () => ({ _id: "otp-user" }));
  let sent = 0;
  t.mock.method(mailer, "deliverMailNow", async () => { sent += 1; return { provider: "brevo", messageId: "provider-message-id" }; });
  return { payload, job, updates, get sent() { return sent; } };
}

test("expired login OTP emails are cancelled without reaching the provider", async t => {
  const f = fixture(t, { validUntil: new Date(Date.now() - 1).toISOString() });
  await outbox._private.processOne();
  assert.equal(f.sent, 0);
  assert.equal(f.updates[0].update.$set.status, "cancelled");
  assert.deepEqual(f.updates[0].update.$unset, { payloadCiphertext: 1, payloadIv: 1, payloadTag: 1 });
});

test("superseded or consumed login OTP emails are discarded", async t => {
  const f = fixture(t);
  let query;
  t.mock.method(User, "exists", async filter => { query = filter; return null; });
  await outbox._private.processOne();
  assert.equal(query.loginOtpHash, f.payload.loginOtp.hash);
  assert.ok(query.loginOtpExpires.$gt instanceof Date);
  assert.equal(f.sent, 0);
  assert.equal(f.updates[0].update.$set.status, "cancelled");
});

test("legacy unbound OTP jobs cannot send a code for a new browser challenge", async t => {
  const f = fixture(t, { loginOtp: undefined, validUntil: undefined });
  await outbox._private.processOne();
  assert.equal(f.sent, 0);
  assert.equal(f.updates[0].update.$set.status, "cancelled");
});

test("accepted OTP jobs retain the provider ID for delivery tracing and erase their payload", async t => {
  const f = fixture(t);
  await outbox._private.processOne();
  assert.equal(f.sent, 1);
  const update = f.updates[0].update;
  assert.equal(update.$set.status, "sent");
  assert.equal(update.$set.providerMessageId, "provider-message-id");
  assert.equal(update.$set.provider, "brevo");
  assert.ok(update.$unset.payloadCiphertext);
});

test("non-login transactional emails keep their existing queue behavior", async t => {
  const f = fixture(t, { source: "booking_confirmation", loginOtp: undefined, validUntil: undefined });
  t.mock.method(User, "exists", async () => { throw new Error("Must not query login state"); });
  await outbox._private.processOne();
  assert.equal(f.sent, 1);
});

test("exhausted email jobs erase encrypted OTP content and retain a failure status", async t => {
  const f = fixture(t);
  f.job.attempts = (Number(process.env.EMAIL_OUTBOX_MAX_ATTEMPTS) || 5) + 1;
  t.mock.method(mailer, "deliverMailNow", async () => { throw new Error("Provider unavailable"); });
  await outbox._private.processOne();
  assert.equal(f.updates[0].update.$set.status, "failed");
  assert.ok(f.updates[0].update.$unset.payloadCiphertext);
  assert.equal(JSON.stringify(f.updates).includes(f.payload.text), false);
});

test("enqueueing preserves OTP expiry and binding inside authenticated ciphertext", async t => {
  const f = fixture(t);
  let saved;
  t.mock.method(EmailOutbox, "create", async payload => { saved = payload; return { _id: "job-id" }; });
  const result = await outbox.enqueueEmail(f.payload);
  const decoded = outbox._private.decryptPayload(saved);
  assert.equal(decoded.validUntil, f.payload.validUntil);
  assert.deepEqual(decoded.loginOtp, f.payload.loginOtp);
  assert.equal(result.queued, true);
  assert.equal(saved.text, undefined);
  assert.equal(JSON.stringify(saved).includes(f.payload.text), false);
});

test("Brevo delivery lookup distinguishes acceptance from recipient-server delivery", async () => {
  let requestedUrl;
  const result = await lookupDelivery("message-id", { apiKey: "test-key", fetchImpl: async url => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ events: [{ messageId: "message-id", event: "requests", email: "private@example.com", content: "private OTP" }] }) };
  } });
  assert.equal(requestedUrl.searchParams.get("messageId"), "message-id");
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(JSON.stringify(result).includes("private"), false);
  const delivered = await lookupDelivery("message-id", { apiKey: "test-key", fetchImpl: async () => ({ ok: true, json: async () => ({ events: [{ messageId: "message-id", event: "delivered" }] }) }) });
  assert.equal(delivered.status, "delivered");
  assert.match(delivered.message, /does not confirm Inbox/);
});

test("Brevo delivery problems expose event reasons without recipient addresses or provider response bodies", async () => {
  const result = await lookupDelivery("message-id", { apiKey: "test-key", fetchImpl: async () => ({ ok: true, json: async () => ({ events: [{ messageId: "message-id", event: "blocked", reason: "Mailbox private@example.com blocked" }] }) }) });
  assert.equal(result.status, "rejected");
  assert.equal(result.events[0].reason, "Mailbox [email] blocked");
  await assert.rejects(lookupDelivery("message-id", { apiKey: "test-key", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ secret: "provider secret" }) }) }), error => !error.message.includes("provider secret"));
});

test("malformed Brevo delivery responses fail with a useful message", async () => {
  await assert.rejects(lookupDelivery("message-id", { apiKey: "test-key", fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("Bad Gateway"); } }) }), /unexpected delivery response/);
});
