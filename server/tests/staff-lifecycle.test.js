const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const User = require("../models/User");
const Technician = require("../models/Technician");
const {
  STAFF_RETENTION_POLICY,
  normalizeArchiveReason,
  staffLifecycleState,
  findStaffArchiveBlockers,
} = require("../utils/staffLifecycle");
const { inferRiskLevel } = require("../utils/audit");

test("staff archive policy preserves linked records and forbids automatic deletion", () => {
  assert.equal(STAFF_RETENTION_POLICY.archiveMode, "soft_delete");
  assert.equal(STAFF_RETENTION_POLICY.automaticHardDelete, false);
  assert.equal(STAFF_RETENTION_POLICY.historicalWork, "retained");
  assert.equal(STAFF_RETENTION_POLICY.emailDeliveryLogsDays, 90);
  assert.equal(inferRiskLevel("staff.archive", "auth", "success"), "high");
  assert.equal(inferRiskLevel("staff.restore", "auth", "success"), "high");
});

test("archive reasons are normalized and validated", () => {
  assert.equal(normalizeArchiveReason("  Employment   has ended. "), "Employment has ended.");
  assert.throws(() => normalizeArchiveReason("short"), /10 and 500/);
  assert.throws(() => normalizeArchiveReason("x".repeat(501)), /10 and 500/);
});

test("staff lifecycle state distinguishes archived and legacy inactive records", () => {
  assert.equal(staffLifecycleState({ active: true }), "active");
  assert.equal(staffLifecycleState({ active: false }), "inactive");
  assert.equal(staffLifecycleState({ active: false, archivedAt: new Date() }), "archived");
});

test("archive preflight reports every unfinished-work category", async () => {
  const queries = {};
  const fakeModel = (name, count) => ({
    countDocuments(query) {
      queries[name] = query;
      return Promise.resolve(count);
    },
  });
  const blockers = await findStaffArchiveBlockers("tech-1", {
    Assignment: fakeModel("assignments", 2),
    BookingService: fakeModel("bookings", 1),
    Order: fakeModel("orders", 3),
    Project: fakeModel("projects", 1),
  });

  assert.equal(blockers.total, 7);
  assert.deepEqual(blockers.items.map((item) => item.type), [
    "assignments",
    "bookings",
    "orders",
    "projects",
  ]);
  assert.deepEqual(queries.assignments.status.$nin, ["completed", "cancelled", "declined", "expired", "no_show"]);
  assert.deepEqual(queries.orders.status.$nin, ["completed", "cancelled"]);
});

test("staff schemas persist archive metadata and lifecycle history", () => {
  for (const model of [User, Technician]) {
    assert.ok(model.schema.path("archivedAt"));
    assert.ok(model.schema.path("archivedBy"));
    assert.ok(model.schema.path("archiveReason"));
    assert.ok(model.schema.path("staffLifecycleHistory"));
  }
});

test("admin staff routes expose archive preflight, archive, restore, and policy endpoints", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/adminApi.js"), "utf8");
  assert.match(routes, /router\.get\("\/staff\/policy"/);
  assert.match(routes, /router\.get\("\/staff\/:id\/archive-preview"/);
  assert.match(routes, /router\.post\("\/staff\/:id\/archive"/);
  assert.match(routes, /router\.post\("\/staff\/:id\/restore"/);
  assert.doesNotMatch(routes, /router\.delete\("\/staff/);
});

test("staff directory explains retention and uses lifecycle actions", () => {
  const view = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Staff/StaffList.ejs"), "utf8");
  assert.match(view, /Staff archive and retention policy/);
  assert.match(view, /archive-preview/);
  assert.match(view, /archive-staff/);
  assert.match(view, /restore-staff/);
  assert.doesNotMatch(view, /id="editStaffActive"/);
});
