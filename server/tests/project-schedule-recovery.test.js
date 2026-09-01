const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currentCommitment,
  mergeDailySummaries,
  normalizeRecoveryRequest,
  riskStatus,
} = require("../utils/projectScheduleRecovery");

const project = {
  plannedCompletionDate: new Date("2026-09-05T00:00:00.000Z"),
  preferredCompletionDeadline: new Date("2026-09-05T00:00:00.000Z"),
  schedulePlan: { workingDays: [1, 2, 3, 4, 5], workingHours: { start: "09:00", end: "17:00" } },
};

test("recovery keeps the current approved commitment", () => {
  const request = normalizeRecoveryRequest({
    mode: "recover",
    reasonCategory: "staffing",
    reason: "Crew capacity dropped below the approved daily target.",
    recoveryStartDate: "2026-09-02",
  }, project, new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(request.revisedCompletionDate.toISOString(), currentCommitment(project).toISOString());
  assert.equal(request.mode, "recover");
});

test("extension must move the approved commitment forward", () => {
  assert.throws(() => normalizeRecoveryRequest({
    mode: "extend",
    reasonCategory: "material_delay",
    reason: "Required materials will arrive after the original target.",
    recoveryStartDate: "2026-09-02",
    revisedCompletionDate: "2026-09-05",
  }, project, new Date("2026-08-30T00:00:00.000Z")), /later than the current approved/);
});

test("daily-summary replacement preserves historical days", () => {
  const merged = mergeDailySummaries(
    [{ date: "2026-08-29", allocations: [1] }, { date: "2026-09-02", allocations: [2] }],
    [{ date: "2026-09-03", allocations: [3] }],
    "2026-09-02",
  );
  assert.deepEqual(merged.map(day => day.date), ["2026-08-29", "2026-09-03"]);
});

test("risk is derived from forecast versus approved commitment", () => {
  assert.equal(riskStatus("2026-09-07", "2026-09-05"), "behind");
  assert.equal(riskStatus("2026-09-04", "2026-09-05"), "on_track");
});

test("legacy named working days remain valid during recovery", () => {
  const legacyProject = {
    preferredCompletionDeadline: new Date("2026-09-10T00:00:00.000Z"),
    preferredWorkingDays: ["Mon", "Tuesday", "Wed", "Thu", "Fri"],
    preferredWorkingHours: { start: "08:00", end: "17:00" },
  };
  const request = normalizeRecoveryRequest({
    mode: "recover",
    reasonCategory: "weather",
    reason: "Weather interruption reduced the available work window.",
    recoveryStartDate: "2026-09-02",
  }, legacyProject, new Date("2026-08-30T00:00:00.000Z"));
  assert.deepEqual(request.workingDays, [1, 2, 3, 4, 5]);
});
