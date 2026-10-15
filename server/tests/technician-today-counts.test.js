const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const technicianApi = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
const assignmentsView = fs.readFileSync(path.join(__dirname, "../views/pages/technician/assignments.ejs"), "utf8");

test("technician KPI counts exclude project assignments from the My Work scope", async () => {
  const { technicianAssignmentScope } = require('../utils/technicianWorkSync');
  const rows = [
    { _id:'standard', bookingId:'booking', technicianId:'tech', status:'accepted', serviceType:'core' },
    { _id:'project', bookingId:'project-booking', technicianId:'tech', status:'accepted', serviceType:'project' },
    { _id:'order', bookingId:'order-booking', technicianId:'tech', status:'accepted', serviceType:'core' },
  ];
  const query = value => ({ select() { return this; }, lean:async()=>value });
  const scope = await technicianAssignmentScope('tech', {
    Assignments:{ find:()=>query(rows) },
    Bookings:{ find:()=>query([
      { _id:'booking', assignmentId:'standard', technicianId:'tech', status:'confirmed' },
      { _id:'project-booking', isProject:true, status:'confirmed' },
      { _id:'order-booking', sourceOrderId:'sale', status:'confirmed' },
    ]) },
  });
  assert.deepEqual(scope._id.$nin, ['project','order']);
  assert.match(technicianApi, /const workScope = await technicianAssignmentScope\(tech\._id\);\s*const baseFilter = \{\s*\.\.\.workScope,/);
  assert.match(technicianApi, /const todayStart = manilaDateTime\(new Date\(\), 0\)/);
  assert.match(technicianApi, /status: \{ \$nin: \["cancelled", "declined", "expired", "no_show", "no_show_reported"\] \}/);
});

test("Today badge is based on the same filtered jobs rendered in the run sheet", () => {
  assert.match(assignmentsView, /todayBadge\.textContent = jobs\.length/);
  assert.match(assignmentsView, /window\._visibleTodayWorkOrderCount = jobs\.length/);
  assert.doesNotMatch(assignmentsView, /if \(status === 'today'\) document\.getElementById\('countToday'\)\.textContent = data\.total/);
});
