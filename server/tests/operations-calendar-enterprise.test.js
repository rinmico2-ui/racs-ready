"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const calendarPath = path.join(__dirname, "../views/pages/admin/Appointments/Calendar.ejs");
const calendarSource = fs.readFileSync(calendarPath, "utf8");
const calendarCss = fs.readFileSync(path.join(__dirname, "../public/css/admin-appointments-calendar.css"), "utf8");

async function renderCalendar(role) {
  const prefix = role === "technician" ? "/technician" : "/admin";
  return ejs.renderFile(calendarPath, {
    calendarWorkspaceRole: role,
    calendarAppointmentsApi: "/api/example/appointments",
    calendarAppointmentsListApi: "/api/example/calendar",
    calendarOrdersApi: "/api/orders",
    calendarOrdersListApi: "/api/orders/all",
    calendarBookingsPath: `${prefix}/appointments`,
    calendarOrdersPath: `${prefix}/orders`,
  });
}

test("operations calendar renders an enterprise scheduling workspace", async () => {
  const html = await renderCalendar("admin");

  assert.match(html, /class="cal-hero cal-command-header"/);
  assert.match(html, /class="cal-eyebrow"/);
  assert.match(html, /class="cal-range-row"/);
  assert.match(html, /class="cal-workspace-head"/);
  assert.match(html, /class="cal-type-legend"/);
  assert.match(html, /aria-label="Selected date agenda"/);
  assert.match(html, /class="list-head-icon"/);
  assert.match(html, /admin-appointments-calendar\.css\?v=20260927-enterprise-v2/);
  assert.match(calendarCss, /OPERATIONS CALENDAR — ENTERPRISE WORKSPACE V2/);
});

test("calendar controls and agenda records are keyboard and screen-reader friendly", async () => {
  const html = await renderCalendar("admin");

  assert.match(html, /id="techFilterTrigger"[^>]+aria-expanded="false"/);
  assert.match(html, /data-view="dayGridMonth"[^>]+aria-pressed="true"/);
  assert.match(calendarSource, /type="button" class="appt-body"/);
  assert.match(calendarSource, /markSelectedDay\(state\.selectedDateKey, info\.dayEl\)/);
  assert.match(calendarSource, /event\.key === "Escape"/);
  assert.match(calendarSource, /setAttribute\("aria-pressed"/);
  assert.doesNotMatch(calendarSource, /console\.log\("\[Calendar\]/);
});

test("shared admin, secretary, and technician calendar templates keep valid inline scripts", async () => {
  for (const role of ["admin", "secretary", "technician"]) {
    const html = await renderCalendar(role);
    for (const match of html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]), role);
    }
  }
});

