const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const technicianApi = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
const assignmentsView = fs.readFileSync(path.join(__dirname, "../views/pages/technician/assignments.ejs"), "utf8");

test("technician KPI counts exclude project assignments from the My Work scope", () => {
  assert.match(technicianApi, /const projectBookingIds = await BookingService\.find\(\{ isProject: true \}\)\.distinct\("_id"\)/);
  assert.match(technicianApi, /bookingId: \{ \$nin: projectBookingIds \}/);
  assert.match(technicianApi, /const todayStart = manilaDateTime\(new Date\(\), 0\)/);
  assert.match(technicianApi, /status: \{ \$nin: \["cancelled", "declined", "expired", "no_show", "no_show_reported"\] \}/);
});

test("Today badge is based on the same filtered jobs rendered in the run sheet", () => {
  assert.match(assignmentsView, /todayBadge\.textContent = jobs\.length/);
  assert.match(assignmentsView, /window\._visibleTodayWorkOrderCount = jobs\.length/);
  assert.doesNotMatch(assignmentsView, /if \(status === 'today'\) document\.getElementById\('countToday'\)\.textContent = data\.total/);
});
