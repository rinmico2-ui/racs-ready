/**
 * Seed 5 assigned bookings for Aug 23, 2026 starting at 6:00 PM,
 * assigned to technician abbygailoseo@gmail.com.
 * Creates both BookingService and Assignment documents (status: accepted).
 *
 * Usage:  node scripts/seed-aug23-evening.js
 */
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const dns = require("dns");
dotenv.config();

// Fix DNS resolution for MongoDB Atlas SRV on networks with broken local DNS
dns.setServers(["8.8.8.8"]);
const origResolveSrv = dns.resolveSrv;
dns.resolveSrv = function (hostname, cb) {
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  resolver.resolveSrv(hostname, cb);
};

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";

const TECH_EMAIL = "abbygailoseo@gmail.com";
const WORK_DATE = new Date("2026-08-23T00:00:00"); // local Aug 23, 2026

const BOOKINGS = [
  {
    serviceType: "core",
    serviceName: "Aircon General Cleaning",
    brand: "Carrier",
    hp: 1.5,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "18:00",
    endTime: "19:00",
    address: "123 Rizal Ave, Makati City",
    lat: 14.5547,
    lng: 121.05,
    issueDescription: "Evening general cleaning and filter maintenance",
    servicePrice: 800,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Check-up",
    brand: "Panasonic",
    hp: 1.0,
    applianceType: "window",
    applianceTypeName: "Window Type",
    startTime: "19:15",
    endTime: "20:00",
    address: "321 Ortigas Center, Pasig City",
    lat: 14.5853,
    lng: 121.0573,
    issueDescription: "Routine evening check-up for window type unit",
    servicePrice: 500,
  },
  {
    serviceType: "repair",
    serviceName: "Washing Machine Repair",
    brand: "Samsung",
    startTime: "20:15",
    endTime: "21:15",
    address: "789 Quezon Ave, Quezon City",
    lat: 14.6537,
    lng: 121.0465,
    issueDescription: "Not spinning, loud noise during cycle",
    servicePrice: 500,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Refrigerant Recharge",
    brand: "Carrier",
    hp: 1.5,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "21:30",
    endTime: "22:30",
    address: "555 EDSA, Mandaluyong City",
    lat: 14.5804,
    lng: 121.0486,
    issueDescription: "Not cooling properly, needs refrigerant top-up",
    servicePrice: 1200,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Installation",
    brand: "Daikin",
    hp: 2.0,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "22:45",
    endTime: "23:45",
    address: "456 España Blvd, Manila",
    lat: 14.6042,
    lng: 120.9822,
    issueDescription: "New split type aircon installation (evening schedule)",
    servicePrice: 2500,
  },
];

function genBookingRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const d = WORK_DATE;
  return `BK-SEED-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${code}`;
}

