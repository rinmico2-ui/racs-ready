"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("expense rejection uses a contextual validated modal instead of a prompt", () => {
  const page = read("views/pages/admin/Appointments/ExpenseApproval.ejs");

  assert.match(page, /id="expenseRejectModal"/);
  assert.match(page, /id="rejectExpenseCategory" required/);
  assert.match(page, /id="rejectExpenseReason" minlength="10" maxlength="500" required/);
  assert.match(page, /id="rejectExpenseCounter"/);
  assert.match(page, /function rejectExpense\(id\)/);
  assert.doesNotMatch(page, /prompt\('Rejection reason:/);
  assert.match(page, /if \(!response\.ok\) throw new Error/);
  assert.match(page, /shown\.bs\.modal/);
});

test("expense rejection API requires a bounded meaningful reason", () => {
  const route = read("routes/appointmentManagement.js");
  const rejection = route.slice(route.indexOf("router.post('/expenses/:id/reject'"), route.indexOf("router.get('/expenses/stats'"));

  assert.match(rejection, /String\(req\.body\.reason \|\| ''\)\.trim\(\)/);
  assert.match(rejection, /reason\.length < 10 \|\| reason\.length > 600/);
  assert.match(rejection, /expense\.rejectionReason = reason/);
  assert.doesNotMatch(rejection, /Rejected by admin/);
});
