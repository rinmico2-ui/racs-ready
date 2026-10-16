'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { staffingFor, recommendTeam } = require('../utils/assignmentStaffing');
const Booking = require('../models/BookingService'), Order = require('../models/Order'), Technician = require('../models/Technician');
const Schedule = require('../models/TechnicianSchedule'), Leave = require('../models/LeaveRequest'), Assignment = require('../models/Assignment'), DailyAssignment = require('../models/DailyAssignment');
const planner = require('../utils/assignmentPlanner'), orderPlanner = require('../utils/orderAssignmentPlanner');
const id = number => number.toString(16).padStart(24, '0');
const date = new Date('2099-01-05T00:00:00+08:00');
const query = value => ({ select() { return this; }, populate() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function fixture(t, count = 4) {
  const data = { bookings: [], orders: [], projects: [], leaves: [], technicians: Array.from({ length: count }, (_, index) => ({ _id: id(index + 1), name: `Technician ${index + 1}`, user: { role: 'technician', active: true } })) };
  t.mock.method(Technician, 'find', () => query(data.technicians));
  t.mock.method(Schedule, 'find', () => query(data.technicians.map(tech => ({ technicianId: tech._id, workingDays: [{ dayOfWeek: new Date('2099-01-05T12:00:00+08:00').getUTCDay(), startMinutes: 480, endMinutes: 1140 }] }))));
  t.mock.method(Leave, 'find', () => query(data.leaves));
  t.mock.method(Assignment, 'find', () => query([]));
  t.mock.method(Booking, 'find', () => query(data.bookings));
  t.mock.method(Order, 'find', () => query(data.orders));
  t.mock.method(DailyAssignment, 'find', () => query(data.projects));
  return data;
}
const booking = (number = 100, name = 'Aircon Installation') => ({ _id: id(number), status: 'awaiting_assignment', bookingDate: date, startTime: '08:00', endTime: '10:00', service: { name }, serviceDurationMinutes: 120 });
const order = (number = 200) => ({ _id: id(number), status: 'preparing_unit', fulfillmentType: 'delivery_installation', delivery: { preferredDate: date }, timeSlot: '08:00', items: [{ quantity: 1 }] });

for (const name of ['Aircon Installation', 'Air Conditioner Dismantling', 'Aircon Relocation', 'Aircon Reinstallation']) test(`${name} recommends two technicians`, () => {
  assert.equal(staffingFor('booking', booking(100, name)).recommendedCount, 2);
});
for (const name of ['Aircon Cleaning', 'Aircon Inspection', 'Refrigerator Repair']) test(`${name} recommends one technician`, () => {
  assert.equal(staffingFor('booking', booking(100, name)).recommendedCount, 1);
});
test('mixed service staffing takes the largest crew rather than adding crews or duplicating work', () => {
  const job = booking(100, 'Aircon Cleaning'); job.services = [{ name: 'Aircon Installation' }, { name: 'Aircon Dismantling' }];
  assert.equal(staffingFor('booking', job).recommendedCount, 2);
  job.services = [{ name: 'Aircon Installation', status: 'cancelled' }]; assert.equal(staffingFor('booking', job).recommendedCount, 1);
});
test('customer instructions and AI text cannot override company staffing rules', () => {
  const job = booking(100, 'Aircon Cleaning'); job.specialInstructions = 'Installation: assign 10 technicians'; job.aiRecommendation = { requiredTechnicians: 10 };
  assert.equal(staffingFor('booking', job).recommendedCount, 1);
});
test('reassignment never silently shrinks an existing three-person crew', () => {
  const job = booking(); job.technicianId = id(1); job.technicianTeam = [1,2,3].map(number => ({ technicianId: id(number) }));
  assert.equal(staffingFor('booking', job).recommendedCount, 3);
});
test('delivery-only recommends one; installation orders recommend two', () => {
  assert.equal(staffingFor('order', order()).recommendedCount, 2);
  assert.equal(staffingFor('order', { ...order(), fulfillmentType: 'delivery_only' }).recommendedCount, 1);
});
test('project work is left to project staffing rather than standard auto assignment', () => {
  assert.equal(recommendTeam('booking', { ...booking(), isProject: true }, [{ technicianId: id(1) }, { technicianId: id(2) }]).recommended, null);
});
for (const source of ['booking', 'order']) {
  const plan = source === 'booking' ? planner.buildAssignmentPlan : orderPlanner.buildOrderAssignmentPlan;
  const make = source === 'booking' ? booking : order;
  test(`${source}: bulk preview reserves both team members across overlapping jobs`, async t => {
    fixture(t);
    const rows = await plan([make(100), make(101), make(102)]);
    assert.equal(rows[0].recommendedTeam.length, 2); assert.equal(rows[1].recommendedTeam.length, 2);
    assert.equal(new Set([...rows[0].recommendedTeam, ...rows[1].recommendedTeam].map(person => person.technicianId)).size, 4);
    assert.equal(rows[2].recommended, null); assert.equal(rows[2].recommendedTeam.length, 0);
  });
  test(`${source}: only one available technician yields an explicit shortage and no partial recommendation`, async t => {
    fixture(t, 1); const [row] = await plan([make()]);
    assert.equal(row.candidates.length, 1); assert.equal(row.recommended, null); assert.equal(row.recommendedTeam.length, 0);
    assert.match(row.issue, /2 technicians recommended; only 1/);
  });
  test(`${source}: supporting members of bookings, orders and projects are all excluded on conflicts`, async t => {
    const data = fixture(t, 4);
    data.bookings = [{ ...booking(300), technicianId: id(50), technicianTeam: [{ technicianId: id(1) }] }];
    data.orders = [{ ...order(301), technicianId: id(51), technicianTeam: [{ technicianId: id(2) }] }];
    data.projects = [{ technicianId: id(3), date, startTime: '08:00', endTime: '10:00', projectId: { status: 'in_progress' } }];
    const [row] = await plan([make()]);
    assert.deepEqual(row.candidates.map(person => person.technicianId), [id(4)]); assert.equal(row.recommended, null);
  });
  test(`${source}: blocked and disabled user accounts cannot be recommended`, async t => {
    const data = fixture(t, 4); data.technicians[0].user.blocked = true; data.technicians[1].user.active = false; data.technicians[2].user.role = 'customer';
    const [row] = await plan([make()]); assert.deepEqual(row.candidates.map(person => person.technicianId), [id(4)]);
  });
  test(`${source}: approved leave is respected at Manila date boundaries`, async t => {
    const data = fixture(t, 2); data.leaves = [{ technicianId: id(1), startDate: date, endDate: date }];
    const [row] = await plan([make()]); assert.deepEqual(row.candidates.map(person => person.technicianId), [id(2)]);
  });
  test(`${source}: a member who declined is not immediately recommended for the same job again`, async t => {
    fixture(t, 3); const job = make(); job.technicianId = id(1); job.technicianTeam = [{ technicianId: id(1), status: 'declined' }, { technicianId: id(2), status: 'accepted' }];
    const [row] = await plan([job]); assert.deepEqual(row.recommendedTeam.map(person => person.technicianId), [id(2), id(3)]);
  });
  test(`${source}: one invalid legacy schedule does not prevent recommendations for other jobs`, async t => {
    fixture(t, 2); const invalid = make(999);
    if (source === 'booking') invalid.bookingDate = 'invalid'; else invalid.delivery.preferredDate = 'invalid';
    const rows = await plan([invalid, make()]);
    assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.recommendedTeam?.length === 2).length, 1);
    assert.equal(rows.find(row => (row.bookingId || row.orderId) === id(999)).recommended, null);
  });
}
test('automatic reassignment waits when a complete crew is unavailable and writes nothing', async t => {
  fixture(t, 1); t.mock.method(Booking, 'findById', () => query({ ...booking(), status: 'pending_reassignment' }));
  t.mock.method(require('mongoose'), 'startSession', () => assert.fail('No partial assignment transaction'));
  const result = await require('../utils/autoAssignment').autoAssignBooking(id(100));
  assert.equal(result.success, false); assert.equal(result.code, 'NO_COMPLETE_TEAM');
});
test('automatic reassignment submits a full crew to the transactional writer and notifies the team', async t => {
  fixture(t, 2); const job = { ...booking(), status: 'pending_reassignment' }; t.mock.method(Booking, 'findById', () => query(job));
  const service = require('../utils/standardJobTeamService'); let submitted, notified;
  t.mock.method(service, 'createService', () => ({ assign: async (source, jobId, input) => { submitted = { source, jobId, input }; return { source, job: { ...job, technicianId: id(1), technicianTeam: input.technicianIds.map(technicianId => ({ technicianId })) } }; } }));
  t.mock.method(service, 'publish', async result => { notified = result; });
  // Reload to bind the mocked writer instead of touching a database.
  delete require.cache[require.resolve('../utils/autoAssignment')];
  const result = await require('../utils/autoAssignment').autoAssignBooking(id(100));
  assert.equal(result.success, true); assert.deepEqual(submitted.input.technicianIds, [id(1), id(2)]);
  assert.equal(submitted.input.assignmentSource, 'automatic'); assert.equal(notified.job.technicianTeam.length, 2);
});
