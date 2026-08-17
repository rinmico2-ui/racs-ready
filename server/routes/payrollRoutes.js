const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const Payroll = require("../models/Payroll");
const User = require("../models/User");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");
const EmployeeCompensation = require("../models/EmployeeCompensation");
const { createNotification } = require("../utils/notify");

router.use(auth.authenticate);

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator access is required." });
  }
  next();
}

function parseDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const error = new Error(`${field} must be a valid date.`);
    error.status = 400;
    throw error;
  }
  return date;
}

function money(value, field, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000000) {
    const error = new Error(`${field} must be a non-negative amount.`);
    error.status = 400;
    throw error;
  }
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function lineItems(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30) {
    const error = new Error(`${field} must be a list of up to 30 items.`);
    error.status = 400;
    throw error;
  }
  return value
    .map((item, index) => ({
      name: String((item && item.name) || "").trim().slice(0, 80),
      amount: money(item && item.amount, `${field}[${index}].amount`),
    }))
    .filter((item) => item.name && item.amount > 0);
}

function totals(data) {
  const allowanceTotal = (data.allowances || []).reduce((sum, item) => sum + item.amount, 0);
  const deductionTotal = (data.deductions || []).reduce((sum, item) => sum + item.amount, 0);
  const grossPay = money(data.basicPay + data.overtimePay + allowanceTotal, "grossPay");
  return {
    grossPay,
    totalDeductions: money(deductionTotal, "totalDeductions"),
    netPay: money(Math.max(0, grossPay - deductionTotal), "netPay"),
  };
}

async function attendanceFor(employeeId, periodStart, periodEnd) {
  const summary = { present: 0, late: 0, absent: 0, onLeave: 0, sickLeave: 0, hoursWorked: 0 };
  const technician = await Technician.findOne({ user: employeeId }).select("_id").lean();
  if (!technician) return summary;

  const records = await TechnicianAttendance.find({
    technicianId: technician._id,
    date: { $gte: periodStart, $lte: periodEnd },
  }).select("status checkInTime checkOutTime").lean();

  records.forEach((record) => {
    if (record.status === "Present") summary.present += 1;
    else if (record.status === "Late") summary.late += 1;
    else if (record.status === "Absent") summary.absent += 1;
    else if (record.status === "On Leave") summary.onLeave += 1;
    else if (record.status === "Sick Leave") summary.sickLeave += 1;
    if (record.checkInTime && record.checkOutTime) {
      const hours = (new Date(record.checkOutTime) - new Date(record.checkInTime)) / 3600000;
      if (hours > 0 && hours < 24) summary.hoursWorked += hours;
    }
  });
  summary.hoursWorked = Math.round(summary.hoursWorked * 100) / 100;
  return summary;
}

function populatePayroll(query) {
  return query
    .populate("employee", "firstName lastName email role active")
    .populate("createdBy", "firstName lastName")
    .populate("approvedBy", "firstName lastName")
    .populate("paidBy", "firstName lastName");
}

// ═══════════════════════════════════════════════════════════════════
// EMPLOYEE COMPENSATION CRUD
// ═══════════════════════════════════════════════════════════════════

router.get("/compensation", requireAdmin, async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.employee && mongoose.isValidObjectId(req.query.employee)) {
      filter.employee = req.query.employee;
    }
    if (req.query.active === "true") {
      filter.active = true;
    } else if (req.query.active === "false") {
      filter.active = false;
    }
    const records = await EmployeeCompensation.find(filter)
      .populate("employee", "firstName lastName email role")
      .populate("createdBy", "firstName lastName")
      .sort({ employee: 1, effectiveFrom: -1 })
      .lean();
    res.json({ records });
  } catch (error) {
    next(error);
  }
});

router.get("/compensation/:employeeId", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }
    const record = await EmployeeCompensation.findOne({
      employee: req.params.employeeId,
      active: true,
    })
      .populate("employee", "firstName lastName email role")
      .lean();
    if (!record) return res.status(404).json({ error: "No active compensation found for this employee." });
    res.json({ record });
  } catch (error) {
    next(error);
  }
});

