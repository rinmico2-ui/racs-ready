const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const Payroll = require("../models/Payroll");
const {
  calculateBasicPay,
  calculateOvertimePay,
  attendanceQualityWarnings,
  hasBlockingAttendanceExceptions,
  separationOfDutiesViolation,
  calendarDayCount,
  payrollTotals,
  periodsOverlap,
} = require("../utils/payrollPolicy");

test("calculates daily and hourly payroll from verified attendance inputs", () => {
  assert.equal(calculateBasicPay(
    { payType: "daily", baseRate: 800 },
    { present: 4, late: 1, hoursWorked: 39 },
    new Date(2026, 7, 1),
    new Date(2026, 7, 5),
  ), 4000);
  assert.equal(calculateBasicPay(
    { payType: "hourly", baseRate: 125.5 },
    { hoursWorked: 7.75 },
    new Date(2026, 7, 1),
    new Date(2026, 7, 1),
  ), 972.63);
});

test("calculates overtime from approved hours and the effective rate", () => {
  assert.equal(calculateOvertimePay({ overtimeRate: 125.5 }, 2.25), 282.38);
  assert.equal(calculateOvertimePay({ overtimeRate: 0 }, 5), 0);
});

test("surfaces attendance exceptions and blocks unsafe non-monthly approval", () => {
  const compensation = { payType: "hourly" };
  const attendance = {
    present: 1,
    late: 0,
    incompleteShifts: 1,
    manualEntries: 1,
    unverifiedEntries: 0,
  };
  const warnings = attendanceQualityWarnings(compensation, attendance);
  assert.equal(warnings.length, 2);
  assert.equal(hasBlockingAttendanceExceptions(compensation, attendance), true);
  assert.equal(hasBlockingAttendanceExceptions({ payType: "monthly" }, attendance), false);
});

test("enforces maker-checker controls only when multiple administrators are available", () => {
  assert.equal(separationOfDutiesViolation({ activeAdminCount: 1, createdBy: "admin-1", actorId: "admin-1", action: "approve" }), null);
  assert.equal(separationOfDutiesViolation({ activeAdminCount: 2, createdBy: "admin-1", actorId: "admin-1", action: "approve" }), "creator_cannot_approve");
  assert.equal(separationOfDutiesViolation({ activeAdminCount: 2, approvedBy: "admin-2", actorId: "admin-2", action: "pay" }), "approver_cannot_pay");
  assert.equal(separationOfDutiesViolation({ activeAdminCount: 2, approvedBy: "admin-2", actorId: "admin-3", action: "pay" }), null);
});

test("prorates monthly salary by each covered calendar month", () => {
  assert.equal(calculateBasicPay(
    { payType: "monthly", baseRate: 30000 },
    {},
    new Date(2026, 7, 1),
    new Date(2026, 7, 31),
  ), 30000);
  assert.equal(calculateBasicPay(
    { payType: "monthly", baseRate: 30000 },
    {},
    new Date(2026, 7, 1),
    new Date(2026, 8, 30),
  ), 60000);
  assert.equal(calendarDayCount(new Date(2026, 7, 15), new Date(2026, 7, 31)), 17);
});

test("derives authoritative totals and never creates a negative net pay", () => {
  assert.deepEqual(payrollTotals({
    basicPay: 1000,
    overtimePay: 250.555,
    allowances: [{ amount: 100.1 }],
    deductions: [{ amount: 200 }, { amount: 50.25 }],
  }), { grossPay: 1350.66, totalDeductions: 250.25, netPay: 1100.41 });

  assert.equal(payrollTotals({ basicPay: 100, deductions: [{ amount: 500 }] }).netPay, 0);
});

test("detects inclusive payroll-period overlaps", () => {
  assert.equal(periodsOverlap("2026-08-01", "2026-08-15", "2026-08-15", "2026-08-31"), true);
  assert.equal(periodsOverlap("2026-08-01", "2026-08-14", "2026-08-15", "2026-08-31"), false);
});

test("payroll audit snapshots and notifications accept payroll references", async () => {
  const userId = new mongoose.Types.ObjectId();
  const payrollId = new mongoose.Types.ObjectId();
  const payroll = new Payroll({
    employee: userId,
    employeeRole: "technician",
    periodStart: new Date(),
    periodEnd: new Date(),
    payDate: new Date(),
    basicPay: 800,
    overtimePay: 0,
    overtimeRate: 125,
    grossPay: 800,
    totalDeductions: 0,
    netPay: 800,
    createdBy: userId,
  });
  await payroll.validate();
  assert.equal(payroll.overtimeRate, 125);

  const notification = new Notification({
    userId,
    type: "payroll_paid",
    title: "Payroll paid",
    message: "Payment processed.",
    referenceId: payrollId,
    referenceModel: "Payroll",
  });
  await notification.validate();
  assert.equal(notification.referenceModel, "Payroll");
});

test("requires an overtime authorization note when overtime hours are present", async () => {
  const userId = new mongoose.Types.ObjectId();
  const payroll = new Payroll({
    employee: userId,
    employeeRole: "technician",
    periodStart: new Date(),
    periodEnd: new Date(),
    payDate: new Date(),
    basicPay: 800,
    overtimeHours: 2,
    overtimePay: 250,
    grossPay: 1050,
    totalDeductions: 0,
    netPay: 1050,
    createdBy: userId,
  });
  await assert.rejects(payroll.validate(), /overtimeNote/);
});

test("keeps the live-period uniqueness rule while allowing voided replacements", () => {
  const [, options] = Payroll.schema.indexes().find(([, indexOptions]) => indexOptions.name === "payroll_employee_active_period_unique");
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression.status.$in, ["draft", "approved", "paid"]);
});
