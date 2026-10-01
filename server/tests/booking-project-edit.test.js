"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Project = require("../models/Project");
const { parseProjectWindow, prepareProjectServiceChange } = require("../utils/projectServiceChange");

const futureKey = days => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

test("project edit requires a future start and an end date", () => {
  assert.throws(() => parseProjectWindow({ date: futureKey(2) }), /start date and an end date/);
  assert.throws(() => parseProjectWindow({ date: futureKey(3), endDate: futureKey(2) }), /valid project date range/);
  assert.throws(() => parseProjectWindow({ date: futureKey(0), endDate: futureKey(2) }), /after today/);
  const window = parseProjectWindow({ date: futureKey(2), endDate: futureKey(3) });
  assert.equal(window.startKey, futureKey(2));
  assert.equal(window.endKey, futureKey(3));
});

test("project conversion clears the appointment time and builds matching project data", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const startDate = parseProjectWindow({ date: futureKey(2), endDate: futureKey(5) }).startDate;
  const endDate = parseProjectWindow({ date: futureKey(2), endDate: futureKey(5) }).endDate;
  const plannedCompletionDate = parseProjectWindow({ date: futureKey(2), endDate: futureKey(4) }).endDate;
  const booking = new BookingService({
    customerId,
    customer: { name: "Test Customer", phone: "09123456789" },
    status: "pending",
    serviceType: "core",
    bookingDate: new Date(),
    startTime: "09:00",
    endTime: "11:00",
    selectedTimeLabel: "9:00 AM",
    services: [
      { name: "Aircon Cleaning", type: "core", quantity: 5, duration: 60, unitPrice: 800, totalPrice: 4000, schedule: { startTime: "09:00", endTime: "11:00" } },
      { name: "Aircon Installation", type: "core", quantity: 3, duration: 120, unitPrice: 1000, totalPrice: 3000, schedule: { startTime: "09:00", endTime: "11:00" } },
    ],
  });
  const projectData = prepareProjectServiceChange(booking, { startDate, endDate, plannedCompletionDate, inspectionDurationMinutes: 90 });
  assert.equal(booking.isProject, true);
  assert.equal(booking.status, "pending_project_scheduling");
  assert.equal(booking.quantity, 8);
  assert.equal(booking.startTime, undefined);
  assert.equal(booking.endTime, undefined);
  assert.equal(booking.selectedTimeLabel, undefined);
  assert.equal(booking.projectScheduling.preferredCompletionDeadline.getTime(), endDate.getTime());
  assert.equal(booking.services.every(item => !item.schedule.startTime && !item.schedule.endTime), true);
  assert.equal(projectData.totalUnits, 8);
  assert.equal(projectData.estimatedTotalHours, 11);
  assert.equal(projectData.plannedCompletionDate.getTime(), plannedCompletionDate.getTime());
  assert.equal(projectData.unitGroups.reduce((sum, item) => sum + item.units.length, 0), 8);
  await new Project(projectData).validate();
});