router.post("/compensation", requireAdmin, async (req, res, next) => {
  try {
    const { employee, payType, baseRate, overtimeRate, effectiveFrom } = req.body;
    if (!mongoose.isValidObjectId(employee)) {
      return res.status(400).json({ error: "Select a valid employee." });
    }
    if (!["daily", "hourly", "monthly"].includes(payType)) {
      return res.status(400).json({ error: "Pay type must be daily, hourly, or monthly." });
    }
    const emp = await User.findOne({ _id: employee, role: { $in: ["technician", "secretary"] } }).lean();
    if (!emp) return res.status(404).json({ error: "Employee not found." });

    const from = parseDate(effectiveFrom, "Effective from");
    from.setHours(0, 0, 0, 0);

    // Deactivate any existing active compensation for this employee
    await EmployeeCompensation.updateMany(
      { employee, active: true },
      { active: false, effectiveTo: from },
    );

    // Remove stale inactive records with the same effectiveFrom to avoid unique-index conflicts
    await EmployeeCompensation.deleteMany({ employee, active: false, effectiveFrom: from });

    const record = await EmployeeCompensation.create({
      employee,
      payType,
      baseRate: money(baseRate, "Base rate"),
      overtimeRate: money(overtimeRate, "Overtime rate"),
      effectiveFrom: from,
      active: true,
      createdBy: req.user._id,
    });

    await audit.logEvent({
      actor: req.user._id, target: employee, action: "payroll.compensation_created",
      module: "payroll", req, entityId: record._id, entityType: "EmployeeCompensation",
      category: "payment", details: { payType, baseRate: record.baseRate },
    });

    const populated = await EmployeeCompensation.findById(record._id)
      .populate("employee", "firstName lastName email role")
      .lean();
    res.status(201).json({ message: "Compensation record created.", record: populated });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: "A compensation record already exists for this effective date." });
    }
    next(error);
  }
});

router.patch("/compensation/:id", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Compensation record not found." });
    }
    const record = await EmployeeCompensation.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Compensation record not found." });
    if (!record.active) return res.status(409).json({ error: "Only active compensation records can be edited." });

    if (req.body.payType !== undefined) record.payType = req.body.payType;
    if (req.body.baseRate !== undefined) record.baseRate = money(req.body.baseRate, "Base rate");
    if (req.body.overtimeRate !== undefined) record.overtimeRate = money(req.body.overtimeRate, "Overtime rate");
    await record.save();

    await audit.logEvent({
      actor: req.user._id, target: record.employee, action: "payroll.compensation_updated",
      module: "payroll", req, entityId: record._id, entityType: "EmployeeCompensation",
      category: "payment",
    });

    const populated = await EmployeeCompensation.findById(record._id)
      .populate("employee", "firstName lastName email role")
      .lean();
    res.json({ message: "Compensation updated.", record: populated });
  } catch (error) {
    next(error);
  }
});

router.post("/compensation/:id/end", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Compensation record not found." });
    }
    const record = await EmployeeCompensation.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Compensation record not found." });
    if (!record.active) return res.status(409).json({ error: "This compensation is already ended." });

    const to = req.body.effectiveTo ? parseDate(req.body.effectiveTo, "Effective to") : new Date();
    to.setHours(23, 59, 59, 999);
    if (to < record.effectiveFrom) {
      return res.status(400).json({ error: "End date cannot be before the start date." });
    }

    record.effectiveTo = to;
    record.active = false;
    await record.save();

    await audit.logEvent({
      actor: req.user._id, target: record.employee, action: "payroll.compensation_ended",
      module: "payroll", req, entityId: record._id, entityType: "EmployeeCompensation",
      category: "payment",
    });

    res.json({ message: "Compensation record ended." });
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════════════
// PAYROLL CALCULATION (auto-fill from attendance + compensation)
// ═══════════════════════════════════════════════════════════════════

