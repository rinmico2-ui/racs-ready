"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const { createAuthAdmission } = require("../middleware/authAdmission");
const { consumeSecurityBudget } = require("../utils/securityRateBudget");
const SecurityRateBucket = require("../models/SecurityRateBucket");
const AuthChallengeUse = require("../models/AuthChallengeUse");
const { issueMathChallenge, verifyMathChallenge } = require("../utils/mathChallenge");
const { deploymentSecretIssues } = require("../utils/deploymentSecrets");
const { validSocketAccount, installSocketAuthorization } = require("../utils/socketAuthorization");
const { requireProofAccess } = require("../middleware/projectProofAccess");
const { encryptPayload, decryptPayload } = require("../utils/emailOutbox")._private;
const Payment = require("../models/Payment");
const Project = require("../models/Project");
const Submission = require("../models/ProjectWorkSubmission");
const Technician = require("../models/Technician");
const paymongo = require("../utils/paymongo");

function response() {
  return { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() {} };
}
function query(value) { return { select() { return this; }, maxTimeMS() { return this; }, lean: async () => value }; }
function environment(t, changes) {
  const original = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => { for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}
function sharedBudget() {
  const rows = new Map();
  return async ({ category, key, windowMs, limit, now }) => {
    const id = `${category}:${key}:${Math.floor(now / windowMs)}`;
    const count = (rows.get(id) || 0) + 1; rows.set(id, count);
    return { allowed: count <= limit, retryAfter: Math.max(1, Math.ceil((windowMs - now % windowMs) / 1000)) };
  };
}
async function admit(guard, suffix = "register", ip = "192.0.2.7") {
  const req = { method: "POST", originalUrl: `/api/auth/${suffix}`, ip, headers: {}, body: { email: crypto.randomUUID() + "@example.test" } };
  const res = response(); let passed = false;
  await guard(req, res, error => { if (error) throw error; passed = true; });
  return { passed, res };
}
test("the demonstrated two-second changing-email signup flood allows only five attempts in its first minute", async () => {
  let now = 1000;
  const guard = createAuthAdmission({ env: {}, now: () => now, consume: sharedBudget() });
  let allowed = 0;
  for (let i = 0; i < 25; i++, now += 2000) {
    const result = await admit(guard); allowed += Number(result.passed);
    if (!result.passed) { assert.equal(result.res.statusCode, 429); assert.ok(Number(result.res.headers["Retry-After"]) > 0); }
  }
  assert.equal(allowed, 5);
});
test("shared signup budgets survive worker changes and restarts", async () => {
  const consume = sharedBudget();
  let allowed = 0;
  for (let i = 0; i < 20; i++) allowed += Number((await admit(createAuthAdmission({ env: {}, now: () => 1000, consume }))).passed);
  assert.equal(allowed, 5);
});
test("signup rolling traffic is capped at twenty attempts per fifteen-minute bucket", async () => {
  const consume = sharedBudget(); let now = 1000; let allowed = 0;
  const guard = createAuthAdmission({ env: {}, now: () => now, consume });
  for (let i = 0; i < 150; i++, now += 2000) allowed += Number((await admit(guard)).passed);
  assert.equal(allowed, 20);
});
for (const suffix of ["REGISTER/", "google/complete-signup", "resend-register-otp", "resend-login-otp", "forgot-password"]) {
  test(`${suffix} cannot bypass its IP attempt budget`, async () => {
    const guard = createAuthAdmission({ env: {}, now: () => 1000, consume: sharedBudget() });
    for (let i = 0; i < 5; i++) assert.equal((await admit(guard, suffix)).passed, true);
    assert.equal((await admit(guard, suffix)).res.statusCode, 429);
  });
}
test("email endpoints share one network budget and independent networks retain access", async () => {
  const guard = createAuthAdmission({ env: {}, now: () => 1000, consume: sharedBudget() });
  for (let i = 0; i < 5; i++) await admit(guard, i % 2 ? "forgot-password" : "resend-login-otp");
  assert.equal((await admit(guard, "resend-register-otp")).res.statusCode, 429);
  assert.equal((await admit(guard, "register", "192.0.2.8")).passed, true);
});
test("shared security store failures block signup before account creation", async () => {
  const guard = createAuthAdmission({ env: {}, consume: async () => { throw Error("offline"); } });
  const result = await admit(guard);
  assert.equal(result.passed, false); assert.equal(result.res.statusCode, 503);
  assert.doesNotMatch(result.res.body.error, /offline/);
});
test("ordinary successful sign-ins are separate from the small signup budget", async () => {
  const guard = createAuthAdmission({ env: {}, consume: async () => { throw Error("must not call"); } });
  for (let i = 0; i < 30; i++) assert.equal((await admit(guard, "secure/login")).passed, true);
});
test("MongoDB counters hash identity and enforce the limit atomically", async t => {
  let count = 0; const ids = new Set();
  t.mock.method(SecurityRateBucket, "findOneAndUpdate", (filter, update, options) => {
    assert.equal(filter.count.$lt, 5); assert.equal(options.upsert, true);
    assert.ok(update.$setOnInsert.expiresAt instanceof Date);
    assert.doesNotMatch(filter._id, /192\.0\.2/); ids.add(filter._id);
    return { select() { return this; }, maxTimeMS() { return this; }, lean: async () => {
      if (count >= 5) throw Object.assign(Error("duplicate"), { code: 11000 });
      return { count: ++count };
    } };
  });
  const results = await Promise.all(Array.from({ length: 30 }, () => consumeSecurityBudget({ category: "signup", key: "192.0.2.7", windowMs: 60000, limit: 5, now: 1000 })));
  assert.equal(results.filter(row => row.allowed).length, 5); assert.equal(ids.size, 1);
});

function challengeRequest(t, purpose = "register", now = Date.now()) {
  environment(t, { JWT_SECRET: "isolated-secure-math-signing-secret" });
  const challenge = issueMathChallenge(purpose, "csrf-one", { num1: 12, num2: 3, now });
  return { body: { mathCaptcha: "15", mathAnswer: "15", mathChallenge: challenge.challenge, csrfToken: "csrf-one" }, headers: { cookie: "XSRF-TOKEN=csrf-one" } };
}
test("a signed security challenge succeeds once and concurrent replay fails", async t => {
  const req = challengeRequest(t); const used = new Set();
  t.mock.method(AuthChallengeUse, "create", async row => {
    if (used.has(row._id)) throw Object.assign(Error("duplicate"), { code: 11000 }); used.add(row._id);
  });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => verifyMathChallenge(req, "register")));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
});
for (const change of ["forged-answer", "wrong-answer", "browser", "purpose", "signature", "expired"]) {
  test(`server challenge rejects ${change}`, async t => {
    const now = Date.now(); const req = challengeRequest(t, "register", now);
    t.mock.method(AuthChallengeUse, "create", async () => { throw Error("must not reach DB"); });
    if (change === "forged-answer") { delete req.body.mathChallenge; req.body.mathCaptcha = "3"; req.body.mathAnswer = "3"; }
    if (change === "wrong-answer") { req.body.mathCaptcha = "14"; req.body.mathAnswer = "14"; }
    if (change === "browser") req.headers.cookie = "XSRF-TOKEN=another-browser";
    if (change === "signature") req.body.mathChallenge += "0";
    await assert.rejects(verifyMathChallenge(req, change === "purpose" ? "login" : "register", { now: change === "expired" ? now + 600001 : now }), error => error.code === "CAPTCHA_INVALID" && error.status === 400);
  });
}
test("security challenge storage failure is a temporary failure, never an authentication bypass", async t => {
  const req = challengeRequest(t);
  t.mock.method(AuthChallengeUse, "create", async () => { throw Error("offline-secret-details"); });
  await assert.rejects(verifyMathChallenge(req, "register"), error => error.status === 503 && !error.message.includes("offline"));
});

