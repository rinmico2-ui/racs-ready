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