router.post("/calculate", requireAdmin, async (req, res, next) => {
  try {
    const { employeeId, periodStart, periodEnd } = req.body;
    if (!mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ error: "Select a valid employee." });
    }
    const start = parseDate(periodStart, "Period start");
    start.setHours(0, 0, 0, 0);
    const end = parseDate(periodEnd, "Period end");
    end.setHours(23, 59, 59, 999);
    if (end < start) return res.status(400).json({ error: "Period end cannot be before period start." });

    const compensation = await EmployeeCompensation.findOne({ employee: employeeId, active: true }).lean();
    if (!compensation) {
      return res.status(404).json({ error: "No active pay rate configured for this employee. Please set up compensation first." });
    }

    const attendance = await attendanceFor(employeeId, start, end);
    let basicPay = 0;

    if (compensation.payType === "daily") {
      const billableDays = attendance.present + attendance.late;
      basicPay = billableDays * compensation.baseRate;
    } else if (compensation.payType === "hourly") {
      basicPay = attendance.hoursWorked * compensation.baseRate;
    } else if (compensation.payType === "monthly") {
      // For monthly: full base rate if covering a full month (>=28 days), otherwise prorate
      const totalDays = Math.ceil((end - start) / 86400000) + 1;
      if (totalDays >= 28) {
        basicPay = compensation.baseRate;
      } else {
        basicPay = (compensation.baseRate / 30) * totalDays;
      }
    }

    const overtimePay = attendance.hoursWorked > 0 && compensation.overtimeRate > 0
      ? 0 // OT must be separately approved — admin can manually add
      : 0;

    basicPay = Math.round((basicPay + Number.EPSILON) * 100) / 100;

    res.json({
      compensation: {
        payType: compensation.payType,
        baseRate: compensation.baseRate,
        overtimeRate: compensation.overtimeRate,
      },
      attendanceSummary: attendance,
      basicPay,
      overtimePay,
      grossPay: basicPay + overtimePay,
    });
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════════════
// STAFF LIST (for dropdowns)
// ═══════════════════════════════════════════════════════════════════

router.get("/staff", requireAdmin, async (req, res, next) => {
  try {
    const staff = await User.find({
      role: { $in: ["technician", "secretary"] },
      active: { $ne: false },
      firstName: { $exists: true, $ne: "" },
      lastName: { $exists: true, $ne: "" },
    })
      .select("firstName lastName email role active")
      .sort({ firstName: 1, lastName: 1 })
      .lean();
    res.json({ staff });
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════════════
// PAYROLL DUE TODAY (daily employees who need payment today)
// ═══════════════════════════════════════════════════════════════════

router.get("/due-today", requireAdmin, async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Find all active daily-rate employees
    const dailyEmployees = await EmployeeCompensation.find({ active: true, payType: "daily" })
      .populate("employee", "firstName lastName email role")
      .lean();

    // Get employee IDs that already have a payroll record covering today
    const existingPayrolls = await Payroll.find({
      periodStart: { $lte: tomorrow },
      periodEnd: { $gte: today },
      status: { $in: ["draft", "approved", "paid"] },
    }).select("employee").lean();

    const paidEmployeeIds = new Set(existingPayrolls.map(p => String(p.employee)));

    const dueToday = [];
    for (const comp of dailyEmployees) {
      if (!comp.employee || paidEmployeeIds.has(String(comp.employee._id))) continue;

      // Check if this employee has attendance today
      const technician = await Technician.findOne({ user: comp.employee._id }).select("_id").lean();
      if (!technician) continue;

      const todayAttendance = await TechnicianAttendance.findOne({
        technicianId: technician._id,
        date: { $gte: today, $lt: tomorrow },
      }).select("status checkInTime checkOutTime").lean();

      if (todayAttendance) {
        dueToday.push({
          employee: comp.employee,
          payType: comp.payType,
          baseRate: comp.baseRate,
          attendance: {
            status: todayAttendance.status,
            checkIn: todayAttendance.checkInTime,
            checkOut: todayAttendance.checkOutTime,
          },
        });
      }
    }

    res.json({ dueToday, count: dueToday.length, date: today });
  } catch (error) {
    next(error);
  }
});

// ═══════════════════════════════════════════════════════════════════
// PAYROLL RECORDS CRUD
// ═══════════════════════════════════════════════════════════════════

router.get("/", async (req, res, next) => {
  try {
    const isAdmin = req.user.role === "admin";
    if (!isAdmin && !["technician", "secretary"].includes(req.user.role)) {
      return res.status(403).json({ error: "Payroll is only available to staff." });
    }

    const filter = isAdmin
      ? {}
      : { employee: req.user._id, status: { $in: ["approved", "paid"] } };
    if (isAdmin && req.query.status && ["draft", "approved", "paid", "voided"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (isAdmin && req.query.role && ["technician", "secretary"].includes(req.query.role)) {
      filter.employeeRole = req.query.role;
    }
    if (isAdmin && req.query.employee && mongoose.isValidObjectId(req.query.employee)) {
      filter.employee = req.query.employee;
    }
    if (req.query.year && /^\d{4}$/.test(req.query.year)) {
      const year = Number(req.query.year);
      filter.payDate = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
    }

    const records = await populatePayroll(Payroll.find(filter).sort({ payDate: -1, createdAt: -1 }).limit(250)).lean();
    const stats = records.reduce(
      (result, item) => {
        result.count += 1;
        if (item.status !== "voided") result.netTotal += item.netPay || 0;
        if (item.status === "draft") result.draft += 1;
        if (item.status === "approved") result.approved += 1;
        if (item.status === "paid") result.paid += 1;
        return result;
      },
      { count: 0, netTotal: 0, draft: 0, approved: 0, paid: 0 },
    );
    stats.netTotal = Math.round(stats.netTotal * 100) / 100;
    res.json({ records, stats });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Payroll record not found." });
    const record = await populatePayroll(Payroll.findById(req.params.id)).lean();
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    const isOwner = String(record.employee._id) === String(req.user._id);
    if (req.user.role !== "admin" && (!isOwner || !["approved", "paid"].includes(record.status))) {
      return res.status(403).json({ error: "You cannot view this payroll record." });
    }
    res.json({ record });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.body.employee)) return res.status(400).json({ error: "Select a valid staff member." });
    const employee = await User.findOne({ _id: req.body.employee, role: { $in: ["technician", "secretary"] } }).lean();
    if (!employee) return res.status(404).json({ error: "Staff member not found." });

    const periodStart = parseDate(req.body.periodStart, "Period start");
    periodStart.setHours(0, 0, 0, 0);
    const periodEnd = parseDate(req.body.periodEnd, "Period end");
    periodEnd.setHours(23, 59, 59, 999);
    const payDate = parseDate(req.body.payDate, "Pay date");
    if (periodEnd < periodStart) return res.status(400).json({ error: "Period end cannot be before period start." });
    if ((periodEnd - periodStart) / 86400000 > 62) return res.status(400).json({ error: "A payroll period cannot exceed 62 days." });

    // Snapshot compensation if available
    const compensation = await EmployeeCompensation.findOne({ employee: employee._id, active: true }).lean();

    const data = {
      employee: employee._id,
      employeeRole: employee.role,
      periodStart,
      periodEnd,
      payDate,
      basicPay: money(req.body.basicPay, "Basic pay"),
      overtimePay: money(req.body.overtimePay, "Overtime pay"),
      allowances: lineItems(req.body.allowances, "Allowances") || [],
      deductions: lineItems(req.body.deductions, "Deductions") || [],
      notes: String(req.body.notes || "").trim().slice(0, 1000),
      createdBy: req.user._id,
      attendanceSummary: await attendanceFor(employee._id, periodStart, periodEnd),
      payType: compensation ? compensation.payType : undefined,
      baseRate: compensation ? compensation.baseRate : undefined,
    };
    Object.assign(data, totals(data));
    const record = await Payroll.create(data);
    await audit.logEvent({
      actor: req.user._id, target: employee._id, action: "payroll.created", module: "payroll", req,
      entityId: record._id, entityType: "Payroll", category: "payment",
      details: { periodStart, periodEnd, netPay: record.netPay },
    });
    const populated = await populatePayroll(Payroll.findById(record._id)).lean();
    res.status(201).json({ message: "Draft payroll created.", record: populated });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ error: "Payroll already exists for this staff member and period." });
    next(error);
  }
});

