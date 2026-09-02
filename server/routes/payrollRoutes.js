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
const {
  calculateBasicPay,
  calculateOvertimePay,
  attendanceQualityWarnings,
  dailyPayrollReadiness,
  hasBlockingAttendanceExceptions,
  separationOfDutiesViolation,
  payrollTotals,
} = require("../utils/payrollPolicy");

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
  return payrollTotals(data);
}

function hours(value, field = "Overtime hours", fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 744) {
    const error = new Error(`${field} must be between 0 and 744.`);
    error.status = 400;
    throw error;
  }
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function assertPayDateForPeriod(payDate, periodEnd) {
  const payableDay = new Date(payDate);
  payableDay.setHours(0, 0, 0, 0);
  const finalPeriodDay = new Date(periodEnd);
  finalPeriodDay.setHours(0, 0, 0, 0);
  if (payableDay < finalPeriodDay) {
    const error = new Error("Pay date cannot be before the end of the payroll period.");
    error.status = 400;
    throw error;
  }
}

async function assertPayrollSeparationOfDuties(record, actorId, action) {
  const activeAdminCount = await User.countDocuments({ role: "admin", active: { $ne: false } });
  const violation = separationOfDutiesViolation({
    activeAdminCount,
    createdBy: record.createdBy,
    approvedBy: record.approvedBy,
    actorId,
    action,
  });
  if (violation === "creator_cannot_approve") {
    const error = new Error("A different administrator must approve payroll created by you.");
    error.status = 409;
    throw error;
  }
  if (violation === "approver_cannot_pay") {
    const error = new Error("A different administrator must record payment for payroll you approved.");
    error.status = 409;
    throw error;
  }
}

function normalizePeriod(periodStartValue, periodEndValue) {
  const periodStart = parseDate(periodStartValue, "Period start");
  periodStart.setHours(0, 0, 0, 0);
  const periodEnd = parseDate(periodEndValue, "Period end");
  periodEnd.setHours(23, 59, 59, 999);
  if (periodEnd < periodStart) {
    const error = new Error("Period end cannot be before period start.");
    error.status = 400;
    throw error;
  }
  if ((periodEnd - periodStart) / 86400000 > 62) {
    const error = new Error("A payroll period cannot exceed 62 days.");
    error.status = 400;
    throw error;
  }
  return { periodStart, periodEnd };
}

async function compensationForPeriod(employeeId, periodStart, periodEnd) {
  const compensation = await EmployeeCompensation.findOne({
    employee: employeeId,
    effectiveFrom: { $lte: periodStart },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: periodEnd } }],
  }).sort({ effectiveFrom: -1 }).lean();

  if (compensation) return compensation;

  const intersects = await EmployeeCompensation.exists({
    employee: employeeId,
    effectiveFrom: { $lte: periodEnd },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: periodStart } }],
  });
  const error = new Error(intersects
    ? "The pay rate changes inside this period. Split it into separate payroll periods."
    : "No pay rate covers the selected payroll period. Configure compensation for those dates first.");
  error.status = 409;
  throw error;
}