const customer = { _id: "customer-one", role: "customer" };
const tech = { _id: "technician-user-one", role: "technician", permissionsOverridden: true, permissions: ["assignments.self.view", "remittances.self.manage"] };
function proofRequest(user, folder) { return { user, originalUrl: `/uploads/${folder}/proof.png` }; }
async function download(req) {
  const res = response(); let passed = false;
  await requireProofAccess(req, res, error => { if (error) throw error; passed = true; });
  return { passed, res };
}
for (const folder of ["project-work-submissions", "project-completion-proofs"]) {
  test(`${folder} requires customer ownership`, async t => {
    const project = { _id: "project", customerId: customer._id };
    t.mock.method(Submission, "findOne", () => query({ projectId: "project" }));
    t.mock.method(Project, "findById", () => query(project));
    t.mock.method(Project, "findOne", () => query(project));
    assert.equal((await download(proofRequest(customer, folder))).passed, true);
    assert.equal((await download(proofRequest({ ...customer, _id: "other-customer" }, folder))).res.statusCode, 403);
  });
}
test("remittance proof is visible only to its owning technician or authorized financial staff", async t => {
  t.mock.method(Payment, "findOne", () => query({ remittedBy: tech._id }));
  t.mock.method(Technician, "findOne", () => query({ _id: "tech-one" }));
  assert.equal((await download(proofRequest(tech, "remittance-proofs"))).passed, true);
  assert.equal((await download(proofRequest({ ...tech, _id: "other-user" }, "remittance-proofs"))).res.statusCode, 403);
  assert.equal((await download(proofRequest({ role: "secretary", _id: "staff", permissionsOverridden: true, permissions: [] }, "remittance-proofs"))).res.statusCode, 403);
  assert.equal((await download(proofRequest({ role: "admin" }, "remittance-proofs"))).passed, true);
});
test("assigned technicians can access project evidence; unrelated technicians cannot", async t => {
  t.mock.method(Project, "findOne", () => query({ assignedTechnicians: [{ _id: "tech-one" }] }));
  t.mock.method(Technician, "findOne", ({ user }) => query({ _id: user === tech._id ? "tech-one" : "tech-two" }));
  assert.equal((await download(proofRequest(tech, "project-completion-proofs"))).passed, true);
  assert.equal((await download(proofRequest({ ...tech, _id: "other-user" }, "project-completion-proofs"))).res.statusCode, 403);
});
test("missing and malformed proof paths fail closed", async t => {
  t.mock.method(Project, "findOne", () => query(null));
  assert.equal((await download(proofRequest(customer, "project-completion-proofs"))).res.statusCode, 404);
  assert.equal((await download({ user: { role: "admin" }, originalUrl: "/uploads/project-completion-proofs/%2e%2e%2f.env" })).res.statusCode, 404);
});