router.patch("/:id", requireAdmin, async (req, res, next) => {
  try {
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status !== "draft") return res.status(409).json({ error: "Only draft payroll can be edited." });

    if (req.body.periodStart !== undefined) {
      record.periodStart = parseDate(req.body.periodStart, "Period start");
      record.periodStart.setHours(0, 0, 0, 0);
    }
    if (req.body.periodEnd !== undefined) {
      record.periodEnd = parseDate(req.body.periodEnd, "Period end");
      record.periodEnd.setHours(23, 59, 59, 999);
    }
    if (record.periodEnd < record.periodStart) return res.status(400).json({ error: "Period end cannot be before period start." });
    if (req.body.payDate !== undefined) record.payDate = parseDate(req.body.payDate, "Pay date");
    if (req.body.basicPay !== undefined) record.basicPay = money(req.body.basicPay, "Basic pay");
    if (req.body.overtimePay !== undefined) record.overtimePay = money(req.body.overtimePay, "Overtime pay");
    if (req.body.allowances !== undefined) record.allowances = lineItems(req.body.allowances, "Allowances");
    if (req.body.deductions !== undefined) record.deductions = lineItems(req.body.deductions, "Deductions");
    if (req.body.notes !== undefined) record.notes = String(req.body.notes || "").trim().slice(0, 1000);
    record.attendanceSummary = await attendanceFor(record.employee, record.periodStart, record.periodEnd);
    Object.assign(record, totals(record));
    await record.save();
    await audit.logEvent({ actor: req.user._id, target: record.employee, action: "payroll.updated", module: "payroll", req, entityId: record._id, entityType: "Payroll", category: "payment" });
    res.json({ message: "Draft payroll updated.", record: await populatePayroll(Payroll.findById(record._id)).lean() });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ error: "Payroll already exists for this staff member and period." });
    next(error);
  }
});

