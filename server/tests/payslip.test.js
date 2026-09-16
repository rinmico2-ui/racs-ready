const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const mongoose = require("mongoose");
const Payroll = require("../models/Payroll");
const { payslipNumberFor, canViewPayslip } = require("../utils/payslipPresentation");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("generates a stable payslip reference and preserves an issued reference", () => {
  const payroll = {
    _id: "66ff00112233445566778899",
    periodEnd: new Date("2026-09-15T23:59:59.999Z"),
  };
  assert.equal(payslipNumberFor(payroll), "PS-202609-66FF00112233445566778899");
  assert.equal(payslipNumberFor({ ...payroll, payslipNumber: "ps-custom-01" }), "PS-CUSTOM-01");
});

test("enforces the payslip access matrix", () => {
  const employeeId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const approved = { employee: { _id: employeeId }, status: "approved" };
  const paid = { employee: employeeId, status: "paid" };
  const voided = { employee: employeeId, status: "voided" };
  const draft = { employee: employeeId, status: "draft" };

  assert.equal(canViewPayslip({ _id: otherId, role: "admin" }, approved), true);
  assert.equal(canViewPayslip({ _id: employeeId, role: "technician" }, approved), true);
  assert.equal(canViewPayslip({ _id: employeeId, role: "secretary" }, paid), true);
  assert.equal(canViewPayslip({ _id: otherId, role: "technician" }, approved), false);
  assert.equal(canViewPayslip({ _id: employeeId, role: "technician" }, voided), false);
  assert.equal(canViewPayslip({ _id: otherId, role: "admin" }, voided), true);
  assert.equal(canViewPayslip({ _id: employeeId, role: "technician" }, draft), false);
  assert.equal(canViewPayslip({ _id: otherId, role: "admin" }, draft), false);
});

test("payroll schema stores immutable issuance metadata", () => {
  assert.ok(Payroll.schema.path("payslipNumber"));
  assert.ok(Payroll.schema.path("payslipVersion"));
  assert.ok(Payroll.schema.path("payslipIssuedAt"));
  assert.ok(Payroll.schema.path("payslipIssuedBy"));
  assert.equal(Payroll.schema.path("payslipNumber").options.unique, true);
  assert.equal(Payroll.schema.path("payslipNumber").options.sparse, true);
  assert.ok(Payroll.schema.path("attendanceExceptionOverride.reason"));
  assert.ok(Payroll.schema.path("attendanceExceptionOverride.authorizedBy"));
});

