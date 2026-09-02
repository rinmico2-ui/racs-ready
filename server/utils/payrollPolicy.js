const MS_PER_DAY = 24 * 60 * 60 * 1000;

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function payrollTotals({ basicPay = 0, overtimePay = 0, allowances = [], deductions = [] }) {
  const allowanceTotal = allowances.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductionTotal = deductions.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const grossPay = roundMoney(Number(basicPay || 0) + Number(overtimePay || 0) + allowanceTotal);
  const totalDeductions = roundMoney(deductionTotal);

  return {
    grossPay,
    totalDeductions,
    netPay: roundMoney(Math.max(0, grossPay - totalDeductions)),
  };
}

function calendarDayCount(periodStart, periodEnd) {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUtc - startUtc) / MS_PER_DAY) + 1;
}

function calculateBasicPay(compensation, attendance, periodStart, periodEnd) {
  if (!compensation) return 0;
  const baseRate = Number(compensation.baseRate || 0);
  let amount = 0;

  if (compensation.payType === "daily") {
    amount = (Number(attendance.present || 0) + Number(attendance.late || 0)) * baseRate;
  } else if (compensation.payType === "hourly") {
    amount = Number(attendance.hoursWorked || 0) * baseRate;
  } else if (compensation.payType === "monthly") {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    let year = start.getFullYear();
    let month = start.getMonth();

    while (year < end.getFullYear() || (year === end.getFullYear() && month <= end.getMonth())) {
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const firstCoveredDay = year === start.getFullYear() && month === start.getMonth() ? start.getDate() : 1;
      const lastCoveredDay = year === end.getFullYear() && month === end.getMonth() ? end.getDate() : daysInMonth;
      amount += baseRate * ((lastCoveredDay - firstCoveredDay + 1) / daysInMonth);
      month += 1;
      if (month === 12) {
        month = 0;
        year += 1;
      }
    }
  }

  return roundMoney(amount);
}

function calculateOvertimePay(compensation, overtimeHours = 0) {
  if (!compensation) return 0;
  const hours = Number(overtimeHours || 0);
  const rate = Number(compensation.overtimeRate || 0);
  if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(rate) || rate < 0) return 0;
  return roundMoney(hours * rate);
}

function attendanceQualityWarnings(compensation, attendance = {}) {
  if (!compensation || compensation.payType === "monthly") return [];
  const warnings = [];
  const payableDays = Number(attendance.present || 0) + Number(attendance.late || 0);
  if (payableDays === 0) warnings.push("No payable attendance was recorded for this period.");
  if (Number(attendance.incompleteShifts || 0) > 0) {
    warnings.push(`${attendance.incompleteShifts} payable attendance record(s) are missing check-in or check-out.`);
  }
  if (Number(attendance.manualEntries || 0) > 0) {
    warnings.push(`${attendance.manualEntries} attendance record(s) were entered or adjusted manually.`);
  }
  if (Number(attendance.unverifiedEntries || 0) > 0) {
    warnings.push(`${attendance.unverifiedEntries} QR attendance record(s) are not verified.`);
  }
  return warnings;
}

function hasBlockingAttendanceExceptions(compensation, attendance = {}) {
  if (!compensation || compensation.payType === "monthly") return false;
  const payableDays = Number(attendance.present || 0) + Number(attendance.late || 0);
  return payableDays === 0
    || Number(attendance.incompleteShifts || 0) > 0
    || Number(attendance.unverifiedEntries || 0) > 0;
}

function separationOfDutiesViolation({ activeAdminCount = 0, createdBy, approvedBy, actorId, action } = {}) {
  if (Number(activeAdminCount || 0) < 2) return null;
  const actor = String(actorId || "");
  if (action === "approve" && String(createdBy || "") === actor) return "creator_cannot_approve";
  if (action === "pay" && String(approvedBy || "") === actor) return "approver_cannot_pay";
  return null;
}

function periodsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  return new Date(firstStart) <= new Date(secondEnd) && new Date(firstEnd) >= new Date(secondStart);
}

function dailyPayrollReadiness(attendance) {
  if (!attendance || !["Present", "Late"].includes(attendance.status)) {
    return { eligible: false, ready: false, reason: "No payable attendance today." };
  }
  if (!attendance.checkInTime) {
    return { eligible: true, ready: false, reason: "Waiting for check-in." };
  }
  if (!attendance.checkOutTime) {
    return { eligible: true, ready: false, reason: "Waiting for check-out before payroll calculation." };
  }
  return { eligible: true, ready: true, reason: "Attendance is complete and ready for a draft." };
}

module.exports = {
  calculateBasicPay,
  calculateOvertimePay,
  dailyPayrollReadiness,
  attendanceQualityWarnings,
  hasBlockingAttendanceExceptions,
  separationOfDutiesViolation,
  calendarDayCount,
  payrollTotals,
  periodsOverlap,
  roundMoney,
};
