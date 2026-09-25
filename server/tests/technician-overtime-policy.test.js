"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { latestAllowedFinish, overtimeMinutesForWindow } = require("../utils/technicianOvertimePolicy");

test("overtime allows a late service start but has a hard daily finish limit", () => {
  assert.equal(latestAllowedFinish(19 * 60), 22 * 60);
  assert.equal(latestAllowedFinish(17 * 60), 22 * 60);
  assert.equal(latestAllowedFinish(12 * 60), 17 * 60);
  assert.equal(overtimeMinutesForWindow(16 * 60, 21 * 60 + 30, 8 * 60, 19 * 60), 150);
  assert.equal(overtimeMinutesForWindow(16 * 60, 22 * 60 + 30, 8 * 60, 19 * 60), null);
  assert.equal(overtimeMinutesForWindow(19 * 60, 20 * 60, 8 * 60, 19 * 60), null);
  assert.equal(overtimeMinutesForWindow(15 * 60, 20 * 60, 8 * 60, 17 * 60), 180);
  assert.equal(overtimeMinutesForWindow(16 * 60, 21 * 60 + 30, 8 * 60, 17 * 60), 270);
  assert.equal(overtimeMinutesForWindow(15 * 60, 22 * 60 + 1, 8 * 60, 17 * 60), null);
  assert.equal(overtimeMinutesForWindow(11 * 60, 17 * 60 + 1, 8 * 60, 12 * 60), null);
});

test("customer and admin time slots use the same overtime limit as assignment", () => {
  const schedule = fs.readFileSync(path.join(__dirname, "../routes/scheduleRoutes.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "../routes/serviceRoutes.js"), "utf8");
  const planner = fs.readFileSync(path.join(__dirname, "../utils/assignmentPlanner.js"), "utf8");
  assert.match(schedule, /overtimeMinutesForWindow\(s, slotEnd, t\.startMinutes, t\.endMinutes\)/);
  assert.match(schedule, /overtimeMinutesForWindow\(slotStart, slotEnd, workStartMin, workEndMin\)/);
  assert.match(schedule, /overtimeMinutesForWindow\(slotStart, slotEnd,[\s\S]*?tech\.workingDay\.endMinutes/);
  assert.match(service, /overtimeMinutesForWindow\(winStart, winEnd, w\.blockStart, w\.blockEnd\)/);
  assert.match(planner, /overtimeMinutesForWindow\(target\.start, target\.end, shiftStart, shiftEnd\)/);
});