test("secret policy rejects missing, weak, reused and publicly committed sample secrets", () => {
  assert.equal(deploymentSecretIssues({}).length, 3);
  const valid = { JWT_SECRET: "a".repeat(48), EMAIL_OUTBOX_SECRET: "b".repeat(48), ATTENDANCE_QR_SECRET: "c".repeat(48) };
  assert.deepEqual(deploymentSecretIssues(valid), []);
  assert.ok(deploymentSecretIssues({ ...valid, ATTENDANCE_QR_SECRET: valid.JWT_SECRET }).some(value => value.includes("different")));
  assert.ok(deploymentSecretIssues({ ...valid, EMAIL_OUTBOX_SECRET: "replace_me_with_random_secret_123456789" }).length);
  const example = fs.readFileSync(path.join(__dirname, "../../.env.example"), "utf8");
  assert.match(example, /^EMAIL_OUTBOX_SECRET=\r?$/m); assert.match(example, /^ATTENDANCE_QR_SECRET=\r?$/m);
});
test("outbox rotation encrypts new jobs with a new key while allowing old jobs during a bounded grace period", t => {
  environment(t, { EMAIL_OUTBOX_SECRET: "old-isolated-secret", EMAIL_OUTBOX_PREVIOUS_SECRET: "", EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL: "" });
  const oldJob = encryptPayload({ subject: "before rotation" });
  const legacy = { ...oldJob }; delete legacy.payloadKeyId;
  process.env.EMAIL_OUTBOX_SECRET = "new-isolated-secret";
  process.env.EMAIL_OUTBOX_PREVIOUS_SECRET = "old-isolated-secret";
  process.env.EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL = new Date(Date.now() + 86400000).toISOString();
  assert.equal(decryptPayload(oldJob).subject, "before rotation");
  assert.equal(decryptPayload(legacy).subject, "before rotation");
  const newJob = encryptPayload({ subject: "after rotation" });
  assert.notEqual(oldJob.payloadKeyId, newJob.payloadKeyId); assert.equal(decryptPayload(newJob).subject, "after rotation");
  process.env.EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL = new Date(Date.now() - 1).toISOString();
  assert.throws(() => decryptPayload(oldJob), /Unable to decrypt/);
  assert.equal(decryptPayload(newJob).subject, "after rotation");
});

