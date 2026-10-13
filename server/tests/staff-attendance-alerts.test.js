"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { attendanceDay } = require("../utils/attendanceTime");
const { requestedAttendanceDay, staffDayState, existedOnAttendanceDay, loadStaffAttendanceRoster } = require("../utils/staffAttendanceRoster");
const { checkAttendanceAlerts } = require("../utils/attendanceAlerts");
const Notification = require("../models/Notification");
const now = new Date("2026-10-12T10:30:00+08:00");
const day = attendanceDay(now);
const state = options => staffDayState({ day, now, ...options });

test("missing check-in is only flagged after cutoff; shift starts and ends are respected", () => {
  assert.equal(state({ now: new Date("2026-10-12T08:30:00+08:00") }).issue, null);
  assert.equal(state({}).issue, "missing_checkin");
  assert.equal(state({ shift: "11:00-20:00" }).issue, null);
  const lateShift = state({ shift: "11:00-20:00", now: new Date("2026-10-12T11:30:00+08:00") });
  assert.equal(lateShift.issue, "missing_checkin");
  assert.equal(lateShift.checkOutDueAt.toISOString(), "2026-10-12T12:00:00.000Z");
});

test("checked-in staff need check-out after their shift; completed time records stay complete", () => {
  const record = { status: "Present", checkInTime: new Date("2026-10-12T08:00:00+08:00") };
  assert.equal(state({ record, now: new Date("2026-10-12T17:00:00+08:00") }).issue, null);
  assert.equal(state({ record, now: new Date("2026-10-12T18:01:00+08:00") }).issue, "missing_checkout");
  assert.equal(state({ record: { ...record, checkOutTime: new Date("2026-10-12T18:00:00+08:00") }, now: new Date("2026-10-12T20:00:00+08:00") }).issue, null);
  assert.equal(record.checkOutTime, undefined);
});

test("leave, holidays and rest dates do not generate false missing-check-in alerts", () => {
  assert.equal(state({ leave: { reason: "Annual leave" } }).issue, null);
  assert.equal(state({ record: { status: "Sick Leave" } }).attendanceStatus, "Sick Leave");
  assert.equal(state({ holiday: true }).issue, null);
  assert.equal(state({ schedule: { workingDays: [{ dayOfWeek: 2 }], restDates: [] } }).issue, null);
  assert.equal(state({ schedule: { workingDays: [{ dayOfWeek: 1 }], restDates: [{ date: now }] } }).issue, null);
  const sunday = new Date("2026-10-11T12:00:00+08:00");
  assert.equal(state({ day: attendanceDay(sunday), now: sunday }).attendanceStatus, "Rest day");
  assert.equal(state({ day: attendanceDay(sunday), now: sunday, schedule: { workingDays: [{ dayOfWeek: 0, startMinutes: 480, endMinutes: 1140 }] } }).issue, "missing_checkin");
});

test("saved technician overtime and overnight secretary shifts do not trigger early check-out alerts", () => {
  const record = { status: "Present", checkInTime: now };
  const schedule = { workingDays: [{ dayOfWeek: 1, startMinutes: 480, endMinutes: 1140 }] };
  assert.equal(state({ record, schedule, now: new Date("2026-10-12T18:00:00+08:00") }).issue, null);
  assert.equal(state({ record, schedule, now: new Date("2026-10-12T19:01:00+08:00") }).issue, "missing_checkout");
  const overnight = state({ record, shift: "22:00-06:00", now: new Date("2026-10-13T05:30:00+08:00") });
  assert.equal(overnight.issue, null);
  assert.equal(overnight.checkOutDueAt.toISOString(), "2026-10-12T22:00:00.000Z");
  assert.equal(state({ record, shift: "22:00-06:00", now: new Date("2026-10-13T07:00:00+08:00") }).issue, "missing_checkout");
});

test("requested dates are validated against real Manila calendar dates", () => {
  assert.equal(requestedAttendanceDay("2026-10-12", now).start.toISOString(), "2026-10-11T16:00:00.000Z");
  for (const value of ["bad", "2026-02-30", "2026-13-12"]) assert.throws(() => requestedAttendanceDay(value, now), error => error.status === 400);
});

test("daily roster includes staff with no records, uses batch reads and never saves attendance or availability", async () => {
  const reads = [];
  const data = {
    Technician: [{ _id: "t1", name: "One", user: { _id: "u1", active: true, role: "technician" }, availabilityStatus: "Assigned" }, { _id: "inactive", name: "Inactive", user: { _id: "inactive-user", active: false } }],
    User: [{ _id: "s1", firstName: "Secretary", lastName: "One" }],
    TechnicianAttendance: [{ technicianId: "t1", status: "Present", checkInTime: new Date("2026-10-12T08:00:00+08:00"), securityVersion: 2 }],
    SecretaryAttendance: [], LeaveRequest: [], TechnicianSchedule: [], Secretary: [], NonWorkingDay: [],
  };
  const models = Object.fromEntries(Object.entries(data).map(([name, records]) => [name, { find(filter) {
    reads.push({ name, filter });
    return { select() { return this; }, populate() { return this; }, async lean() { return records; } };
  }, save() { throw new Error("Unexpected write"); }, updateOne() { throw new Error("Unexpected write"); } }]));
  const rows = await loadStaffAttendanceRoster({ date: day.key, now, models });
  assert.equal(reads.length, 8);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.role === "secretary").missingCheckIn, true);
  assert.equal(rows.find(row => row.role === "technician").availabilityStatus, "Assigned");
  assert.equal(rows.find(row => row.role === "technician").checkOutState, "Not checked out");
  assert.equal(reads.find(read => read.name === "Technician").filter.active.$ne, false);
  const earlier = await loadStaffAttendanceRoster({ date: "2026-10-11", now, models });
  assert.ok(earlier.every(row => row.canEdit === false && row.availabilityStatus === null));
});