router.post("/:id/approve", requireAdmin, async (req, res, next) => {
  try {
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status !== "draft") return res.status(409).json({ error: "Only draft payroll can be approved." });
    record.status = "approved";
    record.approvedBy = req.user._id;
    record.approvedAt = new Date();
    await record.save();
    await audit.logEvent({ actor: req.user._id, target: record.employee, action: "payroll.approved", module: "payroll", req, entityId: record._id, entityType: "Payroll", category: "payment", details: { netPay: record.netPay } });

    // Notify the employee
    const io = req.app.get("io");
    const fmtMoney = (n) => "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const periodLabel = new Date(record.periodStart).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) + " \u2013 " + new Date(record.periodEnd).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    await createNotification({
      type: "payroll_approved",
      title: "Payroll Approved",
      message: `Your payroll for ${periodLabel} (${fmtMoney(record.netPay)}) has been approved and is ready for payment.`,
      userId: record.employee,
      role: "technician",
      referenceId: record._id,
      referenceModel: "Payroll",
      link: "/technician/my-payroll",
      priority: "normal",
      io,
    });

    res.json({ message: "Payroll approved and now visible to the staff member." });
  } catch (error) { next(error); }
});

router.post("/:id/paid", requireAdmin, async (req, res, next) => {
  try {
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status !== "approved") return res.status(409).json({ error: "Approve the payroll before marking it paid." });

    const paymentMethod = req.body.paymentMethod;
    if (!paymentMethod || !["cash", "bank_transfer", "gcash", "other"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Select a valid payment method (cash, bank_transfer, gcash, other)." });
    }

    record.status = "paid";
    record.paymentMethod = paymentMethod;
    record.paymentReference = String(req.body.paymentReference || "").trim().slice(0, 120);
    record.paymentProof = String(req.body.paymentProof || "").trim().slice(0, 500);
    record.paymentDate = req.body.paymentDate ? parseDate(req.body.paymentDate, "Payment date") : new Date();
    record.paidBy = req.user._id;
    record.paidAt = new Date();
    await record.save();
    await audit.logEvent({ actor: req.user._id, target: record.employee, action: "payroll.paid", module: "payroll", req, entityId: record._id, entityType: "Payroll", category: "payment", details: { netPay: record.netPay, paymentMethod, paymentReference: record.paymentReference } });

    // Notify the employee
    const io = req.app.get("io");
    const fmtMoney = (n) => "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const periodLabel = new Date(record.periodStart).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) + " \u2013 " + new Date(record.periodEnd).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    await createNotification({
      type: "payroll_paid",
      title: "Payment Processed",
      message: `Payment of ${fmtMoney(record.netPay)} for ${periodLabel} has been processed via ${paymentMethod.replace("_", " ")}.`,
      userId: record.employee,
      role: "technician",
      referenceId: record._id,
      referenceModel: "Payroll",
      link: "/technician/my-payroll",
      priority: "high",
      io,
    });

    res.json({ message: "Payroll marked as paid." });
  } catch (error) { next(error); }
});

router.post("/:id/void", requireAdmin, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || "").trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: "A reason is required to void payroll." });
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status === "paid" || record.status === "voided") return res.status(409).json({ error: "Paid or already voided payroll cannot be voided." });
    record.status = "voided";
    record.voidReason = reason;
    record.voidedBy = req.user._id;
    record.voidedAt = new Date();
    await record.save();
    await audit.logEvent({ actor: req.user._id, target: record.employee, action: "payroll.voided", module: "payroll", req, entityId: record._id, entityType: "Payroll", category: "payment", details: { reason } });
    res.json({ message: "Payroll voided." });
  } catch (error) { next(error); }
});

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.name === "ValidationError" ? 400 : 500);
  if (status >= 500) console.error("Payroll API error:", error && error.message);
  res.status(status).json({ error: status >= 500 ? "Unable to process payroll right now." : error.message });
});

module.exports = router;