function socketFixture() {
  const now = Date.now(); const user = { _id: "user", role: "technician", active: true, currentSessionId: "session", permissions: [] };
  return { now, user, socket: { user, authPayload: { exp: Math.floor(now / 1000) + 60, iat: Math.floor(now / 1000), sessionId: "session" } } };
}
for (const condition of ["expired", "logged-out", "disabled", "password", "role", "permissions"]) {
  test(`ongoing sockets revoke ${condition} accounts`, () => {
    const f = socketFixture(); assert.equal(validSocketAccount(f.socket, f.user, f.now), true);
    const user = { ...f.user };
    if (condition === "expired") f.socket.authPayload.exp = Math.floor(f.now / 1000) - 1;
    if (condition === "logged-out") user.currentSessionId = null;
    if (condition === "disabled") user.blocked = true;
    if (condition === "password") user.lastPasswordChange = new Date(f.now + 1000);
    if (condition === "role") user.role = "customer";
    if (condition === "permissions") user.permissions = ["tracking.self.manage"];
    assert.equal(validSocketAccount(f.socket, user, f.now), false);
  });
}
test("socket authorization refresh coalesces database work and disconnects revoked idle sessions", async () => {
  const f = socketFixture(); let disconnected = false; let reads = 0;
  f.socket.disconnect = () => { disconnected = true; };
  const io = { sockets: { sockets: new Map([["socket", f.socket]]) } };
  const guard = installSocketAuthorization(io, { load: async () => { reads++; await new Promise(resolve => setImmediate(resolve)); return [{ ...f.user, currentSessionId: "revoked" }]; } });
  try { await Promise.all([guard.refresh(), guard.refresh()]); assert.equal(reads, 1); assert.equal(disconnected, true); }
  finally { guard.stop(); }
});
test("webhook signatures reject stale, future, malformed and altered payloads", () => {
  const body = Buffer.from('{"data":{"id":"evt_test"}}'); const secret = "isolated-webhook-secret";
  const sign = time => { const sig = crypto.createHmac("sha256", secret).update(`${time}.${body}`).digest("hex"); return `t=${time},li=${sig},te=${sig}`; };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(paymongo.verifyWebhook(body, sign(now), secret).data.id, "evt_test");
  for (const header of [sign(now - 301), sign(now + 60), "t=1,te=abc,li=abc"]) assert.throws(() => paymongo.verifyWebhook(body, header, secret));
  assert.throws(() => paymongo.verifyWebhook(Buffer.from("tampered"), sign(now), secret));
});

test("all changed raw JSON template expressions preserve data without HTML script breakouts", () => {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.name.endsWith(".ejs") ? [path.join(directory, entry.name)] : []);
  let checked = 0;
  const hostile = '</script><script>window.injected=true</script>"\u2028&';
  for (const file of walk(path.join(__dirname, "../views"))) {
    const source = fs.readFileSync(file, "utf8");
    ejs.compile(source, { filename: file });
    for (const match of source.matchAll(/<%-\s*(\(JSON\.stringify\([\s\S]*?)\s*%>/g)) {
      const expression = "(JSON.stringify(payload))" + match[1].slice(match[1].indexOf(".replace(/</g"));
      const rendered = ejs.render(`<script type="application/json"><%- ${expression} %></script>`, { payload: { hostile } });
      assert.equal((rendered.match(/<\/script>/g) || []).length, 1, file);
      assert.equal(JSON.parse(rendered.slice(rendered.indexOf(">") + 1, rendered.lastIndexOf("</script>"))).hostile, hostile);
      checked++;
    }
  }
  assert.ok(checked >= 50, `checked ${checked}`);
});
test("chatbot Markdown escapes quote characters before constructing link attributes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../views/partials/chatbot.ejs"), "utf8");
  const start = source.indexOf("function escapeHtml("); const end = source.indexOf("\n  }", start) + 4;
  const document = { createElement: () => ({ set textContent(value) { this.innerHTML = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } }) };
  const escaped = vm.runInNewContext(source.slice(start, end) + ';escapeHtml(\'\\" onclick=\\"marker()\\"\')', { document });
  assert.doesNotMatch(escaped, /"/); assert.match(escaped, /&quot;/);
});

