const mongoose = require("mongoose");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const dns = require("dns");
dotenv.config();

dns.setServers(["8.8.8.8"]);

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";

const BOOKING_DATE = new Date();
BOOKING_DATE.setHours(0, 0, 0, 0);

const BOOKING_NOTE =
  "Booking note: Customer reports unit not cooling since yesterday. Please bring gauges, spare capacitor, and arrive at 8 AM — customer available in the morning only.";

const REPAIR = {
  unitCategory: "aircon",
  unitType: "Split Type Aircon",
  brand: "Carrier",
  model: "42KDPV48",
  quantity: 1,
  symptoms: ["Not Cooling", "Strange Noise", "Overheating"],
  detailedIssue:
    "Not cooling properly since yesterday, making unusual noises from the outdoor unit, and the compressor seems to overheat after ~10 minutes of runtime.",
  photos: ["/uploads/repairs/not-cooling-1.jpg"],
  address: "123 Rizal Ave, Makati City",
  lat: 14.5547,
  lng: 121.05,
  startTime: "08:00",
  endTime: "09:00",
  servicePrice: 1500,
};

function genBookingRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  const d = BOOKING_DATE;
  return `BK-REPAIR-${d.getFullYear()}${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(d.getDate()).padStart(2, "0")}-${code}`;
}

async function run() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("Connected.");

  const User = require("../models/User");
  const Technician = require("../models/Technician");
  const BookingService = require("../models/BookingService");
  const Assignment = require("../models/Assignment");

  let customer = await User.findOne({ role: "customer" }).lean();
  if (!customer) {
    customer = await User.create({
      firstName: "Seed",
      lastName: "Customer",
      email: "seed-repair-customer@example.com",
      phone: "09171234567",
      passwordHash: await bcrypt.hash("password", 12),
      role: "customer",
    });
    console.log("Created seed customer:", customer._id);
  } else {
    console.log("Using existing customer:", customer._id);
  }

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

  const existing = await BookingService.findOne({
    bookingReference: { $regex: /^BK-REPAIR-/ },
  });

  if (existing) {
    existing.bookingDate = BOOKING_DATE;
    existing.preferredDate = BOOKING_DATE;
    existing.preferredTime = REPAIR.startTime;
    existing.startTime = REPAIR.startTime;
    existing.endTime = REPAIR.endTime;
    existing.notes = BOOKING_NOTE;
    if (existing.services && existing.services[0]) {
      existing.services[0].schedule = {
        ...(existing.services[0].schedule || {}),
        date: BOOKING_DATE,
        startTime: REPAIR.startTime,
        endTime: REPAIR.endTime,
      };
    }
    await existing.save();
    console.log("Updated existing repair booking:", existing.bookingReference);

    const existingAssignment = await Assignment.findOne({
      bookingId: existing._id,
    });
    if (existingAssignment) {
      existingAssignment.bookingDate = BOOKING_DATE;
      existingAssignment.startTime = REPAIR.startTime;
      existingAssignment.endTime = REPAIR.endTime;
      existingAssignment.notes = [
        {
          text: BOOKING_NOTE,
          byName: "System",
          createdAt: new Date(),
        },
      ];
      await existingAssignment.save();
      console.log("Updated assignment schedule and note.");
    } else {
      await createAssignment(existing);
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
    return;
  }

  const bookingRef = genBookingRef();

  const booking = await BookingService.create({
    customerId: customer._id,
    technicianId: tech._id,
    customer: {
      _id: customer._id,
      name: customer.firstName + " " + customer.lastName,
      email: customer.email,
      phone: customer.phone,
      address: REPAIR.address,
    },
    technician: {
      _id: tech._id,
      name: tech.name,
      phone: tech.userEmail || "",
      email: tech.userEmail || "",
    },
    serviceType: "repair",
    service: {
      name: "Aircon Repair",
      description: "Air conditioning repair service",
      basePrice: REPAIR.servicePrice,
    },
    serviceName: "Aircon Repair",
    servicePrice: REPAIR.servicePrice,
    brand: REPAIR.brand,
    bookingDate: BOOKING_DATE,
    startTime: REPAIR.startTime,
    endTime: REPAIR.endTime,
    preferredDate: BOOKING_DATE,
    preferredTime: REPAIR.startTime,
    estimatedFee: REPAIR.servicePrice + 150,
    travelFare: 150,
    issueDescription: REPAIR.detailedIssue,
    quantity: REPAIR.quantity,
    totalPrice: REPAIR.servicePrice,
    location: {
      address: REPAIR.address,
      lat: REPAIR.lat,
      lng: REPAIR.lng,
      coordinates: { type: "Point", coordinates: [REPAIR.lng, REPAIR.lat] },
    },
    status: "pending",
    paymentMethod: "cod",
    paymentStatus: "pending",
    downpaymentAmount: REPAIR.servicePrice,
    balanceAmount: 150,
    bookingReference: bookingRef,
    notes: BOOKING_NOTE,
    unitInfo: {
      unitType: REPAIR.unitType,
      brand: REPAIR.brand,
      model: REPAIR.model,
      problemDescription: REPAIR.detailedIssue,
      photos: REPAIR.photos,
    },
    services: [
      {
        name: "Aircon Repair",
        type: "repair",
        quantity: REPAIR.quantity,
        unitPrice: REPAIR.servicePrice,
        totalPrice: REPAIR.servicePrice,
        brand: REPAIR.brand,
        unitCategory: REPAIR.unitCategory,
        model: REPAIR.model,
        problemDescription: REPAIR.detailedIssue,
        repairIssue: REPAIR.detailedIssue,
        symptoms: REPAIR.symptoms,
        photos: REPAIR.photos,
        status: "pending",
        phase: "repair_phase_1",
        technicianId: tech._id,
        technicianName: tech.name,
      },
    ],
    isMultiService: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log(`Created repair booking: ${bookingRef} (${booking._id})`);

  await createAssignment(booking);

  console.log("\n=== Seed Complete ===");
  console.log("Booking note:", BOOKING_NOTE);

  await mongoose.disconnect();
  console.log("Disconnected.");

  async function createAssignment(b) {
    const Assignment = require("../models/Assignment");
    const assignment = await Assignment.create({
      bookingId: b._id,
      technicianId: tech._id,
      customerName: customer.firstName + " " + customer.lastName,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      serviceType: "repair",
      serviceName: "Aircon Repair",
      servicePrice: REPAIR.servicePrice,
      quantity: REPAIR.quantity,
      bookingDate: BOOKING_DATE,
      startTime: REPAIR.startTime,
      endTime: REPAIR.endTime,
      address: REPAIR.address,
      coordinates: { lat: REPAIR.lat, lng: REPAIR.lng },
      status: "accepted",
      priority: "normal",
      assignedAt: new Date(),
      acceptedAt: new Date(),
      estimatedFee: REPAIR.servicePrice + 150,
      travelFare: 150,
      resourcesReserved: false,
      preparationStatus: "pending",
      notes: [
        {
          text: BOOKING_NOTE,
          byName: "System",
          createdAt: new Date(),
        },
      ],
    });
    console.log("Created assignment:", assignment._id);
    return assignment;
  }
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
