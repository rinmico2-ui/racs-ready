const REASON_CATEGORIES = Object.freeze([
  "weather",
  "material_delay",
  "customer_change",
  "access_constraint",
  "staffing",
  "technical_complexity",
  "safety",
  "external_dependency",
  "other",
]);
const WEEKDAY_NUMBERS = Object.freeze({
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
});

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

function dayKey(value) {
  const date = startOfDay(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function originalBaseline(project = {}) {
  return validDate(
    project.scheduleGovernance?.originalBaselineCompletionDate
    || project.schedulePlan?.targetEndDate
    || project.preferredCompletionDeadline
    || project.plannedCompletionDate,
  );
}

function currentCommitment(project = {}) {
  return validDate(
    project.scheduleGovernance?.currentApprovedCompletionDate
    || project.schedulePlan?.targetEndDate
    || project.preferredCompletionDeadline
    || project.plannedCompletionDate,
  );
}

function currentForecast(project = {}) {
  return validDate(
    project.scheduleGovernance?.currentForecastCompletionDate
    || project.schedulePlan?.estimatedEndDate
    || project.plannedCompletionDate,
  );
}

function normalizeRecoveryRequest(body = {}, project = {}, now = new Date()) {
  const mode = body.mode === "extend" ? "extend" : body.mode === "recover" ? "recover" : "";
  if (!mode) throw Object.assign(new Error("Choose Recover Schedule or Approve Extension."), { status: 400 });
  const reasonCategory = REASON_CATEGORIES.includes(body.reasonCategory) ? body.reasonCategory : "";
  if (!reasonCategory) throw Object.assign(new Error("Select a delay reason category."), { status: 400 });
  const reason = String(body.reason || "").trim().slice(0, 1500);
  if (reason.length < 10) throw Object.assign(new Error("Provide a delay and recovery reason of at least 10 characters."), { status: 400 });
  const impactSummary = String(body.impactSummary || "").trim().slice(0, 1500);
  const today = startOfDay(now);
  const defaultStart = new Date(today); defaultStart.setDate(defaultStart.getDate() + 1);
  const recoveryStartDate = startOfDay(body.recoveryStartDate || defaultStart);
  if (!recoveryStartDate || recoveryStartDate <= today) throw Object.assign(new Error("Recovery work must start on a future date so today’s active work remains unchanged."), { status: 400 });
  const commitment = currentCommitment(project);
  if (!commitment) throw Object.assign(new Error("The project has no committed completion date to recover or extend."), { status: 409 });
  const revisedCompletionDate = mode === "extend" ? startOfDay(body.revisedCompletionDate) : commitment;
  if (!revisedCompletionDate) throw Object.assign(new Error("A valid revised completion date is required."), { status: 400 });
  if (mode === "recover" && startOfDay(commitment) < recoveryStartDate) {
    throw Object.assign(new Error("The approved completion date has already passed. Approve a new completion date instead of attempting recovery against an expired commitment."), { status: 409 });
  }
  if (mode === "extend" && revisedCompletionDate <= startOfDay(commitment)) {
    throw Object.assign(new Error("An extension date must be later than the current approved completion date."), { status: 400 });
  }
  if (revisedCompletionDate < recoveryStartDate) throw Object.assign(new Error("The completion target cannot be before the recovery start date."), { status: 400 });

  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.startTime || "")) ? String(body.startTime) : (project.schedulePlan?.workingHours?.start || project.preferredWorkingHours?.start || "09:00");
  const endTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.endTime || "")) ? String(body.endTime) : (project.schedulePlan?.workingHours?.end || project.preferredWorkingHours?.end || "17:00");
  const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  if (toMinutes(endTime) <= toMinutes(startTime)) throw Object.assign(new Error("Daily work end time must be after the start time."), { status: 400 });
  const sourceDays = Array.isArray(body.workingDays) ? body.workingDays : (project.schedulePlan?.workingDays || project.preferredWorkingDays || []);
  const workingDays = [...new Set(sourceDays.map(value => {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WEEKDAY_NUMBERS, text)) return WEEKDAY_NUMBERS[text];
    return Number(text);
  }).filter(value => Number.isInteger(value) && value >= 0 && value <= 6))];
  if (!workingDays.length) throw Object.assign(new Error("Select at least one working day."), { status: 400 });

  return {
    mode,
    reasonCategory,
    reason,
    impactSummary,
    recoveryStartDate,
    revisedCompletionDate,
    previousApprovedCompletionDate: commitment,
    originalBaselineCompletionDate: originalBaseline(project) || commitment,
    forecastBefore: currentForecast(project),
    startTime,
    endTime,
    workingDays,
    notifyCustomer: body.notifyCustomer !== false,
  };
}

function mergeDailySummaries(existing = [], replacement = [], cutoff) {
  const cutoffKey = dayKey(cutoff);
  const historical = (existing || []).filter(day => dayKey(day.date) && dayKey(day.date) < cutoffKey);
  return [...historical, ...(replacement || [])].sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)));
}

function riskStatus(forecast, commitment) {
  const forecastDate = startOfDay(forecast);
  const commitmentDate = startOfDay(commitment);
  if (!forecastDate || !commitmentDate) return "unknown";
  return forecastDate > commitmentDate ? "behind" : "on_track";
}

module.exports = {
  REASON_CATEGORIES,
  currentCommitment,
  currentForecast,
  dayKey,
  mergeDailySummaries,
  normalizeRecoveryRequest,
  originalBaseline,
  riskStatus,
  startOfDay,
};
