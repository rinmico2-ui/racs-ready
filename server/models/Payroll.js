const mongoose = require("mongoose");

const lineItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 0, max: 10000000 },
  },
  { _id: true },
);

const payrollSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    employeeRole: {
      type: String,
      enum: ["technician", "secretary"],
      required: true,
      index: true,
    },
    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true, index: true },
    payDate: { type: Date, required: true },
    basicPay: { type: Number, required: true, min: 0, max: 10000000 },
    overtimeHours: { type: Number, default: 0, min: 0, max: 744 },
    overtimePay: { type: Number, default: 0, min: 0, max: 10000000 },
    overtimeNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
      required() { return Number(this.overtimeHours || 0) > 0; },
    },
    allowances: { type: [lineItemSchema], default: [] },
    deductions: { type: [lineItemSchema], default: [] },
    grossPay: { type: Number, required: true, min: 0 },
    totalDeductions: { type: Number, required: true, min: 0 },
    netPay: { type: Number, required: true, min: 0 },
    attendanceSummary: {
      present: { type: Number, default: 0, min: 0 },
      late: { type: Number, default: 0, min: 0 },
      absent: { type: Number, default: 0, min: 0 },
      onLeave: { type: Number, default: 0, min: 0 },
      sickLeave: { type: Number, default: 0, min: 0 },
      hoursWorked: { type: Number, default: 0, min: 0 },
      recordedDays: { type: Number, default: 0, min: 0 },
      incompleteShifts: { type: Number, default: 0, min: 0 },
      manualEntries: { type: Number, default: 0, min: 0 },
      unverifiedEntries: { type: Number, default: 0, min: 0 },
    },
    calculationSource: {
      type: String,
      enum: ["attendance_compensation"],
      default: "attendance_compensation",
    },
    calculationVersion: { type: Number, default: 1, min: 1 },
    calculatedAt: { type: Date, default: Date.now },
    calculationWarnings: { type: [String], default: [] },
    compensationRecord: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeCompensation" },
    status: {
      type: String,
      enum: ["draft", "approved", "paid", "voided"],
      default: "draft",
      index: true,
    },
    payType: {
      type: String,
      enum: ["daily", "hourly", "monthly"],
    },
    baseRate: {
      type: Number,
      min: 0,
      max: 10000000,
    },
    overtimeRate: {
      type: Number,
      min: 0,
      max: 100000,
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    paymentReference: { type: String, trim: true, maxlength: 120, default: "" },
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "gcash", "other"],
    },
    paymentDate: { type: Date },
    paymentProof: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    paidAt: Date,
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    voidedAt: Date,
    voidReason: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { timestamps: true },
);

// Keep one live payroll per exact period while allowing any number of voided
// corrections to remain available in the audit history.
payrollSchema.index(
  { employee: 1, periodStart: 1, periodEnd: 1 },
  {
    unique: true,
    name: "payroll_employee_active_period_unique",
    partialFilterExpression: { status: { $in: ["draft", "approved", "paid"] } },
  },
);
payrollSchema.index({ employee: 1, payDate: -1 });
payrollSchema.index({ status: 1, payDate: -1 });

module.exports = mongoose.model("Payroll", payrollSchema);
