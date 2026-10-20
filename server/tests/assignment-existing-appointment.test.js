"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
require("../models/User");
const calendar = require("../routes/scheduleRoutes");
const { buildAssignmentPlan } = require("../utils/assignmentPlanner");
const { buildOrderAssignmentPlan } = require("../utils/orderAssignmentPlanner");
const id = number => number.toString(16).padStart(24, "0");
const startMinutes = row => require("../utils/bookingDateTime").parseAppointmentTime(row.startTime);
function query(value) { return { select() { return this; }, populate() { return this; }, lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }

function fixture(t, schedule = null) {
  for (const name of ["NonWorkingDay", "BookingService", "Assignment", "DailyAssignment", "Order"]) {
    t.mock.method(require(`../models/${name}`), "find", () => query([]));
  }
  t.mock.method(require("../models/TechnicianSchedule"), "findOne", () => query(schedule || { workingDays: [{ dayOfWeek: 1, startMinutes: 480, endMinutes: 1140 }] }));
  t.mock.method(require("../models/LeaveRequest"), "findOne", () => query(null));
  t.mock.method(require("../models/SiteSetting"), "findOne", () => query(null));
}

test("existing appointment assignment checks capacity without imposing new customer booking lead time", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T01:00:00Z") });
  fixture(t);
  const input = { date: "2026-10-19", technicianId: id(1), duration: "30", travelTime: "15" };
  const customer = await calendar.getTimeSlotsForQuery(input);
  const staff = await calendar.getTimeSlotsForQuery(input, { excludeBookingId: id(2), existingAppointment: true });
  assert.equal(customer.payload.timeSlots.some(row => startMinutes(row) === 600), false);
  assert.equal(staff.payload.timeSlots.some(row => startMinutes(row) === 600 && row.available), true);
  assert.equal(staff.payload.timeSlots.some(row => startMinutes(row) === 510), false);
});

test("a public query parameter cannot bypass advance notice and trusted calls must reference an existing job", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T01:00:00Z") }); fixture(t);
  const input = { date: "2026-10-19", technicianId: id(1), duration: "30", existingAppointment: "true", _trustedExistingAppointment: true };
  for (const options of [undefined, { existingAppointment: true }]) {
    const result = await calendar.getTimeSlotsForQuery(input, options);
    assert.equal(result.payload.timeSlots.some(row => startMinutes(row) === 600), false);
  }
});

test("existing appointment assignment still respects a technician's approved leave", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T01:00:00Z") }); fixture(t);
  t.mock.method(require("../models/LeaveRequest"), "findOne", () => query({ status: "approved" }));
  const result = await calendar.getTimeSlotsForQuery({ date: "2026-10-19", technicianId: id(1), duration: "30" },
    { excludeOrderId: id(2), existingAppointment: true });
  assert.deepEqual(result.payload.timeSlots, []); assert.match(result.payload.message, /leave/i);
});

test('ongoing repair checks the current Philippine minute, excludes its own job and never extends beyond the saved shift', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T01:03:15Z') }); fixture(t);
  const input = { date: '2026-10-19', technicianId: id(1), duration: '90', travelTime: '30' };
  const result = await calendar.getTimeSlotsForQuery(input, { excludeBookingId: id(2), existingAppointment: true, ongoingStartMinutes: 544 });
  assert.equal(result.payload.timeSlots.length, 1); assert.equal(startMinutes(result.payload.timeSlots[0]), 544);
  const late = await calendar.getTimeSlotsForQuery({ ...input, duration: '480' }, { excludeBookingId: id(2), existingAppointment: true, ongoingStartMinutes: 1100 });
  assert.equal(late.payload.timeSlots.length, 0);
  const forged = await calendar.getTimeSlotsForQuery({ ...input, ongoingStartMinutes: 544, _trustedOngoingStart: 544 });
  assert.ok(!forged.payload.timeSlots.some(row => startMinutes(row) === 544));
});

test('another booking blocks an ongoing repair even when the current inspection is excluded', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T01:03:15Z') }); fixture(t);
  t.mock.method(require('../models/BookingService'), 'find', filter => { assert.equal(String(filter._id.$ne), id(2)); return query([{ startTime: '10:00', endTime: '11:00' }]); });
  const result = await calendar.getTimeSlotsForQuery({ date: '2026-10-19', technicianId: id(1), duration: '90' },
    { excludeBookingId: id(2), existingAppointment: true, ongoingStartMinutes: 544 });
  assert.deepEqual(result.payload.timeSlots, []);
});
test('late booking assignment checks the full visit from the current Philippine minute', async t => {
  t.mock.timers.enable({ apis:['Date'], now:new Date('2026-10-19T01:10:15Z') });fixture(t);
  const input={date:'2026-10-19',technicianId:id(1),duration:'30',travelTime:'15'};
  const options={excludeBookingId:id(2),existingAppointment:true,assignmentStartMinutes:551};
  const result=await calendar.getTimeSlotsForQuery(input,options);
  assert.equal(result.payload.timeSlots.length,1);assert.equal(startMinutes(result.payload.timeSlots[0]),551);
  t.mock.method(require('../models/BookingService'),'find',()=>query([{startTime:'10:30',endTime:'11:00'}]));
  assert.equal((await calendar.getTimeSlotsForQuery(input,options)).payload.timeSlots.length,0);
});
test('a public request cannot forge the late-assignment capacity mode and a whole visit must fit the shift', async t => {
  t.mock.timers.enable({ apis:['Date'], now:new Date('2026-10-19T01:10:15Z') });
  fixture(t,{workingDays:[{dayOfWeek:1,startMinutes:480,endMinutes:600}]});
  const input={date:'2026-10-19',technicianId:id(1),duration:'30',travelTime:'15',assignmentStartMinutes:551,_trustedAssignmentStart:551};
  const publicResult=await calendar.getTimeSlotsForQuery(input);
  assert.ok(!publicResult.payload.timeSlots.some(row=>startMinutes(row)===551));
  const late=await calendar.getTimeSlotsForQuery({...input,duration:'480'}, {excludeBookingId:id(2),existingAppointment:true,assignmentStartMinutes:551});
  assert.deepEqual(late.payload.timeSlots,[]);
});

for (const [label, plan] of [["booking", buildAssignmentPlan], ["order", buildOrderAssignmentPlan]]) {
  test(`${label} AI planner uses the same company fallback as the manual picker when no custom schedule exists`, async t => {
    fixture(t);
    t.mock.method(require("../models/Technician"), "find", () => query([{ _id: id(1), name: "Legacy", active: false,
      user: { _id: id(11), role: "technician", firstName: "Staff", lastName: "Roster", active: true } }]));
    t.mock.method(require("../models/TechnicianSchedule"), "find", () => query([]));
    t.mock.method(require("../models/LeaveRequest"), "find", () => query([]));
    const date = new Date("2099-01-05T00:00:00+08:00");
    const job = { _id: id(2), bookingDate: date, startTime: "08:00", endTime: "10:00", serviceDurationMinutes: 60,
      service: { name: "Cleaning" }, fulfillmentType: "delivery_only", delivery: { preferredDate: date }, timeSlot: "08:00", items: [{ quantity: 1 }] };
    const [result] = await plan([job], { reservePlan: false });
    assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].name, "Staff Roster");
  });
}