test("payslip endpoint is private and issuance happens atomically with approval", () => {
  const route = read("routes/payrollRoutes.js");
  assert.match(route, /router\.get\("\/:id\/payslip"/);
  assert.match(route, /canViewPayslip\(req\.user, record\)/);
  assert.match(route, /Cache-Control": "private, no-store/);
  assert.match(route, /X-Robots-Tag/);
  assert.match(route, /status: "approved",[\s\S]*payslipNumber,[\s\S]*payslipIssuedAt: approvedAt/);
});

test("single-admin payroll is the default while maker-checker remains opt-in", () => {
  const route = read("routes/payrollRoutes.js");
  const environment = fs.readFileSync(path.join(__dirname, "..", "..", ".env.example"), "utf8");
  assert.match(route, /PAYROLL_SEPARATION_OF_DUTIES/);
  assert.match(route, /if \(!separationRequired\) return/);
  assert.match(route, /blocked: \{ \$ne: true \}/);
  assert.match(route, /archivedAt: null/);
  assert.match(environment, /PAYROLL_SEPARATION_OF_DUTIES=false/);
});

test("blocking attendance can only be overridden with documented approval", () => {
  const route = read("routes/payrollRoutes.js");
  const page = read("views/pages/admin/Payroll/PayrollManagement.ejs");
  assert.match(route, /attendanceOverrideRequested/);
  assert.match(route, /attendanceOverrideReason\.length < 10/);
  assert.match(route, /ATTENDANCE_EXCEPTION_OVERRIDE_REQUIRED/);
  assert.match(route, /attendanceExceptionOverride: hasAttendanceBlock/);
  assert.match(page, /attendanceOverrideConfirm/);
  assert.match(page, /attendanceOverrideReason/);
  assert.match(page, /I reviewed the source attendance records/);
});

test("renders a standalone A4 payslip without exposing payment-proof URLs", async () => {
  const templatePath = path.join(__dirname, "..", "views", "pages", "shared", "Payslip.ejs");
  const template = fs.readFileSync(templatePath, "utf8");
  const employeeId = new mongoose.Types.ObjectId();
  const html = await ejs.render(template, {
    payslipNumber: "PS-202609-12345678",
    company: { name: "CALIDRO RACS", address: "Nueva Ecija", phone: "0900", email: "pay@example.com" },
    record: {
      _id: new mongoose.Types.ObjectId(),
      employee: { _id: employeeId, firstName: "Juan", lastName: "Dela Cruz", email: "juan@example.com", role: "technician" },
      employeeRole: "technician",
      status: "paid",
      periodStart: new Date("2026-09-01"),
      periodEnd: new Date("2026-09-15"),
      payDate: new Date("2026-09-16"),
      payslipIssuedAt: new Date("2026-09-16"),
      approvedAt: new Date("2026-09-16"),
      approvedBy: { firstName: "Ana", lastName: "Admin" },
      payType: "daily",
      baseRate: 800,
      basicPay: 8000,
      overtimeHours: 2,
      overtimePay: 250,
      allowances: [{ name: "Meal", amount: 500 }],
      deductions: [{ name: "Advance", amount: 200 }],
      grossPay: 8750,
      totalDeductions: 200,
      netPay: 8550,
      attendanceSummary: { present: 10, hoursWorked: 80 },
      paymentMethod: "bank_transfer",
      paymentDate: new Date("2026-09-16"),
      paymentReference: "TX-001",
      paymentProof: "https://secret.example/proof",
      payslipVersion: 1,
      calculationVersion: 1,
    },
  }, { filename: templatePath });

  assert.match(html, /@page \{ size:A4/);
  assert.match(html, /Print \/ Save PDF/);
  assert.match(html, /PS-202609-12345678/);
  assert.match(html, /Juan Dela Cruz/);
  assert.match(html, /₱8,550\.00/);
  assert.doesNotMatch(html, /secret\.example/);
});

test("admin and employee payroll pages expose payslip actions", () => {
  assert.match(read("views/pages/admin/Payroll/PayrollManagement.ejs"), /\/payslip/);
  assert.match(read("views/pages/shared/MyPayroll.ejs"), /View \/ Print Payslip/);
});

test("payroll management pages render and contain valid inline JavaScript", () => {
  for (const relativePath of [
    "views/pages/admin/Payroll/PayrollManagement.ejs",
    "views/pages/shared/MyPayroll.ejs",
  ]) {
    const filename = path.join(__dirname, "..", relativePath);
    const html = ejs.render(fs.readFileSync(filename, "utf8"), {}, { filename });
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.ok(scripts.length > 0);
    scripts.forEach((source) => assert.doesNotThrow(() => new Function(source)));
  }
});

test("all admin payroll modals use one responsive and accessible shell", () => {
  const page = read("views/pages/admin/Payroll/PayrollManagement.ejs");
  const modalSurfaces = page.match(/class="modal-content [^"]*pw-modal-shell[^"]*"/g) || [];
  const modalDialogs = page.match(/class="modal-dialog [^"]*pw-modal-dialog[^"]*"/g) || [];
  assert.equal(modalSurfaces.length, 6);
  assert.equal(modalDialogs.length, 6);
  for (const titleId of [
    "payrollModalTitle",
    "viewModalTitle",
    "approveModalTitle",
    "paidModalTitle",
    "voidModalTitle",
    "compModalTitle",
  ]) {
    assert.match(page, new RegExp(`aria-labelledby="${titleId}"`));
  }
  assert.match(page, /min-height:100dvh/);
  assert.match(page, /safe-area-inset-bottom/);
  assert.match(page, /class="pw-ent-header pw-ent-header-paid"/);
  assert.match(page, /function setModalButtonBusy/);
  assert.doesNotMatch(page, /class="modal-content" style=/);
});
