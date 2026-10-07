const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const payrollRoutes = require("../routes/payrollRoutes");
const Payroll = require("../models/Payroll");
const EmployeeCompensation = require("../models/EmployeeCompensation");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");
const User = require("../models/User");

const approveRoute = payrollRoutes.stack.find((layer) =>
  layer.route?.path === "/:id/approve" && layer.route.methods.post);
const approvePayroll = approveRoute.route.stack.at(-1).handle;

test("monthly payroll with no worked hours cannot be approved silently", async (t) => {
  const priorSeparation = process.env.PAYROLL_SEPARATION_OF_DUTIES;
  process.env.PAYROLL_SEPARATION_OF_DUTIES = "false";
  t.after(() => {
    if (priorSeparation === undefined) delete process.env.PAYROLL_SEPARATION_OF_DUTIES;
    else process.env.PAYROLL_SEPARATION_OF_DUTIES = priorSeparation;
  });

  const payrollId = new mongoose.Types.ObjectId();
  const employeeId = new mongoose.Types.ObjectId();
  const technicianId = new mongoose.Types.ObjectId();
  const draft = {
    _id: payrollId,
    employee: employeeId,
    status: "draft",
    periodStart: new Date("2026-09-01T00:00:00"),
    periodEnd: new Date("2026-09-30T23:59:59.999"),
    payDate: new Date("2026-10-01T00:00:00"),
    overtimeHours: 0,
    allowances: [],
    deductions: [],
    updatedAt: new Date(),
  };
  t.mock.method(Payroll, "findById", async () => draft);
  t.mock.method(Payroll, "findOne", () => ({ select: () => ({ lean: async () => null }) }));
  let approvalUpdate;
  t.mock.method(Payroll, "findOneAndUpdate", async (_filter, update) => {
    approvalUpdate = update;
    return null;
  });
  t.mock.method(EmployeeCompensation, "findOne", () => ({
    sort: () => ({ lean: async () => ({
      _id: new mongoose.Types.ObjectId(), payType: "monthly", baseRate: 30000, overtimeRate: 0,
    }) }),
  }));
  t.mock.method(Technician, "findOne", () => ({ select: () => ({ lean: async () => ({ _id: technicianId }) }) }));
  t.mock.method(User, "findById", () => ({ select: () => ({ lean: async () => ({ role: "technician" }) }) }));
  t.mock.method(TechnicianAttendance, "find", () => ({ select: () => ({ lean: async () => [{
    status: "Absent",
    checkInTime: new Date("2026-09-05T08:00:00"),
    checkOutTime: new Date("2026-09-05T17:00:00"),
  }] }) }));

  async function request(body) {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await approvePayroll({
      params: { id: String(payrollId) },
      body,
      user: { _id: new mongoose.Types.ObjectId(), role: "admin" },
    }, res, (error) => { throw error; });
    return res;
  }

  const withoutReview = await request({});
  assert.equal(withoutReview.statusCode, 409);
  assert.equal(withoutReview.body.code, "ATTENDANCE_EXCEPTION_OVERRIDE_REQUIRED");
  assert.match(withoutReview.body.error, /no worked hours were recorded/i);
  assert.match(withoutReview.body.warnings.join(" "), /No worked hours/);
  assert.equal(approvalUpdate, undefined);

  const withoutReason = await request({ attendanceExceptionOverride: true });
  assert.equal(withoutReason.statusCode, 400);
  assert.equal(withoutReason.body.code, "ATTENDANCE_EXCEPTION_REASON_REQUIRED");
  assert.equal(approvalUpdate, undefined);

  const documented = await request({
    attendanceExceptionOverride: true,
    attendanceExceptionReason: "Approved paid leave for the whole period",
  });
  assert.equal(documented.statusCode, 409); // The mocked compare-and-swap returns no record.
  assert.equal(approvalUpdate.$set.attendanceExceptionOverride.applied, true);
  assert.equal(approvalUpdate.$set.attendanceExceptionOverride.reason, "Approved paid leave for the whole period");
  assert.equal(approvalUpdate.$set.basicPay, 30000);
});
