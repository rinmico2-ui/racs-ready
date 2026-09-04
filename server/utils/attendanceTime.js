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

module.exports = { attendanceDay, attendanceRange };
