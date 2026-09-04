const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { attendanceDay, attendanceRange } = require("../utils/attendanceTime");
const SecretaryAttendance = require("../models/SecretaryAttendance");

test("attendance day and late cutoff remain anchored to Asia/Manila", () => {
  const beforeMidnight = attendanceDay(new Date("2026-09-01T15:59:59.000Z"));
  assert.equal(beforeMidnight.key, "2026-09-01");
  assert.equal(beforeMidnight.start.toISOString(), "2026-08-31T16:00:00.000Z");

  const afterMidnight = attendanceDay(new Date("2026-09-01T16:00:00.000Z"));
  assert.equal(afterMidnight.key, "2026-09-02");
  assert.equal(afterMidnight.lateCutoff.toISOString(), "2026-09-02T01:00:00.000Z");
});

test("payroll attendance range includes complete Manila calendar days", () => {
  const range = attendanceRange(
    new Date("2026-09-01T00:00:00.000Z"),
    new Date("2026-09-02T00:00:00.000Z"),
  );
  assert.equal(range.start.toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-09-02T15:59:59.999Z");
});

test("secretary attendance enforces one daily record per user", () => {
  const indexes = SecretaryAttendance.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => (
    fields.userId === 1 && fields.date === 1 && options.unique === true
  )));
  assert.deepEqual(
    SecretaryAttendance.schema.path("status").enumValues,
    ["Absent", "Present", "Late", "On Leave", "Sick Leave"],
  );
});

test("secretary self-service and payroll attendance integrations are exposed", () => {
  const secretaryRoutes = fs.readFileSync(path.join(__dirname, "../routes/secretaryApi.js"), "utf8");
  const payrollRoutes = fs.readFileSync(path.join(__dirname, "../routes/payrollRoutes.js"), "utf8");
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");

  for (const endpoint of ["/attendance/status", "/attendance/scan", "/attendance/checkout", "/attendance/history"]) {
    assert.match(secretaryRoutes, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(payrollRoutes, /SecretaryAttendance\.find/);
  assert.match(pages, /\/secretary\/attendance/);
});
