const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOpensBeforeFetch(source, openMarker, message) {
  const openIndex = source.indexOf(openMarker);
  const fetchIndex = source.indexOf("fetch(");
  assert.notEqual(openIndex, -1, `${message}: immediate modal open is missing`);
  assert.notEqual(fetchIndex, -1, `${message}: request is missing`);
  assert.ok(openIndex < fetchIndex, `${message}: modal must open before its request starts`);
}

test("admin modal shell is reusable, fast, accessible, and cache-busted", () => {
  const script = read("public/js/admin.js");
  const styles = read("public/css/admin.css");
  const layout = read("views/layouts/admin.ejs");

  assert.match(script, /window\.AdminModalUX\s*=\s*\(function/);
  assert.match(script, /bootstrap\.Modal\.getOrCreateInstance/);
  assert.match(script, /setAttribute\("aria-busy"/);
  assert.match(script, /state\.setAttribute\("role", failed \? "alert" : "status"\)/);
  assert.match(styles, /\.modal\.fade\s*\{[\s\S]*transition:\s*opacity 0\.1s linear/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(layout, /admin\.css\?v=20260927-fast-modals/);
  assert.match(layout, /admin\.js\?v=20260927-shell-components/);
});

test("remote admin details open immediately instead of waiting for the network", () => {
  const payments = section(
    read("public/js/admin-payments.js"),
    "async function openDetails(paymentId)",
    "function updateStats(items)",
  );
  assertOpensBeforeFetch(payments, "AdminModalUX.open", "payment details");
  assert.match(payments, /signal:\s*requestController\.signal/);

  const pending = section(
    read("views/pages/admin/Appointments/PendingReview.ejs"),
    "async function viewDetail(id)",
    "function refreshList()",
  );
  assertOpensBeforeFetch(pending, "AdminModalUX.open", "booking details");
  assert.match(pending, /signal:\s*requestController\.signal/);

  const staffPage = read("views/pages/admin/Staff/StaffList.ejs");
  const viewStaff = section(staffPage, "// ── View Staff click handler", "// ── Edit Staff click handler");
  const editStaff = section(staffPage, "// ── Edit Staff click handler", "// ── Save Edit");
  assertOpensBeforeFetch(viewStaff, "AdminModalUX.open", "staff details");
  assertOpensBeforeFetch(editStaff, "AdminModalUX.open", "staff editor");
  assert.match(viewStaff, /AbortController/);
  assert.match(editStaff, /AbortController/);

  const appointmentPages = [
    ["views/pages/admin/Appointments/Overview.ejs", "async function viewDetail(id)", "// Enterprise notification system", "appointment overview"],
    ["views/pages/admin/Appointments/CompletedJobs.ejs", "async function viewDetail(id)", "function showNotification", "completed jobs"],
    ["views/pages/admin/Appointments/CancellationLog.ejs", "async function viewHistory(id)", "document.addEventListener('DOMContentLoaded'", "cancellation history"],
  ];
  appointmentPages.forEach(function ([file, start, end, label]) {
    const details = section(read(file), start, end);
    assertOpensBeforeFetch(details, "AdminModalUX.open", label);
    assert.match(details, /AbortController/);
  });

  const calendar = section(
    read("views/pages/admin/Appointments/Calendar.ejs"),
    "window.openCalDetail = async function",
    "async function fetchAppointmentsForRange",
  );
  assertOpensBeforeFetch(calendar, "AdminModalUX.open", "calendar details");
  assert.match(calendar, /signal:\s*requestController\.signal/g);

  const payroll = section(
    read("views/pages/admin/Payroll/PayrollManagement.ejs"),
    "async function viewRecord(id)",
    "function openApprove(id)",
  );
  assertOpensBeforeFetch(payroll, "AdminModalUX.open", "payroll details");
  assert.match(payroll, /signal:\s*requestController\.signal/);
});
