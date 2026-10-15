"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { startOfDay } = require("./reportingDates");

const BATCH = "completed-demo-20261015";
const COUNT = 24;
const demoId = key => new mongoose.Types.ObjectId(crypto.createHash("sha256").update(`${BATCH}:${key}`).digest("hex").slice(0, 24));

function catalogPrice(service) {
  const values = [service.basePrice, ...(service.hpPricing || []).map(row => row.price),
    ...(service.airconTypes || []).flatMap(row => (row.hpPricing || []).map(tier => tier.price))];
  return values.map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
}

async function buildCompletedDemoSeed({ services, now = new Date() }) {
  const catalog = services.filter(row => row.active !== false && !row.archivedAt && catalogPrice(row) > 0).slice(0, 3);
  if (!catalog.length) throw Error("An active core service with a configured positive price is required before seeding.");
  const User = require("../models/User"), Technician = require("../models/Technician");
  const Booking = require("../models/BookingService"), Assignment = require("../models/Assignment");
  const Payment = require("../models/Payment"), ServiceReport = require("../models/ServiceReport");
  const seed = { users: [], technicians: [], bookingservices: [], assignments: [], payments: [], servicereports: [] };
  const passwordHash = await require("bcryptjs").hash(crypto.randomBytes(48).toString("hex"), 12);
  async function add(collection, Model, data) {
    const document = new Model(data);
    await document.validate();
    seed[collection].push(document.toObject({ virtuals: false, versionKey: false }));
    return seed[collection].at(-1);
  }
  for (let index = 0; index < 3; index++) await add("users", User, {
    _id: demoId(`customer-${index}`), firstName: "Demo", lastName: `Customer ${index + 1}`,
    email: `completed-demo-${index + 1}@example.invalid`, phone: `0900000000${index}`,
    passwordHash, role: "customer", blocked: true, active: false, emailVerified: false,
    address: { province: "Demo province", city: "Demo city", barangay: "Demo barangay", postalCode: "0000" },
    createdAt: new Date(now.getTime() - 70 * 86400000),
  });
  for (let index = 0; index < 2; index++) await add("technicians", Technician, {
    _id: demoId(`technician-${index}`), name: `Demo Technician ${index + 1}`,
    userEmail: `completed-demo-technician-${index + 1}@example.invalid`,
    active: false, availabilityStatus: "Offline", createdAt: new Date(now.getTime() - 70 * 86400000),
  });
  const today = startOfDay(now);
  for (let index = 0; index < COUNT; index++) {
    const customer = seed.users[index % seed.users.length], technician = seed.technicians[index % seed.technicians.length];
    const service = catalog[index % catalog.length], quantity = 1 + index % 3;
    const rate = catalogPrice(service), amount = Math.round(rate * quantity * 100) / 100;
    // All dates are historical Philippine days; no outstanding dispatch is seeded.
    const startedAt = new Date(today.getTime() - (1 + index * 2) * 86400000 + 9 * 3600000);
    const completedAt = new Date(startedAt.getTime() + 2 * 3600000);
    const createdAt = new Date(startedAt.getTime() - 2 * 86400000);
    const acceptedAt = new Date(startedAt.getTime() - 86400000);
    const reference = `DEMO-COMP-20261015-${String(index + 1).padStart(3, "0")}`;
    const method = index % 2 ? "gcash" : "cash";
    const labor = Math.round(amount * 0.25 * 100) / 100;
    const booked = await add("bookingservices", Booking, {
      _id: demoId(`booking-${index}`), bookingReference: reference,
      customerId: customer._id, technicianId: technician._id, serviceId: service._id,
      customer: { _id: customer._id, name: `${customer.firstName} ${customer.lastName}`, email: customer.email, phone: customer.phone, address: "Demo service address" },
      technician: { _id: technician._id, name: technician.name, email: technician.userEmail },
      serviceModel: "CoreService", serviceType: "core", service: { _id: service._id, name: service.name },
      servicePrice: rate, quantity, estimatedFee: amount, totalPrice: amount,
      bookingDate: startedAt, startTime: "09:00", endTime: "11:00", selectedTimeLabel: "9:00 AM - 11:00 AM",
      serviceDurationMinutes: 120, status: "completed", isProject: false,
      paymentMethod: method === "cash" ? "cod" : method, paymentStatus: "paid", downpaymentAmount: amount, amountPaid: amount, balanceAmount: 0,
      paymentReference: `DEMO-PAY-${String(index + 1).padStart(3, "0")}`,
      brand: "Demo appliance", applianceType: "split", applianceTypeName: "Split Type", hp: 1,
      assignmentId: demoId(`assignment-${index}`), assignedAt: acceptedAt, startedAt, completedAt,
      statusHistory: [{ fromStatus: "in-progress", toStatus: "completed", changedByModel: "System", changedByName: "Demo data seed", changedAt: completedAt, reason: "Synthetic completed booking requested by the system owner." }],
      createdAt, updatedAt: completedAt,
    });
    await add("assignments", Assignment, {
      _id: demoId(`assignment-${index}`), bookingId: booked._id, technicianId: technician._id,
      customerName: booked.customer.name, serviceType: "core", serviceName: service.name,
      servicePrice: rate, quantity, bookingDate: startedAt, startTime: "09:00", endTime: "11:00",
      address: "Demo service address", status: "completed", priority: "normal",
      assignedAt: acceptedAt, acceptedAt, startedAt, completedAt, createdAt, updatedAt: completedAt,
    });
    await add("payments", Payment, {
      _id: demoId(`payment-${index}`), bookingId: booked._id, amount, method, type: "final", status: "paid",
      reference: booked.paymentReference, collectedBy: technician._id, collectedByName: technician.name,
      submittedAt: completedAt, collectedAt: completedAt, remittedAt: completedAt, verifiedAt: completedAt,
      createdAt: completedAt, updatedAt: completedAt,
    });
    await add("servicereports", ServiceReport, {
      _id: demoId(`report-${index}`), bookingId: booked._id, assignmentId: demoId(`assignment-${index}`),
      technicianId: technician._id, customerName: booked.customer.name, serviceName: service.name,
      serviceType: "core", bookingDate: startedAt, status: "approved", actualLaborCost: labor, laborHours: 2,
      findings: "DEMO DATA: synthetic completed service for report demonstrations.",
      actionsTaken: "Demo cleaning and operational checks completed. No physical inventory was consumed.",
      submittedAt: completedAt, createdAt: completedAt, updatedAt: completedAt,
    });
  }
  return seed;
}

module.exports = { BATCH, COUNT, demoId, catalogPrice, buildCompletedDemoSeed };
