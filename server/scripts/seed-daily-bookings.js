/**
 * Seed 5 bookings for August 19, 2026 (or today) assigned to a technician.
 * Creates both BookingService and Assignment documents.
 *
 * Usage:  node scripts/seed-daily-bookings.js
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

const WORK_DATE = new Date("2026-08-20T00:00:00");

const BOOKINGS = [
  {
    serviceType: "core",
    serviceName: "Aircon General Cleaning",
    brand: "Carrier",
    hp: 1.5,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "09:00",
    endTime: "10:00",
    address: "123 Rizal Ave, Makati City",
    lat: 14.5547,
    lng: 121.05,
    issueDescription: "Unit needs general cleaning and filter maintenance",
    servicePrice: 800,
    quantity: 1,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Installation",
    brand: "Daikin",
    hp: 2.0,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "10:30",
    endTime: "12:30",
    address: "456 España Blvd, Manila",
    lat: 14.6042,
    lng: 120.9822,
    issueDescription: "New split type aircon installation for bedroom",
    servicePrice: 2500,
    quantity: 1,
  },
  {
    serviceType: "repair",
    serviceName: "Washing Machine Repair",
    brand: "Samsung",
    startTime: "13:00",
    endTime: "14:00",
    address: "789 Quezon Ave, Quezon City",
    lat: 14.6537,
    lng: 121.0465,
    issueDescription: "Washing machine not spinning, making loud noise during cycle",
    servicePrice: 500,
    quantity: 1,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Check-up",
    brand: "Panasonic",
    hp: 1.0,
    applianceType: "window",
    applianceTypeName: "Window Type",
    startTime: "15:00",
    endTime: "15:45",
    address: "321 Ortigas Center, Pasig City",
    lat: 14.5853,
    lng: 121.0573,
    issueDescription: "Routine check-up for window type aircon unit",
    servicePrice: 500,
    quantity: 1,
  },
  {
    serviceType: "core",
    serviceName: "Aircon Refrigerant Recharge",
    brand: "Carrier",
    hp: 1.5,
    applianceType: "split",
    applianceTypeName: "Split Type",
    startTime: "16:00",
    endTime: "17:00",
    address: "555 EDSA, Mandaluyong City",
    lat: 14.5804,
    lng: 121.0486,
    issueDescription: "Aircon not cooling properly, likely needs refrigerant top-up",
    servicePrice: 1200,
    quantity: 1,
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

  // Find or create a customer user
  let customer = await User.findOne({ role: "customer" }).lean();
  if (!customer) {
    const bcrypt = require("bcryptjs");
    customer = await User.create({
      firstName: "Seed",
      lastName: "Customer",
      email: "seed-daily-customer@example.com",
      phone: "09171234567",
      passwordHash: await bcrypt.hash("password", 12),
      role: "customer",
    });
    console.log("Created seed customer:", customer._id);
  } else {
    console.log("Using existing customer:", customer._id);
  }

  // Find or create a technician
  let tech = await Technician.findOne().lean();
  if (!tech) {
    tech = await Technician.create({
      name: "Technician Marco",
      userEmail: "tech-marco@example.com",
      availabilityStatus: "Available",
    });
    console.log("Created seed technician:", tech._id);
  } else {
    console.log("Using existing technician:", tech._id);
  }

  // Check if bookings already exist for this date
  const startOfDay = new Date(WORK_DATE);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const existingCount = await BookingService.countDocuments({
    bookingDate: { $gte: startOfDay, $lt: endOfDay },
    technicianId: tech._id,
  });

  if (existingCount >= 5) {
    console.log(`Already ${existingCount} bookings for this date/technician. Skipping.`);
    await mongoose.disconnect();
    return;
  }

  const createdBookings = [];
  const createdAssignments = [];

  for (let i = 0; i < BOOKINGS.length; i++) {
    const b = BOOKINGS[i];
    const bookingRef = genBookingRef();

    const booking = await BookingService.create({
      customerId: customer._id || customer._id,
      technicianId: tech._id,
      customer: {
        _id: customer._id || customer._id,
        name: customer.firstName + " " + customer.lastName,
        email: customer.email,
        phone: customer.phone,
        address: b.address,
      },
      technician: {
        _id: tech._id,
        name: tech.name,
        phone: tech.userEmail || "",
        email: tech.userEmail || "",
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
      quantity: b.quantity,
      totalPrice: b.servicePrice,
      location: {
        address: b.address,
        lat: b.lat,
        lng: b.lng,
        coordinates: { type: "Point", coordinates: [b.lng, b.lat] },
      },
      status: "confirmed",
      paymentMethod: "cod",
      paymentStatus: "paid",
      amountPaid: b.servicePrice,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    createdBookings.push(booking);
    console.log(`Created booking ${i + 1}: ${booking.serviceName} — ${bookingRef}`);

    // Create assignment
    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: customer.firstName + " " + customer.lastName,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      serviceType: b.serviceType,
      serviceName: b.serviceName,
      servicePrice: b.servicePrice,
      quantity: b.quantity,
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
          text: "Seed booking created for daily preparation testing",
          byName: "System",
          createdAt: new Date(),
        },
      ],
    });

    createdAssignments.push(assignment);
    console.log(`Created assignment for booking ${i + 1}: ${assignment._id}`);
  }

  console.log("\n=== Seed Complete ===");
  console.log(`Created ${createdBookings.length} bookings`);
  console.log(`Created ${createdAssignments.length} assignments`);
  console.log(`Date: ${WORK_DATE.toISOString()}`);
  console.log(`Technician: ${tech.name} (${tech._id})`);
  console.log(`Customer: ${customer.firstName} ${customer.lastName} (${customer._id})`);

  await mongoose.disconnect();
  console.log("Disconnected.");
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
