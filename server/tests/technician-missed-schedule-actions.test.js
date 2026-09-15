const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const technicianApi = fs.readFileSync(path.join(__dirname, '../routes/technicianApi.js'), 'utf8');
const assignmentsView = fs.readFileSync(path.join(__dirname, '../views/pages/technician/assignments.ejs'), 'utf8');
const technicianOrdersView = fs.readFileSync(path.join(__dirname, '../views/pages/technician/technicianorders.ejs'), 'utf8');
const orderRoutes = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');

test('technician assignment APIs expose one authoritative missed-schedule state', () => {
  assert.match(technicianApi, /item\.scheduleMissed = assertNotMissedSchedule\(item\)/);
  assert.match(technicianApi, /assignment\.scheduleMissed = assertNotMissedSchedule\(assignment\)/);
  assert.match(technicianApi, /newStatus === "en_route" && assertNotMissedSchedule\(assignment\)/);
});

test('details and cards lock En Route while a visit awaits rescheduling', () => {
  assert.match(assignmentsView, /return !assignmentHasMissedSchedule\(a\)/);
  assert.match(assignmentsView, /En Route is locked until operations confirms a new customer schedule/);
  assert.match(assignmentsView, /stBadge\.textContent = scheduleMissed \? 'Missed Schedule'/);
  assert.doesNotMatch(assignmentsView, /return true; \/\/ TEMPORARILY DISABLED - always allow en route/);
});

test('technician order cards and details use the same schedule-recovery contract', () => {
  assert.match(orderRoutes, /router\.get\("\/technician\/all"[\s\S]*?orders: orders\.map\(\(order\) => withOrderAttentionState\(order\)\)/);
  assert.match(technicianOrdersView, /function orderNeedsScheduleRecovery\(order\)/);
  assert.match(technicianOrdersView, /Accept and En Route are locked until operations updates the customer schedule/);
  assert.match(technicianOrdersView, /status === 'out_for_delivery' && orderNeedsScheduleRecovery\(order\)/);
  assert.match(technicianOrdersView, /data\.code === 'ORDER_SCHEDULE_PASSED'/);
});
