const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveProjectScheduleHealth, summarizeScheduleHealth } = require("../utils/projectScheduleHealth");

const now = new Date("2026-08-30T08:00:00.000Z");

function project(overrides = {}) {
  return {
    status: "in_progress",
    totalUnits: 10,
    completedUnits: 5,
    plannedStartDate: "2026-08-20T00:00:00.000Z",
    preferredCompletionDeadline: "2026-09-05T00:00:00.000Z",
    plannedCompletionDate: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

test("past due takes precedence for unfinished active projects", () => {
  const health = deriveProjectScheduleHealth(project({ preferredCompletionDeadline: "2026-08-28", plannedCompletionDate: "2026-08-28" }), now);
  assert.equal(health.code, "past_due");
  assert.equal(health.daysPastDue, 2);
});

test("forecast beyond commitment is behind schedule", () => {
  const health = deriveProjectScheduleHealth(project({ plannedCompletionDate: "2026-09-09" }), now);
  assert.equal(health.code, "behind_schedule");
  assert.equal(health.forecastVarianceDays, 4);
});

test("time-phased progress identifies behind-schedule delivery", () => {
  const health = deriveProjectScheduleHealth(project({ completedUnits: 1 }), now);
  assert.equal(health.code, "behind_schedule");
  assert.ok(health.progressVariancePercent <= -10);
});

test("governance warning remains an at-risk state before commitment failure", () => {
  const health = deriveProjectScheduleHealth(project({
    completedUnits: 6,
    scheduleGovernance: { riskStatus: "at_risk" },
  }), now);
  assert.equal(health.code, "at_risk");
});

test("lifecycle completion is not mislabeled as past due", () => {
  const health = deriveProjectScheduleHealth(project({ status: "completed", completedUnits: 10, preferredCompletionDeadline: "2026-08-20" }), now);
  assert.equal(health.code, "completed");
  assert.equal(health.actionable, false);
});

test("summary groups each independent schedule-health state", () => {
  const counts = summarizeScheduleHealth([
    project({ preferredCompletionDeadline: "2026-08-28", plannedCompletionDate: "2026-08-28" }),
    project({ plannedCompletionDate: "2026-09-09" }),
    project({ completedUnits: 6, scheduleGovernance: { riskStatus: "at_risk" } }),
  ], now);
  assert.deepEqual({ pastDue: counts.past_due, behind: counts.behind_schedule, atRisk: counts.at_risk }, { pastDue: 1, behind: 1, atRisk: 1 });
});
