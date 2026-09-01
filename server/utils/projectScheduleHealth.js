const ACTIVE_SCHEDULE_STATUSES = new Set([
  "accepted",
  "planning",
  "ready",
  "in_progress",
  "on_hold",
]);
const WEEKDAY_NUMBERS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(value) {
  const date = validDate(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function differenceInDays(later, earlier) {
  const end = startOfDay(later);
  const start = startOfDay(earlier);
  if (!end || !start) return null;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function approvedCompletion(project = {}) {
  return validDate(
    project.scheduleGovernance?.currentApprovedCompletionDate
    || project.schedulePlan?.targetEndDate
    || project.preferredCompletionDeadline
    || project.plannedCompletionDate,
  );
}

function workingForecast(project = {}) {
  return validDate(
    project.scheduleGovernance?.currentForecastCompletionDate
    || project.schedulePlan?.estimatedEndDate
    || project.plannedCompletionDate,
  );
}

function scheduleStart(project = {}) {
  return validDate(
    project.schedulePlan?.startDate
    || project.plannedStartDate
    || project.preferredStartDate,
  );
}

function configuredWorkingDays(project = {}) {
  const source = project.schedulePlan?.workingDays?.length
    ? project.schedulePlan.workingDays
    : project.preferredWorkingDays?.length
      ? project.preferredWorkingDays
      : [1, 2, 3, 4, 5];
  const normalized = source.map(value => {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    const text = String(value ?? "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(WEEKDAY_NUMBERS, text) ? WEEKDAY_NUMBERS[text] : Number(text);
  }).filter(value => Number.isInteger(value) && value >= 0 && value <= 6);
  return new Set(normalized.length ? normalized : [1, 2, 3, 4, 5]);
}

function countWorkingDays(startValue, endValue, workingDays) {
  const start = startOfDay(startValue);
  const end = startOfDay(endValue);
  if (!start || !end || end < start) return 0;
  let count = 0;
  let guard = 0;
  const cursor = new Date(start);
  while (cursor <= end && guard < 3660) {
    if (workingDays.has(cursor.getDay())) count += 1;
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return count;
}

function result(code, label, severity, detail, dates = {}, metrics = {}) {
  return {
    code,
    label,
    severity,
    detail,
    approvedCompletionDate: dates.commitment || null,
    forecastCompletionDate: dates.forecast || null,
    scheduleStartDate: dates.start || null,
    daysPastDue: metrics.daysPastDue || 0,
    forecastVarianceDays: metrics.forecastVarianceDays || 0,
    daysUntilCommitment: metrics.daysUntilCommitment ?? null,
    progressPercent: metrics.progressPercent || 0,
    expectedProgressPercent: metrics.expectedProgressPercent || 0,
    progressVariancePercent: metrics.progressVariancePercent || 0,
    actionable: !["completed", "cancelled", "not_started"].includes(code),
  };
}

function deriveProjectScheduleHealth(project = {}, now = new Date()) {
  const status = String(project.status || "");
  const commitment = approvedCompletion(project);
  const forecast = workingForecast(project);
  const start = scheduleStart(project);
  const dates = { commitment, forecast, start };
  const totalUnits = Math.max(0, Number(project.totalUnits || 0));
  const completedUnits = Math.max(0, Number(project.completedUnits || 0));
  const progressPercent = totalUnits > 0 ? Math.min(100, Math.round((completedUnits / totalUnits) * 100)) : 0;

  if (["completed", "closed"].includes(status)) {
    return result("completed", "Completed", "neutral", "Project execution is complete.", dates, { progressPercent });
  }
  if (status === "cancelled") {
    return result("cancelled", "Cancelled", "neutral", "Schedule monitoring is no longer active.", dates, { progressPercent });
  }
  if (!ACTIVE_SCHEDULE_STATUSES.has(status) && status !== "pending_project_scheduling") {
    return result("unscheduled", "Unscheduled", "warning", "No active approved delivery schedule.", dates, { progressPercent });
  }
  if (!commitment) {
    return result("unscheduled", "Unscheduled", "warning", "Set and approve a completion commitment.", dates, { progressPercent });
  }

  const today = startOfDay(now);
  const commitmentDay = startOfDay(commitment);
  const forecastDay = startOfDay(forecast);
  const startDay = startOfDay(start);
  const daysUntilCommitment = differenceInDays(commitmentDay, today);
  const commonMetrics = { progressPercent, daysUntilCommitment };

  if (today > commitmentDay && progressPercent < 100) {
    const daysPastDue = Math.max(1, differenceInDays(today, commitmentDay));
    return result(
      "past_due",
      "Past Due",
      "critical",
      `${daysPastDue} day${daysPastDue === 1 ? "" : "s"} past the approved completion date.`,
      dates,
      { ...commonMetrics, daysPastDue },
    );
  }

  const forecastVarianceDays = forecastDay ? Math.max(0, differenceInDays(forecastDay, commitmentDay)) : 0;
  if (forecastVarianceDays > 0 || project.scheduleGovernance?.riskStatus === "behind") {
    return result(
      "behind_schedule",
      "Behind Schedule",
      "critical",
      forecastVarianceDays > 0
        ? `Forecast is ${forecastVarianceDays} day${forecastVarianceDays === 1 ? "" : "s"} beyond the approved date.`
        : "The approved execution baseline is behind schedule.",
      dates,
      { ...commonMetrics, forecastVarianceDays },
    );
  }

  if (startDay && today < startDay) {
    return result("not_started", "Not Started", "neutral", "Work has not reached its approved start date.", dates, commonMetrics);
  }

  let expectedProgressPercent = 0;
  let progressVariancePercent = 0;
  if (startDay && commitmentDay > startDay && today >= startDay) {
    const workingDays = configuredWorkingDays(project);
    const totalScheduledDays = Math.max(1, countWorkingDays(startDay, commitmentDay, workingDays));
    const elapsedWorkingDays = countWorkingDays(startDay, today < commitmentDay ? today : commitmentDay, workingDays);
    expectedProgressPercent = Math.min(100, Math.round((elapsedWorkingDays / totalScheduledDays) * 100));
    progressVariancePercent = progressPercent - expectedProgressPercent;
  }

  if (progressVariancePercent <= -10) {
    return result("behind_schedule", "Behind Schedule", "critical", `Progress is ${Math.abs(progressVariancePercent)} percentage points behind the working-day baseline.`, dates, {
      ...commonMetrics,
      expectedProgressPercent,
      progressVariancePercent,
    });
  }

  if (project.scheduleGovernance?.riskStatus === "at_risk"
      || status === "on_hold"
      || progressVariancePercent <= -5
      || (daysUntilCommitment !== null && daysUntilCommitment <= 3 && progressPercent < 90)) {
    const detail = status === "on_hold"
      ? "The project is on hold and its approved date may be affected."
      : progressVariancePercent <= -5
        ? `Progress is ${Math.abs(progressVariancePercent)} percentage points behind the time-phased baseline.`
        : "The completion commitment is approaching with material work remaining.";
    return result("at_risk", "At Risk", "warning", detail, dates, {
      ...commonMetrics,
      expectedProgressPercent,
      progressVariancePercent,
    });
  }

  return result("on_track", "On Track", "healthy", "Progress and forecast remain within the approved commitment.", dates, {
    ...commonMetrics,
    expectedProgressPercent,
    progressVariancePercent,
  });
}

function summarizeScheduleHealth(projects = [], now = new Date()) {
  const counts = {
    past_due: 0,
    behind_schedule: 0,
    at_risk: 0,
    on_track: 0,
    unscheduled: 0,
    not_started: 0,
    completed: 0,
    cancelled: 0,
  };
  projects.forEach(project => {
    const code = deriveProjectScheduleHealth(project, now).code;
    if (Object.prototype.hasOwnProperty.call(counts, code)) counts[code] += 1;
  });
  return counts;
}

module.exports = {
  approvedCompletion,
  deriveProjectScheduleHealth,
  scheduleStart,
  summarizeScheduleHealth,
  workingForecast,
};
