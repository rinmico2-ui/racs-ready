const test = require("node:test");
const assert = require("node:assert/strict");

const ActivityLog = require("../models/ActivityLog");
const {
  classify,
  sanitizeDetails,
  inferOutcome,
  inferRiskLevel,
} = require("../utils/audit");
const {
  normalizeAuditQuery,
  csvCell,
  localDateBoundary,
} = require("../utils/auditTrailPolicy");

test("password reset events are classified as security authentication events", () => {
  assert.deepEqual(
    classify("auth.password_reset_completed", { referenceModel: "User" }, "auth"),
    { category: "auth", entityType: "User", actionType: "security" },
  );
});

test("audit details redact secrets recursively without dropping useful context", () => {
  const sanitized = sanitizeDetails({
    reason: "invalid_token",
    password: "NeverStoreThis1",
    nested: { csrfToken: "secret", attempts: 3 },
    headers: { authorization: "Bearer secret", accept: "application/json" },
  });
  assert.equal(sanitized.reason, "invalid_token");
  assert.equal(sanitized.password, "[REDACTED]");
  assert.equal(sanitized.nested.csrfToken, "[REDACTED]");
  assert.equal(sanitized.nested.attempts, 3);
  assert.equal(sanitized.headers.authorization, "[REDACTED]");
  assert.equal(sanitized.headers.accept, "application/json");
});

test("risk and outcome inference promotes blocked security activity", () => {
  assert.equal(inferOutcome("auth.password_reset_request_blocked"), "blocked");
  assert.equal(inferRiskLevel("auth.password_reset_request_blocked", "auth", "blocked"), "critical");
  assert.equal(inferRiskLevel("auth.password_reset_completed", "auth", "success"), "high");
});

test("audit query normalization applies safe filters and pagination", () => {
  const normalized = normalizeAuditQuery({
    category: "auth",
    actionType: "security",
    riskLevel: "high",
    outcome: "failure",
    q: "reset.*",
    from: "2026-08-01",
    to: "2026-08-31",
    page: "2",
    limit: "500",
  });
  assert.equal(normalized.page, 2);
  assert.equal(normalized.limit, 100);
  assert.equal(normalized.query.category, "auth");
  assert.equal(normalized.query.riskLevel, "high");
  assert.equal(normalized.query.outcome, "failure");
  assert.equal(normalized.query.$or[0].action.test("reset.*"), true);
  assert.equal(normalized.query.$or[0].action.test("resetXYZ"), false);
  assert.ok(normalized.query.createdAt.$gte < normalized.query.createdAt.$lte);
});

test("audit query rejects invalid and reversed date filters", () => {
  assert.throws(() => localDateBoundary("2026-02-30", false), /Invalid audit date/);
  assert.throws(
    () => normalizeAuditQuery({ from: "2026-09-01", to: "2026-08-01" }),
    /From date must not be after to date/,
  );
  assert.throws(() => normalizeAuditQuery({ riskLevel: "severe" }), /Invalid risk level/);
});

test("CSV export neutralizes spreadsheet formulas", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://example.test\")"), '"\'=HYPERLINK(""https://example.test"")"');
  assert.equal(csvCell("normal"), '"normal"');
});

test("activity log schema stores incident-review context", () => {
  const paths = ActivityLog.schema.paths;
  ["riskLevel", "outcome", "source", "requestId", "requestMethod", "requestPath", "userAgent"].forEach((name) => {
    assert.ok(paths[name], `missing ActivityLog.${name}`);
  });
  const indexes = ActivityLog.schema.indexes().map(([fields]) => JSON.stringify(fields));
  assert.ok(indexes.includes(JSON.stringify({ riskLevel: 1, outcome: 1, createdAt: -1 })));
});
