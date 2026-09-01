const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTime,
  expectedReturnForWorkDate,
  effectiveExpectedReturnAt,
  equipmentReturnState,
} = require("../utils/equipmentReturnPolicy");

test("parses 12-hour and 24-hour booking end times", () => {
  assert.deepEqual(parseTime("5:30 PM"), { hour: 17, minute: 30 });
  assert.deepEqual(parseTime("08:15"), { hour: 8, minute: 15 });
  assert.deepEqual(parseTime("12:00 AM"), { hour: 0, minute: 0 });
  assert.equal(parseTime("25:00"), null);
});

test("expected return adds the operational grace period to booking end", () => {
  const result = expectedReturnForWorkDate(new Date(2026, 7, 27, 8, 0), "5:00 PM", 120);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 7);
  assert.equal(result.getDate(), 27);
  assert.equal(result.getHours(), 19);
  assert.equal(result.getMinutes(), 0);
});

test("legacy assignments fall back to end of their work date", () => {
  const result = effectiveExpectedReturnAt({ workDate: new Date(2026, 7, 26, 9, 0) });
  assert.equal(result.getHours(), 23);
  assert.equal(result.getMinutes(), 59);
});

test("return state distinguishes overdue, due today, open, and resolved", () => {
  const now = new Date(2026, 7, 27, 12, 0);
  assert.equal(equipmentReturnState({ status: "checked_out", expectedReturnAt: new Date(2026, 7, 27, 10, 0) }, now).state, "overdue");
  assert.equal(equipmentReturnState({ status: "in_use", expectedReturnAt: new Date(2026, 7, 27, 18, 0) }, now).state, "due_today");
  assert.equal(equipmentReturnState({ status: "checked_out", expectedReturnAt: new Date(2026, 7, 28, 18, 0) }, now).state, "open");
  assert.equal(equipmentReturnState({ status: "returned", expectedReturnAt: new Date(2026, 7, 26, 18, 0) }, now).state, "resolved");
});
