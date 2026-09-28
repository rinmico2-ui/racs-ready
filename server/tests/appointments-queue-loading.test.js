"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const route = read("routes/appointmentManagement.js");
const view = read("views/pages/admin/Appointments/AppointmentsUnified.ejs");

test("queue cards use a compact paginated response and ignore stale page results", () => {
  assert.match(view, /list\?page='\+page\+'&limit=20&compact=queue&status=awaiting_assignment,pending_reassignment/);
  assert.match(view, /var loadRequest=\+\+_qLoadRequest/);
  assert.match(view, /if\(loadRequest!==_qLoadRequest\)return/);
  assert.match(route, /req\.query\.compact === 'true' \|\| req\.query\.compact === 'queue'/);
  assert.match(route, /projection\.cancellationHistory = \{ \$slice:/);
});

test("queue metrics and warnings avoid list payloads and distant future bookings", () => {
  assert.match(view, /fetch\(APPOINTMENTS_API\+'\/queue-metrics'\)/);
  assert.doesNotMatch(view.slice(view.indexOf('AU.Queue.loadStats=function'), view.indexOf('AU.Queue.filterByStatus=function')), /\/list\?|\/cancellation-log\?/);
  assert.match(route, /router\.get\('\/queue-metrics', requireRole\(\['admin', 'secretary'\]\)/);
  assert.match(route, /bookingDate: \{ \$gte: upcomingStart, \$lt: upcomingEnd \}/);
  assert.match(route, /bookingDate: \{ \$lte: now \}/);
});

test("technician recommendations are bounded to the currently visible queue page", () => {
  assert.match(view, /AU\.Queue\.loadRecommendations\(data\.bookings\.filter\([\s\S]*?\.map\(function\(b\)\{return b\._id;\}\),loadRequest\)/);
  assert.match(view, /assignment-plan\?status='\+encodeURIComponent\(statuses\)\+'&bookingIds='/);
  assert.match(route, /bookingIds\.length > 20/);
  assert.match(route, /if \(bookingIds\) filter\._id = \{ \$in: bookingIds\.map/);
});
