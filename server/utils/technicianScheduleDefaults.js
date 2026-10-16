"use strict";

// Existing company fallback, shared by customer capacity and staff assignment.
const COMPANY_START_MINUTES = 480;
const COMPANY_END_MINUTES = 1140;
const DEFAULT_WORKING_DAYS = [1, 3, 4, 5].map(dayOfWeek => ({ dayOfWeek,
  startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES }));
const DEFAULT_NON_WORKING = [0, 2, 6].map(dayOfWeek => ({ dayOfWeek }));
const DEFAULT_SCHEDULE = { workingDays: DEFAULT_WORKING_DAYS, nonWorkingWeekdays: DEFAULT_NON_WORKING, restDates: [] };

module.exports = { COMPANY_START_MINUTES, COMPANY_END_MINUTES, DEFAULT_WORKING_DAYS, DEFAULT_NON_WORKING, DEFAULT_SCHEDULE };
