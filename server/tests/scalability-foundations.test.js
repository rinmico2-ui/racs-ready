const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.JWT_SECRET ||= "scalability-test-secret-that-is-long-enough";

const {
  authenticatedOrIpKey,
  emailOrIpKey,
  generalApiLimit,
} = require("../utils/rateLimitIdentity");
const { safeRequestId } = require("../middleware/requestTelemetry");
const loginRateLimiter = require("../middleware/loginRateLimiter");
const { bookingCapacityLockKey } = require("../utils/operationLock");
const emailOutbox = require("../utils/emailOutbox");
const BookingService = require("../models/BookingService");
const OperationLock = require("../models/OperationLock");
const User = require("../models/User");
const bcryptjs = require("bcryptjs");

test("authenticated API budgets are isolated by user rather than shared NAT IP", () => {
  const first = authenticatedOrIpKey({ ip: "203.0.113.8", user: { _id: "user-a" } });
  const second = authenticatedOrIpKey({ ip: "203.0.113.8", user: { _id: "user-b" } });
  assert.equal(first, "user:user-a");
  assert.equal(second, "user:user-b");
  assert.notEqual(first, second);
});

test("per-account limiter keys normalize and hash email addresses", () => {
  const first = emailOrIpKey({ ip: "203.0.113.8", body: { email: " Person@Example.COM " } });
  const second = emailOrIpKey({ ip: "198.51.100.9", body: { email: "person@example.com" } });
  assert.equal(first, second);
  assert.match(first, /^email:[a-f0-9]{64}$/);
  assert.equal(first.includes("person@example.com"), false);
});

test("authenticated users receive the configured independent API budget", () => {
  process.env.ANONYMOUS_API_RATE_LIMIT = "100";
  process.env.AUTHENTICATED_API_RATE_LIMIT = "300";
  assert.equal(generalApiLimit({ ip: "203.0.113.8" }), 100);
  assert.equal(generalApiLimit({ ip: "203.0.113.8", user: { _id: "user-a" } }), 300);
});

test("progressive network lockouts are scoped to the attempted account", () => {
  const a = loginRateLimiter.scopedIpIdentifier("203.0.113.8", "a@example.com");
  const b = loginRateLimiter.scopedIpIdentifier("203.0.113.8", "b@example.com");
  assert.notEqual(a, b);
});

test("request IDs accept bounded safe values and replace unsafe input", () => {
  assert.equal(safeRequestId("request-1234"), "request-1234");
  assert.match(safeRequestId("bad id with spaces"), /^[a-f0-9-]{36}$/);
});

test("booking capacity locks serialize one date while preserving cross-date parallelism", () => {
  assert.equal(bookingCapacityLockKey("2030-01-02"), "booking-capacity:2030-01-02");
  assert.notEqual(bookingCapacityLockKey("2030-01-02"), bookingCapacityLockKey("2030-01-03"));
});

test("booking idempotency and operation-lock expiry have database indexes", () => {
  const bookingIndexes = BookingService.schema.indexes();
  assert.ok(bookingIndexes.some(([fields, options]) =>
    fields.customerId === 1 && fields.clientSubmissionId === 1 && options.unique === true));
  const lockIndexes = OperationLock.schema.indexes();
  assert.ok(lockIndexes.some(([fields, options]) =>
    fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test("email outbox payloads are encrypted and authenticated", () => {
  const payload = { to: "person@example.com", subject: "OTP", text: "123456" };
  const encrypted = emailOutbox._private.encryptPayload(payload);
  assert.equal(encrypted.payloadCiphertext.includes("123456"), false);
  assert.deepEqual(emailOutbox._private.decryptPayload(encrypted), payload);
});

test("native bcrypt verifies hashes created by the previous bcryptjs implementation", async () => {
  const legacyHash = bcryptjs.hashSync("Compatible-password-1", 10);
  const user = new User({
    email: "compatibility@example.com",
    firstName: "Hash",
    lastName: "Test",
    phone: "09171234567",
    passwordHash: legacyHash,
  });
  assert.equal(await user.comparePassword("Compatible-password-1"), true);
});

test("booking submission uses multipart streaming and a transactional capacity guard", () => {
  const root = path.join(__dirname, "..");
  const browser = fs.readFileSync(path.join(root, "public/js/services-multi.js"), "utf8");
  const route = fs.readFileSync(path.join(root, "routes/bookingRoutesNew.js"), "utf8");
  assert.match(browser, /new FormData\(\)/);
  assert.doesNotMatch(browser, /bookingData\.proofImageBase64\s*=/);
  assert.match(route, /withOperationLock\(capacityLockKey/);
  assert.match(route, /creationSession\.withTransaction/);
});

test("login OTP state is persistent and hidden by default", () => {
  for (const field of ["loginOtpHash", "loginOtpExpires", "loginOtpLastSentAt", "loginOtpRememberMe"]) {
    assert.equal(User.schema.path(field).options.select, false);
  }
});
