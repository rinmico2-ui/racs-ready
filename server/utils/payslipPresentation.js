function payslipNumberFor(payroll) {
  if (payroll && payroll.payslipNumber) return String(payroll.payslipNumber).trim().toUpperCase();

  const sourceDate = new Date(
    (payroll && (payroll.periodEnd || payroll.approvedAt || payroll.createdAt)) || Date.now(),
  );
  const validDate = Number.isNaN(sourceDate.getTime()) ? new Date(0) : sourceDate;
  const year = validDate.getUTCFullYear();
  const month = String(validDate.getUTCMonth() + 1).padStart(2, "0");
  const idSuffix = String((payroll && payroll._id) || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-24)
    .toUpperCase()
    .padStart(24, "0");

  return `PS-${year}${month}-${idSuffix}`;
}

function canViewPayslip(user, payroll) {
  if (!user || !payroll) return false;
  if (payroll.status === "draft") return false;
  if (user.role === "admin") return ["approved", "paid", "voided"].includes(payroll.status);
  if (!["technician", "secretary"].includes(user.role)) return false;
  if (!["approved", "paid"].includes(payroll.status)) return false;

  const employeeId = payroll.employee && payroll.employee._id
    ? payroll.employee._id
    : payroll.employee;
  return String(employeeId || "") === String(user._id || "");
}

module.exports = { payslipNumberFor, canViewPayslip };