test("duplicate signed webhook deliveries process once, including concurrent deliveries", async t => {
  environment(t, { PAYMONGO_WEBHOOK_SECRET: "isolated-webhook-secret" });
  const operations = require("../utils/operationLock");
  const locks = new Map();
  t.mock.method(operations, "withOperationLock", async (key, work) => {
    const before = locks.get(key) || Promise.resolve();
    const current = before.then(work); locks.set(key, current.catch(() => {})); return current;
  });
  const events = require("../models/GatewayWebhookEvent"); const processed = new Set();
  t.mock.method(events, "exists", async ({ _id }) => processed.has(_id));
  t.mock.method(events, "create", async ({ _id }) => { processed.add(_id); });
  const controller = require("../controllers/paymentController"); let calls = 0;
  t.mock.method(controller, "handleGatewayWebhook", async () => { calls++; await new Promise(resolve => setImmediate(resolve)); });
  const file = require.resolve("../routes/paymongoRoutes"); delete require.cache[file];
  const handler = require(file).webhookHandler; t.after(() => delete require.cache[file]);
  const body = Buffer.from(JSON.stringify({ data: { id: "evt_duplicate", attributes: { type: "payment.paid", data: { id: "pay_one" } } } }));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const req = { body, headers: { "paymongo-signature": `t=${timestamp},te=${signature},li=${signature}` } };
  const responses = [response(), response(), response()];
  for (const res of responses) res.send = function(body) { this.body = body; return this; };
  await Promise.all(responses.map(res => handler(req, res)));
  assert.equal(calls, 1); assert.ok(responses.every(res => res.statusCode === 200)); assert.equal(processed.size, 1);
});
test("failed webhook processing returns a retryable failure and does not mark the event processed", async t => {
  environment(t, { PAYMONGO_WEBHOOK_SECRET: "isolated-webhook-secret" });
  const operations = require("../utils/operationLock"); t.mock.method(operations, "withOperationLock", async (_key, work) => work());
  const events = require("../models/GatewayWebhookEvent");
  t.mock.method(events, "exists", async () => false); let completed = 0;
  t.mock.method(events, "create", async () => { completed++; });
  const controller = require("../controllers/paymentController");
  t.mock.method(controller, "handleGatewayWebhook", async () => { throw Error("temporary processing failure"); });
  const file = require.resolve("../routes/paymongoRoutes"); delete require.cache[file];
  const handler = require(file).webhookHandler; t.after(() => delete require.cache[file]);
  const body = Buffer.from(JSON.stringify({ data: { id: "evt_failure", attributes: { type: "payment.paid", data: { id: "pay_one" } } } }));
  const timestamp = Math.floor(Date.now() / 1000); const signature = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const res = response(); res.send = function(body) { this.body = body; return this; };
  await handler({ body, headers: { "paymongo-signature": `t=${timestamp},te=${signature},li=${signature}` } }, res);
  assert.equal(res.statusCode, 500); assert.equal(completed, 0);
});
for (const status of ["paid", "verified", "completed", "refunded"]) {
  test(`a delayed failed webhook cannot downgrade a ${status} payment`, async t => {
    t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => work());
    let saves = 0; const payment = { _id: "payment", status, save: async () => { saves++; } };
    t.mock.method(Payment, "findOne", () => ({ sort: async () => payment }));
    t.mock.method(Payment, "findById", async () => payment);
    await require("../controllers/paymentController").handleGatewayWebhook({ data: { id: "evt_failed", attributes: { type: "payment.failed", data: { id: "pay_one", attributes: { status: "failed" } } } } });
    assert.equal(payment.status, status); assert.equal(saves, 0);
  });
}
test("gateway events reject a payment amount mismatch before updating financial records", async t => {
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => work());
  let saves = 0; const payment = { _id: "payment", gatewayId: "pay_one", status: "pending", amount: 1000, save: async () => { saves++; } };
  t.mock.method(Payment, "findOne", () => ({ sort: async () => payment }));
  t.mock.method(Payment, "findById", async () => payment);
  await assert.rejects(require("../controllers/paymentController").handleGatewayWebhook({ data: { id: "evt_paid", attributes: { type: "payment.paid", data: { id: "pay_one", attributes: { status: "paid", amount: 100, currency: "PHP" } } } } }), /amount mismatch/);
  assert.equal(saves, 0); assert.equal(payment.status, "pending");
});

