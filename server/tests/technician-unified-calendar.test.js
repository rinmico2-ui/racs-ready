"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), "utf8");
const pages = read("../routes/pages.js");
const permissions = read("../middleware/requirePermission.js");
const sidebar = read("../views/partials/technician-sidebar.ejs");
const calendar = read("../views/pages/admin/Appointments/Calendar.ejs");
const assignments = read("../views/pages/technician/assignments.ejs");
const ordersView = read("../views/pages/technician/technicianorders.ejs");
const orderRoutes = read("../routes/orderRoutes.js");

test("technician has a separate ownership-scoped unified calendar page", () => {
  const route = pages.slice(
    pages.indexOf('"/technician/calendar"'),
    pages.indexOf("// technician analytics page"),
  );
  assert.match(route, /calendarWorkspaceRole: "technician"/);
  assert.match(route, /calendarAppointmentsListApi: "\/api\/technician\/calendar"/);
  assert.match(route, /calendarOrdersListApi: "\/api\/orders\/technician\/all"/);
  assert.match(route, /calendarBookingsQueryParam: "id"/);
  assert.match(route, /Technician\.findOne\(\{ user: req\.user\._id \}\)\.lean\(\)/);
  assert.match(route, /technician: tech \|\| \{\}/);
  assert.match(sidebar, /href="\/technician\/calendar"[\s\S]*?My Calendar/);
  assert.match(sidebar, /typeof technician !== 'undefined'/);
  assert.match(permissions, /path\.startsWith\("\/technician\/calendar"\)/);
});

test("technician booking page no longer embeds its old calendar UI", () => {
  assert.doesNotMatch(assignments, /data-view="calendar"/);
  assert.doesNotMatch(assignments, /id="techCalendar"/);
  assert.doesNotMatch(assignments, /<script src="[^"]*fullcalendar/i);
});

test("shared calendar adapts record identity and controls for technicians", () => {
  assert.match(calendar, /calendarIsTechnicianView \? 'My Calendar' : 'Operations Calendar'/);
  assert.match(calendar, /if \(!calendarIsTechnicianView\)/);
  assert.match(calendar, /objectIdValue\(appointment\.bookingId\)/);
  assert.match(calendar, /calendarBookingsQueryParam/);
  assert.match(calendar, /calendarOrdersQueryParam/);
});

test("technician calendar renders personal labels and scoped endpoints", async () => {
  const html = await ejs.renderFile(path.join(__dirname, "../views/pages/admin/Appointments/Calendar.ejs"), {
    calendarWorkspaceRole: "technician",
    calendarAppointmentsApi: "/api/technician/appointments",
    calendarAppointmentsListApi: "/api/technician/calendar",
    calendarOrdersApi: "/api/orders",
    calendarOrdersListApi: "/api/orders/technician/all",
    calendarBookingsPath: "/technician/assignments",
    calendarBookingsQueryParam: "id",
    calendarOrdersPath: "/technician/orders",
    calendarOrdersQueryParam: "order",
  });
  assert.match(html, /<h1 class="cal-hero-title">My Calendar<\/h1>/);
  assert.match(html, /const calendarIsTechnician = true/);
  assert.match(html, /const calendarOrdersListApi = "\/api\/orders\/technician\/all"/);
  assert.doesNotMatch(html, /id="techFilterWrapper"/);
});

test("technician order calendar requests schedule ranges and opens linked orders", () => {
  const technicianOrdersRoute = orderRoutes.slice(
    orderRoutes.indexOf('router.get("/technician/all"'),
    orderRoutes.indexOf('router.get("/assignment-plan"'),
  );
  assert.match(technicianOrdersRoute, /scheduledFrom, scheduledTo/);
  assert.match(technicianOrdersRoute, /"delivery\.preferredDate": scheduledRange/);
  assert.match(technicianOrdersRoute, /pickupDate: scheduledRange/);
  assert.match(ordersView, /linkedOrderId = new URLSearchParams\(window\.location\.search\)\.get\('order'\)/);
  assert.match(ordersView, /window\.viewOrder\(linkedOrderId\)/);
});
