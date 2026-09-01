const DEFAULT_RETURN_GRACE_MINUTES = 120;

function parseTime(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  const match = input.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = String(match[3] || "").toUpperCase();
  if (minute > 59 || hour > (period ? 12 : 23) || hour < 0 || (period && hour < 1)) return null;
  if (period === "AM" && hour === 12) hour = 0;
  if (period === "PM" && hour !== 12) hour += 12;
  return { hour, minute };
}

function expectedReturnForWorkDate(workDate, endTime, graceMinutes = DEFAULT_RETURN_GRACE_MINUTES) {
  const expected = new Date(workDate || Date.now());
  if (Number.isNaN(expected.getTime())) return null;
  const clock = parseTime(endTime);
  if (!clock) {
    expected.setHours(23, 59, 59, 999);
    return expected;
  }
  expected.setHours(clock.hour, clock.minute, 0, 0);
  expected.setMinutes(expected.getMinutes() + Math.max(0, Number(graceMinutes) || 0));
  return expected;
}

function effectiveExpectedReturnAt(assignment) {
  const explicit = assignment && assignment.expectedReturnAt
    ? new Date(assignment.expectedReturnAt)
    : null;
  if (explicit && !Number.isNaN(explicit.getTime())) return explicit;
  return expectedReturnForWorkDate(
    assignment && (assignment.workDate || assignment.checkedOutAt || assignment.createdAt),
    null,
    0,
  );
}

function equipmentReturnState(assignment, now = new Date()) {
  const active = ["checked_out", "in_use"].includes(String(assignment && assignment.status));
  if (!active || assignment?.consumable) {
    return { state: "resolved", overdue: false, overdueMinutes: 0, expectedReturnAt: effectiveExpectedReturnAt(assignment) };
  }
  const expectedReturnAt = effectiveExpectedReturnAt(assignment);
  if (!expectedReturnAt) return { state: "open", overdue: false, overdueMinutes: 0, expectedReturnAt: null };
  const current = new Date(now);
  const overdueMinutes = Math.max(0, Math.floor((current - expectedReturnAt) / 60000));
  if (current > expectedReturnAt) return { state: "overdue", overdue: true, overdueMinutes, expectedReturnAt };
  const endOfToday = new Date(current);
  endOfToday.setHours(23, 59, 59, 999);
  if (expectedReturnAt <= endOfToday) return { state: "due_today", overdue: false, overdueMinutes: 0, expectedReturnAt };
  return { state: "open", overdue: false, overdueMinutes: 0, expectedReturnAt };
}

module.exports = {
  DEFAULT_RETURN_GRACE_MINUTES,
  parseTime,
  expectedReturnForWorkDate,
  effectiveExpectedReturnAt,
  equipmentReturnState,
};
