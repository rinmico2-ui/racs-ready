"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const LeaveRequest = require("../models/LeaveRequest");
const Assignment = require("../models/Assignment");
const { bookingWindow, buildAssignmentPlan } = require("../utils/assignmentPlanner");

const query = rows => ({ select() { return this; }, lean: async () => rows });

test("assignment planner keeps every eligible technician, not only the top five", async () => {
  const originals = [
    [Technician, Technician.find],
    [TechnicianSchedule, TechnicianSchedule.find],
    [LeaveRequest, LeaveRequest.find],
    [BookingService, BookingService.find],
    [Assignment, Assignment.find],
  ];
  const technicians = Array.from({ length: 7 }, (_, i) => ({ _id: `tech-${i + 1}`, name: `Technician ${i + 1}`, active: true }));
  try {
    Technician.find = () => query(technicians);
    TechnicianSchedule.find = () => query(technicians.map((tech, i) => ({
      technicianId: tech._id,
      workingDays: [{ dayOfWeek: 1, startMinutes: i === 6 ? 600 : 480, endMinutes: 1020 }],
    })));
    LeaveRequest.find = () => query([]);
    BookingService.find = () => query([]);
    Assignment.find = () => query([]);

    const [plan] = await buildAssignmentPlan([{
      _id: "booking-1",
      bookingDate: new Date("2027-01-04T00:00:00+08:00"),
      startTime: "09:00",
      endTime: "10:00",
      serviceDurationMinutes: 60,
    }], { reservePlan: false });

    assert.equal(plan.candidates.length, 6);
    assert.ok(plan.candidates.some(candidate => candidate.technicianId === "tech-6"));
    assert.equal(plan.exclusionReasons["tech-7"], "Outside Working Hours and Overtime Limit");

    const lateBooking = {
      _id: "booking-2",
      bookingDate: new Date("2027-01-04T00:00:00+08:00"),
      startTime: "16:00",
      endTime: "21:30",
      serviceDurationMinutes: 330,
    };
    const [overtimePlan] = await buildAssignmentPlan([lateBooking], { reservePlan: false });
    assert.equal(overtimePlan.candidates.length, 7);
    assert.equal(overtimePlan.candidates[0].overtimeMinutes, 270);

    const [tooLatePlan] = await buildAssignmentPlan([{ ...lateBooking, endTime: "22:30" }], { reservePlan: false });
    assert.equal(tooLatePlan.candidates.length, 0);
    assert.equal(tooLatePlan.exclusionReasons["tech-1"], "Outside Working Hours and Overtime Limit");
  } finally {
    for (const [model, find] of originals) model.find = find;
  }
});

test("explicit booking end time defines capacity even when legacy duration disagrees", () => {
  assert.deepEqual(bookingWindow({ startTime: "09:00", endTime: "10:00", serviceDurationMinutes: 240 }), {
    start: 540, end: 600, duration: 60,
  });
});

test("technician picker and confirmation both use the assignment planner", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/appointmentManagement.js"), "utf8");
  const picker = route.slice(route.indexOf("router.get('/:id/eligible-technicians'"), route.indexOf("router.get('/waiting-acceptance/list'"));
  assert.match(picker, /buildAssignmentPlan\(\[booking\], \{ reservePlan: false \}\)/);
  assert.match(picker, /candidateById\.has\(tid\)/);
  assert.doesNotMatch(picker, /MAX_ACTIVE_ASSIGNMENTS|overlapTechIds/);
  assert.match(route, /eligibility\?\.exclusionReasons\?\.\[String\(technicianId\)\]/);
});
