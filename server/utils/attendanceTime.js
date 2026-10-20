const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Return deterministic Asia/Manila attendance boundaries on any server host. */
function attendanceDay(reference = new Date()) {
  const instant = reference instanceof Date ? reference : new Date(reference);
  if (Number.isNaN(instant.getTime())) throw new TypeError("Invalid attendance date");

  const manilaClock = new Date(instant.getTime() + MANILA_OFFSET_MS);
  const start = new Date(
    Date.UTC(
      manilaClock.getUTCFullYear(),
      manilaClock.getUTCMonth(),
      manilaClock.getUTCDate(),
    ) - MANILA_OFFSET_MS,
  );

  return {
    key: new Date(start.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10),
    start,
    end: new Date(start.getTime() + DAY_MS - 1),
    next: new Date(start.getTime() + DAY_MS),
    lateCutoff: new Date(start.getTime() + 9 * 60 * 60 * 1000),
  };
}

function attendanceRange(from, to) {
  const startDay = attendanceDay(from);
  const endDay = attendanceDay(to || from);
  return { start: startDay.start, end: endDay.end };
}

/** Keep scan lateness and roster reminders on the same saved shift. */
function attendanceShift(day, { schedule, shift } = {}) {
  const weekday = new Date(day.start.getTime() + MANILA_OFFSET_MS).getUTCDay();
  const working = schedule?.workingDays?.find(item => item.dayOfWeek === weekday);
  const minutes = (value, fallback) => Number.isFinite(value) && value >= 0 && value <= 2880 ? value : fallback;
  let start = minutes(working?.startMinutes, 480), end = minutes(working?.endMinutes, 1080);
  const match = String(shift || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
  if (match) { start = Number(match[1]) * 60 + Number(match[2]); end = Number(match[3]) * 60 + Number(match[4]); }
  const rest = schedule?.restDates?.some(item => attendanceDay(item.date).key === day.key)
    || schedule?.nonWorkingWeekdays?.some(item => item.dayOfWeek === weekday);
  return {
    scheduled: !rest && (schedule ? !!working : weekday !== 0),
    startsAt: new Date(day.start.getTime() + start * 60000),
    // Preserve the existing 9 AM cutoff for daytime shifts; later shifts use
    // their saved start, rather than marking everybody late after 9 AM.
    checkInDueAt: new Date(day.start.getTime() + Math.max(540, start) * 60000),
    checkOutDueAt: new Date(day.start.getTime() + (end <= start ? end + 1440 : end) * 60000),
  };
}

module.exports = { attendanceDay, attendanceRange, attendanceShift };
