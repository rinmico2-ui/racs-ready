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
  assert.match(html, /admin-appointments-calendar\.css\?v=20261010-blue-weekdays/);
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

test("month counts include all filtered bookings and orders while detailed views retain their events", () => {
  const source = calendarSource.match(/function applyFilters\(\) \{[\s\S]*?\n      \}/)[0];
  const appointments = Array.from({ length: 6 }, (_, index) => ({
    _id: `booking-${index}`, bookingDate: "2026-10-09", status: index ? "confirmed" : "pending",
  }));
  const orders = [{ _id: "order-1", date: "2026-10-09" }, { _id: "order-2", date: "2026-10-10" }];
  const added = [];
  const context = {
    state: { allAppointments: appointments, allOrders: orders, activeFilters: new Set(), selectedTechIds: [], technicians: [], showBookings: true, showOrders: true },
    calendar: { view: { type: "dayGridMonth" }, removeAllEvents() { added.length = 0; }, addEventSource(events) { added.push(...events); } },
    appointmentMatchesQuery: () => true, orderMatchesQuery: () => true,
    appointmentWorkspaceId: record => record._id, appointmentDetailId: record => record._id,
    technicianId: () => "", getTechColor: () => null, getColor: () => "#2563eb",
    appointmentTimeMinutes: () => null, parseTimeMinutes: () => null,
    customerName: () => "Customer", serviceName: () => "Cleaning",
    eventStart: record => record.bookingDate, orderScheduledDate: record => record.date, orderEventStart: record => record.date,
    toDateKey: date => date, refreshDaySummaries() {}, updateSummary() {}, renderDateList() {},
  };
  vm.createContext(context);
  vm.runInContext(`let dayCounts = new Map(); ${source}; applyFilters();`, context);
  const counts = () => JSON.parse(vm.runInContext("JSON.stringify([...dayCounts])", context));
  assert.deepEqual(counts(), [["2026-10-09", 7], ["2026-10-10", 1]]);
  assert.equal(added.length, 0, "month cells show counts without job cards");

  context.state.showOrders = false;
  context.state.activeFilters.add("pending");
  vm.runInContext("applyFilters()", context);
  assert.deepEqual(counts(), [["2026-10-09", 1]]);
  assert.equal(added.length, 0);

  context.state.activeFilters.clear();
  context.state.showOrders = true;
  for (const view of ["timeGridWeek", "timeGridDay", "listWeek"]) {
    context.calendar.view.type = view;
    vm.runInContext("applyFilters()", context);
    assert.equal(added.length, 8, view);
    assert.deepEqual(counts(), [["2026-10-09", 7], ["2026-10-10", 1]]);
  }
});

