'use strict';
const crypto = require('node:crypto');
const defaults = [
  { _id: 'builtin-meal', name: 'Meal allowance', kind: 'allowance', amount: 0, builtin: true },
  { _id: 'builtin-transport', name: 'Transport allowance', kind: 'allowance', amount: 0, builtin: true },
  { _id: 'builtin-advance', name: 'Cash advance', kind: 'deduction', amount: 0, builtin: true },
  { _id: 'builtin-loan', name: 'Loan repayment', kind: 'deduction', amount: 0, builtin: true },
];
const problem = message => Object.assign(new Error(message), { status: 400 });
function normalizeBatchRequest(body = {}) {
  if (!Array.isArray(body.employeeIds) || !body.employeeIds.length || body.employeeIds.length > 25 || body.employeeIds.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw problem('Select between 1 and 25 staff members.');
  const employeeIds = body.employeeIds.map(id => id.toLowerCase()).sort();
  if (new Set(employeeIds).size !== employeeIds.length) throw problem('Select each staff member only once.');
  const templateIds = body.templateIds || [];
  if (!Array.isArray(templateIds) || templateIds.length > 30 || templateIds.some(id => typeof id !== 'string' || (!/^[a-f\d]{24}$/i.test(id) && !defaults.some(t => t._id === id))) || new Set(templateIds).size !== templateIds.length) throw problem('Select valid payroll templates.');
  for (const key of ['periodStart', 'periodEnd', 'payDate']) {
    const value = body[key];
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw problem('Enter a valid ' + key.replace(/([A-Z])/g, ' $1').toLowerCase() + '.');
  }
  if (body.periodEnd < body.periodStart) throw problem('Period end cannot be before period start.');
  if (body.payDate < body.periodEnd) throw problem('Pay date cannot be before the period end.');
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 1000)) throw problem('Notes must be text up to 1,000 characters.');
  return { employeeIds, templateIds: [...templateIds].sort(), periodStart: body.periodStart, periodEnd: body.periodEnd, payDate: body.payDate, notes: (body.notes || '').trim() };
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function draftFingerprint(data) {
  return hash({ employee: String(data.employee), compensationRecord: String(data.compensationRecord), basicPay: data.basicPay,
    overtimePay: data.overtimePay, allowances: data.allowances, deductions: data.deductions, netPay: data.netPay, attendance: data.attendanceSummary, warnings: data.calculationWarnings });
}
async function mapLimited(items, work, concurrency = 3) {
  const output = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await work(items[index], index); }
  }));
  return output;
}
module.exports = { defaults, normalizeBatchRequest, draftFingerprint, hash, mapLimited };
