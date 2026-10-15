"use strict";

const { strictManilaDateKey, manilaDateKey } = require("./bookingDateTime");
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function projectDateKey(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return strictManilaDateKey(value);
  if (value instanceof Date || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return manilaDateKey(value);
  return "";
}
function walkInProjectWindow(input, bookingDate, requiredHours, now = new Date()) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400, code: "WALK_IN_PROJECT_WINDOW_INVALID" }); };
  const prefs = input?.preferences || {};
  const start = projectDateKey(input?.preferredStartDate || input?.startDate || bookingDate);
  const end = projectDateKey(input?.preferredCompletionDeadline || input?.endDate || prefs.completionDeadline);
  const startDate = new Date(`${start}T00:00:00+08:00`), endDate = new Date(`${end}T00:00:00+08:00`);
  if (!start || !end || start < manilaDateKey(now) || end < start || endDate - startDate > 366 * 86400000 || start !== projectDateKey(bookingDate)) fail("Choose a valid project start date and finish-by date within one year. Past dates are not available.");
  const days = prefs.workingDays ?? input?.preferredWorkingDays ?? [];
  if (!Array.isArray(days) || days.some(d => !DAY_NAMES.includes(d)) || new Set(days).size !== days.length) fail("Choose valid project working days.");
  const period = prefs.preferredWorkingHours || prefs.timeOfDay || "morning";
  if (!["morning", "afternoon", "evening"].includes(period)) fail("Choose a supported project working period.");
  if (days.length) {
    let found = false;
    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      if (days.includes(DAY_NAMES[new Date(d.getTime() + 8 * 3600000).getUTCDay()])) { found = true; break; }
    }
    if (!found) fail("The project window does not contain any of the selected working days.");
  }
  return { preferredStartDate: startDate, preferredCompletionDeadline: endDate, preferredWorkingDays: days,
    preferredWorkingHours: { morning: { start: "08:00", end: "12:00" }, afternoon: { start: "13:00", end: "17:00" }, evening: { start: "17:00", end: "19:00" } }[period],
    estimatedTotalHours: requiredHours };
}
function hasPreferredCapacity(verdict, preferences) {
  if (!verdict.sufficient) return false;
  const period = preferences.preferredWorkingHours;
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const preferredHours = (minutes(period.end) - minutes(period.start)) / 60;
  const hours = (verdict.days || []).reduce((sum, day) => {
    const weekday = DAY_NAMES[new Date(`${day.date}T12:00:00Z`).getUTCDay()];
    if (!day.isWorkingDay || (preferences.preferredWorkingDays.length && !preferences.preferredWorkingDays.includes(weekday))) return sum;
    return sum + Math.min(Number(day.capacityHours) || 0, (Number(day.availableTechnicians) || 0) * preferredHours);
  }, 0);
  return hours + 1e-9 >= preferences.estimatedTotalHours;
}
function preferredProjectDays(days, preferences) {
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const hours = (minutes(preferences.preferredWorkingHours.end) - minutes(preferences.preferredWorkingHours.start)) / 60;
  return days.map(day => {
    const allowed = !preferences.preferredWorkingDays.length || preferences.preferredWorkingDays.includes(DAY_NAMES[new Date(`${day.date}T12:00:00Z`).getUTCDay()]);
    const capacityHours = allowed && day.isWorkingDay ? Math.min(day.capacityHours, day.availableTechnicians * hours) : 0;
    return { ...day, isWorkingDay: day.isWorkingDay && allowed, capacityHours,
      status: !capacityHours ? "none" : "partial", ...(!allowed ? { reason: "Outside preferred working days" } : {}) };
  });
}
module.exports = { walkInProjectWindow, projectDateKey, hasPreferredCapacity, preferredProjectDays };