async function findOverlap(employeeId, periodStart, periodEnd, excludeId = null) {
  const filter = {
    employee: employeeId,
    status: { $ne: "voided" },
    periodStart: { $lte: periodEnd },
    periodEnd: { $gte: periodStart },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Payroll.findOne(filter).select("_id periodStart periodEnd status").lean();
}

function overlapError(record) {
  const error = new Error(`This period overlaps an existing ${record.status} payroll. Void or adjust that record first.`);
  error.status = 409;
  return error;
}

async function attendanceFor(employeeId, periodStart, periodEnd) {
  const summary = {
    present: 0,
    late: 0,
    absent: 0,
    onLeave: 0,
    sickLeave: 0,
    hoursWorked: 0,
    recordedDays: 0,
    incompleteShifts: 0,
    manualEntries: 0,
    unverifiedEntries: 0,
  };
  const technician = await Technician.findOne({ user: employeeId }).select("_id").lean();
  if (!technician) return summary;

  const records = await TechnicianAttendance.find({
    technicianId: technician._id,
    date: { $gte: periodStart, $lte: periodEnd },
  }).select("status checkInTime checkOutTime qrVerified method").lean();

  records.forEach((record) => {
    summary.recordedDays += 1;
    if (record.status === "Present") summary.present += 1;
    else if (record.status === "Late") summary.late += 1;
    else if (record.status === "Absent") summary.absent += 1;
    else if (record.status === "On Leave") summary.onLeave += 1;
    else if (record.status === "Sick Leave") summary.sickLeave += 1;
    if (record.method === "manual") summary.manualEntries += 1;
    if (record.method === "qr_scan" && !record.qrVerified) summary.unverifiedEntries += 1;
    if (["Present", "Late"].includes(record.status) && (!record.checkInTime || !record.checkOutTime)) {
      summary.incompleteShifts += 1;
    }
    if (record.checkInTime && record.checkOutTime) {
      const hours = (new Date(record.checkOutTime) - new Date(record.checkInTime)) / 3600000;
      if (hours > 0 && hours < 24) summary.hoursWorked += hours;
    }
  });
  summary.hoursWorked = Math.round(summary.hoursWorked * 100) / 100;
  return summary;
}

async function calculatePayroll(employeeId, periodStart, periodEnd, overtimeHours = 0) {
  const compensation = await compensationForPeriod(employeeId, periodStart, periodEnd);
  const attendance = await attendanceFor(employeeId, periodStart, periodEnd);
  const normalizedOvertimeHours = hours(overtimeHours);
  if (normalizedOvertimeHours > 0 && Number(compensation.overtimeRate || 0) <= 0) {
    const error = new Error("Configure an overtime rate before adding overtime hours.");
    error.status = 409;
    throw error;
  }
  const basicPay = calculateBasicPay(compensation, attendance, periodStart, periodEnd);
  const overtimePay = calculateOvertimePay(compensation, normalizedOvertimeHours);
  return {
    compensation,
    attendance,
    basicPay,
    overtimeHours: normalizedOvertimeHours,
    overtimePay,
    warnings: attendanceQualityWarnings(compensation, attendance),
  };
}

function populatePayroll(query) {
  return query
    .populate("employee", "firstName lastName email role active")
    .populate("createdBy", "firstName lastName")
    .populate("approvedBy", "firstName lastName")
    .populate("paidBy", "firstName lastName")
    .populate("voidedBy", "firstName lastName")
    .populate("compensationRecord", "payType baseRate overtimeRate effectiveFrom effectiveTo");
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
    const emp = await User.findOne({
      _id: employee,
      role: { $in: ["technician", "secretary"] },
      active: { $ne: false },
    }).lean();
    if (!emp) return res.status(404).json({ error: "Employee not found." });
    if (emp.role === "secretary" && payType !== "monthly") {
      return res.status(400).json({ error: "Secretary payroll must use a monthly rate because secretary attendance is not tracked." });
    }

    const from = parseDate(effectiveFrom, "Effective from");
    from.setHours(0, 0, 0, 0);
    const latest = await EmployeeCompensation.findOne({ employee }).sort({ effectiveFrom: -1 }).select("effectiveFrom").lean();
    if (latest && from < latest.effectiveFrom) {
      return res.status(409).json({ error: "A new pay rate cannot start before the latest rate. End or correct the latest record first." });
    }
    const normalizedBaseRate = money(baseRate, "Base rate");
    if (normalizedBaseRate <= 0) return res.status(400).json({ error: "Base rate must be greater than zero." });
    const normalizedOvertimeRate = money(overtimeRate, "Overtime rate");
    if (normalizedOvertimeRate > 100000) {
      return res.status(400).json({ error: "Overtime rate cannot exceed 100,000." });
    }
    const previousMoment = new Date(from.getTime() - 1);

    const sameEffectiveDate = await EmployeeCompensation.exists({ employee, effectiveFrom: from });
    if (sameEffectiveDate) {
      return res.status(409).json({ error: "A compensation record already exists for this effective date. Preserve it and choose a new effective date." });
    }

    const record = await EmployeeCompensation.create({
      employee,
      payType,
      baseRate: normalizedBaseRate,
      overtimeRate: normalizedOvertimeRate,
      effectiveFrom: from,
      active: true,
      createdBy: req.user._id,
    });

    // Preserve the full rate history. Only close records that preceded this one;
    // never delete an old compensation row to make a new rate fit.
    try {
      await EmployeeCompensation.updateMany(
        { employee, active: true, _id: { $ne: record._id }, effectiveFrom: { $lt: from } },
        { active: false, effectiveTo: previousMoment },
      );
    } catch (error) {
      await EmployeeCompensation.deleteOne({ _id: record._id });
      throw error;
    }

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

    const finalizedPayroll = await Payroll.exists({
      employee: record.employee,
      status: { $in: ["approved", "paid"] },
      periodEnd: { $gte: record.effectiveFrom },
      ...(record.effectiveTo ? { periodStart: { $lte: record.effectiveTo } } : {}),
    });
    if (finalizedPayroll) {
      return res.status(409).json({ error: "This rate is already referenced by finalized payroll. Add a new effective-dated rate instead of editing payroll history." });
    }

    if (req.body.payType !== undefined) {
      if (!["daily", "hourly", "monthly"].includes(req.body.payType)) {
        return res.status(400).json({ error: "Pay type must be daily, hourly, or monthly." });
      }
      record.payType = req.body.payType;
    }
    const employee = await User.findById(record.employee).select("role").lean();
    if (employee?.role === "secretary" && record.payType !== "monthly") {
      return res.status(400).json({ error: "Secretary payroll must use a monthly rate because secretary attendance is not tracked." });
    }
    if (req.body.baseRate !== undefined) {
      const baseRate = money(req.body.baseRate, "Base rate");
      if (baseRate <= 0) return res.status(400).json({ error: "Base rate must be greater than zero." });
      record.baseRate = baseRate;
    }
    if (req.body.overtimeRate !== undefined) {
      const overtimeRate = money(req.body.overtimeRate, "Overtime rate");
      if (overtimeRate > 100000) return res.status(400).json({ error: "Overtime rate cannot exceed 100,000." });
      record.overtimeRate = overtimeRate;
    }
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

    const payrollAfterEnd = await Payroll.exists({
      employee: record.employee,
      status: { $in: ["approved", "paid"] },
      periodStart: { $lte: to },
      periodEnd: { $gt: to },
    });
    if (payrollAfterEnd) {
      return res.status(409).json({ error: "This end date would cut through a finalized payroll period." });
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
    const { periodStart: start, periodEnd: end } = normalizePeriod(periodStart, periodEnd);
    const employee = await User.exists({
      _id: employeeId,
      role: { $in: ["technician", "secretary"] },
      active: { $ne: false },
    });
    if (!employee) return res.status(404).json({ error: "Active staff member not found." });

    const overlap = await findOverlap(employeeId, start, end, req.body.excludePayrollId);
    if (overlap) throw overlapError(overlap);

    const calculation = await calculatePayroll(employeeId, start, end, req.body.overtimeHours);
    const { compensation, attendance, basicPay, overtimeHours, overtimePay, warnings } = calculation;

    res.json({
      compensation: {
        payType: compensation.payType,
        baseRate: compensation.baseRate,
        overtimeRate: compensation.overtimeRate,
      },
      attendanceSummary: attendance,
      basicPay,
      overtimeHours,
      overtimePay,
      grossPay: basicPay + overtimePay,
      calculationWarnings: warnings,
      calculationSource: "attendance_compensation",
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

    // Resolve rates by effective dates so future rate changes do not replace today's rate.
    const dailyEmployees = await EmployeeCompensation.find({
      payType: "daily",
      effectiveFrom: { $lte: today },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
    })
      .populate("employee", "firstName lastName email role")
      .lean();

    // Get employee IDs that already have a payroll record covering today
    const existingPayrolls = await Payroll.find({
      periodStart: { $lt: tomorrow },
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

      const readiness = dailyPayrollReadiness(todayAttendance);
      if (readiness.eligible) {
        dueToday.push({
          employee: comp.employee,
          payType: comp.payType,
          baseRate: comp.baseRate,
          attendance: {
            status: todayAttendance.status,
            checkIn: todayAttendance.checkInTime,
            checkOut: todayAttendance.checkOutTime,
          },
          readyForDraft: readiness.ready,
          readinessReason: readiness.reason,
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
      filter.employee = new mongoose.Types.ObjectId(req.query.employee);
    }
    if (req.query.year && /^\d{4}$/.test(req.query.year)) {
      const year = Number(req.query.year);
      filter.payDate = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
    }

    const [records, statsRows] = await Promise.all([
      populatePayroll(Payroll.find(filter).sort({ payDate: -1, createdAt: -1 }).limit(250)).lean(),
      Payroll.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            netTotal: { $sum: { $cond: [{ $ne: ["$status", "voided"] }, "$netPay", 0] } },
            draft: { $sum: { $cond: [{ $eq: ["$status", "draft"] }, 1, 0] } },
            approved: { $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] } },
            paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const stats = statsRows[0] || { count: 0, netTotal: 0, draft: 0, approved: 0, paid: 0 };
    stats.netTotal = Math.round(Number(stats.netTotal || 0) * 100) / 100;
    res.json({ records, stats, resultLimit: 250, hasMore: stats.count > records.length });
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
    const employee = await User.findOne({
      _id: req.body.employee,
      role: { $in: ["technician", "secretary"] },
      active: { $ne: false },
    }).lean();
    if (!employee) return res.status(404).json({ error: "Staff member not found." });

    const { periodStart, periodEnd } = normalizePeriod(req.body.periodStart, req.body.periodEnd);
    const payDate = parseDate(req.body.payDate, "Pay date");
    assertPayDateForPeriod(payDate, periodEnd);
    const overlap = await findOverlap(employee._id, periodStart, periodEnd);
    if (overlap) throw overlapError(overlap);

    const calculation = await calculatePayroll(employee._id, periodStart, periodEnd, req.body.overtimeHours);
    const overtimeNote = String(req.body.overtimeNote || "").trim().slice(0, 300);
    if (calculation.overtimeHours > 0 && !overtimeNote) {
      return res.status(400).json({ error: "An overtime approval reason is required when overtime hours are added." });
    }

    const data = {
      employee: employee._id,
      employeeRole: employee.role,
      periodStart,
      periodEnd,
      payDate,
      basicPay: calculation.basicPay,
      overtimeHours: calculation.overtimeHours,
      overtimePay: calculation.overtimePay,
      overtimeNote,
      allowances: lineItems(req.body.allowances, "Allowances") || [],
      deductions: lineItems(req.body.deductions, "Deductions") || [],
      notes: String(req.body.notes || "").trim().slice(0, 1000),
      createdBy: req.user._id,
      attendanceSummary: calculation.attendance,
      payType: calculation.compensation.payType,
      baseRate: calculation.compensation.baseRate,
      overtimeRate: calculation.compensation.overtimeRate,
      compensationRecord: calculation.compensation._id,
      calculationWarnings: calculation.warnings,
      calculationSource: "attendance_compensation",
      calculationVersion: 1,
      calculatedAt: new Date(),
    };
    Object.assign(data, totals(data));
    const record = await Payroll.create(data);
    await audit.logEvent({
      actor: req.user._id, target: employee._id, action: "payroll.created", module: "payroll", req,
      entityId: record._id, entityType: "Payroll", category: "payment",
      details: {
        periodStart,
        periodEnd,
        netPay: record.netPay,
        calculationSource: record.calculationSource,
        calculationVersion: record.calculationVersion,
      },
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Payroll record not found." });
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
    if ((record.periodEnd - record.periodStart) / 86400000 > 62) {
      return res.status(400).json({ error: "A payroll period cannot exceed 62 days." });
    }
    const overlap = await findOverlap(record.employee, record.periodStart, record.periodEnd, record._id);
    if (overlap) throw overlapError(overlap);
    if (req.body.payDate !== undefined) record.payDate = parseDate(req.body.payDate, "Pay date");
    assertPayDateForPeriod(record.payDate, record.periodEnd);
    const requestedOvertimeHours = req.body.overtimeHours !== undefined
      ? req.body.overtimeHours
      : record.overtimeHours;
    const calculation = await calculatePayroll(record.employee, record.periodStart, record.periodEnd, requestedOvertimeHours);
    const overtimeNote = req.body.overtimeNote !== undefined
      ? String(req.body.overtimeNote || "").trim().slice(0, 300)
      : record.overtimeNote;
    if (calculation.overtimeHours > 0 && !overtimeNote) {
      return res.status(400).json({ error: "An overtime approval reason is required when overtime hours are added." });
    }
    if (req.body.allowances !== undefined) record.allowances = lineItems(req.body.allowances, "Allowances");
    if (req.body.deductions !== undefined) record.deductions = lineItems(req.body.deductions, "Deductions");
    if (req.body.notes !== undefined) record.notes = String(req.body.notes || "").trim().slice(0, 1000);
    record.basicPay = calculation.basicPay;
    record.overtimeHours = calculation.overtimeHours;
    record.overtimePay = calculation.overtimePay;
    record.overtimeNote = overtimeNote;
    record.attendanceSummary = calculation.attendance;
    record.payType = calculation.compensation.payType;
    record.baseRate = calculation.compensation.baseRate;
    record.overtimeRate = calculation.compensation.overtimeRate;
    record.compensationRecord = calculation.compensation._id;
    record.calculationWarnings = calculation.warnings;
    record.calculatedAt = new Date();
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Payroll record not found." });
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status !== "draft") return res.status(409).json({ error: "Only draft payroll can be approved." });
    await assertPayrollSeparationOfDuties(record, req.user._id, "approve");
    const overlap = await findOverlap(record.employee, record.periodStart, record.periodEnd, record._id);
    if (overlap) throw overlapError(overlap);
    assertPayDateForPeriod(record.payDate, record.periodEnd);
    const calculation = await calculatePayroll(record.employee, record.periodStart, record.periodEnd, record.overtimeHours);
    if (calculation.overtimeHours > 0 && !String(record.overtimeNote || "").trim()) {
      return res.status(409).json({ error: "Add an overtime approval reason before approving this payroll." });
    }
    if (hasBlockingAttendanceExceptions(calculation.compensation, calculation.attendance)) {
      return res.status(409).json({
        error: "Resolve missing, incomplete, or unverified attendance before approval.",
        warnings: calculation.warnings,
      });
    }
    const computedTotals = totals({
      basicPay: calculation.basicPay,
      overtimePay: calculation.overtimePay,
      allowances: record.allowances,
      deductions: record.deductions,
    });
    if (computedTotals.totalDeductions >= computedTotals.grossPay) {
      return res.status(409).json({ error: "Deductions must be lower than gross pay before approval." });
    }
    const approvedAt = new Date();
    const approvedRecord = await Payroll.findOneAndUpdate(
      { _id: record._id, status: "draft", updatedAt: record.updatedAt },
      {
        $set: {
          status: "approved",
          approvedBy: req.user._id,
          approvedAt,
          basicPay: calculation.basicPay,
          overtimeHours: calculation.overtimeHours,
          overtimePay: calculation.overtimePay,
          attendanceSummary: calculation.attendance,
          payType: calculation.compensation.payType,
          baseRate: calculation.compensation.baseRate,
          overtimeRate: calculation.compensation.overtimeRate,
          compensationRecord: calculation.compensation._id,
          calculationWarnings: calculation.warnings,
          calculatedAt: approvedAt,
          ...computedTotals,
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!approvedRecord) {
      return res.status(409).json({ error: "Payroll changed while it was being approved. Refresh and review the latest draft." });
    }
    await audit.logEvent({ actor: req.user._id, target: approvedRecord.employee, action: "payroll.approved", module: "payroll", req, entityId: approvedRecord._id, entityType: "Payroll", category: "payment", details: { netPay: approvedRecord.netPay, calculationWarnings: approvedRecord.calculationWarnings } });

    // Notify the employee
    const io = req.app.get("io");
    const fmtMoney = (n) => "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const periodLabel = new Date(approvedRecord.periodStart).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) + " \u2013 " + new Date(approvedRecord.periodEnd).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    await createNotification({
      type: "payroll_approved",
      title: "Payroll Approved",
      message: `Your payroll for ${periodLabel} (${fmtMoney(approvedRecord.netPay)}) has been approved and is ready for payment.`,
      userId: approvedRecord.employee,
      role: approvedRecord.employeeRole,
      referenceId: approvedRecord._id,
      referenceModel: "Payroll",
      link: `/${approvedRecord.employeeRole}/payroll`,
      priority: "normal",
      io,
    });

    res.json({ message: "Payroll approved and now visible to the staff member." });
  } catch (error) { next(error); }
});

router.post("/:id/paid", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Payroll record not found." });
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status !== "approved") return res.status(409).json({ error: "Approve the payroll before marking it paid." });
    await assertPayrollSeparationOfDuties(record, req.user._id, "pay");

    const paymentMethod = req.body.paymentMethod;
    if (!paymentMethod || !["cash", "bank_transfer", "gcash", "other"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Select a valid payment method (cash, bank_transfer, gcash, other)." });
    }
    const paymentReference = String(req.body.paymentReference || "").trim().slice(0, 120);
    if (paymentMethod !== "cash" && !paymentReference) {
      return res.status(400).json({ error: "A transaction reference is required for non-cash payroll payments." });
    }
    const paymentProof = String(req.body.paymentProof || "").trim().slice(0, 500);
    if (paymentProof && !/^https?:\/\//i.test(paymentProof)) {
      return res.status(400).json({ error: "Payment proof must be a valid HTTP or HTTPS URL." });
    }
    const paymentDate = req.body.paymentDate ? parseDate(req.body.paymentDate, "Payment date") : new Date();
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (paymentDate > endOfToday) return res.status(400).json({ error: "Payment date cannot be in the future." });
    assertPayDateForPeriod(paymentDate, record.periodEnd);

    const paidAt = new Date();
    const paidRecord = await Payroll.findOneAndUpdate(
      { _id: record._id, status: "approved", updatedAt: record.updatedAt },
      {
        $set: {
          status: "paid",
          paymentMethod,
          paymentReference,
          paymentProof,
          paymentDate,
          paidBy: req.user._id,
          paidAt,
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!paidRecord) {
      return res.status(409).json({ error: "Payroll changed while payment was being recorded. Refresh and review its latest status." });
    }
    await audit.logEvent({ actor: req.user._id, target: paidRecord.employee, action: "payroll.paid", module: "payroll", req, entityId: paidRecord._id, entityType: "Payroll", category: "payment", details: { netPay: paidRecord.netPay, paymentMethod, paymentReference: paidRecord.paymentReference } });

    // Notify the employee
    const io = req.app.get("io");
    const fmtMoney = (n) => "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const periodLabel = new Date(paidRecord.periodStart).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) + " \u2013 " + new Date(paidRecord.periodEnd).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    await createNotification({
      type: "payroll_paid",
      title: "Payment Processed",
      message: `Payment of ${fmtMoney(paidRecord.netPay)} for ${periodLabel} has been processed via ${paymentMethod.replace("_", " ")}.`,
      userId: paidRecord.employee,
      role: paidRecord.employeeRole,
      referenceId: paidRecord._id,
      referenceModel: "Payroll",
      link: `/${paidRecord.employeeRole}/payroll`,
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Payroll record not found." });
    const record = await Payroll.findById(req.params.id);
    if (!record) return res.status(404).json({ error: "Payroll record not found." });
    if (record.status === "paid" || record.status === "voided") return res.status(409).json({ error: "Paid or already voided payroll cannot be voided." });
    const voidedRecord = await Payroll.findOneAndUpdate(
      { _id: record._id, status: { $in: ["draft", "approved"] }, updatedAt: record.updatedAt },
      { $set: { status: "voided", voidReason: reason, voidedBy: req.user._id, voidedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    );
    if (!voidedRecord) {
      return res.status(409).json({ error: "Payroll changed while it was being voided. Refresh and review its latest status." });
    }
    await audit.logEvent({ actor: req.user._id, target: voidedRecord.employee, action: "payroll.voided", module: "payroll", req, entityId: voidedRecord._id, entityType: "Payroll", category: "payment", details: { reason } });
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
