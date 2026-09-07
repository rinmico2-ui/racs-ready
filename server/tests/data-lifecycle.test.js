const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DATA_RETENTION_POLICY,
  normalizeLifecycleReason,
  archiveRecord,
  restoreRecord,
} = require("../utils/dataLifecycle");
const { cancelBookingRecord } = require("../utils/bookingLifecycle");
const { buildToolUsageFilter } = require("../utils/toolUsageManagement");

const root = path.join(__dirname, "..");
const source = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("system lifecycle policy forbids automatic hard deletion", () => {
  assert.equal(DATA_RETENTION_POLICY.automaticHardDelete, false);
  assert.equal(DATA_RETENTION_POLICY.operationalRecords, "retained");
  assert.equal(DATA_RETENTION_POLICY.correctionMode, "void_cancel_or_reverse");
});

test("lifecycle reasons are normalized and validated", () => {
  assert.equal(normalizeLifecycleReason("  No longer   offered to customers  ", "Archive"), "No longer offered to customers");
  assert.throws(() => normalizeLifecycleReason("short", "Archive"), /between 10 and 500/);
});

test("archive and restore preserve record identity and history", () => {
  const actorId = "admin-1";
  const record = { _id: "catalogue-1", active: true, linkedOrders: ["order-1"], lifecycleHistory: [] };
  archiveRecord(record, actorId, "Product has been discontinued", new Date("2026-01-01T00:00:00Z"));
  assert.equal(record._id, "catalogue-1");
  assert.deepEqual(record.linkedOrders, ["order-1"]);
  assert.equal(record.active, false);
  assert.equal(record.lifecycleHistory[0].action, "archived");

  archiveRecord(record, actorId, "Repeated archive request is idempotent", new Date("2026-01-01T12:00:00Z"));
  assert.equal(record.lifecycleHistory.length, 1);

  restoreRecord(record, actorId, "Product returned to active catalogue", new Date("2026-01-02T00:00:00Z"));
  assert.equal(record.active, true);
  assert.equal(record.archivedAt, null);
  assert.equal(record.lifecycleHistory[1].action, "restored");

  restoreRecord(record, actorId, "Repeated restore request is idempotent", new Date("2026-01-02T12:00:00Z"));
  assert.equal(record.lifecycleHistory.length, 2);
});

test("booking cancellation retains the booking and updates item histories", () => {
  const history = [];
  const booking = {
    _id: "booking-1",
    status: "scheduled",
    services: [
      { status: "scheduled", statusHistory: [] },
      { status: "completed", statusHistory: [] },
    ],
    recordStatusHistory(entry) { history.push(entry); },
  };
  const result = cancelBookingRecord(booking, {
    actorId: "admin-1",
    actorName: "Admin",
    reason: "Customer requested cancellation",
    at: new Date("2026-01-03T00:00:00Z"),
  });
  assert.equal(result.changed, true);
  assert.equal(booking._id, "booking-1");
  assert.equal(booking.status, "cancelled");
  assert.equal(booking.services[0].status, "cancelled");
  assert.equal(booking.services[1].status, "completed");
  assert.equal(history[0].toStatus, "cancelled");
  assert.throws(() => cancelBookingRecord({ status: "completed" }, { reason: "Attempted invalid cancellation" }), /cannot be cancelled/);
});

test("normal tool usage queries exclude voided ledger rows", () => {
  assert.deepEqual(buildToolUsageFilter({}).lifecycleStatus, { $ne: "voided" });
  assert.equal(buildToolUsageFilter({ lifecycleStatus: "voided" }).lifecycleStatus, "voided");
  assert.equal(buildToolUsageFilter({ includeVoided: "1" }).lifecycleStatus, undefined);
});

test("critical admin flows no longer hard-delete business history", () => {
  assert.doesNotMatch(source("routes/appointmentRoutes.js"), /BookingService\.findByIdAndDelete/);
  assert.doesNotMatch(source("utils/toolUsageManagement.js"), /usage\.deleteOne\(/);
  assert.doesNotMatch(source("routes/projectRoutes.js"), /material\.deleteOne\(/);
  assert.doesNotMatch(source("routes/appointmentManagement.js"), /assignment\.deleteOne\(/);
  assert.doesNotMatch(source("routes/appointmentManagement.js"), /EquipmentAssignment\.deleteMany/);
  assert.doesNotMatch(source("routes/appointmentManagement.js"), /EquipmentAssignment\.updateMany/);
  assert.doesNotMatch(source("routes/appointmentRoutes.js"), /EquipmentAssignment\.updateMany/);
  assert.match(source("routes/secretaryApi.js"), /archiveRecord\(item, req\.user\._id, reason\)/);
  assert.match(source("routes/productRoutes.js"), /active: true,[\s\S]*salesChannel/);
  assert.match(source("routes/orderRoutes.js"), /HVACProduct\.findOne\(\{ active: \{ \$ne: false \}, "variants\._id": inventoryId \}\)/);
});

test("archive center and policy are exposed to administrators", () => {
  assert.match(source("routes/pages.js"), /router\.get\("\/admin\/archive"/);
  assert.match(source("routes/adminApi.js"), /router\.get\("\/archive", archiveController\.listArchive\)/);
  assert.match(source("views/partials/admin-sidebar.ejs"), /Archive &amp; Retention/);
  assert.match(source("controllers/archiveController.js"), /\{ active: false \}, \{ archivedAt: \{ \$ne: null \} \}/);
  assert.match(source("..\/docs/data-lifecycle-retention-policy.md"), /does not automatically hard-delete business records/);
});

test("hidden normalized ratings cannot return through the legacy booking fallback", () => {
  const reportSource = source("utils/serviceRatingReport.js");
  assert.match(reportSource, /Rating\.find\(\{ targetType: "booking", targetId: \{ \$in: legacyIds \} \}\)/);
});

test("legacy technician administration uses the governed archive workflow", () => {
  const adminApi = source("routes/adminApi.js");
  const directory = source("views/pages/admin/Technicians/TechnicianList.ejs");
  assert.match(adminApi, /STAFF_LIFECYCLE_ACTION_REQUIRED/);
  assert.doesNotMatch(adminApi, /if \(active !== undefined\) update\.active = active/);
  assert.match(directory, /\/api\/admin\/staff\/\$\{encodeURIComponent\(id\)\}\/archive/);
});
