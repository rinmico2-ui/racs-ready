"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const source = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Staff/Attendance.ejs"), "utf8");
const staff = [...Array.from({ length: 9 }, (_, i) => ({ name: "Technician " + i, role: "technician", attendanceStatus: "Absent" })), ...Array.from({ length: 6 }, (_, i) => ({ name: "Secretary " + i, role: "secretary", attendanceStatus: "Absent" }))];

function filters() {
  const renderings = [];
  const context = {
    rosterData: staff, rosterFiltered: [], currentPage: 2, pageSize: 10,
    attendanceSearchInput: { value: "" }, attendanceStatusFilter: { value: "all" }, attendanceRoleFilter: { value: "all" },
    renderPage(page, rows) { renderings.push({ page, rows }); },
  };
  const start = source.indexOf("    function selectRosterRole(role)");
  const end = source.indexOf("    function renderRow(tech)", start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, renderings };
}

test("Show technicians clears other filters and displays all nine technicians together", () => {
  const { context, renderings } = filters();
  context.attendanceSearchInput.value = "Technician 1";
  context.attendanceStatusFilter.value = "Present";
  vm.runInContext("selectRosterRole('technician');", context);
  assert.equal(context.attendanceSearchInput.value, "");
  assert.equal(context.attendanceStatusFilter.value, "all");
  assert.equal(renderings.at(-1).page, 1);
  assert.equal(renderings.at(-1).rows.length, 9);
  assert.ok(renderings.at(-1).rows.every(row => row.role === "technician"));
  vm.runInContext("selectRosterRole('all');", context);
  assert.equal(renderings.at(-1).rows.length, 15);
});

test("paging labels distinguish visible rows, filtered matches and the full staff roster", () => {
  const rosterRecordCount = { textContent: "" };
  const context = {
    rosterData: staff, rosterRecordCount, tblRosterBody: { innerHTML: "" }, attendanceFooter: { innerHTML: "" },
    currentPage: 1, pageSize: 10,
    renderRow: row => `<tr>${row.name}</tr>`, renderPagination() {},
    document: { querySelectorAll: () => [] },
  };
  const start = source.indexOf("    function renderPage(page, items)");
  const end = source.indexOf("    function renderPagination", start);
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  vm.runInContext("renderPage(1, rosterData);", context);
  assert.equal(rosterRecordCount.textContent, "Showing 1-10 of 15 matching staff (15 total)");
  vm.runInContext("renderPage(2, rosterData);", context);
  assert.equal(rosterRecordCount.textContent, "Showing 11-15 of 15 matching staff (15 total)");
  vm.runInContext("renderPage(1, rosterData.filter(row => row.role === 'technician'));", context);
  assert.equal(rosterRecordCount.textContent, "Showing 1-9 of 9 matching staff (15 total)");
  vm.runInContext("renderPage(1, []);", context);
  assert.match(rosterRecordCount.textContent, /Showing 0 of 15.*Clear filters/);
});

test("attendance page exposes role totals and its scripts compile", () => {
  assert.match(source, /id="rosterTechnicianCount"/);
  assert.match(source, /id="rosterSecretaryCount"/);
  ejs.compile(source);
  for (const script of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
});