test("a default staff role permission change revokes already connected sockets", async () => {
  const f = socketFixture(); let disconnected = false;
  f.socket.permissionFingerprint = JSON.stringify(["assignments.self.view"]);
  f.socket.disconnect = () => { disconnected = true; };
  const io = { sockets: { sockets: new Map([["socket", f.socket]]) } };
  const guard = installSocketAuthorization(io, { load: async () => [f.user], loadRoles: async () => [{ name: "technician", permissions: [] }] });
  try { await guard.refresh(); assert.equal(disconnected, true); } finally { guard.stop(); }
});
test("a webhook cannot update another payment using only attacker-selected metadata", async t => {
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => work());
  let saves = 0; const payment = { _id: "payment", gatewayId: "pay_original", status: "pending", amount: 1000, save: async () => { saves++; } };
  t.mock.method(Payment, "findOne", () => ({ sort: async () => payment }));
  t.mock.method(Payment, "findById", async () => payment);
  await assert.rejects(require("../controllers/paymentController").handleGatewayWebhook({ data: { id: "evt_paid", attributes: { type: "payment.paid", data: { id: "pay_other", attributes: { status: "paid", amount: 100000, currency: "PHP", metadata: { paymentId: "507f1f77bcf86cd799439011" } } } } } }), /gateway resource mismatch/);
  assert.equal(saves, 0);
});
test("a retried paid source event finishes booking updates without issuing another charge", async t => {
  environment(t, { PAYMONGO_WEBHOOK_SECRET: "isolated-webhook-secret" });
  t.mock.method(require("../utils/operationLock"), "withOperationLock", async (_key, work) => work());
  const events = require("../models/GatewayWebhookEvent");
  t.mock.method(events, "exists", async () => false); let completed = 0;
  t.mock.method(events, "create", async () => { completed++; });
  const payment = { _id: "507f1f77bcf86cd799439011", gatewayId: "pay_one", gatewaySourceId: "src_one", status: "paid", amount: 1000, bookingId: "booking", save: async () => {} };
  t.mock.method(Payment, "findOne", () => ({ sort: async () => payment }));
  t.mock.method(Payment, "findById", async () => payment);
  t.mock.method(paymongo, "createPaymentFromSource", async () => { throw Error("must not charge twice"); });
  const booking = { status: "pending", paymentStatus: "unpaid", amountPaid: 0, save: async () => {} };
  t.mock.method(require("../models/BookingService"), "findById", async () => booking);
  const file = require.resolve("../routes/paymongoRoutes"); delete require.cache[file];
  const handler = require(file).webhookHandler; t.after(() => delete require.cache[file]);
  const body = Buffer.from(JSON.stringify({ data: { id: "evt_source_retry", attributes: { type: "source.chargeable", data: { id: "src_one", attributes: { amount: 100000, currency: "PHP" } } } } }));
  const timestamp = Math.floor(Date.now() / 1000); const signature = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const res = response(); res.send = function(body) { this.body = body; return this; };
  await handler({ body, headers: { "paymongo-signature": `t=${timestamp},te=${signature},li=${signature}` } }, res);
  assert.equal(res.statusCode, 200); assert.equal(completed, 1); assert.equal(booking.paymentStatus, "paid"); assert.equal(booking.amountPaid, 1000);
});
test("public AI health does not load database knowledge or expose provider diagnostics", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/chatRoutes.js"), "utf8");
  const start = source.indexOf('router.get("/health",');
  const end = source.indexOf("\n});", start) + 4;
  let handler;
  vm.runInNewContext(source.slice(start, end), { router: { get(_path, callback) { handler = callback; } }, loadKnowledge: async () => { throw Error("must not query the database"); } });
  const res = response(); await handler({}, res);
  assert.equal(JSON.stringify(res.body), '{"status":"ok"}'); assert.equal(res.headers["Cache-Control"], "no-store");
});
test("local account summaries remain private when the browser echoes them in later AI conversation history", () => {
  const { externalChatHistory } = require("../utils/customerChatPrivacy");
  const history = [
    { role: "user", content: "What services do you offer?" },
    { role: "bot", content: "Reference: **PRIVATE-REFERENCE**\nSchedule: **Oct 15**\nBalance: **1000**\n[My Schedule](/tracking)" },
    { role: "bot", content: "Private account details", privateAccount: true },
    { role: "user", content: "Tell me about aircon cleaning" },
  ];
  const allowed = externalChatHistory(history);
  assert.equal(allowed.length, 2); assert.ok(allowed.every(item => item.role === "user"));
  assert.equal(history.length, 4);
});