async function run() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("Connected.");

  const User = require("../models/User");
  const Technician = require("../models/Technician");
  const BookingService = require("../models/BookingService");
  const Assignment = require("../models/Assignment");

  // Resolve technician by user email
  const techUser = await User.findOne({ email: TECH_EMAIL }).lean();
  let tech = null;
  if (techUser) {
    tech = await Technician.findOne({ $or: [{ user: techUser._id }, { userEmail: TECH_EMAIL }] }).lean();
  }
  if (!tech) tech = await Technician.findOne({ userEmail: TECH_EMAIL }).lean();
  if (!tech) {
    console.error(`Technician not found for ${TECH_EMAIL}.`);
    if (!techUser) console.error("No User account with that email either.");
    else console.error(`User exists (${techUser._id}) but has no linked Technician record.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Using technician: ${tech.name} (${tech._id})`);

  // Find or create a customer user
  let customer = await User.findOne({ role: "customer" }).lean();
  if (!customer) {
    const bcrypt = require("bcryptjs");
    customer = await User.create({
      firstName: "Seed",
      lastName: "Customer",
      email: "seed-evening-customer@example.com",
      phone: "09171234567",
      passwordHash: await bcrypt.hash("password", 12),
      role: "customer",
    });
    console.log("Created seed customer:", customer._id);
  } else {
    console.log("Using existing customer:", customer._id);
  }

  const startOfDay = new Date(WORK_DATE);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const createdBookings = [];
  const createdAssignments = [];

  for (let i = 0; i < BOOKINGS.length; i++) {
    const b = BOOKINGS[i];
    const bookingRef = genBookingRef();

    const booking = await BookingService.create({
      customerId: customer._id,
      technicianId: tech._id,
      customer: {
        _id: customer._id,
        name: customer.firstName + " " + customer.lastName,
        email: customer.email,
        phone: customer.phone,
        address: b.address,
      },
      technician: {
        _id: tech._id,
        name: tech.name,
        phone: tech.phone || "",
        email: tech.userEmail || TECH_EMAIL,
      },
      serviceType: b.serviceType,
      service: {
        name: b.serviceName,
        description: b.serviceName,
        basePrice: b.servicePrice,
      },
      serviceName: b.serviceName,
      servicePrice: b.servicePrice,
      brand: b.brand,
      hp: b.hp,
      applianceType: b.applianceType,
      applianceTypeName: b.applianceTypeName,
      hpDescription: b.hp ? `${b.hp} HP ${b.applianceTypeName || ""}` : "",
      bookingDate: WORK_DATE,
      startTime: b.startTime,
      endTime: b.endTime,
      estimatedFee: b.servicePrice + 150,
      travelFare: 150,
      issueDescription: b.issueDescription,
      quantity: 1,
      totalPrice: b.servicePrice,
      location: {
        address: b.address,
        lat: b.lat,
        lng: b.lng,
        coordinates: { type: "Point", coordinates: [b.lng, b.lat] },
      },
      status: "confirmed",
      paymentMethod: "cod",
      paymentStatus: "pending",
      downpaymentAmount: b.servicePrice,
      balanceAmount: 150,
      bookingReference: bookingRef,
      services: [
        {
          name: b.serviceName,
          type: b.serviceType,
          quantity: 1,
          unitPrice: b.servicePrice,
          totalPrice: b.servicePrice,
          hp: b.hp,
          hpDescription: b.hp ? `${b.hp} HP ${b.applianceTypeName || ""}` : "",
          brand: b.brand,
          applianceType: b.applianceType,
          applianceTypeName: b.applianceTypeName,
          status: "accepted",
          phase: b.serviceType === "repair" ? "repair_phase_1" : "core",
          technicianId: tech._id,
          technicianName: tech.name,
        },
      ],
      isMultiService: false,
    });

    createdBookings.push(booking);
    console.log(`Created booking ${i + 1}: ${booking.serviceName} (${b.startTime}-${b.endTime}) — ${bookingRef}`);

    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: customer.firstName + " " + customer.lastName,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      serviceType: b.serviceType,
      serviceName: b.serviceName,
      servicePrice: b.servicePrice,
      quantity: 1,
      bookingDate: WORK_DATE,
      startTime: b.startTime,
      endTime: b.endTime,
      address: b.address,
      coordinates: { lat: b.lat, lng: b.lng },
      status: "accepted",
      priority: "normal",
      assignedAt: new Date(),
      acceptedAt: new Date(),
      estimatedFee: b.servicePrice + 150,
      travelFare: 150,
      resourcesReserved: false,
      preparationStatus: "pending",
      notes: [
        {
          text: "Seed booking created for evening schedule testing",
          byName: "System",
          createdAt: new Date(),
        },
      ],
    });

    createdAssignments.push(assignment);
    console.log(`Created assignment ${i + 1}: ${assignment._id}`);
  }

  console.log("\n=== Seed Complete ===");
  console.log(`Created ${createdBookings.length} bookings + ${createdAssignments.length} assignments`);
  console.log(`Date: ${WORK_DATE.toDateString()}, starting 18:00`);
  console.log(`Technician: ${tech.name} (${TECH_EMAIL})`);

  await mongoose.disconnect();
  console.log("Disconnected.");
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
