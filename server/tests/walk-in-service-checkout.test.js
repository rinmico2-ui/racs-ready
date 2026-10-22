"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const mongoose = require("mongoose");
const Booking = require("../models/BookingService"), Assignment = require("../models/Assignment");
const Project = require("../models/Project"), Payment = require("../models/Payment");
const { BookingStatus } = require("../models/BookingStatus");
const selection = require("../utils/walkInCoreSelection");
const { parseAppointmentTime } = require("../utils/bookingDateTime");
const router = require("../routes/appointmentRoutes");
const source = router.stack.find(layer => layer.route?.path === "/walk-in").route.stack.at(-1).handle.toString();
const customerId = new mongoose.Types.ObjectId(), serviceId = new mongoose.Types.ObjectId(), techId = new mongoose.Types.ObjectId();

function fixture(t, { quantity = 1, method = "gcash", failPayment = false } = {}) {
  const records = new Map(), events = [];
  const customer = { _id: customerId, firstName: "Demo", lastName: "Customer", role: "customer", phone: "09171234567", email: "customer@example.test", address: { city: "Demo City" } };
  const query = value => ({ select() { return this; }, lean: async () => value });
  for (const Model of [Booking, Assignment, Project, Payment]) {
    t.mock.method(Model.prototype, "save", async function () {
      await this.validate();
      if (Model === Payment && failPayment) throw Error("Payment write failed");
      records.set(String(this._id), this.toObject()); events.push(Model.modelName); return this;
    });
    t.mock.method(Model, "deleteOne", async ({ _id }) => { records.delete(String(_id)); });
  }
  t.mock.method(Booking, "findOne", () => query(null));
  const customRequire = name => {
    if (name === '../utils/repairInspectionPricing') return { resolveRepairInspectionFees: async rows => rows.map(() => ({ fee: 850, unitType: 'split', unitLabel: 'Split Type', categorySlug: 'aircon' })) };
    if (name === '../utils/bookingPolicy') return { getInspectionDurationMinutes: async () => 90 };
    if (name === "../models/Assignment") return Assignment;
    if (name === "../models/Project") return Project;
    if (name === "../models/Technician") return { findOne: () => query({ _id: techId, user: customerId, name: "Demo Technician" }) };
    if (name === "./scheduleRoutes") return { getTimeSlotsForQuery: async () => ({ statusCode: 200, payload: { timeSlots: [{ available: true, startTime: "09:00" }] } }) };
    if (name === "../utils/enterpriseSchedulingEngine") return {
      isLargeProject: async input => input.totalUnits >= 8,
      getProjectWindowAvailability: async () => ({ sufficient: true, days: [{ date: "2035-01-02", isWorkingDay: true, capacityHours: 80, availableTechnicians: 20 }] }),
    };
    if (name.startsWith("../utils/")) return require(name);
    throw Error("Unexpected dependency: " + name);
  };
  const handler = vm.runInNewContext("(" + source + ")", {
    require: customRequire, console: { error() {}, warn() {} }, mongoose: { connection: { getClient: () => ({ topology: { description: { servers: new Map([["db", { type: "Standalone" }]]) } } }) } },
    BookingService: Booking, Payment, BookingStatus,
    User: { findOne: () => ({ then: resolve => Promise.resolve(resolve(customer)), select() { return this; }, lean: async () => customer }) },
    CoreService: { findOne: () => query({ _id: serviceId, name: "Cleaning", active: true, isAirconService: true, durationMinutes: 60, airconTypes: [{ type: "split", name: "Split Type", hpPricing: [{ hp: 1, price: 500, durationMinutes: 60 }] }] }) },
    RepairService: { findOne: () => query(null) },
    normalizeEmailAddress: value => value, validateBookingUnitLimit: require("../utils/bookingUnitLimit").validateBookingUnitLimit,
    ...selection, parseMinuteValue: parseAppointmentTime, getBufferMinutes: async () => 15,
    resolveTechnicianRefId: async () => techId, assertCompanyCapacity: async () => {}, assertNoTechnicianOverlap: async () => {},
    generateBookingReference: () => "BKG-SERVICE-TEST", minutesTo12h: value => String(value),
    provisionWalkInCustomer: async () => { events.push("account"); return { state: "active", created: false, user: customer }; },
    calculateTechnicianAcceptanceDeadline: () => new Date("2035-01-01T05:00:00Z"),
    withOperationLock: async (_, work) => work(), bookingCapacityLockKey: () => "test-day",
    createNotification: async () => events.push("notify"), sendTechnicianNotificationEmail: async () => {},
    sendWalkInBookingAccountEmail: async () => true, audit: { logEvent: async () => {} },
  });
  const req = { body: { firstName: "Demo", lastName: "Customer", customerEmail: customer.email, customerPhone: customer.phone, accountConsent: true, address: customer.address,
    date: "2035-01-02", startTime: "09:00", serviceId: String(serviceId), technicianId: String(techId),
    services: [{ serviceId: String(serviceId), applianceKind: "aircon", applianceGroupId: "walkin_service_appliance", airconType: "split", hp: 1, quantity, brand: "Demo Brand", model: "Split" }],
    customerLocation: { lat: 14, lng: 121, address: "Customer service site" }, travelFare: 100, travelTime: 30,
    paymentMethod: method, cashPaymentMode: "downpayment", paymentReference: "AUTH-RECEIVED-1234", downpaymentAmount: 100,
    ...(quantity >= 8 ? { projectScheduling: { preferredStartDate: "2035-01-02", endDate: "2035-01-10", preferences: { workingDays: ["tuesday"], preferredWorkingHours: "afternoon" } } } : {}) },
    user: { _id: customerId, role: "admin" }, protocol: "https", get: () => "example.test", app: { get: () => null } };
  const res = { status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
  return { req, res, records, events, run: () => handler(req, res) };
}

test("service walk-in saves the actual received method, partial amount and pending technician assignment", async t => {
  const f = fixture(t); await f.run();
  assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
  const payment = [...f.records.values()].find(row => row.method === "gcash");
  assert.equal(payment.amount, 100); assert.equal(payment.status, "verified"); assert.equal(payment.reference, "AUTH-RECEIVED-1234");
  const booking = f.res.body.appointment;
  assert.equal(booking.paymentMethod, "gcash"); assert.equal(booking.paymentStatus, "partial");
  assert.equal(booking.amountPaid, 100); assert.equal(booking.balanceAmount, 500);
  assert.equal(booking.status, "assigned"); assert.equal(f.res.body.assignment.status, "pending_acceptance");
  assert.equal(booking.technicianTeam[0].status, 'pending');
  assert.equal(String(booking.technicianTeam[0].assignmentId), String(f.res.body.assignment._id));
  assert.ok(f.events.indexOf("notify") > f.events.indexOf("Payment"));
});
test("large service walk-in creates all unit records and preserves preferred dates without confirming a work plan", async t => {
  const f = fixture(t, { quantity: 10, method: "maya" }); await f.run();
  assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
  const project = [...f.records.values()].find(row => row.unitGroups);
  assert.equal(project.totalUnits, 10); assert.equal(project.unitGroups[0].units.length, 10);
  assert.equal(project.plannedStartDate, undefined); assert.equal(project.plannedCompletionDate, undefined);
  assert.equal(project.location.lat, 14); assert.equal(project.preferredWorkingHours.start, "13:00");
  assert.equal(f.res.body.assignment, null); assert.equal(f.res.body.appointment.status, "pending_project_scheduling");
  assert.ok([...f.records.values()].some(row => row.method === "maya" && row.reference === "AUTH-RECEIVED-1234"));
});
test("a service payment write failure leaves no booking, assignment, or technician notification", async t => {
  const f = fixture(t, { failPayment: true }); await f.run();
  assert.equal(f.res.code, 500); assert.equal(f.records.size, 0); assert.ok(!f.events.includes("notify"));
});
test("service counter rejects electronic payments without references before creating an account or booking", async t => {
  const f = fixture(t); f.req.body.paymentReference = ""; await f.run();
  assert.equal(f.res.code, 400); assert.equal(f.records.size, 0); assert.ok(!f.events.includes("account"));
});

test('catalog repairs without legacy service IDs use the inspection fee and appliance workflow', async t => {
  const f = fixture(t);
  f.req.body.services = [{ type: 'repair', serviceId: null, unitCategory: 'aircon', unitType: 'split',
    brand: 'Carrier', hp: 1, quantity: 1, model: '', problemDescription: 'Aircon runs but does not cool.', unitPrice: 1, totalPrice: 1 }];
  await f.run();
  assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
  const booking = f.res.body.appointment;
  assert.equal(booking.serviceType, 'repair');
  assert.equal(booking.repairUnitTracking, true);
  assert.equal(booking.serviceDurationMinutes, 90);
  assert.equal(booking.services[0].unitPrice, 850);
  assert.equal(booking.services[0].units[0].status, 'pending');
  assert.equal(booking.services[0].units[0].problemDescription, 'Aircon runs but does not cool.');
  assert.equal(booking.status, 'inspection_scheduled');
  assert.equal(booking.services[0].schedule.kind, 'inspection');
  assert.equal(booking.amountPaid, 100);
  assert.equal(booking.balanceAmount, 850);
  assert.equal(booking.technicianTeam[0].status, 'pending');
});

test('mixed walk-ins preserve core and repair phases under one booking and one counter payment', async t => {
  const f = fixture(t);
  f.req.body.services.push({ type: 'repair', unitCategory: 'aircon', unitType: 'split', brand: 'Carrier', hp: 1,
    quantity: 1, problemDescription: 'The indoor unit is leaking water.' });
  await f.run();
  assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
  const booking = f.res.body.appointment;
  assert.equal(booking.serviceType, 'mixed'); assert.equal(booking.quantity, 2);
  assert.equal(booking.serviceDurationMinutes, 150);
  assert.deepEqual(booking.services.map(item => item.status), ['assigned', 'inspection_scheduled']);
  assert.equal(f.events.filter(name => name === 'Payment').length, 1);
  assert.equal(f.res.body.assignment.status, 'pending_acceptance');
});

test('walk-in repairs require separate appliances and verified brand and HP before checkout', async t => {
  for (const overrides of [{ quantity: 2 }, { hp: null }, { brand: 'Unknown' }]) {
    const f = fixture(t);
    f.req.body.services = [{ type: 'repair', unitCategory: 'aircon', unitType: 'split', brand: 'Carrier', hp: 1,
      quantity: 1, problemDescription: 'The indoor unit is leaking water.', ...overrides }];
    await f.run();
    assert.equal(f.res.code, 400, JSON.stringify(f.res.body)); assert.equal(f.records.size, 0);
    assert.ok(!f.events.includes('account'));
  }
});

test('large repair walk-ins retain appliance tracking and configured inspection work in project planning', async t => {
  const f = fixture(t, { quantity: 10 });
  f.req.body.services = Array.from({ length: 10 }, (_, index) => ({ type: 'repair', unitCategory: 'aircon',
    unitType: 'split', brand: 'Carrier', hp: 1, quantity: 1, problemDescription: `Aircon ${index + 1} is leaking water.` }));
  await f.run();
  assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
  const project = [...f.records.values()].find(row => row.unitGroups);
  assert.equal(project.estimatedTotalHours, 15);
  assert.equal(project.repairUnitTracking, true);
  assert.equal(project.unitGroups.length, 10);
  assert.equal(project.unitGroups[0].duration, 90);
  assert.equal(project.unitGroups[0].units[0].status, 'pending');
  assert.equal(f.res.body.assignment, null);
});