test("legacy creation dates use the profile ID while valid dates preserve historical staff eligibility", () => {
  const oldId = "6a280b6334b3d7bc1a3ad5d1";
  const tomorrowId = Math.floor(new Date("2026-10-13T08:00:00+08:00").getTime() / 1000).toString(16) + "0000000000000000";
  for (const createdAt of [{}, null, undefined, "invalid"]) {
    assert.equal(existedOnAttendanceDay({ _id: oldId, createdAt }, day), true);
    assert.equal(existedOnAttendanceDay({ _id: tomorrowId, createdAt }, day), false);
  }
  for (const createdAt of [new Date("2026-10-13T08:00:00+08:00"), "2026-10-13T08:00:00+08:00"]) {
    assert.equal(existedOnAttendanceDay({ _id: oldId, createdAt }, day), false);
  }
  assert.equal(existedOnAttendanceDay({ _id: oldId, createdAt: day.end }, day), true);
});

test("roster keeps seven imported technician profiles alongside two dated profiles, including staff without sign-in accounts", async () => {
  const legacy = Array.from({ length: 7 }, (_, index) => ({ _id: `6a280b6334b3d7bc1a3ad5d${index}`, name: `Imported ${index}`, createdAt: {}, user: index < 2 ? null : { _id: `u${index}`, active: true, role: "technician" } }));
  const data = {
    Technician: [...legacy, { _id: "recent1", name: "Recent one", createdAt: now }, { _id: "recent2", name: "Recent two", createdAt: now }, { _id: "future", name: "Future", createdAt: new Date("2026-10-13T08:00:00+08:00") }],
    User: [{ _id: "6a280b6334b3d7bc1a3ad5df", firstName: "Imported secretary", createdAt: {} }, { _id: "futureSecretary", firstName: "Future secretary", createdAt: new Date("2026-10-13T08:00:00+08:00") }],
    TechnicianAttendance: [], SecretaryAttendance: [], LeaveRequest: [], TechnicianSchedule: [], Secretary: [], NonWorkingDay: [],
  };
  const models = Object.fromEntries(Object.entries(data).map(([name, records]) => [name, { find(filter) {
    if (["Technician", "User"].includes(name)) {
      // MongoDB's date comparison excludes BSON objects. The database query
      // must leave legacy dates for the service to normalize instead.
      assert.equal(filter.$or, undefined);
      assert.equal(filter.createdAt, undefined);
    }
    return { select() { return this; }, populate() { return this; }, async lean() { return records; } };
  } }]));
  const rows = await loadStaffAttendanceRoster({ date: day.key, now, models });
  assert.equal(rows.filter(row => row.role === "technician").length, 9);
  assert.equal(rows.filter(row => row.role === "secretary").length, 1);
  assert.equal(rows.filter(row => row.role === "technician" && row.userId === null).length, 4);
  assert.ok(rows.every(row => row.missingCheckIn));
  assert.ok(rows.every(row => !row.name.startsWith("Future")));
});

test("attendance alerts are saved once per staff/day/issue/recipient and target the staff account privately", async () => {
  const saved = new Map();
  const emitted = [];
  const row = { staffId: "t1", userId: "u1", staffType: "technician", role: "technician", name: "One", issue: "missing_checkin" };
  const options = { now, loadRoster: async ({ date }) => date === day.key ? [row] : [],
    notificationModel: { async updateOne(filter, update) {
      if (saved.has(filter.attendanceAlertKey)) return { upsertedCount: 0 };
      saved.set(filter.attendanceAlertKey, update.$setOnInsert);
      return { upsertedCount: 1, upsertedId: filter.attendanceAlertKey };
    } }, io: { to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } },
  };
  assert.equal(await checkAttendanceAlerts(options), 2);
  assert.equal(await checkAttendanceAlerts(options), 0);
  assert.deepEqual(emitted.map(item => item.room), ["admin-room", "user:u1"]);
  const personal = [...saved.values()].find(item => item.userId === "u1");
  assert.equal(personal.role, null);
  assert.equal(personal.link, "/technician/attendance");
  row.issue = "missing_checkout";
  assert.equal(await checkAttendanceAlerts(options), 2);
  assert.equal(saved.size, 4);
  assert.ok(Notification.schema.indexes().some(([fields, spec]) => fields.attendanceAlertKey === 1 && spec.unique && spec.sparse));
});

test("secretary alerts use the secretary's account; failed saves retry without duplicating successful recipients", async () => {
  let failed = true;
  const saved = new Map();
  const options = { now, io: null, loadRoster: async ({ date }) => date === day.key ? [{ staffId: "s1", userId: "s1", staffType: "secretary", role: "secretary", name: "Office", issue: "missing_checkin" }] : [],
    notificationModel: { async updateOne(filter, update) {
      if (update.$setOnInsert.userId && failed) { failed = false; throw new Error("Temporary database error"); }
      if (saved.has(filter.attendanceAlertKey)) return { upsertedCount: 0 };
      saved.set(filter.attendanceAlertKey, update.$setOnInsert); return { upsertedCount: 1 };
    } },
  };
  await assert.rejects(checkAttendanceAlerts(options));
  assert.equal(await checkAttendanceAlerts(options), 1);
  assert.equal(saved.size, 2);
  assert.equal([...saved.values()].find(row => row.userId === "s1").link, "/secretary/attendance");
});
