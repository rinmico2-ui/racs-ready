require("dotenv").config();
const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const ServiceReport = require("../models/ServiceReport");
const { bookingServices } = require("../utils/bookingServiceItems");

function legacyItemStatus(booking) {
  if (booking.serviceType === "repair" || booking.serviceModel === "RepairService") return "inspection_pending";
  const value = String(booking.status || "pending");
  const map = {
    pending: "pending", payment_verified: "pending", awaiting_assignment: "awaiting_assignment",
    assigned: "assigned", accepted: "accepted", confirmed: "scheduled", scheduled: "scheduled",
    "on-the-way": "en_route", en_route: "en_route", arrived: "arrived",
    "in-progress": "in_progress", in_progress: "in_progress", completed: "completed",
    cancelled: "cancelled", on_hold: "on_hold",
  };
  return map[value] || "pending";
}

async function run() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
  await mongoose.connect(uri);
  const reportIndexes = await ServiceReport.collection.indexes();
  const legacyUniqueReportIndex = reportIndexes.find(index => index.unique && Object.keys(index.key || {}).length === 1 && index.key.bookingId === 1);
  if (legacyUniqueReportIndex) await ServiceReport.collection.dropIndex(legacyUniqueReportIndex.name);
  await ServiceReport.collection.createIndex(
    { bookingId: 1, serviceItemId: 1 },
    { unique: true, partialFilterExpression: { serviceItemId: { $type: "objectId" } }, name: "booking_service_item_unique" },
  );
  const cursor = BookingService.find({ $or: [{ services: { $exists: false } }, { services: { $size: 0 } }] }).cursor();
  let migrated = 0;
  for await (const booking of cursor) {
    const itemStatus = legacyItemStatus(booking);
    const items = bookingServices(booking).map(item => ({
      ...item,
      status: itemStatus,
      phase: booking.serviceType === "repair" ? "repair_phase_1" : "core",
      schedule: { date: booking.bookingDate, startTime: booking.startTime, endTime: booking.endTime, durationMinutes: booking.serviceDurationMinutes || 60, kind: booking.serviceType === "repair" ? "inspection" : "service" },
      statusHistory: [{ status: itemStatus, changedAt: booking.createdAt || new Date(), changedByName: "Legacy migration", reason: `Materialized legacy booking from parent status ${booking.status || "pending"}` }],
    }));
    booking.services = items;
    booking.isMultiService = false;
    await booking.save();
    migrated++;
  }
  console.log(`Migrated ${migrated} legacy bookings to service items.`);
  await mongoose.disconnect();
}

run().catch(async error => {
  console.error(error);
  try { await mongoose.disconnect(); } catch {}
  process.exitCode = 1;
});
